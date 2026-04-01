// ============================================================
// Four.meme BSC Migration Sniper Bot (v4)
// ============================================================
// 变更 (v3 → v4):
//   1. 删除 X 推文监控 (不再依赖 CZ/何一推文)
//   2. 删除 DeepSeek AI 关联性评估
//   3. 买入条件改为: 收录即检测，FDV > 30000, LP > 10000, holders > 20
//   4. 卖出策略不变 (trailing stop + hard stop)
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const { SniperBot } = require("./bot/sniper");
const { PriceMonitor } = require("./bot/priceMonitor");
const { SecurityChecker } = require("./bot/security");
const { TradeExecutor } = require("./bot/tradeExecutor");
const { Dashboard } = require("./bot/dashboard");
const { logger } = require("./bot/logger");

// ── Config ──
const C = {
  ALCHEMY_WSS:   process.env.ALCHEMY_WSS  || "wss://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY",
  ALCHEMY_HTTP:  process.env.ALCHEMY_HTTP  || "https://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY",
  MEV_GUARD_RPC: process.env.MEV_GUARD_RPC || "https://bscrpc.pancakeswap.finance",
  PRIVATE_KEY:   process.env.PRIVATE_KEY,
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,

  PANCAKE_ROUTER_V2: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",

  BUY_AMOUNT_BNB:    parseFloat(process.env.BUY_AMOUNT_BNB || "0.2"),
  SLIPPAGE_PERCENT:  parseInt(process.env.SLIPPAGE_PERCENT  || "30"),
  GAS_PRICE_GWEI:    parseInt(process.env.GAS_PRICE_GWEI    || "5"),
  GAS_LIMIT:         parseInt(process.env.GAS_LIMIT          || "500000"),

  // 买入条件阈值
  MIN_FDV:     parseFloat(process.env.MIN_FDV     || "30000"),
  MIN_LP:      parseFloat(process.env.MIN_LP      || "10000"),
  MIN_HOLDERS: parseInt(process.env.MIN_HOLDERS    || "20"),

  TRAILING_ACTIVATE: 50,   // +50% 激活移动止损
  TRAILING_STOP:     30,   // 从最高点回撤 30% 卖出
  HARD_STOP:         30,   // 直接跌 30% 止损

  POLL_INTERVAL:  5000,    // 价格轮询间隔 5 秒
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT || "3000"),
};

