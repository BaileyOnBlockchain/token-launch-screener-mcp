# Token Launch Screener — MCP Server

> One call. 30 seconds. Know if it's a rug before you ape.

Aggregates **GoPlus Security**, **DexScreener**, and **Etherscan V2** into a single structured risk verdict for newly launched EVM tokens. Built for the [Context Protocol marketplace](https://ctxprotocol.com) by [@blockchainbail](https://x.com/blockchainbail).

---

## What It Replaces

| Manual workflow | Time | Cost |
|---|---|---|
| DexScreener for chart & liquidity | 2 min | Free |
| DEXTools Pro for first buyers | 3 min | $99/mo |
| Token Sniffer for contract flags | 2 min | Free (slow) |
| Etherscan for deployer history | 5 min | Free (painful) |
| **Token Launch Screener MCP** | **< 30 sec** | **$0.10/call** |

---

## Risk Model

| Score | Meaning |
|---|---|
| `SAFE` | No significant flags detected |
| `CAUTION` | Multiple warning signals — proceed carefully |
| `LIKELY_RUG` | Hard red flag present (honeypot, owner drain, extreme tax) |

**Hard fails (always `LIKELY_RUG`):**
- Honeypot detected — tokens cannot be sold
- Owner can arbitrarily modify wallet balances
- Sell tax > 25%
- >50% sniper concentration + serial deployer

---

## Data Sources

| Source | Data | Key Required |
|---|---|---|
| [GoPlus Security](https://gopluslabs.io) | Honeypot, buy/sell tax, mintable, blacklist, ownership | ❌ Free |
| [DexScreener](https://dexscreener.com) | Liquidity, pair age, price | ❌ Free |
| [Etherscan V2](https://etherscan.io) | Deployer history, early buyers, sniper detection | ✅ Free tier (ETH mainnet) |

---

## Output Schema

```json
{
  "contract_address":            "0x...",
  "chain":                       "base",
  "screened_at":                 "2025-04-09T12:00:00.000Z",
  "token_name":                  "Example Token",
  "token_symbol":                "EXT",
  "decimals":                    18,
  "contract_age_hours":          3,
  "deployer_address":            "0x...",
  "deployer_previous_contracts": 5,
  "deployer_flagged":            true,
  "liquidity_usd":               12500,
  "liquidity_locked":            false,
  "is_honeypot":                 false,
  "buy_tax_percent":             2.0,
  "sell_tax_percent":            8.0,
  "is_mintable":                 true,
  "is_proxy":                    false,
  "has_blacklist":               false,
  "owner_can_change_balance":    false,
  "first_buyers_count":          50,
  "sniper_count":                18,
  "bundler_count":               4,
  "sniper_held_percent":         36,
  "risk_score":                  "CAUTION",
  "risk_flags": [
    "Deployer has launched 5 previous contracts (serial launcher pattern)",
    "Liquidity is not locked — deployer can pull at any time",
    "Token is mintable — total supply can be inflated post-launch",
    "36% of early buyers are fresh wallets (sniper pattern)"
  ],
  "summary": "⚠️ Example Token (EXT) — CAUTION\nLiquidity: $12,500 | Age: 3h | Snipers: 18/50 early buyers\n\nRisk flags:\n  • ..."
}
```

---

## Setup

### Prerequisites
- Node.js 18+
- Free [Etherscan API key](https://etherscan.io/apikey)

### Install & Run

```bash
# Clone and install
git clone https://github.com/BaileyOnBlockchain/token-launch-screener-mcp
cd token-launch-screener-mcp
npm install

# Configure
cp .env.example .env
# Edit .env — add your ETHERSCAN_API_KEY

# Build and start
npm run build
npm start
```

Server runs at `http://localhost:3000/mcp`

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ETHERSCAN_API_KEY` | Yes | From [etherscan.io/apikey](https://etherscan.io/apikey) |
| `PORT` | No | HTTP port (default: `3000`) |
| `TRANSPORT` | No | `http` or `stdio` (default: `http`) |

---

## Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set your API key in Railway dashboard
# Project → Variables → ETHERSCAN_API_KEY=your_key
```

Your endpoint will be: `https://yourapp.up.railway.app/mcp`

---

## 5 Must-Win Prompts

These are the prompts used for Context Protocol grant review:

1. `"Screen this Base token: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`
   - Expected: `risk_score`, `liquidity_usd`, `is_honeypot`, tax, sniper count, summary

2. `"Is 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 on base safe to ape?"`
   - Expected: Full `TokenScreenResult` with `risk_flags[]` and human-readable summary

3. `"Quick rug check — ETH contract 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"`
   - Expected: `SAFE` verdict for USDC — high liquidity, no flags

4. `"New token just launched on base: 0x4200000000000000000000000000000000000042 — sniper check"`
   - Expected: `sniper_count`, `bundler_count`, `sniper_held_percent`, `deployer_flagged`

5. `"Screen 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 — what's the risk level and why?"`
   - Expected: Structured verdict with `risk_flags` explaining the score in plain English

---

## Project Structure

```
token-launch-screener-mcp/
├── src/
│   ├── index.ts              # MCP server, tool registration, HTTP transport
│   ├── types.ts              # All TypeScript interfaces and types
│   ├── services/
│   │   └── apis.ts           # DexScreener, GoPlus, Etherscan V2 clients
│   └── tools/
│       └── screen_token.ts   # Core risk scoring and verdict logic
├── .env.example              # Environment variable template
├── .gitignore                # Excludes .env, node_modules, dist
├── package.json
├── tsconfig.json
└── README.md
```

---

## Built By

**Bailey** — [@blockchainbail](https://x.com/blockchainbail)  
Solo builder. Privacy-first dapp. No VC.  
[odennetworkxr.com](https://odennetworkxr.com) · [github.com/BaileyOnBlockchain](https://github.com/BaileyOnBlockchain)
