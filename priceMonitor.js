// ============================================================
// Price Monitor — Birdeye API (v4)
// 变更: 所有代币价格统一转换为 BNB 计价
//       新增 BNB 价格缓存 (30 秒 TTL)
//       priceBNB = priceUSD / bnbPriceUSD
// ============================================================

const { logger } = require("./logger");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

class PriceMonitor {
  constructor(config) {
    this.apiKey = config.BIRDEYE_API_KEY;
    this.base = "https://public-api.birdeye.so";
    this.cache = new Map();
    this.cacheTTL = 4000; // 4 秒缓存 (配合 5 秒轮询)

    // BNB 价格缓存 (USD)
    this._bnbPriceUsd = 600;  // 默认值
    this._bnbPriceTs = 0;
    this._bnbPriceTTL = 30000; // 30 秒刷新一次
  }

  /**
   * 获取 BNB 的 USD 价格 (30 秒缓存)
   */
  async _getBnbPrice() {
    if (Date.now() - this._bnbPriceTs < this._bnbPriceTTL) return this._bnbPriceUsd;

    try {
      const r = await fetch(`${this.base}/defi/price?address=${WBNB}`, {
        headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.data?.value) {
          this._bnbPriceUsd = d.data.value;
          this._bnbPriceTs = Date.now();
          logger.info(`BNB price updated: $${this._bnbPriceUsd.toFixed(2)}`);
        }
      }
    } catch (e) {
      logger.warn(`BNB price fetch failed: ${e.message}, using cached $${this._bnbPriceUsd.toFixed(2)}`);
    }
    return this._bnbPriceUsd;
  }

  async getPrice(tokenAddress) {
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.ts < this.cacheTTL) return cached.data;

    try {
      // 并行获取代币价格和 BNB 价格
      const [tokenResp, bnbPriceUsd] = await Promise.all([
        fetch(`${this.base}/defi/token_overview?address=${tokenAddress}`, {
          headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
          signal: AbortSignal.timeout(5000),
        }),
        this._getBnbPrice(),
      ]);

      if (tokenResp.status === 429) {
        logger.warn("Birdeye 429, backing off");
        await this._sleep(2000);
        return null;
      }
      if (!tokenResp.ok) return null;

      const d = await tokenResp.json();
      if (!d.success || !d.data) return null;

      const priceUsd = d.data.price || 0;
      // 核心转换: USD 价格 → BNB 价格
      const priceBnb = bnbPriceUsd > 0 ? priceUsd / bnbPriceUsd : 0;

      const result = {
        price: priceBnb,         // BNB 计价 (与 entryPrice 单位一致)
        priceUsd: priceUsd,      // 保留 USD 价格供 dashboard 展示
        fdv: d.data.fdv || 0,
        liquidity: d.data.liquidity || 0,
        holders: d.data.holder || 0,
      };

      this.cache.set(tokenAddress, { data: result, ts: Date.now() });
      return result;
    } catch (e) {
      logger.error(`Birdeye price ${tokenAddress.slice(0, 10)}: ${e.message}`);
      return null;
    }
  }

  async getBatchPrices(addresses) {
    if (!addresses.length) return new Map();
    try {
      const list = addresses.slice(0, 100).join(",");
      const r = await fetch(`${this.base}/defi/multi_price?list_address=${list}`, {
        headers: { "X-API-KEY": this.apiKey, "x-chain": "bsc" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return new Map();
      const d = await r.json();
      const out = new Map();
      if (d.success && d.data) {
        for (const [addr, info] of Object.entries(d.data)) {
          out.set(addr.toLowerCase(), info.value || 0);
        }
      }
      return out;
    } catch (e) {
      logger.error(`Birdeye batch: ${e.message}`);
      return new Map();
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { PriceMonitor };
