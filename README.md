# CryptoPulse — pay-per-call data API for AI agents (x402)

**Live:** https://cryptopulse.saascloud.ai · **Docs:** https://cryptopulse.saascloud.ai/docs · **MCP:** `https://cryptopulse.saascloud.ai/mcp` · **llms.txt:** https://cryptopulse.saascloud.ai/llms.txt · **OpenAPI:** https://cryptopulse.saascloud.ai/openapi.json

No API keys, no accounts, no subscriptions. Every endpoint answers `HTTP 402` with [x402](https://x402.org) payment requirements; your agent retries with a signed USDC micropayment (**Base** or **Solana**) and gets the data. Prices are **$0.001–$0.10 per call**.

24 endpoints in three groups:

| Group | Endpoints | Price |
|---|---|---|
| **Crypto market data** | `/api/price`, `/api/trending`, `/api/fear-greed`, `/api/gas`, `/api/ohlc`, `/api/token-pairs`, `/api/token-risk`, `/api/yields`, `/api/market-summary`, `/api/token-score`, `/api/screener`, `/api/funding-rates`, `/api/stablecoins`, `/api/dex-volume`, `/api/wallet` | $0.002–$0.10 |
| **Halal food, mosques & prayer** | `/api/halal/near`, `/api/halal/city`, `/api/halal/place`, `/api/mosques/near`, `/api/mosques/city`, `/api/prayer-times`, `/api/qibla`, `/api/trip/halal` | $0.001–$0.02 |
| **Fiat FX** | `/api/fx` (ECB reference rates, conversion, history) | $0.001 |

The halal index holds **17,687 halal restaurants, grocers and butchers** and **164,761 mosques and prayer spaces** worldwide (OpenStreetMap, ODbL, refreshed monthly). Prayer times are computed astronomically with 17 calculation methods, Hanafi/Standard Asr, high-latitude handling and Hijri dates. `/api/trip/halal` bundles prayer times, qibla, nearby halal food and nearby mosques for a city in one call.

## Quick start (REST)

```bash
npm i @x402/fetch @x402/evm viem
```

```js
import { wrapFetchWithPayment } from "@x402/fetch";
// `client` = your x402 EVM signer (a viem account holding USDC on Base)
const fetchWithPay = wrapFetchWithPayment(fetch, client);

const r = await fetchWithPay("https://cryptopulse.saascloud.ai/api/halal/near?lat=40.7128&lng=-74.006&radius_km=3");
console.log(await r.json());
```

Without a client, any plain request shows the price and payment requirements:

```bash
curl -i "https://cryptopulse.saascloud.ai/api/prayer-times?lat=51.5&lng=-0.12&method=MWL"
# HTTP/1.1 402 Payment Required
# PAYMENT-REQUIRED: <base64 x402 v2 requirements>   (v1 clients get the same in the JSON body)
```

Both x402 **v1** (`X-PAYMENT`) and **v2** (`PAYMENT-SIGNATURE`) clients are supported. Facilitator: PayAI (`https://facilitator.payai.network`). Networks: `eip155:8453` (Base) and `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.

## Quick start (MCP)

Add a Streamable-HTTP server:

```json
{ "mcpServers": { "cryptopulse": { "url": "https://cryptopulse.saascloud.ai/mcp" } } }
```

`initialize` and `tools/list` are free. Paid tool calls return `402` with the same x402 headers; x402-aware MCP clients (or an x402 proxy) retry with payment automatically. Registered in the official MCP Registry as `ai.saascloud/cryptopulse`.

Tools: `price`, `trending`, `fear_greed`, `gas`, `ohlc`, `token_pairs`, `token_risk`, `yields`, `market_summary`, `token_score`, `screener`, `funding_rates`, `stablecoins`, `dex_volume`, `wallet`, `halal_near`, `halal_city`, `halal_place`, `mosques_near`, `mosques_city`, `prayer_times`, `qibla`, `trip_halal`, `fx`.

## Example responses

`GET /api/prayer-times?lat=41.8781&lng=-87.6298&method=ISNA`

```json
{ "date": "2026-11-03", "hijri": { "formatted": "22 Jumada al-awwal 1448 AH" },
  "timezone": { "name": "America/Chicago", "offset_hours": -6 },
  "times": { "fajr": "05:07", "sunrise": "06:26", "dhuhr": "11:34", "asr": "14:19", "maghrib": "16:42", "isha": "18:01" } }
```

`GET /api/funding-rates?symbols=BTC,ETH`

```json
{ "results": [ { "symbol": "BTC", "funding_rate_1h": 0.0000125, "funding_apr_pct": 10.95, "mark_price": 77402, "open_interest_usd": 3243000000 } ] }
```

## How it works

A single zero-dependency Cloudflare Worker (`src/worker.js`): x402 v1+v2 seller flow (verify → serve → settle), an MCP Streamable-HTTP server that exposes every route as a tool, a D1 database for the halal/mosque index (loaded from OpenStreetMap via the QLever SPARQL endpoint, refreshed by a cron trigger), and generated `/llms.txt`, `/openapi.json` and `/docs`.

Data sources: CoinGecko, DexScreener, GoPlus, DefiLlama, Hyperliquid, Blockscout, alternative.me, OpenStreetMap (© OpenStreetMap contributors, ODbL), European Central Bank. Prayer times are computed, not fetched.

## Why x402?

Agents can't sign up for API keys or enter credit cards. With x402 the agent's wallet pays per request, settlement is on-chain in USDC, and the seller never holds an account for the buyer. CryptoPulse is listed on [x402-list](https://x402-list.com), the PayAI Bazaar and the MCP Registry.

## License

Code: MIT. Data served by the API keeps its original license (OpenStreetMap data is ODbL; attribution is included in every halal/mosque response).