async function main() {
  logger.info("══════════════════════════════════════════");
  logger.info("  Four.meme BSC Migration Sniper Bot v4");
  logger.info("  策略: 收录即检测 FDV/LP/Holders 阈值买入");
  logger.info(`  买入条件: FDV>${C.MIN_FDV} LP>${C.MIN_LP} Holders>${C.MIN_HOLDERS}`);
  logger.info(`  买入金额: ${C.BUY_AMOUNT_BNB} BNB`);
  logger.info("══════════════════════════════════════════");

  // 校验必填配置
  if (!C.PRIVATE_KEY)      { logger.error("PRIVATE_KEY missing in .env"); process.exit(1); }
  if (!C.BIRDEYE_API_KEY)  { logger.error("BIRDEYE_API_KEY missing in .env"); process.exit(1); }

  // ── Providers ──
  const wssProvider  = new ethers.WebSocketProvider(C.ALCHEMY_WSS);
  const httpProvider = new ethers.JsonRpcProvider(C.ALCHEMY_HTTP);
  const mevProvider  = new ethers.JsonRpcProvider(C.MEV_GUARD_RPC);

  const wallet = new ethers.Wallet(C.PRIVATE_KEY, mevProvider);
  const balance = await mevProvider.getBalance(wallet.address);
  logger.info(`Wallet:  ${wallet.address}`);
  logger.info(`Balance: ${ethers.formatEther(balance)} BNB`);
  if (balance < ethers.parseEther("0.3")) logger.warn("Balance low — recommend ≥ 0.3 BNB");

  // ── Modules (不再需要 XMonitor 和 DeepSeekEvaluator) ──
  const security   = new SecurityChecker();
  const executor   = new TradeExecutor(wallet, C);
  const priceWatch = new PriceMonitor(C);
  const dashboard  = new Dashboard(C.DASHBOARD_PORT, C.BUY_AMOUNT_BNB);

  dashboard.start();

  // ── State ──
  const positions   = new Map();
  const soldTokens  = new Set();
  let   monitorBusy = false;

  // ════════════════════════════════════════
  // 迁移检测回调 — 新策略: FDV/LP/Holders 阈值
  // ════════════════════════════════════════
  async function onMigration(tokenAddr, symbol, lp, fdv, holders) {
    logger.info(`🔍 Migration: ${symbol} (${tokenAddr.slice(0, 10)}...) FDV=$${fdv} LP=$${lp} Holders=${holders}`);

    if (soldTokens.has(tokenAddr) || positions.has(tokenAddr)) {
      logger.info(`  skip — already traded/monitoring`);
      return;
    }

    // Step 1: 安全检查 (GoPlus + Honeypot.is)
    const sec = await security.check(tokenAddr);
    if (!sec.safe) {
      logger.warn(`  ✗ Security FAIL: ${sec.reason}`);
      dashboard.addDetectedToken({
        tokenAddress: tokenAddr, symbol, lp, fdv, holders,
        safe: false, qualified: false, qualifyReason: `Security: ${sec.reason}`,
      });
      return;
    }

    // Step 2: 检查 FDV / LP / Holders 阈值
    const fdvOk     = fdv > C.MIN_FDV;
    const lpOk      = lp > C.MIN_LP;
    const holdersOk = holders > C.MIN_HOLDERS;
    const qualified  = fdvOk && lpOk && holdersOk;

    const checks = [];
    if (!fdvOk)     checks.push(`FDV=$${fdv}<${C.MIN_FDV}`);
    if (!lpOk)      checks.push(`LP=$${lp}<${C.MIN_LP}`);
    if (!holdersOk) checks.push(`Holders=${holders}<=${C.MIN_HOLDERS}`);
    const qualifyReason = qualified
      ? `PASS: FDV=$${fdv} LP=$${lp} Holders=${holders}`
      : `FAIL: ${checks.join(", ")}`;

    dashboard.addDetectedToken({
      tokenAddress: tokenAddr, symbol, lp, fdv, holders,
      safe: true, qualified, qualifyReason,
    });

    if (!qualified) {
      logger.warn(`  ✗ Threshold check: ${qualifyReason}`);
      return;
    }

    // Step 3: 买入固定数额 BNB
    logger.info(`  ✓ QUALIFIED — FDV=$${fdv} LP=$${lp} Holders=${holders}`);
    logger.info(`  Buying ${C.BUY_AMOUNT_BNB} BNB...`);
    const buyResult = await executor.buy(tokenAddr, C.BUY_AMOUNT_BNB);
    if (!buyResult.success) {
      logger.error(`  ✗ Buy failed: ${buyResult.error}`);
      return;
    }

    const pos = {
      tokenAddress: tokenAddr,
      symbol,
      entryPrice:   buyResult.price,
      currentPrice: buyResult.price,
      highestPrice: buyResult.price,
      tokenAmount:  buyResult.tokenAmount,
      decimals:     buyResult.decimals,
      bnbAmount:    C.BUY_AMOUNT_BNB,
      buyTxHash:    buyResult.txHash,
      buyTime:      Date.now(),
      trailingActive: false,
      pnl: 0,
      fdv: fdv,
    };

    positions.set(tokenAddr, pos);
    dashboard.addActivePosition(pos);
    dashboard.addTrade({
      symbol, side: "BUY", price: buyResult.price,
      txHash: buyResult.txHash, time: Date.now(),
      reason: `FDV=$${fdv} LP=$${lp} Holders=${holders}`,
      pnl: null,
    });

    logger.success(`  Bought ${symbol} @ $${buyResult.price} | tx: ${buyResult.txHash}`);
  }

  // ════════════════════════════════════════
  // 卖出 (策略不变)
  // ════════════════════════════════════════
  async function doSell(tokenAddr, reason, pnl) {
    const pos = positions.get(tokenAddr);
    if (!pos) return;

    logger.info(`  Selling ${pos.symbol} — ${reason} (PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)`);
    const result = await executor.sell(tokenAddr, pos.tokenAmount);

    if (result.success) {
      dashboard.addTrade({
        symbol: pos.symbol, side: "SELL", price: pos.currentPrice, pnl,
        txHash: result.txHash, time: Date.now(), reason,
        bnbAmount: pos.bnbAmount,
      });
      logger.success(`  SOLD ${pos.symbol} | ${reason} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% | tx: ${result.txHash}`);
      positions.delete(tokenAddr);
      soldTokens.add(tokenAddr);
      dashboard.removePosition(tokenAddr);
    } else {
      logger.error(`  Sell FAILED for ${pos.symbol}: ${result.error} — will retry next cycle`);
    }
  }

  // ════════════════════════════════════════
  // 价格监控循环 (5 秒) — 不变
  // ════════════════════════════════════════
  async function monitorPrices() {
    if (monitorBusy || positions.size === 0) return;
    monitorBusy = true;

    try {
      const entries = [...positions.entries()];
      const results = await Promise.allSettled(
        entries.map(([addr]) => priceWatch.getPrice(addr))
      );

      for (let i = 0; i < entries.length; i++) {
        const [tokenAddr, pos] = entries[i];
        if (!positions.has(tokenAddr)) continue;

        const priceResult = results[i];
        if (priceResult.status !== "fulfilled" || !priceResult.value) continue;

        const data = priceResult.value;
        pos.currentPrice = data.price;
        pos.fdv = data.fdv || pos.fdv;

        if (pos.currentPrice > pos.highestPrice) pos.highestPrice = pos.currentPrice;

        const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.pnl = pnl;

        // ── 激活移动止损 ──
        if (!pos.trailingActive && pnl >= C.TRAILING_ACTIVATE) {
          pos.trailingActive = true;
          logger.info(`${pos.symbol} TRAILING ACTIVATED @ +${pnl.toFixed(1)}%`);
        }

        // ── 移动止损触发 ──
        if (pos.trailingActive) {
          const drawdown = ((pos.highestPrice - pos.currentPrice) / pos.highestPrice) * 100;
          if (drawdown >= C.TRAILING_STOP) {
            logger.warn(`${pos.symbol} TRAILING STOP -${drawdown.toFixed(1)}% from high`);
            await doSell(tokenAddr, "TRAILING_STOP", pnl);
            continue;
          }
        }

        // ── 硬止损 ──
        if (pnl <= -C.HARD_STOP) {
          logger.warn(`${pos.symbol} HARD STOP ${pnl.toFixed(1)}%`);
          await doSell(tokenAddr, "HARD_STOP", pnl);
          continue;
        }

        // 更新 dashboard
        dashboard.updatePosition(tokenAddr, {
          currentPrice: pos.currentPrice,
          highestPrice: pos.highestPrice,
          pnl,
          trailingActive: pos.trailingActive,
          fdv: pos.fdv,
        });
      }
    } catch (e) {
      logger.error(`monitorPrices error: ${e.message}`);
    } finally {
      monitorBusy = false;
    }
  }

  // ── 启动 (不再启动 xMonitor) ──
  const sniper = new SniperBot(wssProvider, httpProvider, C);
  sniper.on("migration", onMigration);
  sniper.start();

  setInterval(monitorPrices, C.POLL_INTERVAL);

  // ════════════════════════════════════════
  // 定时调度: 北京时间 23:30 停止扫描, 07:00 恢复
  // 注意: 休眠期间只暂停链上扫描(不接新单)
  //       价格监控和已有持仓的止损/止盈继续运行
  // ════════════════════════════════════════
  let sniperPaused = false;

  /**
   * 获取当前北京时间的小时和分钟
   */
  function getBeijingHM() {
    const now = new Date();
    // UTC+8
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const beijing = new Date(utc + 8 * 3600000);
    return { h: beijing.getHours(), m: beijing.getMinutes() };
  }

  /**
   * 判断当前是否在休眠时段 (23:30 ~ 07:00 北京时间)
   */
  function isInSleepWindow() {
    const { h, m } = getBeijingHM();
    const t = h * 60 + m; // 当前分钟数
    // 23:30 = 1410, 07:00 = 420
    // 休眠区间: [1410, 1440) 跨午夜 [0, 420)
    return t >= 1410 || t < 420;
  }

  /**
   * 计算到下一个切换时间点的毫秒数
   */
  function msToNext(targetH, targetM) {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const beijing = new Date(utc + 8 * 3600000);

    let target = new Date(beijing);
    target.setHours(targetH, targetM, 0, 0);

    // 如果目标时间已过，则推到明天
    if (target <= beijing) {
      target.setDate(target.getDate() + 1);
    }

    // 转回 UTC 差值
    return target.getTime() - beijing.getTime();
  }

  function scheduleSleep() {
    const ms = msToNext(23, 30);
    const hrs = (ms / 3600000).toFixed(1);
    logger.info(`⏰ Schedule: will PAUSE scanning at 23:30 Beijing time (in ${hrs}h)`);

    setTimeout(() => {
      if (!sniperPaused) {
        sniperPaused = true;
        sniper.stop();
        logger.info("🌙 23:30 Beijing — Sniper PAUSED (price monitor still active)");
        dashboard.state.sniperStatus = "PAUSED (23:30-07:00)";
      }
      scheduleWake();
    }, ms);
  }

  function scheduleWake() {
    const ms = msToNext(7, 0);
    const hrs = (ms / 3600000).toFixed(1);
    logger.info(`⏰ Schedule: will RESUME scanning at 07:00 Beijing time (in ${hrs}h)`);

    setTimeout(() => {
      if (sniperPaused) {
        sniperPaused = false;
        sniper.resume();
        logger.info("☀️ 07:00 Beijing — Sniper RESUMED");
        dashboard.state.sniperStatus = "ACTIVE";
      }
      scheduleSleep();
    }, ms);
  }

  // 启动时判断是否在休眠窗口
  if (isInSleepWindow()) {
    const { h, m } = getBeijingHM();
    logger.info(`⏰ Current Beijing time: ${h}:${String(m).padStart(2, "0")} — in sleep window (23:30~07:00)`);
    sniperPaused = true;
    sniper.stop();
    logger.info("🌙 Sniper PAUSED on startup (sleep window)");
    dashboard.state.sniperStatus = "PAUSED (23:30-07:00)";
    scheduleWake();
  } else {
    const { h, m } = getBeijingHM();
    logger.info(`⏰ Current Beijing time: ${h}:${String(m).padStart(2, "0")} — active window`);
    dashboard.state.sniperStatus = "ACTIVE";
    scheduleSleep();
  }

  logger.info(`Price poll interval: ${C.POLL_INTERVAL / 1000}s`);
  logger.info("Bot running. Ctrl+C to stop.");

  // ── 优雅关闭 (不再需要 xMonitor.stop()) ──
  async function shutdown() {
    logger.info("Shutting down...");
    sniper.stop();
    for (const [addr, pos] of positions) {
      const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      logger.info(`Emergency sell ${pos.symbol}...`);
      await doSell(addr, "SHUTDOWN", pnl);
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("unhandledRejection", (e) => {
    logger.error(`Unhandled rejection: ${e?.message || e}`);
  });
}

main().catch(e => {
  logger.error(`Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
