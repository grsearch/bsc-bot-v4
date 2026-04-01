# Four.meme BSC Migration Sniper Bot v4

## 策略架构

```
Alchemy WSS ──→ PairCreated 事件 ──→ 验证 tx.to == Four.meme
                                          │
                                    GoPlus 安全检查
                                          │ PASS
                                          ▼
                              阈值检测 (收录即检测):
                              ├─ FDV > $30,000
                              ├─ LP  > $10,000
                              └─ Holders > 20
                                          │ ALL PASS
                                          ▼
                              PancakeSwap Buy 固定 BNB
                              (via MEV Guard 防三明治)
                                          │
                                          ▼
                              Birdeye 价格轮询 (5s)
                              ┌─ +50% → 激活 trailing stop
                              ├─ 从高点回撤 30% → 卖出
                              └─ 直接跌 30% → 硬止损
```

## v3 → v4 变更

| 变更项 | v3 | v4 |
| --- | --- | --- |
| 买入条件 | DeepSeek AI 评估推文关联性 | **FDV > 30K, LP > 10K, Holders > 20** |
| X 推文监控 | 监控 CZ/何一推文 | **已删除** |
| DeepSeek AI | 评估代币与推文关联性 | **已删除** |
| 所需 API Keys | X API + DeepSeek | **不再需要** |
| 阈值参数 | 无 | **可通过 .env 配置** |

## 已确认合约

| 合约 | 地址 |
| --- | --- |
| Four.meme Token Manager | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` |
| PancakeSwap Factory V2 | `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` |
| PancakeSwap Router V2 | `0x10ED43C718714eb63d5aA57B78B54704E256024E` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |

## 部署步骤

### 1. 服务器环境

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

### 2. 部署代码

```bash
cd /opt
git clone https://github.com/YOUR_USER/four-meme-sniper.git
cd four-meme-sniper
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
nano .env
# 填入 API keys 和钱包私钥
```

### 4. 启动

```bash
npm run pm2
pm2 logs four-meme-sniper
pm2 save && pm2 startup
```

### 5. 访问 Dashboard

浏览器打开 `http://你的服务器IP:3000`

## 所需 API Keys

| 服务 | 用途 | 费用 |
| --- | --- | --- |
| Alchemy | BSC WSS 监听 | 免费 |
| Birdeye | 价格/FDV/Holders | $450/月 (B-05) |
| GoPlus | 安全检测 | 免费 |
| Honeypot.is | 二次验证 | 免费 |
| BscScan | Holder 查询 (备用) | 免费 |
| PancakeSwap MEV Guard | 发送交易 | 免费 |

## 买入阈值配置 (.env)

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `MIN_FDV` | 30000 | FDV 最低要求 ($) |
| `MIN_LP` | 10000 | LP 流动性最低要求 ($) |
| `MIN_HOLDERS` | 20 | 最少持有人数 |
| `BUY_AMOUNT_BNB` | 0.2 | 每次买入的固定 BNB 数额 |

## 项目结构

```
four-meme-sniper/
├── index.js              # 主入口 (v4)
├── ecosystem.config.js   # PM2 配置
├── package.json
├── .env.example
├── .gitignore
├── bot/
│   ├── sniper.js         # 迁移事件监听
│   ├── tradeExecutor.js  # 买卖执行
│   ├── priceMonitor.js   # 价格轮询 (5s)
│   ├── security.js       # 安全检测
│   ├── dashboard.js      # Web Dashboard
│   └── logger.js         # 日志
└── logs/
```

> **注意**: `xMentions.js` 和 `deepseekEval.js` 在 v4 中不再使用，可安全删除。

## 安全提示

* 使用**专用热钱包**，只放交易资金
* 先用 0.01 BNB 测试一轮确认正常
* `.env` 永远不要提交到 git
* 建议安全组仅允许你的 IP 访问 3000 端口
