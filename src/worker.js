// CryptoPulse x402 API — Cloudflare Worker (zero dependencies). Live at https://cryptopulse.saascloud.ai
// Bindings: PAY_TO, NETWORK, FACILITATOR_URL (plain text), HALAL_DB (D1), ADMIN_KEY (secret). Cron: */3 * * * *
// License: MIT. Data served keeps its own license (OpenStreetMap: ODbL).

/**
 * CryptoPulse — x402 pay-per-call crypto data API (standalone Cloudflare Worker)
 *
 * Zero-dependency implementation of the x402 v2 seller flow:
 *   1. Unpaid request to /api/*  -> 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   2. Client retries with PAYMENT-SIGNATURE header (base64 JSON payload)
 *   3. Worker POSTs facilitator /verify, serves data, POSTs /settle,
 *      returns PAYMENT-RESPONSE header with the settlement receipt.
 *
 * Wire format cross-checked against @x402/core 2.18.0 (headers, verify/settle
 * bodies, requirement matching, USDC domain params per network).
 *
 * Env vars:
 *   PAY_TO           0x wallet receiving USDC (falls back to owner's address)
 *   NETWORK          "eip155:84532" Base Sepolia (default) | "eip155:8453" Base
 *   FACILITATOR_URL  override facilitator (default testnet: x402.org/facilitator)
 */

const OWNER_WALLET = "0x9331bf848992A61f184654c1c0E931c66398C409";
const TESTNET = "eip155:84532";
const MAINNET = "eip155:8453";
const TESTNET_FACILITATOR = "https://x402.org/facilitator";

const SERVICE_NAME = "CryptoPulse Data API";
const TAGS = ["crypto", "market-data", "prices", "defi", "sentiment"];

// USDC config per network (EIP-712 domain name/version used by paying clients)
const USDC = {
  [MAINNET]: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  [TESTNET]: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
};

// $ price string -> USDC atomic units (6 decimals)
const usd = (s) => String(Math.round(parseFloat(s.replace("$", "")) * 1e6));

// ---------------------------------------------------------------------------
// Bazaar discovery metadata (same wire shape @x402/extensions produces)
// ---------------------------------------------------------------------------
function bazaarExt(cfg) {
  const inputProps = {
    type: { type: "string", const: "http" },
    method: { type: "string", enum: ["GET"] },
  };
  if (cfg.inputSchema) inputProps.queryParams = { type: "object", ...cfg.inputSchema };
  const info = {
    input: { type: "http", method: "GET", ...(cfg.input ? { queryParams: cfg.input } : {}) },
  };
  if (cfg.output) info.output = { type: "json", ...cfg.output };
  return {
    bazaar: {
      info,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: { type: "object", properties: inputProps, required: ["type", "method"], additionalProperties: false },
          output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
        },
        required: ["input"],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Paid routes: price, description, discovery metadata, handler
// ---------------------------------------------------------------------------
const ROUTES = {
  "/api/price": {
    price: "$0.002",
    description: "Spot prices for one or more cryptocurrencies in any fiat/crypto quote currency. Comma-separated CoinGecko ids.",
    ext: bazaarExt({
      input: { ids: "bitcoin,ethereum", vs: "usd" },
      inputSchema: {
        properties: {
          ids: { type: "string", description: "Comma-separated CoinGecko coin ids, e.g. bitcoin,ethereum,solana" },
          vs: { type: "string", description: "Quote currency (default usd), e.g. usd, eur, btc" },
        },
        required: ["ids"],
      },
      output: { example: { bitcoin: { usd: 118423, usd_24h_change: 1.42 } } },
    }),
    handler: async (q) => fetchPrices(q.get("ids") || "bitcoin,ethereum", q.get("vs") || "usd"),
  },

  "/api/trending": {
    price: "$0.002",
    description: "Top trending cryptocurrencies right now (most-searched coins, with rank, price and 24h change).",
    ext: bazaarExt({
      output: { example: { trending: [{ id: "some-coin", symbol: "COIN", market_cap_rank: 42, price_usd: 1.23, change_24h_pct: 8.7 }] } },
    }),
    handler: async () => fetchTrending(),
  },

  "/api/fear-greed": {
    price: "$0.002",
    description: "Current Crypto Fear & Greed Index value and classification, plus previous day for trend.",
    ext: bazaarExt({
      output: { example: { value: 64, classification: "Greed", previous: { value: 58, classification: "Greed" } } },
    }),
    handler: async () => fetchFearGreed(),
  },

  "/api/gas": {
    price: "$0.002",
    description: "Live gas price (wei and gwei) for Base or Ethereum mainnet from public RPC.",
    ext: bazaarExt({
      input: { chain: "base" },
      inputSchema: { properties: { chain: { type: "string", description: "base (default) or ethereum" } } },
      output: { example: { chain: "base", gas_price_wei: "12345678", gas_price_gwei: 0.0123 } },
    }),
    handler: async (q) => fetchGas(q.get("chain") || "base"),
  },

  "/api/ohlc": {
    price: "$0.005",
    description: "OHLC candlestick data for any CoinGecko coin id (1, 7, 14, 30, 90, 180, 365 days).",
    ext: bazaarExt({
      input: { id: "bitcoin", days: "1", vs: "usd" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "CoinGecko coin id, e.g. bitcoin" },
          days: { type: "string", description: "1 | 7 | 14 | 30 | 90 | 180 | 365" },
          vs: { type: "string", description: "Quote currency (default usd)" },
        },
        required: ["id"],
      },
      output: { example: { ohlc: [[1720656000000, 118000, 118500, 117800, 118423]] } },
    }),
    handler: async (q) => fetchOhlc(q.get("id") || "bitcoin", q.get("days") || "1", q.get("vs") || "usd"),
  },

  "/api/token-pairs": {
    price: "$0.01",
    description: "DEX trading data for a token: pairs, price, liquidity, volume, 24h txns/change across DEXes. Search by symbol, name, or contract address.",
    ext: bazaarExt({
      input: { q: "WETH" },
      inputSchema: { properties: { q: { type: "string", description: "Token symbol, name, or contract address" } }, required: ["q"] },
      output: { example: { pairs: [{ chain: "base", dex: "uniswap", pair: "WETH/USDC", price_usd: "4210.55", liquidity_usd: 12345678 }] } },
    }),
    handler: async (q) => {
      const query = q.get("q");
      if (!query) return { __status: 400, error: "q query param required" };
      return fetchTokenPairs(query);
    },
  },

  "/api/token-risk": {
    price: "$0.02",
    description: "Token security / rug-pull risk check for any ERC-20 (honeypot, mintable, owner privileges, tax, LP holders). Essential pre-trade safety check for trading agents.",
    ext: bazaarExt({
      input: { chain: "base", address: "0x0000000000000000000000000000000000000000" },
      inputSchema: {
        properties: {
          chain: { type: "string", description: "base | ethereum | bsc | polygon | arbitrum (default base)" },
          address: { type: "string", description: "ERC-20 token contract address (0x...)" },
        },
        required: ["address"],
      },
      output: { example: { is_honeypot: "0", is_mintable: "0", buy_tax: "0", sell_tax: "0", holder_count: "15234" } },
    }),
    handler: async (q) => {
      const address = q.get("address");
      if (!address || !address.startsWith("0x")) return { __status: 400, error: "address query param (0x...) required" };
      return fetchTokenRisk(q.get("chain") || "base", address);
    },
  },

  "/api/yields": {
    price: "$0.02",
    description: "Top DeFi yield opportunities: highest-APY pools filtered by chain and minimum TVL, with project, symbol, APY breakdown and stablecoin flag. Data from DefiLlama.",
    ext: bazaarExt({
      input: { chain: "Base", min_tvl: "1000000", limit: "10" },
      inputSchema: {
        properties: {
          chain: { type: "string", description: "Chain name, e.g. Base, Ethereum, Solana, Arbitrum (default Base)" },
          min_tvl: { type: "string", description: "Minimum pool TVL in USD (default 1000000)" },
          limit: { type: "string", description: "Max pools to return (default 10, max 50)" },
          stable_only: { type: "string", description: "true = only stablecoin pools" },
        },
      },
      output: { example: { pools: [{ project: "aave-v3", chain: "Base", symbol: "USDC", tvl_usd: 250000000, apy: 5.42 }] } },
    }),
    handler: async (q) =>
      fetchYields({
        chain: q.get("chain") || "Base",
        minTvl: Number(q.get("min_tvl") || 1e6),
        limit: Number(q.get("limit") || 10),
        stableOnly: q.get("stable_only") === "true",
      }),
  },

  "/api/token-score": {
    price: "$0.05",
    description: "Composite 0-100 buy-safety score for any token: combines contract security analysis (honeypot, taxes, ownership risks) with live market depth (liquidity, volume, activity) into a single verdict: avoid | high-risk | caution | ok | strong. One call answers 'should my agent touch this token?'",
    ext: bazaarExt({
      input: { chain: "base", address: "0x0000000000000000000000000000000000000000" },
      inputSchema: {
        properties: {
          chain: { type: "string", description: "base | ethereum | bsc | polygon | arbitrum (default base)" },
          address: { type: "string", description: "Token contract address (0x...)" },
        },
        required: ["address"],
      },
      output: { example: { score: 72, verdict: "ok", components: { security: 45, market: 27 }, reasons: ["thin liquidity"] } },
    }),
    handler: async (q) => {
      const address = q.get("address");
      if (!address || !address.startsWith("0x")) return { __status: 400, error: "address query param (0x...) required" };
      return fetchTokenScore(q.get("chain") || "base", address);
    },
  },

  "/api/screener": {
    price: "$0.10",
    description: "Token screener: trending or newly-launched pools on a chain, filtered by minimum liquidity and 24h volume, with optional on-chain safety screening (drops honeypots and balance-modifiable tokens). Returns ranked opportunities with price, liquidity, volume, buys/sells and safety flags.",
    ext: bazaarExt({
      input: { network: "base", mode: "trending", min_liquidity: "50000", min_volume: "10000", limit: "10", safe_only: "true" },
      inputSchema: {
        properties: {
          network: { type: "string", description: "GeckoTerminal network id, e.g. base, eth, solana (default base)" },
          mode: { type: "string", description: "trending (default) or new" },
          min_liquidity: { type: "string", description: "Minimum pool liquidity USD (default 50000)" },
          min_volume: { type: "string", description: "Minimum 24h volume USD (default 10000)" },
          limit: { type: "string", description: "Max results (default 10, max 20)" },
          safe_only: { type: "string", description: "true = run security screen on Base tokens and drop dangerous ones" },
        },
      },
      output: { example: { network: "base", mode: "trending", count: 2, results: [{ pool: "TOKEN / WETH", liquidity_usd: 250000, volume_24h: 900000, safety: "ok" }] } },
    }),
    handler: async (q) =>
      fetchScreener({
        network: q.get("network") || "base",
        mode: q.get("mode") === "new" ? "new" : "trending",
        minLiquidity: Number(q.get("min_liquidity") || 50000),
        minVolume: Number(q.get("min_volume") || 10000),
        limit: Number(q.get("limit") || 10),
        safeOnly: q.get("safe_only") !== "false",
      }),
  },

  "/api/market-summary": {
    price: "$0.01",
    description: "One-call market brief: BTC/ETH/SOL prices with 24h change, Fear & Greed index, and top-5 trending coins. Ideal for agents that need a single snapshot.",
    ext: bazaarExt({
      output: { example: { prices: { bitcoin: { usd: 118423 } }, fear_greed: { value: 64, classification: "Greed" }, trending: [] } },
    }),
    handler: async () => {
      const [prices, fg, trending] = await Promise.all([
        fetchPrices("bitcoin,ethereum,solana", "usd"),
        fetchFearGreed(),
        fetchTrending(),
      ]);
      return {
        as_of: new Date().toISOString(),
        prices,
        fear_greed: { value: fg.value, classification: fg.classification },
        trending: (trending.trending || []).slice(0, 5).map((t) => ({ id: t.id, symbol: t.symbol, rank: t.market_cap_rank })),
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Upstream data (free public sources)
// ---------------------------------------------------------------------------
const CG = "https://api.coingecko.com/api/v3";
const UA = { "User-Agent": "cryptopulse-x402/1.0", Accept: "application/json" };

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

const fetchPrices = (ids, vs) =>
  getJSON(`${CG}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`);

async function fetchTrending() {
  const data = await getJSON(`${CG}/search/trending`);
  return {
    trending: (data.coins || []).map((c) => ({
      id: c.item?.id,
      symbol: c.item?.symbol,
      name: c.item?.name,
      market_cap_rank: c.item?.market_cap_rank,
      price_usd: c.item?.data?.price ?? null,
      change_24h_pct: c.item?.data?.price_change_percentage_24h?.usd ?? null,
    })),
  };
}

async function fetchFearGreed() {
  const data = await getJSON("https://api.alternative.me/fng/?limit=2");
  const [today, prev] = data.data || [];
  return {
    value: today ? Number(today.value) : null,
    classification: today?.value_classification ?? null,
    previous: prev ? { value: Number(prev.value), classification: prev.value_classification } : null,
    updated: today ? new Date(Number(today.timestamp) * 1000).toISOString() : null,
  };
}

const RPC = { base: "https://mainnet.base.org", ethereum: "https://eth.llamarpc.com" };

async function fetchGas(chain) {
  const rpc = RPC[chain] || RPC.base;
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
  });
  const j = await r.json();
  const wei = BigInt(j.result || "0x0");
  return { chain: RPC[chain] ? chain : "base", gas_price_wei: wei.toString(), gas_price_gwei: Number(wei) / 1e9 };
}

const fetchOhlc = async (id, days, vs) => ({
  id, vs, days,
  ohlc: await getJSON(`${CG}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=${encodeURIComponent(vs)}&days=${encodeURIComponent(days)}`),
});

async function fetchTokenPairs(q) {
  const data = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  return {
    pairs: (data.pairs || []).slice(0, 15).map((p) => ({
      chain: p.chainId,
      dex: p.dexId,
      pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      base_token: p.baseToken?.address,
      price_usd: p.priceUsd ?? null,
      liquidity_usd: p.liquidity?.usd ?? null,
      volume_24h: p.volume?.h24 ?? null,
      change_24h_pct: p.priceChange?.h24 ?? null,
      txns_24h: p.txns?.h24 ?? null,
      url: p.url,
    })),
  };
}

const GOPLUS_CHAINS = { base: "8453", ethereum: "1", bsc: "56", polygon: "137", arbitrum: "42161" };

async function fetchTokenRisk(chain, address) {
  const chainId = GOPLUS_CHAINS[chain] || GOPLUS_CHAINS.base;
  const data = await getJSON(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(address)}`);
  const r = data.result?.[address.toLowerCase()];
  if (!r) return { __status: 404, error: "token not found or not yet indexed" };
  const pick = (k) => r[k] ?? null;
  return {
    address,
    chain: GOPLUS_CHAINS[chain] ? chain : "base",
    is_honeypot: pick("is_honeypot"),
    is_mintable: pick("is_mintable"),
    is_open_source: pick("is_open_source"),
    is_proxy: pick("is_proxy"),
    can_take_back_ownership: pick("can_take_back_ownership"),
    owner_change_balance: pick("owner_change_balance"),
    hidden_owner: pick("hidden_owner"),
    selfdestruct: pick("selfdestruct"),
    buy_tax: pick("buy_tax"),
    sell_tax: pick("sell_tax"),
    cannot_sell_all: pick("cannot_sell_all"),
    holder_count: pick("holder_count"),
    lp_holder_count: pick("lp_holder_count"),
    token_name: pick("token_name"),
    token_symbol: pick("token_symbol"),
  };
}

async function fetchYields(opts) {
  const data = await getJSON("https://yields.llama.fi/pools");
  const chainLc = opts.chain.toLowerCase();
  const pools = (data.data || [])
    .filter((p) => p.chain?.toLowerCase() === chainLc && (p.tvlUsd ?? 0) >= opts.minTvl && (!opts.stableOnly || p.stablecoin === true) && p.apy != null)
    .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
    .slice(0, Math.min(opts.limit, 50))
    .map((p) => ({
      project: p.project, chain: p.chain, symbol: p.symbol, tvl_usd: p.tvlUsd,
      apy: p.apy, apy_base: p.apyBase, apy_reward: p.apyReward,
      stablecoin: p.stablecoin === true, il_risk: p.ilRisk, pool_id: p.pool,
    }));
  return { chain: opts.chain, count: pools.length, pools };
}

// ---------------------------------------------------------------------------
// x402 v2 protocol helpers (wire-compatible with @x402/core 2.18)
// ---------------------------------------------------------------------------
const b64encode = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
};

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

/** Same semantics as @x402/core paymentRequirementsMatchAccepted */
function requirementsMatch(required, accepted) {
  if (!accepted || typeof accepted !== "object") return false;
  const { extra: reqExtra, ...reqCore } = required;
  const { extra: accExtra, ...accCore } = accepted;
  if (!deepEqual(reqCore, accCore)) return false;
  if (reqExtra === undefined) return true;
  if (!accExtra || typeof accExtra !== "object") return false;
  return Object.entries(reqExtra).every(([k, v]) => deepEqual(v, accExtra[k]));
}

function buildRequirement(route, env) {
  const network = env.NETWORK === MAINNET ? MAINNET : TESTNET;
  const u = USDC[network];
  return {
    scheme: "exact",
    network,
    amount: usd(route.price),
    asset: u.asset,
    payTo: env.PAY_TO || OWNER_WALLET,
    maxTimeoutSeconds: 300,
    extra: { name: u.name, version: u.version },
  };
}

const SOLANA_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_FEEPAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const SOLANA_PAYTO = "BX8mCX2TkiYiYvU8s94QT4ebUY3E6C7t36bwYgjptCoN";

function buildRequirements(route, env) {
  const reqs = [buildRequirement(route, env)];
  if (env.NETWORK === MAINNET && SOLANA_PAYTO) {
    reqs.push({ scheme: "exact", network: SOLANA_NET, amount: usd(route.price), asset: SOLANA_USDC, payTo: SOLANA_PAYTO, maxTimeoutSeconds: 300, extra: { feePayer: SOLANA_FEEPAYER } });
  }
  return reqs;
}

function matchRequirement(route, env, accepted) {
  return buildRequirements(route, env).find((rq) => requirementsMatch(rq, accepted));
}

function paymentRequired402(req, route, requirement, errorMsg) {
  const paymentRequired = {
    x402Version: 2,
    error: errorMsg || "Payment required",
    resource: {
      url: req.url,
      description: route.description,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags: TAGS,
    },
    accepts: Array.isArray(requirement) ? requirement : [requirement],
    extensions: route.ext,
  };
  return new Response(JSON.stringify(v1Body(req, route, requirement, errorMsg)), {
    status: 402,
    headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": b64encode(paymentRequired) },
  });
}

async function facilitatorPost(env, path, paymentPayload, paymentRequirements) {
  const base = env.FACILITATOR_URL || (env.NETWORK === MAINNET ? null : TESTNET_FACILITATOR);
  if (!base) throw new Error("FACILITATOR_URL must be set for Base mainnet");
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "follow",
    body: JSON.stringify({ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!r.ok) throw new Error(`facilitator ${path} ${r.status}: ${text.slice(0, 300)}`);
  return data;
}


// ---------------------------------------------------------------------------
// Premium composite endpoints: token-score + screener (upstream helpers)
// ---------------------------------------------------------------------------
async function fetchTokenScore(chain, address) {
  const [riskRes, pairsRes] = await Promise.allSettled([
    fetchTokenRisk(chain, address),
    getJSON(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`),
  ]);
  const risk = riskRes.status === "fulfilled" ? riskRes.value : null;
  if (!risk || risk.__status) return { __status: 404, error: "token not found in security database - cannot score safely" };
  const pairs = pairsRes.status === "fulfilled" ? (pairsRes.value.pairs || []) : [];
  const chainPairs = pairs.filter((p) => !chain || p.chainId === chain);
  const best = chainPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  const liq = best?.liquidity?.usd || 0;
  const vol = best?.volume?.h24 || 0;
  const txns = best ? ((best.txns?.h24?.buys || 0) + (best.txns?.h24?.sells || 0)) : 0;

  const reasons = [];
  let riskScore = 50;
  const flag = (k) => risk[k] === "1";
  const num = (k) => parseFloat(risk[k] || "0");
  if (flag("is_honeypot")) { riskScore = 0; reasons.push("HONEYPOT: token cannot be sold"); }
  else {
    if (num("buy_tax") > 0.1 || num("sell_tax") > 0.1) { riskScore -= 15; reasons.push(`high tax (buy ${risk.buy_tax}, sell ${risk.sell_tax})`); }
    if (flag("is_mintable")) { riskScore -= 10; reasons.push("supply is mintable by owner"); }
    if (flag("hidden_owner") || flag("can_take_back_ownership")) { riskScore -= 15; reasons.push("hidden/reclaimable ownership"); }
    if (flag("owner_change_balance")) { riskScore -= 15; reasons.push("owner can modify balances"); }
    if (risk.is_open_source === "0") { riskScore -= 10; reasons.push("contract not open source"); }
    if (parseInt(risk.lp_holder_count || "0") < 3) { riskScore -= 5; reasons.push("very few LP holders"); }
    if (parseInt(risk.holder_count || "0") < 100) { riskScore -= 5; reasons.push("fewer than 100 holders"); }
    riskScore = Math.max(0, riskScore);
  }
  let marketScore = 0;
  if (liq > 1e6) marketScore += 20; else if (liq > 1e5) marketScore += 15; else if (liq > 1e4) marketScore += 8; else { marketScore += 2; reasons.push("thin liquidity"); }
  if (vol > 1e6) marketScore += 15; else if (vol > 1e5) marketScore += 10; else if (vol > 1e4) marketScore += 5;
  if (txns > 500) marketScore += 5;
  if (!best) reasons.push("no active DEX pair found");

  const score = flag("is_honeypot") ? 0 : Math.min(100, riskScore + marketScore);
  const verdict = flag("is_honeypot") ? "avoid" : score < 35 ? "high-risk" : score < 55 ? "caution" : score < 75 ? "ok" : "strong";
  return {
    address, chain: chain || "base",
    token: { name: risk.token_name, symbol: risk.token_symbol },
    score, verdict,
    components: { security: riskScore, market: marketScore },
    market: best ? { dex: best.dexId, pair: `${best.baseToken?.symbol}/${best.quoteToken?.symbol}`, price_usd: best.priceUsd, liquidity_usd: liq, volume_24h: vol, txns_24h: txns, change_24h_pct: best.priceChange?.h24 ?? null } : null,
    security_flags: risk,
    reasons,
  };
}

async function fetchScreener(opts) {
  const feed = opts.mode === "new" ? "new_pools" : "trending_pools";
  const data = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(opts.network)}/${feed}?page=1`);
  let pools = (data.data || []).map((p) => {
    const a = p.attributes || {};
    const tokenId = p.relationships?.base_token?.data?.id || "";
    return {
      pool: a.name,
      token_address: tokenId.includes("_") ? tokenId.split("_").slice(1).join("_") : null,
      price_usd: a.base_token_price_usd ? Number(a.base_token_price_usd) : null,
      liquidity_usd: a.reserve_in_usd ? Number(a.reserve_in_usd) : 0,
      volume_24h: a.volume_usd?.h24 ? Number(a.volume_usd.h24) : 0,
      change_24h_pct: a.price_change_percentage?.h24 ? Number(a.price_change_percentage.h24) : null,
      buys_24h: a.transactions?.h24?.buys ?? null,
      sells_24h: a.transactions?.h24?.sells ?? null,
      pool_created_at: a.pool_created_at || null,
    };
  });
  pools = pools.filter((p) => p.liquidity_usd >= opts.minLiquidity && p.volume_24h >= opts.minVolume);
  pools = pools.slice(0, Math.min(opts.limit, 20));
  if (opts.safeOnly && opts.network === "base") {
    const checked = [];
    for (const p of pools.slice(0, 10)) {
      if (!p.token_address) continue;
      try {
        const r = await fetchTokenRisk("base", p.token_address);
        if (r.__status) { p.safety = "unknown"; checked.push(p); continue; }
        if (r.is_honeypot === "1" || r.owner_change_balance === "1") continue;
        p.safety = (r.is_mintable === "1" || parseFloat(r.sell_tax || "0") > 0.1) ? "caution" : "ok";
        p.safety_flags = { honeypot: r.is_honeypot, mintable: r.is_mintable, sell_tax: r.sell_tax, holders: r.holder_count };
        checked.push(p);
      } catch { p.safety = "unknown"; checked.push(p); }
    }
    pools = checked;
  }
  return { network: opts.network, mode: opts.mode, count: pools.length, filters: { min_liquidity: opts.minLiquidity, min_volume: opts.minVolume, safe_only: opts.safeOnly }, results: pools };
}

// ---------------------------------------------------------------------------
// x402 v1 compatibility (X-PAYMENT header clients; requirements in 402 body)
// ---------------------------------------------------------------------------
const V1_NETWORKS = { "eip155:8453": "base", "eip155:84532": "base-sepolia" };

function v1Requirement(req, route, requirement) {
  return {
    scheme: "exact",
    network: V1_NETWORKS[requirement.network] || "base",
    maxAmountRequired: requirement.amount,
    resource: req.url,
    description: route.description,
    mimeType: "application/json",
    outputSchema: (route.ext && route.ext.bazaar && route.ext.bazaar.info) || {},
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    asset: requirement.asset,
    extra: requirement.extra,
  };
}

function v1Body(req, route, requirement, errorMsg) {
  return { x402Version: 1, error: errorMsg || "X-PAYMENT header is required", accepts: [v1Requirement(req, route, requirement)] };
}

async function handleV1(req, env, route, requirement, urlObj, xPayment) {
  let p;
  try { p = b64decode(xPayment); } catch { return json(v1Body(req, route, requirement, "Invalid X-PAYMENT header"), 402); }
  const v1req = v1Requirement(req, route, requirement);
  if (p.x402Version !== 1 || p.scheme !== "exact" || p.network !== v1req.network) {
    return json(v1Body(req, route, requirement, "No matching payment requirements"), 402);
  }
  const verify = await facilitatorPost(env, "/verify", p, v1req);
  if (!verify.isValid) return json(v1Body(req, route, requirement, verify.invalidReason || "Payment verification failed"), 402);
  const data = await route.handler(urlObj.searchParams);
  if (data && data.__status) { const { __status, ...body } = data; return json(body, __status); }
  const settle = await facilitatorPost(env, "/settle", p, v1req);
  if (!settle.success) return json(v1Body(req, route, requirement, settle.errorReason || "Settlement failed"), 402);
  await logSale(env, route, settle, "rest-v1");
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-PAYMENT-RESPONSE": b64encode(settle), "PAYMENT-RESPONSE": b64encode(settle) },
  });
}

// ---------------------------------------------------------------------------
// MCP server (Streamable HTTP, JSON-RPC 2.0) at /mcp
// Free: initialize, tools/list. Paid tool calls use the same x402 flow:
// unpaid -> HTTP 402 + PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE.
// ---------------------------------------------------------------------------
function mcpToolName(path) { return path.replace("/api/", "").replace(/\//g, "_").replace(/-/g, "_"); }

function mcpTools() {
  return Object.entries(ROUTES).map(([path, r]) => {
    const qp = r.ext?.bazaar?.info?.input?.queryParams;
    const schema = r.ext?.bazaar?.schema?.properties?.input?.properties?.queryParams || { type: "object", properties: {} };
    return {
      name: mcpToolName(path),
      description: `[${r.price} USDC per call via x402] ${r.description}`,
      inputSchema: { type: "object", properties: schema.properties || {}, ...(schema.required ? { required: schema.required } : {}) },
      _path: path,
    };
  });
}

async function handleMcp(req, env) {
  if (req.method === "GET") {
    return json({ name: "cryptopulse-mcp", version: "1.0.0", transport: "streamable-http", instructions: "POST JSON-RPC 2.0. Paid tools return HTTP 402 with x402 PAYMENT-REQUIRED header; retry the same POST with a PAYMENT-SIGNATURE header." });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let rpc;
  try { rpc = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const reply = (result) => json({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  const rpcErr = (code, message) => json({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });

  if (rpc.method === "initialize") {
    return reply({ protocolVersion: rpc.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cryptopulse", version: "1.0.0" }, instructions: "CryptoPulse crypto market intelligence. Every tool is pay-per-call in USDC on Base via the x402 protocol: an unpaid tools/call returns HTTP 402 with a PAYMENT-REQUIRED header; retry the identical POST with a PAYMENT-SIGNATURE header. Prices are in each tool description." });
  }
  if (rpc.method === "notifications/initialized" || (rpc.method || "").startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (rpc.method === "tools/list") {
    return reply({ tools: mcpTools().map(({ _path, ...t }) => t) });
  }
  if (rpc.method === "tools/call") {
    const tool = mcpTools().find((t) => t.name === rpc.params?.name);
    if (!tool) return rpcErr(-32602, "unknown tool: " + (rpc.params?.name || ""));
    const route = ROUTES[tool._path];
    const args = rpc.params?.arguments || {};
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, String(v));
    const requirement = buildRequirement(route, env);
    const synthReq = new Request(new URL(tool._path + (qs.toString() ? "?" + qs.toString() : ""), req.url).toString(), { headers: req.headers });
    const sigHeader = req.headers.get("PAYMENT-SIGNATURE");
    if (!sigHeader) return paymentRequired402(synthReq, route, requirement);
    let payload;
    try { payload = b64decode(sigHeader); } catch { return paymentRequired402(synthReq, route, requirement, "Invalid payment signature header"); }
    if (payload.x402Version !== 2 || !requirementsMatch(requirement, payload.accepted)) {
      return paymentRequired402(synthReq, route, requirement, "No matching payment requirements");
    }
    const verify = await facilitatorPost(env, "/verify", payload, requirement);
    if (!verify.isValid) return paymentRequired402(synthReq, route, requirement, verify.invalidReason || "Payment verification failed");
    const data = await route.handler(qs);
    if (data && data.__status) { const { __status, ...body } = data; return reply({ content: [{ type: "text", text: JSON.stringify(body) }], isError: true }); }
    const settle = await facilitatorPost(env, "/settle", payload, requirement);
    if (!settle.success) return paymentRequired402(synthReq, route, requirement, settle.errorReason || "Settlement failed");
    await logSale(env, route, settle, "mcp");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(data) }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": b64encode(settle) },
    });
  }
  return rpcErr(-32601, "method not found: " + rpc.method);
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Read-only Solana earnings proxy (server-side; browsers can't hit Solana RPC)
// GET /solana-earnings -> { wallet, balance, count, total, payments[] }
// ---------------------------------------------------------------------------
async function handleSolanaEarnings() {
  const owner = SOLANA_PAYTO;
  const mint = SOLANA_USDC;
  const RPCS = ["https://solana-rpc.publicnode.com", "https://solana.drpc.org", "https://endpoints.omniatech.io/v1/sol/mainnet/public"];
  async function rpc(method, params) {
    let lastErr = "no rpc";
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(4000) });
        if (!r.ok) { lastErr = "http " + r.status; continue; }
        const j = await r.json();
        if (j.error) { lastErr = j.error.message || "rpc error"; continue; }
        return j.result;
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    throw new Error(lastErr);
  }
  try {
    const accts = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
    const acct = accts && accts.value && accts.value[0];
    const balance = acct ? (acct.account.data.parsed.info.tokenAmount.uiAmount || 0) : 0;
    const ata = acct ? acct.pubkey : null;
    const payments = [];
    if (ata) {
      const sigs = await rpc("getSignaturesForAddress", [ata, { limit: 25 }]);
      for (const s of sigs || []) {
        try {
          const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
          if (!tx || !tx.meta) continue;
          const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
          const idx = keys.indexOf(ata);
          const pre = (tx.meta.preTokenBalances || []).find((b) => b.accountIndex === idx);
          const post = (tx.meta.postTokenBalances || []).find((b) => b.accountIndex === idx);
          const delta = (post ? Number(post.uiTokenAmount.uiAmount || 0) : 0) - (pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0);
          if (delta > 0) payments.push({ when: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, usdc: delta, sig: s.signature });
        } catch {}
      }
    }
    const total = payments.reduce((a, p) => a + p.usdc, 0);
    return { wallet: owner, balance, count: payments.length, total, payments };
  } catch (e) {
    return { wallet: owner, balance: 0, count: 0, total: 0, payments: [], error: String((e && e.message) || e) };
  }
}

// ===== CryptoPulse: Halal places module (OpenStreetMap, ODbL) =====
// Data lives in D1 binding HALAL_DB, table places (clustered by 1x1 degree cell).
// Harvested from OpenStreetMap (QLever SPARQL) by cron + /admin/halal/harvest (ADMIN_KEY protected).

const HALAL_ATTRIB = "Data © OpenStreetMap contributors (ODbL). Served by CryptoPulse x402.";
// Source: QLever SPARQL endpoint over the OSM planet (osm2rdf), paged by OFFSET.
const QLEVER = "https://qlever.cs.uni-freiburg.de/api/osm-planet";
const QL_PAGE = 500;
const QL_REFRESH_DAYS = 30;
function qleverQuery(limit, offset) {
  return `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?osm ?name ?c ?amenity ?shop ?cuisine ?dh ?h ?street ?hn ?city ?pc ?phone ?web ?hours WHERE {
  { ?osm osmkey:diet:halal ?dh . FILTER(?dh = "yes" || ?dh = "only") } UNION { ?osm osmkey:halal ?h . FILTER(?h = "yes" || ?h = "only") } UNION { ?osm osmkey:cuisine ?cu . FILTER(CONTAINS(?cu, "halal")) }
  ?osm osmkey:name ?name .
  ?osm geo:hasGeometry/geo:asWKT ?wkt . BIND(geof:centroid(?wkt) AS ?c)
  OPTIONAL { ?osm osmkey:amenity ?amenity } OPTIONAL { ?osm osmkey:shop ?shop } OPTIONAL { ?osm osmkey:cuisine ?cuisine }
  OPTIONAL { ?osm osmkey:addr:street ?street } OPTIONAL { ?osm osmkey:addr:housenumber ?hn } OPTIONAL { ?osm osmkey:addr:city ?city } OPTIONAL { ?osm osmkey:addr:postcode ?pc }
  OPTIONAL { ?osm osmkey:phone ?phone } OPTIONAL { ?osm osmkey:website ?web } OPTIONAL { ?osm osmkey:opening_hours ?hours }
} ORDER BY ?osm LIMIT ${limit} OFFSET ${offset}`;
}

function cellId(lat, lon) { return (Math.floor(lat) + 90) * 360 + (Math.floor(lon) + 180); }
const HALAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS places (cell INTEGER NOT NULL, id TEXT NOT NULL, name TEXT, lat REAL, lon REAL, type TEXT, cuisine TEXT, halal TEXT, address TEXT, city TEXT, postcode TEXT, phone TEXT, website TEXT, hours TEXT, PRIMARY KEY (cell, id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS geo (q TEXT PRIMARY KEY, lat REAL, lon REAL, display TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS sales (ts TEXT, path TEXT, category TEXT, usd REAL, network TEXT, payer TEXT, tx TEXT, source TEXT)`,
];
async function ensureSchema(env) { if (env.__halalSchema) return; await env.HALAL_DB.batch(HALAL_SCHEMA.map((s) => env.HALAL_DB.prepare(s))); env.__halalSchema = true; }
async function metaGet(env, k, dflt) { const r = await env.HALAL_DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first(); return r ? JSON.parse(r.v) : dflt; }
async function metaSet(env, k, v) { await env.HALAL_DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run(); }
const PLACE_COLS = ["cell","id","name","lat","lon","type","cuisine","halal","address","city","postcode","phone","website","hours"];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function rowToPlace(b) {
  const v = (k) => (b[k] ? b[k].value : null);
  const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(v("c") || "");
  const idm = /openstreetmap\.org\/(node|way|relation)\/(\d+)/.exec(v("osm") || "");
  if (!m || !idm || !v("name")) return null;
  const lon = +m[1], lat = +m[2];
  const cuisine = v("cuisine");
  const addr = [v("hn"), v("street")].filter(Boolean).join(" ");
  return {
    id: idm[1][0] + idm[2],
    name: v("name"),
    lat: +lat.toFixed(6), lon: +lon.toFixed(6),
    type: v("amenity") || v("shop") || "place",
    cuisine,
    halal: v("dh") || v("h") || (cuisine && /halal/.test(cuisine) ? "yes" : null),
    address: addr || null, city: v("city"), postcode: v("pc"),
    phone: v("phone"), website: v("web"), hours: v("hours"),
  };
}

async function harvestPage(env, offset) {
  const left = env.__deadline ? env.__deadline - Date.now() : 60000;
  if (left < 15000) throw new Error("deadline");
  const r = await fetch(QLEVER + "?query=" + encodeURIComponent(qleverQuery(QL_PAGE, offset)), {
    headers: { accept: "application/sparql-results+json", "user-agent": "CryptoPulse-x402/1.0 (halal endpoint)" },
    signal: AbortSignal.timeout(Math.min(60000, left - 5000)),
  });
  if (!r.ok) throw new Error("qlever " + r.status);
  const j = await r.json();
  if (j.exception) throw new Error("qlever: " + String(j.exception).slice(0, 80));
  const rows = [];
  for (const b of j.results?.bindings || []) { const p = rowToPlace(b); if (p) rows.push(p); }
  const sql = `INSERT INTO places (${PLACE_COLS.join(",")}) VALUES (${PLACE_COLS.map(() => "?").join(",")}) ON CONFLICT(cell,id) DO UPDATE SET name=excluded.name,lat=excluded.lat,lon=excluded.lon,type=excluded.type,cuisine=excluded.cuisine,halal=excluded.halal,address=excluded.address,city=excluded.city,postcode=excluded.postcode,phone=excluded.phone,website=excluded.website,hours=excluded.hours`;
  for (let i = 0; i < rows.length; i += 50) {
    const stmts = rows.slice(i, i + 50).map((p) => env.HALAL_DB.prepare(sql).bind(cellId(p.lat, p.lon), p.id, p.name, p.lat, p.lon, p.type, p.cuisine, p.halal, p.address, p.city, p.postcode, p.phone, p.website, p.hours));
    await env.HALAL_DB.batch(stmts);
  }
  return { fetched: (j.results?.bindings || []).length, stored: rows.length };
}

async function runHarvest(env, steps, budgetMs, reset) {
  await ensureSchema(env);
  const meta = await metaGet(env, "harvest", { offset: 0, places: 0, done: false, errors: [], pass: 0 });
  const stale = meta.done && meta.finishedAt && Date.now() - Date.parse(meta.finishedAt) > QL_REFRESH_DAYS * 86400000;
  if (reset || stale) { meta.offset = 0; meta.places = 0; meta.done = false; meta.errors = []; meta.pass = (meta.pass || 0) + 1; }
  const started = Date.now();
  env.__deadline = started + budgetMs;
  let done = 0, deadline = false;
  const dayKey = new Date().toISOString().slice(0, 10); if (meta.dayKey !== dayKey) { meta.dayKey = dayKey; meta.dayRows = 0; }
  while (!meta.done && done < steps && Date.now() - started < budgetMs - 15000 && (meta.dayRows || 0) < 40000) {
    try {
      const { fetched, stored } = await harvestPage(env, meta.offset);
      meta.places += stored; meta.offset += QL_PAGE; done += 1; meta.dayRows = (meta.dayRows || 0) + stored;
      if (fetched < QL_PAGE) { meta.done = true; meta.finishedAt = new Date().toISOString(); }
    } catch (e) {
      if (/deadline/.test(String(e))) { deadline = true; break; }
      meta.errors.push({ offset: meta.offset, err: String(e).slice(0, 100), at: new Date().toISOString() }); meta.errors = meta.errors.slice(-20);
      break; // retry same page next run
    }
  }
  meta.lastRun = { ms: Date.now() - started, pages: done, deadline, at: new Date().toISOString() };
  meta.updatedAt = new Date().toISOString();
  await metaSet(env, "harvest", meta);
  return { ...meta };
}

async function handleHarvest(req, env) {
  const u = new URL(req.url);
  if (!env.ADMIN_KEY || u.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
  const steps = Math.min(+(u.searchParams.get("steps") || 3), 10);
  return json(await runHarvest(env, steps, 100000, u.searchParams.get("reset") === "1"));
}

// ---- Serving ----
async function placesNear(env, lat, lon, radiusKm, limit, cuisine, type) {
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  const cells = [];
  for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++)
    for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) cells.push(cellId(la, lo));
  const sel = cells.slice(0, 9);
  const { results } = await env.HALAL_DB.prepare(`SELECT * FROM places WHERE cell IN (${sel.map(() => "?").join(",")})`).bind(...sel).all();
  const out = [];
  for (const p of results || []) {
    if (cuisine && !(p.cuisine || "").toLowerCase().includes(cuisine)) continue;
    if (type && p.type !== type) continue;
    const km = haversineKm(lat, lon, p.lat, p.lon);
    if (km <= radiusKm) { const { cell, ...rest } = p; out.push({ ...rest, distance_km: +km.toFixed(2) }); }
  }
  out.sort((a, b) => a.distance_km - b.distance_km);
  return out.slice(0, limit);
}

async function geocodeCity(env, name) {
  const key = name.toLowerCase().trim();
  const cached = await env.HALAL_DB.prepare("SELECT lat,lon,display FROM geo WHERE q=?").bind(key).first();
  if (cached) return { lat: cached.lat, lon: cached.lon, display_name: cached.display };
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(name), {
    headers: { "user-agent": "CryptoPulse-x402/1.0 (halal endpoint; contact via cryptopulse.saascloud.ai)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j[0]) return null;
  const g = { lat: +j[0].lat, lon: +j[0].lon, display_name: j[0].display_name };
  try { await env.HALAL_DB.prepare("INSERT OR REPLACE INTO geo (q,lat,lon,display) VALUES (?,?,?,?)").bind(key, g.lat, g.lon, g.display_name).run(); } catch (e) { /* write quota exhausted: serve uncached */ }
  return g;
}

async function fetchHalalNear(q, env) {
  const lat = +q.get("lat"), lon = +q.get("lng") || +q.get("lon");
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("lat and lng are required");
  const radius = Math.min(Math.max(+(q.get("radius_km") || 5), 0.2), 30);
  const limit = Math.min(Math.max(+(q.get("limit") || 20), 1), 50);
  const cuisine = (q.get("cuisine") || "").toLowerCase() || null;
  const type = q.get("type") || null;
  const results = await placesNear(env, lat, lon, radius, limit, cuisine, type);
  return { query: { lat, lng: lon, radius_km: radius, cuisine, type }, count: results.length, results, attribution: HALAL_ATTRIB };
}

async function fetchHalalCity(q, env) {
  const city = q.get("city");
  if (!city) throw new Error("city is required (e.g. city=Houston, TX)");
  const g = await geocodeCity(env, city);
  if (!g) throw new Error("city not found");
  const radius = Math.min(Math.max(+(q.get("radius_km") || 15), 1), 30);
  const limit = Math.min(Math.max(+(q.get("limit") || 30), 1), 50);
  const cuisine = (q.get("cuisine") || "").toLowerCase() || null;
  const results = await placesNear(env, g.lat, g.lon, radius, limit, cuisine, null);
  return { query: { city, resolved: g.display_name, lat: g.lat, lng: g.lon, radius_km: radius, cuisine }, count: results.length, results, attribution: HALAL_ATTRIB };
}

async function fetchHalalPlace(q, env) {
  const id = q.get("id");
  const lat = +q.get("lat"), lon = +q.get("lng") || +q.get("lon");
  if (!id || !isFinite(lat) || !isFinite(lon)) throw new Error("id, lat and lng are required (as returned by /api/halal/near)");
  const row = await env.HALAL_DB.prepare("SELECT * FROM places WHERE cell=? AND id=?").bind(cellId(lat, lon), id).first();
  if (!row) throw new Error("place not found");
  const { cell, ...p } = row;
  return { place: { ...p, osm_url: `https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[p.id[0]]}/${p.id.slice(1)}` }, attribution: HALAL_ATTRIB };
}

async function halalStats(env) {
  await ensureSchema(env);
  const meta = await metaGet(env, "harvest", {});
  const c = await env.HALAL_DB.prepare("SELECT COUNT(*) AS n FROM places").first().catch(() => ({ n: 0 }));
  return { places_indexed: c?.n || 0, rows_loaded: meta.places || 0, offset: meta.offset || 0, complete: !!meta.done, finishedAt: meta.finishedAt || null, updatedAt: meta.updatedAt || null, lastRun: meta.lastRun || null, recentErrors: (meta.errors || []).slice(-3).map((x) => x.err), source: "OpenStreetMap via QLever (osm2rdf)" };
}

let HALAL_ENV = null;
const halalSafe = (fn) => async (q) => { try { return await fn(q, HALAL_ENV); } catch (e) { return { __status: /not found/.test(e.message) ? 404 : 400, error: e.message }; } };
const HALAL_PLACE_EXAMPLE = { id: "n123", name: "Haandi", lat: 40.7424, lon: -73.9824, type: "restaurant", cuisine: "indian", halal: "yes", address: "257 Lexington Avenue", city: "New York", phone: "+1 212 555 0100", website: null, hours: "Mo-Su 11:00-23:00", distance_km: 1.2 };
const HALAL_ROUTES = {
  "/api/halal/near": {
    price: "$0.005",
    description: "Halal restaurants, grocers, butchers and caterers near a lat/lng (radius up to 30 km), sorted by distance, with cuisine and type filters. OpenStreetMap data (ODbL).",
    ext: bazaarExt({
      input: { lat: "40.7128", lng: "-74.0060", radius_km: "5", limit: "20" },
      inputSchema: {
        properties: {
          lat: { type: "string", description: "Latitude, e.g. 40.7128" },
          lng: { type: "string", description: "Longitude, e.g. -74.0060" },
          radius_km: { type: "string", description: "Search radius in km, 0.2-30 (default 5)" },
          limit: { type: "string", description: "Max results, 1-50 (default 20)" },
          cuisine: { type: "string", description: "Filter by cuisine substring, e.g. indian, turkish, pakistani" },
          type: { type: "string", description: "Filter by place type: restaurant, fast_food, cafe, butcher, supermarket, convenience" },
        },
        required: ["lat", "lng"],
      },
      output: { example: { count: 1, results: [HALAL_PLACE_EXAMPLE], attribution: HALAL_ATTRIB } },
    }),
    handler: halalSafe(fetchHalalNear),
  },
  "/api/halal/city": {
    price: "$0.01",
    description: "Halal places in a named city (geocoded), e.g. city=Houston, TX. Up to 50 results sorted by distance from the city centre, optional cuisine filter. OpenStreetMap data (ODbL).",
    ext: bazaarExt({
      input: { city: "Houston, TX", limit: "30" },
      inputSchema: {
        properties: {
          city: { type: "string", description: "City name, optionally with region/country, e.g. 'Houston, TX' or 'Birmingham, UK'" },
          radius_km: { type: "string", description: "Radius from city centre in km, 1-30 (default 15)" },
          limit: { type: "string", description: "Max results, 1-50 (default 30)" },
          cuisine: { type: "string", description: "Filter by cuisine substring" },
        },
        required: ["city"],
      },
      output: { example: { count: 1, query: { city: "Houston, TX", lat: 29.76, lng: -95.37 }, results: [HALAL_PLACE_EXAMPLE], attribution: HALAL_ATTRIB } },
    }),
    handler: halalSafe(fetchHalalCity),
  },
  "/api/halal/place": {
    price: "$0.002",
    description: "Full record for one halal place by id (as returned by /api/halal/near): phone, website, opening hours, address and OpenStreetMap link.",
    ext: bazaarExt({
      input: { id: "n123", lat: "40.7424", lng: "-73.9824" },
      inputSchema: {
        properties: {
          id: { type: "string", description: "Place id from /api/halal/near, e.g. n123 or w456" },
          lat: { type: "string", description: "Latitude of the place (from the search result)" },
          lng: { type: "string", description: "Longitude of the place (from the search result)" },
        },
        required: ["id", "lat", "lng"],
      },
      output: { example: { place: { ...HALAL_PLACE_EXAMPLE, osm_url: "https://www.openstreetmap.org/node/123" }, attribution: HALAL_ATTRIB } },
    }),
    handler: halalSafe(fetchHalalPlace),
  },
};
Object.assign(ROUTES, HALAL_ROUTES);

// ---- Sales log (per-endpoint attribution for the dashboard) ----
async function logSale(env, route, settle, source) {
  try {
    await ensureSchema(env);
    const path = Object.keys(ROUTES).find((k) => ROUTES[k] === route) || "?";
    const usd = parseFloat(String(route.price).replace("$", "")) || 0;
    await env.HALAL_DB.prepare("INSERT INTO sales (ts,path,category,usd,network,payer,tx,source) VALUES (?,?,?,?,?,?,?,?)")
      .bind(new Date().toISOString(), path, routeCategory(path), usd, settle?.network || null, settle?.payer || null, settle?.transaction || null, source).run();
  } catch (e) { /* never block a paid response on logging */ }
}
async function salesStats(env) {
  await ensureSchema(env);
  const byCat = (await env.HALAL_DB.prepare("SELECT category, COUNT(*) AS n, SUM(usd) AS usd FROM sales GROUP BY category").all()).results || [];
  const byPath = (await env.HALAL_DB.prepare("SELECT path, category, COUNT(*) AS n, SUM(usd) AS usd, MAX(ts) AS last FROM sales GROUP BY path ORDER BY usd DESC").all()).results || [];
  const bySource = (await env.HALAL_DB.prepare("SELECT source, COUNT(*) AS n, SUM(usd) AS usd FROM sales GROUP BY source").all()).results || [];
  const first = await env.HALAL_DB.prepare("SELECT MIN(ts) AS ts FROM sales").first();
  return { since: first?.ts || null, by_category: byCat, by_endpoint: byPath, by_source: bySource, halal_index: await halalStats(env), mosque_index: await mosqueStats(env) };
}


// ===== CryptoPulse extension 2: prayer times, qibla, mosques, trip composite, more crypto, FX, discovery =====
// Appended after the halal module (uses HALAL_DB, cellId, haversineKm, geocodeCity, placesNear, bazaarExt, ROUTES, json).

// ---------- Prayer times (astronomical, PrayTimes-compatible formulas) ----------
const PRAYER_METHODS = {
  MWL: { name: "Muslim World League", fajr: 18, isha: 17 },
  ISNA: { name: "Islamic Society of North America", fajr: 15, isha: 15 },
  Egypt: { name: "Egyptian General Authority of Survey", fajr: 19.5, isha: 17.5 },
  Makkah: { name: "Umm al-Qura, Makkah", fajr: 18.5, ishaMinutes: 90 },
  Karachi: { name: "University of Islamic Sciences, Karachi", fajr: 18, isha: 18 },
  Tehran: { name: "Institute of Geophysics, University of Tehran", fajr: 17.7, isha: 14, maghrib: 4.5 },
  Jafari: { name: "Shia Ithna-Ashari, Leva Institute, Qum", fajr: 16, isha: 14, maghrib: 4 },
  Turkey: { name: "Diyanet İşleri Başkanlığı, Turkey", fajr: 18, isha: 17 },
  Singapore: { name: "Majlis Ugama Islam Singapura", fajr: 20, isha: 18 },
  France: { name: "Union des Organisations Islamiques de France", fajr: 12, isha: 12 },
  Russia: { name: "Spiritual Administration of Muslims of Russia", fajr: 16, isha: 15 },
  Dubai: { name: "Dubai (UAE)", fajr: 18.2, isha: 18.2 },
  Kuwait: { name: "Kuwait", fajr: 18, isha: 17.5 },
  Qatar: { name: "Qatar", fajr: 18, ishaMinutes: 90 },
  Kemenag: { name: "Kementerian Agama Republik Indonesia", fajr: 20, isha: 18 },
  JAKIM: { name: "Jabatan Kemajuan Islam Malaysia", fajr: 20, isha: 18 },
  Moonsighting: { name: "Moonsighting Committee Worldwide (approx.)", fajr: 18, isha: 18 },
};
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const dsin = (d) => Math.sin(d * D2R), dcos = (d) => Math.cos(d * D2R), dtan = (d) => Math.tan(d * D2R);
const darcsin = (x) => Math.asin(x) * R2D, darccos = (x) => Math.acos(x) * R2D, darctan2 = (y, x) => Math.atan2(y, x) * R2D, darccot = (x) => Math.atan(1 / x) * R2D;
const fixAngle = (a) => ((a % 360) + 360) % 360, fixHour = (h) => ((h % 24) + 24) % 24;

function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fixAngle(357.529 + 0.98560028 * D), q = fixAngle(280.459 + 0.98564736 * D);
  const L = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g));
  const e = 23.439 - 0.00000036 * D;
  const RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15;
  return { declination: darcsin(dsin(e) * dsin(L)), equation: q / 15 - fixHour(RA) };
}
function computePrayerTimes({ lat, lon, year, month, day, method = "MWL", asr = "Standard", elevation = 0 }) {
  const M = PRAYER_METHODS[method] || PRAYER_METHODS.MWL;
  const jDate = julianDay(year, month, day) - lon / (15 * 24);
  const midDay = (t) => fixHour(12 - sunPosition(jDate + t).equation);
  const sunAngleTime = (angle, t, ccw) => {
    const decl = sunPosition(jDate + t).declination;
    const x = (-dsin(angle) - dsin(decl) * dsin(lat)) / (dcos(decl) * dcos(lat));
    if (x < -1 || x > 1) return NaN;
    const tt = darccos(x) / 15;
    return midDay(t) + (ccw ? -tt : tt);
  };
  const asrTime = (factor, t) => { const decl = sunPosition(jDate + t).declination; return sunAngleTime(-darccot(factor + dtan(Math.abs(lat - decl))), t, false); };
  const riseSet = 0.833 + 0.0347 * Math.sqrt(Math.max(0, elevation));
  let t = { fajr: 5 / 24, sunrise: 6 / 24, dhuhr: 12 / 24, asr: 13 / 24, sunset: 18 / 24, maghrib: 18 / 24, isha: 18 / 24 };
  let out = {};
  for (let i = 0; i < 2; i++) {
    out = {
      fajr: sunAngleTime(M.fajr, t.fajr, true),
      sunrise: sunAngleTime(riseSet, t.sunrise, true),
      dhuhr: midDay(t.dhuhr),
      asr: asrTime(asr === "Hanafi" ? 2 : 1, t.asr),
      sunset: sunAngleTime(riseSet, t.sunset, false),
    };
    out.maghrib = M.maghrib ? sunAngleTime(M.maghrib, t.maghrib, false) : out.sunset;
    out.isha = M.ishaMinutes ? out.maghrib + M.ishaMinutes / 60 : sunAngleTime(M.isha, t.isha, false);
    t = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, (isNaN(v) ? 12 : v) / 24]));
  }
  // high-latitude adjustment (AngleBased, as used by most apps): when the sun never reaches the
  // Fajr/Isha depression angle, take a share of the night proportional to the angle.
  let highLat = false;
  if (isFinite(out.sunrise) && isFinite(out.sunset)) {
    const night = fixHour(out.sunrise - out.sunset) || 24 - (out.sunset - out.sunrise);
    const portion = (angle) => (angle / 60) * night;
    const fajrDiff = fixHour(out.sunrise - out.fajr);
    if (isNaN(out.fajr) || fajrDiff > portion(M.fajr)) { out.fajr = out.sunrise - portion(M.fajr); highLat = true; }
    if (!M.ishaMinutes) { const ishaDiff = fixHour(out.isha - out.sunset); if (isNaN(out.isha) || ishaDiff > portion(M.isha)) { out.isha = out.sunset + portion(M.isha); highLat = true; } }
  }
  // convert from local-solar hours to UTC hours
  const utc = {};
  for (const [k, v] of Object.entries(out)) utc[k] = isNaN(v) ? null : fixHour(v - lon / 15);
  return { utc, method: M.name, methodKey: PRAYER_METHODS[method] ? method : "MWL", high_latitude_rule: highLat ? "AngleBased" : null };
}
function tzOffsetHours(tz, dateIso) {
  try {
    const d = new Date(dateIso + "T12:00:00Z");
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d);
    const s = (parts.find((p) => p.type === "timeZoneName") || {}).value || "GMT";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(s);
    if (!m) return 0;
    return (m[1] === "-" ? -1 : 1) * (+m[2] + (+(m[3] || 0)) / 60);
  } catch { return null; }
}
function fmtHM(h) { if (h == null || isNaN(h)) return null; h = fixHour(h); const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const H = mm === 60 ? (hh + 1) % 24 : hh, Mn = mm === 60 ? 0 : mm; return `${String(H).padStart(2, "0")}:${String(Mn).padStart(2, "0")}`; }
// Hijri (tabular/arithmetical, Kuwaiti algorithm): ±1 day vs official moon-sighting calendars
function hijriFromJD(jd) {
  let l = Math.floor(jd) - 1948440 + 10632; const n = Math.floor((l - 1) / 10631); l = l - 10631 * n + 354;
  const j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238);
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29;
  const month = Math.floor((24 * l) / 709), day = l - Math.floor((709 * month) / 24), year = 30 * n + j - 30;
  const names = ["Muharram", "Safar", "Rabi' al-awwal", "Rabi' al-thani", "Jumada al-awwal", "Jumada al-thani", "Rajab", "Sha'ban", "Ramadan", "Shawwal", "Dhu al-Qi'dah", "Dhu al-Hijjah"];
  return { year, month, day, month_name: names[month - 1], formatted: `${day} ${names[month - 1]} ${year} AH`, note: "arithmetical calendar; official moon-sighting dates may differ by one day" };
}
function parseLatLng(q) {
  const lat = +q.get("lat"), lon = +(q.get("lng") ?? q.get("lon"));
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || q.get("lat") == null) throw new Error("lat and lng are required");
  return { lat, lon };
}
// ISO-3166 alpha-2 -> IANA zone for countries with a single civil timezone (plus sensible defaults)
const COUNTRY_TZ = { AF: "Asia/Kabul", AL: "Europe/Tirane", DZ: "Africa/Algiers", AO: "Africa/Luanda", AR: "America/Argentina/Buenos_Aires", AM: "Asia/Yerevan", AT: "Europe/Vienna", AZ: "Asia/Baku", BH: "Asia/Bahrain", BD: "Asia/Dhaka", BY: "Europe/Minsk", BE: "Europe/Brussels", BJ: "Africa/Porto-Novo", BT: "Asia/Thimphu", BO: "America/La_Paz", BA: "Europe/Sarajevo", BW: "Africa/Gaborone", BN: "Asia/Brunei", BG: "Europe/Sofia", BF: "Africa/Ouagadougou", BI: "Africa/Bujumbura", KH: "Asia/Phnom_Penh", CM: "Africa/Douala", CF: "Africa/Bangui", TD: "Africa/Ndjamena", CN: "Asia/Shanghai", CO: "America/Bogota", KM: "Indian/Comoro", CG: "Africa/Brazzaville", CR: "America/Costa_Rica", CI: "Africa/Abidjan", HR: "Europe/Zagreb", CU: "America/Havana", CY: "Asia/Nicosia", CZ: "Europe/Prague", DK: "Europe/Copenhagen", DJ: "Africa/Djibouti", DO: "America/Santo_Domingo", EG: "Africa/Cairo", SV: "America/El_Salvador", ER: "Africa/Asmara", EE: "Europe/Tallinn", ET: "Africa/Addis_Ababa", FI: "Europe/Helsinki", FR: "Europe/Paris", GA: "Africa/Libreville", GM: "Africa/Banjul", GE: "Asia/Tbilisi", DE: "Europe/Berlin", GH: "Africa/Accra", GR: "Europe/Athens", GT: "America/Guatemala", GN: "Africa/Conakry", GY: "America/Guyana", HT: "America/Port-au-Prince", HN: "America/Tegucigalpa", HK: "Asia/Hong_Kong", HU: "Europe/Budapest", IS: "Atlantic/Reykjavik", IN: "Asia/Kolkata", IR: "Asia/Tehran", IQ: "Asia/Baghdad", IE: "Europe/Dublin", IL: "Asia/Jerusalem", IT: "Europe/Rome", JM: "America/Jamaica", JP: "Asia/Tokyo", JO: "Asia/Amman", KE: "Africa/Nairobi", KW: "Asia/Kuwait", KG: "Asia/Bishkek", LA: "Asia/Vientiane", LV: "Europe/Riga", LB: "Asia/Beirut", LY: "Africa/Tripoli", LT: "Europe/Vilnius", LU: "Europe/Luxembourg", MK: "Europe/Skopje", MG: "Indian/Antananarivo", MW: "Africa/Blantyre", MY: "Asia/Kuala_Lumpur", MV: "Indian/Maldives", ML: "Africa/Bamako", MT: "Europe/Malta", MR: "Africa/Nouakchott", MU: "Indian/Mauritius", MD: "Europe/Chisinau", MA: "Africa/Casablanca", MZ: "Africa/Maputo", MM: "Asia/Yangon", NA: "Africa/Windhoek", NP: "Asia/Kathmandu", NL: "Europe/Amsterdam", NZ: "Pacific/Auckland", NI: "America/Managua", NE: "Africa/Niamey", NG: "Africa/Lagos", KP: "Asia/Pyongyang", NO: "Europe/Oslo", OM: "Asia/Muscat", PK: "Asia/Karachi", PA: "America/Panama", PY: "America/Asuncion", PE: "America/Lima", PH: "Asia/Manila", PL: "Europe/Warsaw", PT: "Europe/Lisbon", QA: "Asia/Qatar", RO: "Europe/Bucharest", RW: "Africa/Kigali", SA: "Asia/Riyadh", SN: "Africa/Dakar", RS: "Europe/Belgrade", SL: "Africa/Freetown", SG: "Asia/Singapore", SK: "Europe/Bratislava", SI: "Europe/Ljubljana", SO: "Africa/Mogadishu", ZA: "Africa/Johannesburg", KR: "Asia/Seoul", SS: "Africa/Juba", ES: "Europe/Madrid", LK: "Asia/Colombo", SD: "Africa/Khartoum", SR: "America/Paramaribo", SE: "Europe/Stockholm", CH: "Europe/Zurich", SY: "Asia/Damascus", TW: "Asia/Taipei", TJ: "Asia/Dushanbe", TZ: "Africa/Dar_es_Salaam", TH: "Asia/Bangkok", TG: "Africa/Lome", TT: "America/Port_of_Spain", TN: "Africa/Tunis", TR: "Europe/Istanbul", TM: "Asia/Ashgabat", UG: "Africa/Kampala", UA: "Europe/Kyiv", AE: "Asia/Dubai", GB: "Europe/London", UY: "America/Montevideo", UZ: "Asia/Tashkent", VE: "America/Caracas", VN: "Asia/Ho_Chi_Minh", YE: "Asia/Aden", ZM: "Africa/Lusaka", ZW: "Africa/Harare", PS: "Asia/Gaza", XK: "Europe/Belgrade", ME: "Europe/Podgorica", LI: "Europe/Vaduz", MC: "Europe/Monaco", AD: "Europe/Andorra", SM: "Europe/Rome", BB: "America/Barbados", BS: "America/Nassau", BZ: "America/Belize", FJ: "Pacific/Fiji", PG: "Pacific/Port_Moresby", CL: "America/Santiago", EC: "America/Guayaquil", KZ: "Asia/Almaty", MN: "Asia/Ulaanbaatar", CD: "Africa/Kinshasa", ID: "Asia/Jakarta" };
// multi-zone countries: pick by longitude bands
function multiZoneTz(cc, lat, lon) {
  if (cc === "US") return lon > -85 ? "America/New_York" : lon > -102 ? "America/Chicago" : lon > -114 ? "America/Denver" : lon > -130 ? "America/Los_Angeles" : lon > -160 ? "America/Anchorage" : "Pacific/Honolulu";
  if (cc === "CA") return lon > -68 ? "America/Halifax" : lon > -90 ? "America/Toronto" : lon > -102 ? "America/Winnipeg" : lon > -120 ? "America/Edmonton" : "America/Vancouver";
  if (cc === "MX") return lon > -105 ? "America/Mexico_City" : lon > -113 ? "America/Hermosillo" : "America/Tijuana";
  if (cc === "BR") return lon > -52 ? "America/Sao_Paulo" : lon > -68 ? "America/Manaus" : "America/Rio_Branco";
  if (cc === "AU") return lon > 141 ? "Australia/Sydney" : lon > 129 ? "Australia/Adelaide" : "Australia/Perth";
  if (cc === "RU") return lon < 40 ? "Europe/Moscow" : lon < 60 ? "Europe/Samara" : lon < 75 ? "Asia/Yekaterinburg" : lon < 90 ? "Asia/Novosibirsk" : lon < 105 ? "Asia/Krasnoyarsk" : lon < 120 ? "Asia/Irkutsk" : lon < 135 ? "Asia/Yakutsk" : "Asia/Vladivostok";
  if (cc === "ID") return lon < 113 ? "Asia/Jakarta" : lon < 129 ? "Asia/Makassar" : "Asia/Jayapura";
  if (cc === "KZ") return lon < 60 ? "Asia/Aqtobe" : "Asia/Almaty";
  if (cc === "CD") return lon < 23 ? "Africa/Kinshasa" : "Africa/Lubumbashi";
  if (cc === "MN") return "Asia/Ulaanbaatar";
  if (cc === "CL") return lon < -100 ? "Pacific/Easter" : "America/Santiago";
  return COUNTRY_TZ[cc] || null;
}
async function timezoneFromCoords(env, lat, lon) {
  const key = "tz:" + lat.toFixed(1) + "," + lon.toFixed(1);
  try {
    const cached = await env.HALAL_DB.prepare("SELECT display FROM geo WHERE q=?").bind(key).first();
    if (cached) return cached.display || null;
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, { headers: { "user-agent": "CryptoPulse-x402/1.0 (prayer times; contact via cryptopulse.saascloud.ai)" }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const cc = (j.address?.country_code || "").toUpperCase();
    const tz = cc ? multiZoneTz(cc, lat, lon) : null;
    await env.HALAL_DB.prepare("INSERT OR REPLACE INTO geo (q,lat,lon,display) VALUES (?,?,?,?)").bind(key, lat, lon, tz || "").run();
    return tz;
  } catch { return null; }
}
async function resolveTimezone(q, lat, lon, dateIso, env) {
  const tz = q.get("tz");
  if (tz && /^[A-Za-z_]+\/[A-Za-z_\/+-]+$|^UTC$|^Etc\/GMT[+-]\d+$/.test(tz)) {
    const off = tzOffsetHours(tz, dateIso);
    if (off != null) return { name: tz, offset_hours: off, estimated: false };
  }
  if (q.get("tz_offset") != null && isFinite(+q.get("tz_offset"))) return { name: `UTC${+q.get("tz_offset") >= 0 ? "+" : ""}${+q.get("tz_offset")}`, offset_hours: +q.get("tz_offset"), estimated: false };
  if (env) { const guess = await timezoneFromCoords(env, lat, lon); if (guess) { const off = tzOffsetHours(guess, dateIso); if (off != null) return { name: guess, offset_hours: off, estimated: false, source: "country lookup" }; } }
  const off = Math.round(lon / 15);
  return { name: `UTC${off >= 0 ? "+" : ""}${off}`, offset_hours: off, estimated: true, note: "timezone estimated from longitude (no DST); pass tz=Area/City for exact local times" };
}
function prayerTimesFor(lat, lon, dateIso, method, asr, tzinfo) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const r = computePrayerTimes({ lat, lon, year: y, month: m, day: d, method, asr });
  const local = {}, utcIso = {};
  for (const k of ["fajr", "sunrise", "dhuhr", "asr", "sunset", "maghrib", "isha"]) {
    const h = r.utc[k];
    local[k] = h == null ? null : fmtHM(h + tzinfo.offset_hours);
    utcIso[k] = h == null ? null : new Date(Date.UTC(y, m - 1, d) + Math.round(h * 3600000)).toISOString();
  }
  return { date: dateIso, hijri: hijriFromJD(julianDay(y, m, d) + 0.5), method: r.method, method_key: r.methodKey, high_latitude_rule: r.high_latitude_rule, asr_juristic: asr === "Hanafi" ? "Hanafi" : "Standard (Shafi'i, Maliki, Hanbali)", timezone: tzinfo, times: local, times_utc: utcIso };
}
function todayIso(q) {
  const d = q.get("date");
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date().toISOString().slice(0, 10);
}
async function fetchPrayerTimes(q, env) {
  const { lat, lon } = parseLatLng(q);
  const dateIso = todayIso(q);
  const method = q.get("method") || "MWL";
  if (!PRAYER_METHODS[method]) throw new Error("unknown method; one of " + Object.keys(PRAYER_METHODS).join(", "));
  const tzinfo = await resolveTimezone(q, lat, lon, dateIso, env);
  const days = Math.min(Math.max(+(q.get("days") || 1), 1), 7);
  const out = { query: { lat, lng: lon, method, asr: q.get("asr") || "Standard" }, ...prayerTimesFor(lat, lon, dateIso, method, q.get("asr"), tzinfo) };
  if (days > 1) {
    out.next_days = [];
    for (let i = 1; i < days; i++) {
      const d = new Date(Date.UTC(...dateIso.split("-").map((x, j) => (j === 1 ? +x - 1 : +x)))); d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const tzi = tzinfo.estimated ? tzinfo : { ...tzinfo, offset_hours: tzOffsetHours(tzinfo.name, iso) ?? tzinfo.offset_hours };
      const p = prayerTimesFor(lat, lon, iso, method, q.get("asr"), tzi);
      out.next_days.push({ date: iso, hijri: p.hijri.formatted, times: p.times });
    }
  }
  out.methods_available = Object.keys(PRAYER_METHODS);
  return out;
}
const KAABA = { lat: 21.422487, lon: 39.826206 };
function qiblaFor(lat, lon) {
  const dLon = (KAABA.lon - lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(KAABA.lat * D2R);
  const x = Math.cos(lat * D2R) * Math.sin(KAABA.lat * D2R) - Math.sin(lat * D2R) * Math.cos(KAABA.lat * D2R) * Math.cos(dLon);
  const bearing = fixAngle(Math.atan2(y, x) * R2D);
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return { bearing_degrees: +bearing.toFixed(2), compass: dirs[Math.round(bearing / 22.5) % 16], distance_km: +haversineKm(lat, lon, KAABA.lat, KAABA.lon).toFixed(1), kaaba: KAABA };
}
async function fetchQibla(q) { const { lat, lon } = parseLatLng(q); return { query: { lat, lng: lon }, qibla: qiblaFor(lat, lon) }; }

// ---------- Mosques (OpenStreetMap place_of_worship + religion=muslim) via QLever ----------
const MOSQUE_SCHEMA = `CREATE TABLE IF NOT EXISTS mosques (cell INTEGER NOT NULL, id TEXT NOT NULL, name TEXT, lat REAL, lon REAL, denomination TEXT, address TEXT, city TEXT, postcode TEXT, phone TEXT, website TEXT, hours TEXT, PRIMARY KEY (cell, id)) WITHOUT ROWID`;
async function ensureMosqueSchema(env) { if (env.__mosqueSchema) return; await ensureSchema(env); await env.HALAL_DB.prepare(MOSQUE_SCHEMA).run(); env.__mosqueSchema = true; }
function mosqueQuery(limit, offset) {
  return `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT ?osm ?name ?c ?denom ?street ?hn ?city ?pc ?phone ?web ?hours WHERE {
  ?osm osmkey:amenity "place_of_worship" . ?osm osmkey:religion "muslim" . ?osm osmkey:name ?name .
  ?osm geo:hasGeometry/geo:asWKT ?wkt . BIND(geof:centroid(?wkt) AS ?c)
  OPTIONAL { ?osm osmkey:denomination ?denom }
  OPTIONAL { ?osm osmkey:addr:street ?street } OPTIONAL { ?osm osmkey:addr:housenumber ?hn } OPTIONAL { ?osm osmkey:addr:city ?city } OPTIONAL { ?osm osmkey:addr:postcode ?pc }
  OPTIONAL { ?osm osmkey:phone ?phone } OPTIONAL { ?osm osmkey:website ?web } OPTIONAL { ?osm osmkey:opening_hours ?hours }
} ORDER BY ?osm LIMIT ${limit} OFFSET ${offset}`;
}
const MOSQUE_COLS = ["cell", "id", "name", "lat", "lon", "denomination", "address", "city", "postcode", "phone", "website", "hours"];
async function harvestMosquePage(env, offset) {
  const left = env.__deadline ? env.__deadline - Date.now() : 60000;
  if (left < 15000) throw new Error("deadline");
  const r = await fetch(QLEVER + "?query=" + encodeURIComponent(mosqueQuery(QL_PAGE, offset)), { headers: { accept: "application/sparql-results+json", "user-agent": "CryptoPulse-x402/1.0 (mosques endpoint)" }, signal: AbortSignal.timeout(Math.min(60000, left - 5000)) });
  if (!r.ok) throw new Error("qlever " + r.status);
  const j = await r.json();
  if (j.exception) throw new Error("qlever: " + String(j.exception).slice(0, 80));
  const rows = [];
  for (const b of j.results?.bindings || []) {
    const v = (k) => (b[k] ? b[k].value : null);
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(v("c") || ""), idm = /openstreetmap\.org\/(node|way|relation)\/(\d+)/.exec(v("osm") || "");
    if (!m || !idm || !v("name")) continue;
    const addr = [v("hn"), v("street")].filter(Boolean).join(" ");
    rows.push({ id: idm[1][0] + idm[2], name: v("name"), lat: +(+m[2]).toFixed(6), lon: +(+m[1]).toFixed(6), denomination: v("denom"), address: addr || null, city: v("city"), postcode: v("pc"), phone: v("phone"), website: v("web"), hours: v("hours") });
  }
  const sql = `INSERT INTO mosques (${MOSQUE_COLS.join(",")}) VALUES (${MOSQUE_COLS.map(() => "?").join(",")}) ON CONFLICT(cell,id) DO UPDATE SET name=excluded.name,lat=excluded.lat,lon=excluded.lon,denomination=excluded.denomination,address=excluded.address,city=excluded.city,postcode=excluded.postcode,phone=excluded.phone,website=excluded.website,hours=excluded.hours`;
  for (let i = 0; i < rows.length; i += 50) await env.HALAL_DB.batch(rows.slice(i, i + 50).map((p) => env.HALAL_DB.prepare(sql).bind(cellId(p.lat, p.lon), p.id, p.name, p.lat, p.lon, p.denomination, p.address, p.city, p.postcode, p.phone, p.website, p.hours)));
  return { fetched: (j.results?.bindings || []).length, stored: rows.length };
}
async function runMosqueHarvest(env, steps, budgetMs, reset) {
  await ensureMosqueSchema(env);
  const meta = await metaGet(env, "harvest_mosques", { offset: 0, places: 0, done: false, errors: [], pass: 0 });
  const stale = meta.done && meta.finishedAt && Date.now() - Date.parse(meta.finishedAt) > QL_REFRESH_DAYS * 86400000;
  if (reset || stale) { meta.offset = 0; meta.places = 0; meta.done = false; meta.errors = []; meta.pass = (meta.pass || 0) + 1; }
  const started = Date.now(); env.__deadline = started + budgetMs;
  let done = 0, deadline = false;
  const dayKey = new Date().toISOString().slice(0, 10); if (meta.dayKey !== dayKey) { meta.dayKey = dayKey; meta.dayRows = 0; }
  while (!meta.done && done < steps && Date.now() - started < budgetMs - 15000 && (meta.dayRows || 0) < 40000) {
    try {
      const { fetched, stored } = await harvestMosquePage(env, meta.offset);
      meta.places += stored; meta.offset += QL_PAGE; done += 1; meta.dayRows = (meta.dayRows || 0) + stored;
      if (fetched < QL_PAGE) { meta.done = true; meta.finishedAt = new Date().toISOString(); }
    } catch (e) {
      if (/deadline/.test(String(e))) { deadline = true; break; }
      meta.errors.push({ offset: meta.offset, err: String(e).slice(0, 100), at: new Date().toISOString() }); meta.errors = meta.errors.slice(-20);
      break;
    }
  }
  meta.lastRun = { ms: Date.now() - started, pages: done, deadline, at: new Date().toISOString() };
  meta.updatedAt = new Date().toISOString();
  await metaSet(env, "harvest_mosques", meta);
  return { ...meta };
}
async function mosqueStats(env) {
  await ensureMosqueSchema(env);
  const meta = await metaGet(env, "harvest_mosques", {});
  const c = await env.HALAL_DB.prepare("SELECT COUNT(*) AS n FROM mosques").first().catch(() => ({ n: 0 }));
  return { mosques_indexed: c?.n || 0, rows_loaded: meta.places || 0, offset: meta.offset || 0, complete: !!meta.done, finishedAt: meta.finishedAt || null, updatedAt: meta.updatedAt || null, lastRun: meta.lastRun || null, recentErrors: (meta.errors || []).slice(-3).map((x) => x.err) };
}
async function mosquesNear(env, lat, lon, radiusKm, limit) {
  await ensureMosqueSchema(env);
  const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.max(0.2, Math.cos(lat * D2R)));
  const cells = [];
  for (let la = Math.floor(lat - dLat); la <= Math.floor(lat + dLat); la++) for (let lo = Math.floor(lon - dLon); lo <= Math.floor(lon + dLon); lo++) cells.push(cellId(la, lo));
  const sel = cells.slice(0, 9);
  const { results } = await env.HALAL_DB.prepare(`SELECT * FROM mosques WHERE cell IN (${sel.map(() => "?").join(",")})`).bind(...sel).all();
  const out = [];
  for (const p of results || []) { const km = haversineKm(lat, lon, p.lat, p.lon); if (km <= radiusKm) { const { cell, ...rest } = p; out.push({ ...rest, distance_km: +km.toFixed(2), osm_url: `https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[p.id[0]]}/${p.id.slice(1)}` }); } }
  out.sort((a, b) => a.distance_km - b.distance_km);
  return out.slice(0, limit);
}
async function fetchMosquesNear(q, env) {
  const { lat, lon } = parseLatLng(q);
  const radius = Math.min(Math.max(+(q.get("radius_km") || 5), 0.2), 30), limit = Math.min(Math.max(+(q.get("limit") || 20), 1), 50);
  const results = await mosquesNear(env, lat, lon, radius, limit);
  return { query: { lat, lng: lon, radius_km: radius }, count: results.length, results, qibla: qiblaFor(lat, lon), attribution: HALAL_ATTRIB };
}
async function fetchMosquesCity(q, env) {
  const city = q.get("city"); if (!city) throw new Error("city is required");
  const g = await geocodeCity(env, city); if (!g) throw new Error("city not found");
  const radius = Math.min(Math.max(+(q.get("radius_km") || 15), 1), 30), limit = Math.min(Math.max(+(q.get("limit") || 30), 1), 50);
  const results = await mosquesNear(env, g.lat, g.lon, radius, limit);
  return { query: { city, resolved: g.display_name, lat: g.lat, lng: g.lon, radius_km: radius }, count: results.length, results, attribution: HALAL_ATTRIB };
}

// ---------- Trip composite ----------
async function fetchHalalTrip(q, env) {
  let lat, lon, resolved = null;
  if (q.get("city")) { const g = await geocodeCity(env, q.get("city")); if (!g) throw new Error("city not found"); lat = g.lat; lon = g.lon; resolved = g.display_name; }
  else ({ lat, lon } = parseLatLng(q));
  const dateIso = todayIso(q);
  const method = PRAYER_METHODS[q.get("method") || ""] ? q.get("method") : "MWL";
  const tzinfo = await resolveTimezone(q, lat, lon, dateIso, env);
  const radius = Math.min(Math.max(+(q.get("radius_km") || 10), 1), 30);
  const cuisine = (q.get("cuisine") || "").toLowerCase() || null;
  const [food, mosques] = await Promise.all([placesNear(env, lat, lon, radius, Math.min(+(q.get("limit") || 10), 25), cuisine, null), mosquesNear(env, lat, lon, radius, 5)]);
  return {
    query: { city: q.get("city") || null, resolved, lat, lng: lon, radius_km: radius, date: dateIso, method },
    prayer_times: prayerTimesFor(lat, lon, dateIso, method, q.get("asr"), tzinfo),
    qibla: qiblaFor(lat, lon),
    halal_places: { count: food.length, results: food },
    mosques: { count: mosques.length, results: mosques },
    attribution: HALAL_ATTRIB,
  };
}

// ---------- More crypto ----------
async function fetchFundingRates(q) {
  const want = (q.get("symbols") || "").toUpperCase().split(",").map((s) => s.trim().replace(/-?PERP$|USDT$|USD$/, "")).filter(Boolean);
  const limit = Math.min(Math.max(+(q.get("limit") || 20), 1), 100);
  const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("hyperliquid " + r.status);
  const [meta, ctxs] = await r.json();
  let rows = meta.universe.map((u, i) => { const c = ctxs[i] || {}; const f = +c.funding; return { symbol: u.name, funding_rate_1h: f, funding_rate_8h: +(f * 8).toFixed(8), funding_apr_pct: +(f * 24 * 365 * 100).toFixed(2), mark_price: +c.markPx, oracle_price: +c.oraclePx, premium: +c.premium, open_interest: +c.openInterest, open_interest_usd: +(+c.openInterest * +c.markPx).toFixed(0), volume_24h_usd: +(+c.dayNtlVlm).toFixed(0), max_leverage: u.maxLeverage, delisted: !!u.isDelisted }; }).filter((x) => !x.delisted && isFinite(x.mark_price));
  if (want.length) rows = rows.filter((x) => want.includes(x.symbol));
  else rows.sort((a, b) => b.volume_24h_usd - a.volume_24h_usd);
  const sort = q.get("sort");
  if (sort === "funding_desc") rows.sort((a, b) => b.funding_rate_1h - a.funding_rate_1h);
  if (sort === "funding_asc") rows.sort((a, b) => a.funding_rate_1h - b.funding_rate_1h);
  if (sort === "oi") rows.sort((a, b) => b.open_interest_usd - a.open_interest_usd);
  return { source: "Hyperliquid perpetuals (funding paid hourly)", count: Math.min(rows.length, limit), results: rows.slice(0, limit), note: "funding_rate_1h is the hourly rate as a fraction; positive = longs pay shorts" };
}
async function fetchStablecoins(q) {
  const limit = Math.min(Math.max(+(q.get("limit") || 15), 1), 50);
  const r = await fetch("https://stablecoins.llama.fi/stablecoins?includePrices=true", { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("defillama " + r.status);
  const j = await r.json();
  const rows = (j.peggedAssets || []).map((a) => { const circ = a.circulating?.peggedUSD ?? Object.values(a.circulating || {})[0] ?? 0; const prev = a.circulatingPrevDay?.peggedUSD ?? circ; const week = a.circulatingPrevWeek?.peggedUSD ?? circ; return { symbol: a.symbol, name: a.name, peg: a.pegType, mechanism: a.pegMechanism, price: a.price ?? null, peg_deviation_pct: a.price != null ? +((a.price - 1) * 100).toFixed(3) : null, circulating_usd: Math.round(circ), change_1d_pct: prev ? +(((circ - prev) / prev) * 100).toFixed(3) : null, change_7d_pct: week ? +(((circ - week) / week) * 100).toFixed(3) : null, chains: (a.chains || []).slice(0, 8) }; }).filter((x) => x.circulating_usd > 0).sort((a, b) => b.circulating_usd - a.circulating_usd);
  const total = rows.reduce((s, x) => s + x.circulating_usd, 0);
  return { source: "DefiLlama stablecoins", total_circulating_usd: total, count: Math.min(rows.length, limit), results: rows.slice(0, limit), depegged: rows.filter((x) => x.price != null && Math.abs(x.price - 1) > 0.01 && x.circulating_usd > 1e7).slice(0, 10).map((x) => ({ symbol: x.symbol, price: x.price, circulating_usd: x.circulating_usd })) };
}
async function fetchDexVolume(q) {
  const limit = Math.min(Math.max(+(q.get("limit") || 15), 1), 50);
  const chain = q.get("chain");
  const url = "https://api.llama.fi/overview/dexs" + (chain ? "/" + encodeURIComponent(chain) : "") + "?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("defillama " + r.status);
  const j = await r.json();
  const rows = (j.protocols || []).map((p) => ({ name: p.name, category: p.category, chains: (p.chains || []).slice(0, 6), volume_24h_usd: p.total24h ?? null, volume_7d_usd: p.total7d ?? null, volume_30d_usd: p.total30d ?? null, change_1d_pct: p.change_1d ?? null, change_7d_pct: p.change_7d ?? null })).filter((x) => x.volume_24h_usd != null).sort((a, b) => b.volume_24h_usd - a.volume_24h_usd);
  return { source: "DefiLlama DEX overview", chain: chain || "all", total_24h_usd: j.total24h ?? null, total_7d_usd: j.total7d ?? null, change_1d_pct: j.change_1d ?? null, change_7d_pct: j.change_7d ?? null, count: Math.min(rows.length, limit), results: rows.slice(0, limit) };
}
const WALLET_CHAINS = { base: "https://base.blockscout.com", ethereum: "https://eth.blockscout.com", optimism: "https://optimism.blockscout.com", arbitrum: "https://arbitrum.blockscout.com", polygon: "https://polygon.blockscout.com", gnosis: "https://gnosis.blockscout.com" };
async function fetchWallet(q) {
  const address = (q.get("address") || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("address must be a 0x EVM address");
  const chain = (q.get("chain") || "base").toLowerCase();
  const base = WALLET_CHAINS[chain]; if (!base) throw new Error("chain must be one of " + Object.keys(WALLET_CHAINS).join(", "));
  const BSH = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; CryptoPulse-x402/1.0; +https://cryptopulse.saascloud.ai)" };
  const [ar, tr] = await Promise.all([fetch(`${base}/api/v2/addresses/${address}`, { headers: BSH, signal: AbortSignal.timeout(8000) }), fetch(`${base}/api/v2/addresses/${address}/tokens?type=ERC-20`, { headers: BSH, signal: AbortSignal.timeout(8000) })]);
  if (!ar.ok && ar.status !== 404) throw new Error("blockscout " + ar.status);
  const a = ar.ok ? await ar.json() : {}, t = tr.ok ? await tr.json() : { items: [] };
  const nativeBal = +(a.coin_balance || 0) / 1e18, nativeRate = +(a.exchange_rate || 0);
  const tokens = (t.items || []).map((x) => { const dec = +(x.token?.decimals ?? 18); const bal = +x.value / Math.pow(10, dec); const rate = x.token?.exchange_rate != null ? +x.token.exchange_rate : null; return { symbol: x.token?.symbol || "?", name: x.token?.name || null, address: x.token?.address_hash || x.token?.address || null, balance: +bal.toFixed(6), price_usd: rate, value_usd: rate != null ? +(bal * rate).toFixed(2) : null }; }).sort((x, y) => (y.value_usd || 0) - (x.value_usd || 0));
  const total = (nativeRate ? nativeBal * nativeRate : 0) + tokens.reduce((s, x) => s + (x.value_usd || 0), 0);
  return { chain, address, native: { symbol: chain === "polygon" ? "POL" : chain === "gnosis" ? "xDAI" : "ETH", balance: +nativeBal.toFixed(6), price_usd: nativeRate || null, value_usd: nativeRate ? +(nativeBal * nativeRate).toFixed(2) : null }, is_contract: !!a.is_contract, tx_count: a.transactions_count ?? null, tokens: tokens.slice(0, 50), total_value_usd: +total.toFixed(2), source: "Blockscout" };
}

// ---------- FX (ECB reference rates via frankfurter.dev) ----------
async function fetchFx(q) {
  const from = (q.get("from") || q.get("base") || "USD").toUpperCase();
  const symbols = (q.get("to") || q.get("symbols") || "").toUpperCase().replace(/[^A-Z,]/g, "");
  const amount = q.get("amount") != null ? +q.get("amount") : null;
  const date = q.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(q.get("date")) ? q.get("date") : "latest";
  const r = await fetch(`https://api.frankfurter.dev/v1/${date}?base=${from}${symbols ? "&symbols=" + symbols : ""}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(r.status === 404 ? "unsupported currency or date (ECB covers ~30 major currencies)" : "fx upstream " + r.status);
  const j = await r.json();
  const out = { source: "European Central Bank reference rates (via frankfurter.dev), updated ~16:00 CET on business days", base: j.base, date: j.date, rates: j.rates };
  if (amount != null && isFinite(amount)) out.converted = Object.fromEntries(Object.entries(j.rates).map(([k, v]) => [k, +(amount * v).toFixed(4)]));
  return out;
}

// ---------- Routes ----------
const EXT2_ROUTES = {
  "/api/prayer-times": {
    price: "$0.002",
    description: "Islamic prayer times (Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha) for any lat/lng and date, 17 calculation methods, Hanafi/Standard Asr, Hijri date, up to 7 days.",
    ext: bazaarExt({ input: { lat: "40.7128", lng: "-74.0060", method: "ISNA", tz: "America/New_York" }, inputSchema: { properties: { lat: { type: "string", description: "Latitude" }, lng: { type: "string", description: "Longitude" }, date: { type: "string", description: "YYYY-MM-DD (default today, UTC)" }, method: { type: "string", description: "MWL (default), ISNA, Egypt, Makkah, Karachi, Tehran, Jafari, Turkey, Singapore, France, Russia, Dubai, Kuwait, Qatar, Kemenag, JAKIM, Moonsighting" }, asr: { type: "string", description: "Standard (default) or Hanafi" }, tz: { type: "string", description: "IANA timezone for local times, e.g. America/New_York (otherwise estimated from longitude)" }, days: { type: "string", description: "1-7 days of times (default 1)" } }, required: ["lat", "lng"] }, output: { example: { date: "2026-11-03", hijri: { formatted: "23 Jumada al-awwal 1448 AH" }, times: { fajr: "05:12", sunrise: "06:31", dhuhr: "11:47", asr: "14:28", maghrib: "17:02", isha: "18:19" } } } }),
    handler: halalSafe(fetchPrayerTimes),
  },
  "/api/qibla": {
    price: "$0.001",
    description: "Qibla direction (compass bearing to the Kaaba) and great-circle distance from any lat/lng.",
    ext: bazaarExt({ input: { lat: "51.5074", lng: "-0.1278" }, inputSchema: { properties: { lat: { type: "string", description: "Latitude" }, lng: { type: "string", description: "Longitude" } }, required: ["lat", "lng"] }, output: { example: { qibla: { bearing_degrees: 118.99, compass: "ESE", distance_km: 4788.6 } } } }),
    handler: halalSafe(fetchQibla),
  },
  "/api/mosques/near": {
    price: "$0.005",
    description: "Mosques and Muslim prayer spaces near a lat/lng (radius up to 30 km), sorted by distance, with qibla bearing. OpenStreetMap data (ODbL).",
    ext: bazaarExt({ input: { lat: "43.6532", lng: "-79.3832", radius_km: "5" }, inputSchema: { properties: { lat: { type: "string", description: "Latitude" }, lng: { type: "string", description: "Longitude" }, radius_km: { type: "string", description: "0.2-30 (default 5)" }, limit: { type: "string", description: "1-50 (default 20)" } }, required: ["lat", "lng"] }, output: { example: { count: 1, results: [{ id: "w123", name: "Masjid Toronto", lat: 43.65, lon: -79.38, denomination: "sunni", address: "168 Dundas St W", distance_km: 0.4 }] } } }),
    handler: halalSafe(fetchMosquesNear),
  },
  "/api/mosques/city": {
    price: "$0.01",
    description: "Mosques in a named city (geocoded), up to 50 sorted by distance from the city centre. OpenStreetMap data (ODbL).",
    ext: bazaarExt({ input: { city: "Dearborn, MI", limit: "30" }, inputSchema: { properties: { city: { type: "string", description: "City name, e.g. 'Dearborn, MI' or 'Bradford, UK'" }, radius_km: { type: "string", description: "1-30 (default 15)" }, limit: { type: "string", description: "1-50 (default 30)" } }, required: ["city"] }, output: { example: { count: 1, results: [{ id: "w123", name: "Islamic Center of America", distance_km: 2.1 }] } } }),
    handler: halalSafe(fetchMosquesCity),
  },
  "/api/trip/halal": {
    price: "$0.02",
    description: "One-call Muslim travel bundle for a city or lat/lng: today's prayer times, qibla, nearby halal restaurants and nearby mosques. Replaces 4 separate calls.",
    ext: bazaarExt({ input: { city: "Chicago, IL", method: "ISNA", tz: "America/Chicago" }, inputSchema: { properties: { city: { type: "string", description: "City name (or pass lat and lng instead)" }, lat: { type: "string", description: "Latitude (alternative to city)" }, lng: { type: "string", description: "Longitude (alternative to city)" }, date: { type: "string", description: "YYYY-MM-DD (default today)" }, method: { type: "string", description: "Prayer calculation method (default MWL)" }, tz: { type: "string", description: "IANA timezone for local prayer times" }, radius_km: { type: "string", description: "1-30 (default 10)" }, cuisine: { type: "string", description: "Halal cuisine filter" }, limit: { type: "string", description: "halal places to return, 1-25 (default 10)" } }, required: [] }, output: { example: { prayer_times: { times: { fajr: "05:30", maghrib: "16:45" } }, qibla: { bearing_degrees: 48.6 }, halal_places: { count: 10 }, mosques: { count: 5 } } } }),
    handler: halalSafe(fetchHalalTrip),
  },
  "/api/funding-rates": {
    price: "$0.005",
    description: "Perpetual futures funding rates, open interest, mark/oracle price and 24h volume for 200+ crypto perps (Hyperliquid). Filter by symbols or sort by funding/OI.",
    ext: bazaarExt({ input: { symbols: "BTC,ETH,SOL" }, inputSchema: { properties: { symbols: { type: "string", description: "Comma-separated base symbols, e.g. BTC,ETH,SOL (default: top by volume)" }, limit: { type: "string", description: "1-100 (default 20)" }, sort: { type: "string", description: "funding_desc, funding_asc, oi (default: 24h volume)" } }, required: [] }, output: { example: { results: [{ symbol: "BTC", funding_rate_1h: 0.0000125, funding_apr_pct: 10.95, mark_price: 77752, open_interest_usd: 3257000000 }] } } }),
    handler: halalSafe(fetchFundingRates),
  },
  "/api/stablecoins": {
    price: "$0.005",
    description: "Stablecoin market: circulating supply, price and peg deviation, 1d/7d supply change and chains for the top stablecoins, plus a depeg watchlist (DefiLlama).",
    ext: bazaarExt({ input: { limit: "15" }, inputSchema: { properties: { limit: { type: "string", description: "1-50 (default 15)" } }, required: [] }, output: { example: { total_circulating_usd: 310000000000, results: [{ symbol: "USDT", price: 1.0004, circulating_usd: 185000000000, change_7d_pct: 0.42 }] } } }),
    handler: halalSafe(fetchStablecoins),
  },
  "/api/dex-volume": {
    price: "$0.005",
    description: "DEX trading volume: total 24h/7d volume and change, and the top DEXs by 24h volume, optionally for one chain (DefiLlama).",
    ext: bazaarExt({ input: { chain: "Base", limit: "10" }, inputSchema: { properties: { chain: { type: "string", description: "Chain name as on DefiLlama, e.g. Ethereum, Base, Solana, Arbitrum (default all)" }, limit: { type: "string", description: "1-50 (default 15)" } }, required: [] }, output: { example: { total_24h_usd: 12500000000, results: [{ name: "Uniswap", volume_24h_usd: 2900000000, change_1d_pct: 3.1 }] } } }),
    handler: halalSafe(fetchDexVolume),
  },
  "/api/wallet": {
    price: "$0.01",
    description: "EVM wallet portfolio: native balance, ERC-20 token balances with USD prices and total value, tx count (Base, Ethereum, Optimism, Arbitrum, Polygon, Gnosis via Blockscout).",
    ext: bazaarExt({ input: { address: "0x9331bf848992A61f184654c1c0E931c66398C409", chain: "base" }, inputSchema: { properties: { address: { type: "string", description: "0x address" }, chain: { type: "string", description: "base (default), ethereum, optimism, arbitrum, polygon, gnosis" } }, required: ["address"] }, output: { example: { total_value_usd: 2.28, native: { symbol: "ETH", balance: 0.0 }, tokens: [{ symbol: "USDC", balance: 2.27, value_usd: 2.28 }] } } }),
    handler: halalSafe(fetchWallet),
  },
  "/api/fx": {
    price: "$0.001",
    description: "Fiat exchange rates and conversion from ECB reference data (USD, EUR, GBP, JPY, CAD, AUD, CHF, CNY, INR, and ~20 more), latest or any date since 1999.",
    ext: bazaarExt({ input: { from: "USD", to: "EUR,GBP,CAD", amount: "100" }, inputSchema: { properties: { from: { type: "string", description: "Base currency code (default USD)" }, to: { type: "string", description: "Comma-separated target codes (default all)" }, amount: { type: "string", description: "Optional amount to convert" }, date: { type: "string", description: "YYYY-MM-DD for historical rates (default latest)" } }, required: [] }, output: { example: { base: "USD", date: "2026-11-03", rates: { EUR: 0.8945, GBP: 0.7457 }, converted: { EUR: 89.45, GBP: 74.57 } } } }),
    handler: halalSafe(fetchFx),
  },
};
Object.assign(ROUTES, EXT2_ROUTES);
function routeCategory(path) {
  if (/^\/api\/(halal|mosques|prayer-times|qibla|trip)/.test(path)) return "halal";
  if (path === "/api/fx") return "fx";
  return "crypto";
}

// ---------- Discovery: llms.txt, OpenAPI, docs ----------
const SITE = "https://cryptopulse.saascloud.ai";
function routeParams(r) { const s = r.ext?.bazaar?.schema?.properties?.input?.properties?.queryParams || {}; return { props: s.properties || {}, required: s.required || [] }; }
function llmsTxt() {
  const lines = [
    "# CryptoPulse x402 API", "",
    "> Pay-per-call data API for AI agents. No API keys, no accounts: every endpoint under /api/ answers HTTP 402 with x402 payment requirements (USDC on Base eip155:8453 or Solana), and returns data once the request is retried with a signed payment. Prices are $0.001-$0.10 per call. Also an MCP server at /mcp (Streamable HTTP).", "",
    "- Base URL: " + SITE, "- MCP endpoint: " + SITE + "/mcp (tools/list is free; paid tools use the same x402 flow)", "- OpenAPI: " + SITE + "/openapi.json", "- Human docs: " + SITE + "/docs", "- Machine directory (JSON): " + SITE + "/", "",
    "## How to pay", "", "Use any x402 client (e.g. @x402/fetch, x402-axios, or the x402 MCP wrapper) with a wallet holding USDC on Base or Solana. Call the endpoint; read the PAYMENT-REQUIRED header (v2) or 402 JSON body (v1); sign the exact-amount USDC authorization; retry with PAYMENT-SIGNATURE (or X-PAYMENT). The facilitator is https://facilitator.payai.network.", "",
    "## Endpoints", "",
  ];
  const cats = { crypto: "Crypto market data", halal: "Halal food, mosques and prayer times", fx: "Fiat FX" };
  for (const [cat, title] of Object.entries(cats)) {
    lines.push("### " + title, "");
    for (const [p, r] of Object.entries(ROUTES)) if (routeCategory(p) === cat) { const { props, required } = routeParams(r); lines.push(`- [${p}](${SITE}${p}) — ${r.price}/call. ${r.description} Params: ${Object.keys(props).map((k) => k + (required.includes(k) ? "*" : "")).join(", ") || "none"}.`); }
    lines.push("");
  }
  lines.push("## Data sources and licenses", "", "Crypto: CoinGecko, DexScreener, GoPlus, DefiLlama, Hyperliquid, Blockscout, alternative.me (public endpoints). Halal places and mosques: OpenStreetMap contributors, ODbL (attribution included in responses). FX: European Central Bank reference rates. Prayer times: computed astronomically (no external data).", "");
  return lines.join("\n");
}
function openapiJson() {
  const paths = {};
  for (const [p, r] of Object.entries(ROUTES)) {
    const { props, required } = routeParams(r);
    paths[p] = { get: { summary: r.description.split(". ")[0], description: `${r.description}\n\nPrice: ${r.price} USDC per call via x402 (HTTP 402 then retry with PAYMENT-SIGNATURE).`, tags: [routeCategory(p)], parameters: Object.entries(props).map(([k, v]) => ({ name: k, in: "query", required: required.includes(k), schema: { type: "string" }, description: v.description || "" })), responses: { 200: { description: "Data (after payment)", content: { "application/json": { example: r.ext?.bazaar?.schema?.properties?.output?.example || r.ext?.bazaar?.info?.output?.example || {} } } }, 402: { description: "Payment required: x402 requirements in PAYMENT-REQUIRED header (v2) and JSON body (v1)" } }, "x-price-usdc": r.price } };
  }
  return { openapi: "3.1.0", info: { title: "CryptoPulse x402 API", version: "2.0.0", description: "Pay-per-call crypto, halal/prayer and FX data for AI agents. Payment via x402 (USDC on Base or Solana). No API keys.", "x-payment": { protocol: "x402", networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], facilitator: "https://facilitator.payai.network" } }, servers: [{ url: SITE }], tags: [{ name: "crypto" }, { name: "halal" }, { name: "fx" }], paths, "x-mcp": { endpoint: SITE + "/mcp", transport: "streamable-http" } };
}
function docsHtml() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cats = { crypto: "Crypto market data", halal: "Halal food, mosques and prayer times", fx: "Fiat FX" };
  let body = "";
  for (const [cat, title] of Object.entries(cats)) {
    body += `<h2>${title}</h2>`;
    for (const [p, r] of Object.entries(ROUTES)) if (routeCategory(p) === cat) {
      const { props, required } = routeParams(r);
      const ex = r.ext?.bazaar?.info?.input?.queryParams || {};
      const qs = Object.entries(ex).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      body += `<section class="ep"><h3><code>GET ${esc(p)}</code> <span class="price">${esc(r.price)}</span></h3><p>${esc(r.description)}</p>` +
        (Object.keys(props).length ? `<table><tr><th>Param</th><th>Description</th></tr>${Object.entries(props).map(([k, v]) => `<tr><td><code>${esc(k)}</code>${required.includes(k) ? " <em>required</em>" : ""}</td><td>${esc(v.description || "")}</td></tr>`).join("")}</table>` : "") +
        `<pre>curl "${SITE}${esc(p)}${qs ? "?" + esc(qs) : ""}"   # → 402 + PAYMENT-REQUIRED; retry with a signed payment</pre></section>`;
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CryptoPulse x402 API — docs</title>
<meta name="description" content="Pay-per-call crypto, halal/prayer and FX data API for AI agents. x402 payments in USDC on Base and Solana, no API keys. MCP server included."><link rel="alternate" type="text/plain" href="/llms.txt"><link rel="alternate" type="application/json" href="/openapi.json">
<style>:root{--bg:#0b0f17;--fg:#e6e9ef;--muted:#9aa4b2;--acc:#4f8cff;--card:#121826;--border:#223047}@media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#111;--muted:#555;--acc:#1f5eff;--card:#f6f8fb;--border:#dde3ec}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:900px;margin:0 auto}h1{font-size:28px;margin:0 0 6px}h2{font-size:20px;margin:32px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}h3{font-size:16px;margin:0 0 6px}.lead{color:var(--muted)}.ep{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:12px 0}.price{float:right;color:var(--acc);font-weight:600}code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px;font-size:13px}pre{overflow:auto;background:rgba(127,127,127,.12);padding:10px;border-radius:6px;font-size:12.5px}table{border-collapse:collapse;width:100%;font-size:13.5px;margin:8px 0}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border);vertical-align:top}a{color:var(--acc)}.links a{margin-right:14px}</style></head><body><main>
<h1>CryptoPulse x402 API</h1><p class="lead">Pay-per-call data for AI agents. No API keys, no sign-up: call an endpoint, get HTTP 402 with x402 payment requirements, retry with a signed USDC payment (Base or Solana), get data. Prices $0.001–$0.10 per call.</p>
<p class="links"><a href="/llms.txt">llms.txt</a><a href="/openapi.json">OpenAPI</a><a href="/">JSON directory</a><a href="/mcp">MCP endpoint</a><a href="/dashboard">Earnings dashboard</a></p>
<h2>Quick start</h2><pre>npm i @x402/fetch @x402/evm viem
import { wrapFetchWithPayment } from "@x402/fetch";
// client = your x402 EVM signer (viem account with USDC on Base)
const fetchWithPay = wrapFetchWithPayment(fetch, client);
const r = await fetchWithPay("${SITE}/api/halal/near?lat=40.7128&lng=-74.006");
console.log(await r.json());</pre>
<p><strong>MCP:</strong> add <code>{"url": "${SITE}/mcp"}</code> as a Streamable-HTTP server. <code>tools/list</code> is free; paid tools return 402 with the same x402 headers.</p>
${body}
<h2>Data sources</h2><p class="lead">Crypto: CoinGecko, DexScreener, GoPlus, DefiLlama, Hyperliquid, Blockscout, alternative.me. Halal places and mosques: © OpenStreetMap contributors (ODbL). FX: European Central Bank reference rates. Prayer times: astronomical computation. Facilitator: PayAI.</p>
</main></body></html>`;
}


export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runHarvest(env, 10, 100000, false).then((m) => (m && m.done ? runMosqueHarvest(env, 10, 90000, false) : null))); },
  async fetch(req, env) {
    HALAL_ENV = env;
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/dashboard") return new Response(DASH_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (path === "/health") return json({ ok: true });
      if (path === "/llms.txt") return new Response(llmsTxt(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
      if (path === "/openapi.json") return new Response(JSON.stringify(openapiJson(), null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
      if (path === "/docs") return new Response(docsHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
      if (path === "/source.js") { const rows = (await env.HALAL_DB.prepare("SELECT k, v FROM meta WHERE k LIKE 'source:%' ORDER BY k").all()).results || []; const src = rows.map((r) => r.v).join(""); return new Response(src || "// source not published yet", { headers: { "Content-Type": "application/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } }); }
      if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: https://cryptopulse.saascloud.ai/llms.txt\n", { headers: { "Content-Type": "text/plain" } });
      if (path === "/admin/halal/harvest") return handleHarvest(req, env);
      if (path === "/admin/mosques/harvest") { if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403); return json(await runMosqueHarvest(env, Math.min(+(url.searchParams.get("steps") || 3), 10), 100000, url.searchParams.get("reset") === "1")); }
      if (path === "/admin/sample") { if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403); const rt = ROUTES[url.searchParams.get("path") || ""]; if (!rt) return json({ error: "unknown path" }, 404); const data = await rt.handler(url.searchParams); if (data && data.__status) { const { __status, ...body } = data; return json(body, __status); } return json(data); }
      if (path === "/halal-stats") return json({ halal: await halalStats(env), mosques: await mosqueStats(env) });
      if (path === "/sales-stats") return json(await salesStats(env));
      if (path === "/") return json(directory(url, env));
      if (path === "/mcp") return handleMcp(req, env);
      if (path === "/solana-earnings") return json(await handleSolanaEarnings());

      const route = ROUTES[path];
      if (!route) return json({ error: "not found" }, 404);
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

      const requirement = buildRequirement(route, env);
      const sigHeader = req.headers.get("PAYMENT-SIGNATURE");
      const xPayment = req.headers.get("X-PAYMENT");
      if (!sigHeader && xPayment) return handleV1(req, env, route, requirement, url, xPayment);

      if (!sigHeader) return paymentRequired402(req, route, buildRequirements(route, env));

      // --- Paid flow ---
      let payload;
      try {
        payload = b64decode(sigHeader);
      } catch {
        return paymentRequired402(req, route, requirement, "Invalid payment signature header");
      }
      if (payload.x402Version !== 2) {
        return paymentRequired402(req, route, requirement, `Unsupported x402 version: ${payload.x402Version}`);
      }
      const chosen = matchRequirement(route, env, payload.accepted);
      if (!chosen) {
        return paymentRequired402(req, route, buildRequirements(route, env), "No matching payment requirements");
      }

      const verify = await facilitatorPost(env, "/verify", payload, chosen);
      if (!verify.isValid) {
        return paymentRequired402(req, route, chosen, verify.invalidReason || "Payment verification failed");
      }

      const data = await route.handler(url.searchParams);
      if (data && data.__status) {
        // Client error in params — do NOT settle, no charge.
        const { __status, ...body } = data;
        return json(body, __status);
      }

      const settle = await facilitatorPost(env, "/settle", payload, chosen);
      if (!settle.success) {
        return paymentRequired402(req, route, chosen, settle.errorReason || "Settlement failed");
      }
      await logSale(env, route, settle, "rest");

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": b64encode(settle) },
      });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function directory(url, env) {
  return {
    service: SERVICE_NAME,
    protocol: "x402",
    x402Version: 2,
    network: env.NETWORK === MAINNET ? "base" : "base-sepolia (testnet)",
    payment_asset: "USDC",
    pay_to: env.PAY_TO || OWNER_WALLET,
    endpoints: Object.entries(ROUTES).map(([p, r]) => ({
      path: p,
      price: r.price,
      desc: r.description,
    })),
    how_to_pay: "Request any /api/* endpoint; the 402 response's PAYMENT-REQUIRED header contains x402 payment requirements. Use an x402 client (e.g. @x402/fetch) with a funded wallet.",
    docs: "https://docs.x402.org",
    base_url: url.origin,
  };
}


// Public earnings dashboard (served at /dashboard)
const DASH_HTML = new TextDecoder().decode(Uint8Array.from(atob("PCFET0NUWVBFIGh0bWw+PGh0bWwgbGFuZz0iZW4iPjxoZWFkPjxtZXRhIGNoYXJzZXQ9IlVURi04Ij48bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCI+PHRpdGxlPkNyeXB0b1B1bHNlIOKAlCBFYXJuaW5nczwvdGl0bGU+PHN0eWxlPi52aXotcm9vdHstLXN1cmZhY2UtMTojZmNmY2ZiOy0tc3VyZmFjZS0yOiNmNGY0ZjI7LS1ib3JkZXI6I2U0ZTNkZjstLXRleHQtcHJpbWFyeTojMGIwYjBiOy0tdGV4dC1zZWNvbmRhcnk6IzUyNTE0ZTstLXRleHQtbXV0ZWQ6IzhhODk4NDstLWJhc2U6IzJhNzhkNjstLXNvbDojNGEzYWE3Oy0tZ29vZDojMDA4MzAwO31AbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOmRhcmspey52aXotcm9vdHstLXN1cmZhY2UtMTojMWExYTE5Oy0tc3VyZmFjZS0yOiMyMzIzMjI7LS1ib3JkZXI6IzNhM2EzODstLXRleHQtcHJpbWFyeTojZmZmZmZmOy0tdGV4dC1zZWNvbmRhcnk6I2MzYzJiNzstLXRleHQtbXV0ZWQ6IzhhODk4NDstLWJhc2U6IzM5ODdlNTstLXNvbDojOTA4NWU5Oy0tZ29vZDojMzVhODM1O319Kntib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luOjA7fWJvZHl7YmFja2dyb3VuZDp2YXIoLS1zdXJmYWNlLTEpO30udml6LXJvb3R7Zm9udC1mYW1pbHk6dWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLCJTZWdvZSBVSSIsUm9ib3RvLHNhbnMtc2VyaWY7YmFja2dyb3VuZDp2YXIoLS1zdXJmYWNlLTEpO2NvbG9yOnZhcigtLXRleHQtcHJpbWFyeSk7bWF4LXdpZHRoOjg4MHB4O21hcmdpbjowIGF1dG87cGFkZGluZzoyOHB4IDIwcHggNDhweDt9aDF7Zm9udC1zaXplOjE5cHg7Zm9udC13ZWlnaHQ6NjUwO2xldHRlci1zcGFjaW5nOi0wLjAxZW07fS5zdWJ7Y29sb3I6dmFyKC0tdGV4dC1zZWNvbmRhcnkpO2ZvbnQtc2l6ZToxM3B4O21hcmdpbi10b3A6NHB4O30uc3ViIGF7Y29sb3I6dmFyKC0tYmFzZSk7dGV4dC1kZWNvcmF0aW9uOm5vbmU7fS5uZXQtYmFkZ2V7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjZweDttYXJnaW4tbGVmdDoxMHB4O2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS1nb29kKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Ym9yZGVyLXJhZGl1czo5OXB4O3BhZGRpbmc6MnB4IDEwcHg7dmVydGljYWwtYWxpZ246MnB4O30ubmV0LWJhZGdlOjpiZWZvcmV7Y29udGVudDoiIjt3aWR0aDo3cHg7aGVpZ2h0OjdweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLWdvb2QpO30udGlsZXN7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KDE1MHB4LDFmcikpO2dhcDoxMHB4O21hcmdpbjoyMnB4IDAgMTBweDt9LnRpbGV7YmFja2dyb3VuZDp2YXIoLS1zdXJmYWNlLTIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyKTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxNHB4IDE2cHg7fS50aWxlIC5sYWJlbHtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo2MDA7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOjAuMDVlbTtjb2xvcjp2YXIoLS10ZXh0LW11dGVkKTt9LnRpbGUgLnZhbHVle2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0OjcwMDtsZXR0ZXItc3BhY2luZzotMC4wMmVtO21hcmdpbi10b3A6NnB4O2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXItbnVtczt9LnRpbGUgLmhpbnR7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tdGV4dC1zZWNvbmRhcnkpO21hcmdpbi10b3A6NHB4O30uZG90e2Rpc3BsYXk6aW5saW5lLWJsb2NrO3dpZHRoOjhweDtoZWlnaHQ6OHB4O2JvcmRlci1yYWRpdXM6NTAlO21hcmdpbi1yaWdodDo1cHg7dmVydGljYWwtYWxpZ246MXB4O30uZG90LmJhc2V7YmFja2dyb3VuZDp2YXIoLS1iYXNlKTt9LmRvdC5zb2x7YmFja2dyb3VuZDp2YXIoLS1zb2wpO30uY2FyZHtiYWNrZ3JvdW5kOnZhcigtLXN1cmZhY2UtMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjE2cHg7bWFyZ2luLXRvcDoxMnB4O30uY2FyZCBoMntmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2NTA7Y29sb3I6dmFyKC0tdGV4dC1zZWNvbmRhcnkpO21hcmdpbi1ib3R0b206MTBweDt9Lm5vdGV7Zm9udC1zaXplOjEyLjVweDtjb2xvcjp2YXIoLS10ZXh0LXNlY29uZGFyeSk7bGluZS1oZWlnaHQ6MS41NTt9Lm5vdGUgYntjb2xvcjp2YXIoLS10ZXh0LXByaW1hcnkpO310YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTtmb250LXNpemU6MTNweDt9dGh7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzowLjA1ZW07Y29sb3I6dmFyKC0tdGV4dC1tdXRlZCk7Zm9udC13ZWlnaHQ6NjAwO3BhZGRpbmc6NnB4IDhweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpO310ZHtwYWRkaW5nOjhweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIpO2NvbG9yOnZhcigtLXRleHQtc2Vjb25kYXJ5KTtmb250LXZhcmlhbnQtbnVtZXJpYzp0YWJ1bGFyLW51bXM7fXRkLmFtdHtjb2xvcjp2YXIoLS10ZXh0LXByaW1hcnkpO2ZvbnQtd2VpZ2h0OjYwMDt9dGQgYXtjb2xvcjp2YXIoLS1iYXNlKTt0ZXh0LWRlY29yYXRpb246bm9uZTtmb250LWZhbWlseTp1aS1tb25vc3BhY2UsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxMnB4O30uY2hpcHtmb250LXNpemU6MTBweDtmb250LXdlaWdodDo2MDA7cGFkZGluZzoxcHggN3B4O2JvcmRlci1yYWRpdXM6OTlweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7fS5jaGlwLmJhc2V7Y29sb3I6dmFyKC0tYmFzZSk7fS5jaGlwLnNvbHtjb2xvcjp2YXIoLS1zb2wpO30uZW1wdHl7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzoyNHB4IDEycHg7Y29sb3I6dmFyKC0tdGV4dC1zZWNvbmRhcnkpO2ZvbnQtc2l6ZToxMy41cHg7bGluZS1oZWlnaHQ6MS42O30ubGlua3N7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHg7bWFyZ2luLXRvcDoxNnB4O30ubGlua3MgYXtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjU1MDtjb2xvcjp2YXIoLS1iYXNlKTt0ZXh0LWRlY29yYXRpb246bm9uZTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo3cHggMTJweDtiYWNrZ3JvdW5kOnZhcigtLXN1cmZhY2UtMik7fS5yZWZyZXNoe2Zsb2F0OnJpZ2h0O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLWJhc2UpO2N1cnNvcjpwb2ludGVyO2JhY2tncm91bmQ6bm9uZTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Ym9yZGVyLXJhZGl1czo3cHg7cGFkZGluZzo1cHggMTFweDt9LnN0YW1we2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1tdXRlZCk7bWFyZ2luLXRvcDoxNHB4O308L3N0eWxlPjwvaGVhZD48Ym9keT48ZGl2IGNsYXNzPSJ2aXotcm9vdCI+PGJ1dHRvbiBjbGFzcz0icmVmcmVzaCIgb25jbGljaz0ibG9hZCgpIj5SZWZyZXNoPC9idXR0b24+PGgxPkNyeXB0b1B1bHNlIGVhcm5pbmdzPHNwYW4gY2xhc3M9Im5ldC1iYWRnZSI+TElWRSDCtyBCYXNlICsgU29sYW5hPC9zcGFuPjwvaDE+PGRpdiBjbGFzcz0ic3ViIj4KVVNEQyB0byA8YSBocmVmPSJodHRwczovL2Jhc2VzY2FuLm9yZy9hZGRyZXNzLzB4OTMzMWJmODQ4OTkyQTYxZjE4NDY1NGMxYzBFOTMxYzY2Mzk4QzQwOSIgdGFyZ2V0PSJfYmxhbmsiPjB4OTMzMeKApkM0MDk8L2E+IChCYXNlKQomYW1wOyA8YSBocmVmPSJodHRwczovL3NvbHNjYW4uaW8vYWNjb3VudC9CWDhtQ1gyVGtpWWlZdlU4czk0UVQ0ZWJVWTNFNkM3dDM2YndZZ2pwdENvTiIgdGFyZ2V0PSJfYmxhbmsiPkJYOG3igKZ0Q29OPC9hPiAoU29sYW5hKQpmcm9tIDxhIGhyZWY9Imh0dHBzOi8vY3J5cHRvcHVsc2Uuc2Fhc2Nsb3VkLmFpIiB0YXJnZXQ9Il9ibGFuayI+Y3J5cHRvcHVsc2Uuc2Fhc2Nsb3VkLmFpPC9hPjwvZGl2PjxkaXYgY2xhc3M9InRpbGVzIj48ZGl2IGNsYXNzPSJ0aWxlIj48ZGl2IGNsYXNzPSJsYWJlbCI+VG90YWwgZWFybmVkPC9kaXY+PGRpdiBjbGFzcz0idmFsdWUiIGlkPSJ0LXRvdGFsIj7igJQ8L2Rpdj48ZGl2IGNsYXNzPSJoaW50Ij5VU0RDLCBib3RoIGNoYWluczwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InRpbGUiPjxkaXYgY2xhc3M9ImxhYmVsIj48c3BhbiBjbGFzcz0iZG90IGJhc2UiPjwvc3Bhbj5CYXNlPC9kaXY+PGRpdiBjbGFzcz0idmFsdWUiIGlkPSJ0LWJhc2UiPuKAlDwvZGl2PjxkaXYgY2xhc3M9ImhpbnQiIGlkPSJ0LWJhc2UtbiI+4oCUPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0idGlsZSI+PGRpdiBjbGFzcz0ibGFiZWwiPjxzcGFuIGNsYXNzPSJkb3Qgc29sIj48L3NwYW4+U29sYW5hPC9kaXY+PGRpdiBjbGFzcz0idmFsdWUiIGlkPSJ0LXNvbCI+4oCUPC9kaXY+PGRpdiBjbGFzcz0iaGludCIgaWQ9InQtc29sLW4iPuKAlDwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InRpbGUiPjxkaXYgY2xhc3M9ImxhYmVsIj5QYXltZW50czwvZGl2PjxkaXYgY2xhc3M9InZhbHVlIiBpZD0idC1jb3VudCI+4oCUPC9kaXY+PGRpdiBjbGFzcz0iaGludCI+c2V0dGxlZCBjYWxsczwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InRpbGUiPjxkaXYgY2xhc3M9ImxhYmVsIj5VbmlxdWUgcGF5ZXJzPC9kaXY+PGRpdiBjbGFzcz0idmFsdWUiIGlkPSJ0LXBheWVycyI+4oCUPC9kaXY+PGRpdiBjbGFzcz0iaGludCI+ZGlzdGluY3Qgd2FsbGV0czwvZGl2PjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImNhcmQiPjxoMj5SZWNlbnQgcGF5bWVudHMgKGJvdGggY2hhaW5zKTwvaDI+PGRpdiBpZD0icGF5bWVudHMiPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImNhcmQiPjxoMj5FYXJuaW5ncyBieSBjYXRlZ29yeTwvaDI+PGRpdiBpZD0ic2FsZXMiIGNsYXNzPSJub3RlIj5Mb2FkaW5nIHNhbGVzIGxvZ+KApjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImNhcmQiPjxoMj5Ib3cgcGF5bWVudHMgYXJyaXZlPC9oMj48ZGl2IGNsYXNzPSJub3RlIj4KQWdlbnRzIHBheSB0d28gd2F5cywgYm90aCBzZXR0bGluZyB0byB0aGUgd2FsbGV0cyBhYm92ZTogdGhlIDxiPlJFU1QgQVBJPC9iPiAoPGNvZGU+L2FwaS8qPC9jb2RlPikgYW5kIHRoZQo8Yj5NQ1Agc2VydmVyPC9iPiAoPGNvZGU+L21jcDwvY29kZT4sIGxpc3RlZCBpbiB0aGUgb2ZmaWNpYWwgTUNQIHJlZ2lzdHJ5KS4gT24tY2hhaW4gdGhleSdyZSBpZGVudGljYWwgVVNEQwp0cmFuc2ZlcnMsIHNvIHRoZXkncmUgY291bnRlZCB0b2dldGhlciBoZXJlLiBGb3IgcmF3IHJlcXVlc3Qgdm9sdW1lIHNwbGl0IGJ5IDxjb2RlPi9tY3A8L2NvZGU+IHZzIDxjb2RlPi9hcGk8L2NvZGU+LApzZWUgPGEgaHJlZj0iaHR0cHM6Ly9kYXNoLmNsb3VkZmxhcmUuY29tLz90bz0vOmFjY291bnQvd29ya2Vycy1hbmQtcGFnZXMiIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYmFzZSk7dGV4dC1kZWNvcmF0aW9uOm5vbmUiPkNsb3VkZmxhcmUg4oaSIE1ldHJpY3M8L2E+Lgo8L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJsaW5rcyI+PGEgaHJlZj0iaHR0cHM6Ly9jcnlwdG9wdWxzZS5zYWFzY2xvdWQuYWkiIHRhcmdldD0iX2JsYW5rIj5TZXJ2aWNlIGRpcmVjdG9yeTwvYT48YSBocmVmPSJodHRwczovL2NyeXB0b3B1bHNlLnNhYXNjbG91ZC5haS9tY3AiIHRhcmdldD0iX2JsYW5rIj5NQ1AgZW5kcG9pbnQ8L2E+PGEgaHJlZj0iaHR0cHM6Ly9yZWdpc3RyeS5tb2RlbGNvbnRleHRwcm90b2NvbC5pby92MC9zZXJ2ZXJzP3NlYXJjaD1jcnlwdG9wdWxzZSIgdGFyZ2V0PSJfYmxhbmsiPk1DUCByZWdpc3RyeSByZWNvcmQ8L2E+PGEgaHJlZj0iaHR0cHM6Ly9iYXNlc2Nhbi5vcmcvYWRkcmVzcy8weDkzMzFiZjg0ODk5MkE2MWYxODQ2NTRjMWMwRTkzMWM2NjM5OEM0MDkjdG9rZW50eG5zIiB0YXJnZXQ9Il9ibGFuayI+QmFzZXNjYW48L2E+PGEgaHJlZj0iaHR0cHM6Ly9zb2xzY2FuLmlvL2FjY291bnQvQlg4bUNYMlRraVlpWXZVOHM5NFFUNGViVVkzRTZDN3QzNmJ3WWdqcHRDb04iIHRhcmdldD0iX2JsYW5rIj5Tb2xzY2FuPC9hPjxhIGhyZWY9Imh0dHBzOi8veDQwMi1saXN0LmNvbS9zZXJ2aWNlcy9jcnlwdG9wdWxzZS1kYXRhLWFwaSIgdGFyZ2V0PSJfYmxhbmsiPng0MDItbGlzdDwvYT48L2Rpdj48ZGl2IGNsYXNzPSJzdGFtcCIgaWQ9InN0YW1wIj48L2Rpdj48L2Rpdj4KPHNjcmlwdD4KY29uc3QgQkFTRV9XQUxMRVQgPSAiMHg5MzMxYmY4NDg5OTJBNjFmMTg0NjU0YzFjMEU5MzFjNjYzOThDNDA5IjsKY29uc3QgQkFTRV9VU0RDID0gIjB4ODMzNTg5ZmNkNmVkYjZlMDhmNGM3YzMyZDRmNzFiNTRiZGEwMjkxMyI7CmNvbnN0IEJMT0NLU0NPVVQgPSBgaHR0cHM6Ly9iYXNlLmJsb2Nrc2NvdXQuY29tL2FwaS92Mi9hZGRyZXNzZXMvJHtCQVNFX1dBTExFVH0vdG9rZW4tdHJhbnNmZXJzP3R5cGU9RVJDLTIwJmZpbHRlcj10b2A7CmZ1bmN0aW9uIGZtdChuKSB7IHJldHVybiAobnx8MCkudG9Mb2NhbGVTdHJpbmcoImVuLVVTIiwgeyBtaW5pbXVtRnJhY3Rpb25EaWdpdHM6IG4gPCAxID8gNCA6IDIsIG1heGltdW1GcmFjdGlvbkRpZ2l0czogbiA8IDEgPyA0IDogMiB9KTsgfQphc3luYyBmdW5jdGlvbiBsb2FkQmFzZSgpIHsKbGV0IGl0ZW1zID0gW107CnRyeSB7CmxldCB1cmwgPSBCTE9DS1NDT1VULCBwYWdlcyA9IDA7CndoaWxlICh1cmwgJiYgcGFnZXMgPCA1KSB7CmNvbnN0IHIgPSBhd2FpdCBmZXRjaCh1cmwsIHsgaGVhZGVyczogeyBBY2NlcHQ6ICJhcHBsaWNhdGlvbi9qc29uIiB9IH0pOwppZiAoIXIub2spIHRocm93IG5ldyBFcnJvcigiQmxvY2tzY291dCAiICsgci5zdGF0dXMpOwpjb25zdCBqID0gYXdhaXQgci5qc29uKCk7Cml0ZW1zID0gaXRlbXMuY29uY2F0KGouaXRlbXMgfHwgW10pOwp1cmwgPSBqLm5leHRfcGFnZV9wYXJhbXMgPyBCTE9DS1NDT1VUICsgIiYiICsgbmV3IFVSTFNlYXJjaFBhcmFtcyhqLm5leHRfcGFnZV9wYXJhbXMpIDogbnVsbDsKcGFnZXMrKzsKfQp9IGNhdGNoIChlKSB7IHJldHVybiB7IGVycm9yOiBlLm1lc3NhZ2UsIHBheW1lbnRzOiBbXSB9OyB9CmNvbnN0IHBheXMgPSBpdGVtcwouZmlsdGVyKHQgPT4gKHQudG9rZW4/LmFkZHJlc3NfaGFzaCB8fCB0LnRva2VuPy5hZGRyZXNzIHx8ICIiKS50b0xvd2VyQ2FzZSgpID09PSBCQVNFX1VTREMpCi5tYXAodCA9PiAoeyBjaGFpbjogImJhc2UiLCB3aGVuOiBuZXcgRGF0ZSh0LnRpbWVzdGFtcCksIHVzZGM6IE51bWJlcih0LnRvdGFsPy52YWx1ZSB8fCAwKSAvIDFlNiwgZnJvbTogdC5mcm9tPy5oYXNoIHx8ICI/IiwgcmVmOiB0LnRyYW5zYWN0aW9uX2hhc2ggfHwgIiIgfSkpCi5maWx0ZXIocCA9PiBwLnVzZGMgPiAwKTsKcmV0dXJuIHsgcGF5bWVudHM6IHBheXMgfTsKfQphc3luYyBmdW5jdGlvbiBsb2FkU29sYW5hKCkgewp0cnkgewpjb25zdCByID0gYXdhaXQgZmV0Y2goIi9zb2xhbmEtZWFybmluZ3MiLCB7IGhlYWRlcnM6IHsgQWNjZXB0OiAiYXBwbGljYXRpb24vanNvbiIgfSB9KTsKY29uc3QgaiA9IGF3YWl0IHIuanNvbigpOwpjb25zdCBwYXlzID0gKGoucGF5bWVudHMgfHwgW10pLm1hcChwID0+ICh7IGNoYWluOiAic29sYW5hIiwgd2hlbjogcC53aGVuID8gbmV3IERhdGUocC53aGVuKSA6IG5ldyBEYXRlKDApLCB1c2RjOiBOdW1iZXIocC51c2RjIHx8IDApLCBmcm9tOiAi4oCUIiwgcmVmOiBwLnNpZyB9KSk7CnJldHVybiB7IHBheW1lbnRzOiBwYXlzLCBiYWxhbmNlOiBqLmJhbGFuY2UgfHwgMCwgZXJyb3I6IGouZXJyb3IgfTsKfSBjYXRjaCAoZSkgeyByZXR1cm4geyBlcnJvcjogZS5tZXNzYWdlLCBwYXltZW50czogW10sIGJhbGFuY2U6IDAgfTsgfQp9CmFzeW5jIGZ1bmN0aW9uIGxvYWQoKSB7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzdGFtcCIpLnRleHRDb250ZW50ID0gIkxvYWRpbmfigKYiOwpjb25zdCBbYmFzZSwgc29sXSA9IGF3YWl0IFByb21pc2UuYWxsKFtsb2FkQmFzZSgpLCBsb2FkU29sYW5hKCldKTsKY29uc3QgYmFzZVRvdGFsID0gYmFzZS5wYXltZW50cy5yZWR1Y2UoKHMsIHApID0+IHMgKyBwLnVzZGMsIDApOwpjb25zdCBzb2xUb3RhbCA9IHNvbC5wYXltZW50cy5yZWR1Y2UoKHMsIHApID0+IHMgKyBwLnVzZGMsIDApOwpjb25zdCBhbGwgPSBbLi4uYmFzZS5wYXltZW50cywgLi4uc29sLnBheW1lbnRzXS5zb3J0KChhLCBiKSA9PiBiLndoZW4gLSBhLndoZW4pOwpjb25zdCBwYXllcnMgPSBuZXcgU2V0KGFsbC5tYXAocCA9PiAocC5jaGFpbiArICI6IiArIHAuZnJvbSkudG9Mb3dlckNhc2UoKSkpLnNpemU7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0LXRvdGFsIikudGV4dENvbnRlbnQgPSAiJCIgKyBmbXQoYmFzZVRvdGFsICsgc29sVG90YWwpOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidC1iYXNlIikudGV4dENvbnRlbnQgPSAiJCIgKyBmbXQoYmFzZVRvdGFsKTsKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInQtYmFzZS1uIikudGV4dENvbnRlbnQgPSBiYXNlLnBheW1lbnRzLmxlbmd0aCArICIgcGF5bWVudHMiICsgKGJhc2UuZXJyb3IgPyAiIChmZWVkIGVycm9yKSIgOiAiIik7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0LXNvbCIpLnRleHRDb250ZW50ID0gIiQiICsgZm10KHNvbFRvdGFsIHx8IHNvbC5iYWxhbmNlIHx8IDApOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidC1zb2wtbiIpLnRleHRDb250ZW50ID0gc29sLmVycm9yID8gImNoYWluIHJlYWQgZXJyb3IiIDogKHNvbC5wYXltZW50cy5sZW5ndGggKyAiIHBheW1lbnRzIik7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0LWNvdW50IikudGV4dENvbnRlbnQgPSBhbGwubGVuZ3RoLnRvTG9jYWxlU3RyaW5nKCk7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0LXBheWVycyIpLnRleHRDb250ZW50ID0gcGF5ZXJzLnRvTG9jYWxlU3RyaW5nKCk7CmNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInBheW1lbnRzIik7CmlmICghYWxsLmxlbmd0aCkgewplbC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZW1wdHkiPk5vIHBheW1lbnRzIHlldC48YnI+ClRoZSBBUEkgaXMgbGl2ZSBvbiA8Yj5CYXNlICsgU29sYW5hPC9iPiBhbmQgbGlzdGVkIGluIHRoZSBNQ1AgcmVnaXN0cnkg4oCUIGZpcnN0IHRoaXJkLXBhcnR5IHBheW1lbnRzCnR5cGljYWxseSBmb2xsb3cgcHJvbW90aW9uLiBBbnkgeDQwMiBjbGllbnQgY2FsbGluZyBhbiBlbmRwb2ludCBwYXlzIGluc3RhbnRseSB0byB5b3VyIHdhbGxldC48L2Rpdj5gOwp9IGVsc2Ugewpjb25zdCByb3dzID0gYWxsLnNsaWNlKDAsIDMwKS5tYXAocCA9PiB7CmNvbnN0IGxpbmsgPSBwLmNoYWluID09PSAiYmFzZSIKPyBgPGEgaHJlZj0iaHR0cHM6Ly9iYXNlc2Nhbi5vcmcvdHgvJHtwLnJlZn0iIHRhcmdldD0iX2JsYW5rIj4ke3AucmVmLnNsaWNlKDAsMTApfeKApjwvYT5gCjogYDxhIGhyZWY9Imh0dHBzOi8vc29sc2Nhbi5pby90eC8ke3AucmVmfSIgdGFyZ2V0PSJfYmxhbmsiPiR7cC5yZWYuc2xpY2UoMCwxMCl94oCmPC9hPmA7CmNvbnN0IHdobyA9IHAuY2hhaW4gPT09ICJiYXNlIgo/IGA8YSBocmVmPSJodHRwczovL2Jhc2VzY2FuLm9yZy9hZGRyZXNzLyR7cC5mcm9tfSIgdGFyZ2V0PSJfYmxhbmsiPiR7cC5mcm9tLnNsaWNlKDAsOCl94oCmJHtwLmZyb20uc2xpY2UoLTQpfTwvYT5gCjogIuKAlCI7CnJldHVybiBgPHRyPjx0ZD4ke3Aud2hlbi5nZXRUaW1lKCkgPyBwLndoZW4udG9Mb2NhbGVTdHJpbmcoKSA6ICLigJQifTwvdGQ+Cjx0ZD48c3BhbiBjbGFzcz0iY2hpcCAke3AuY2hhaW59Ij4ke3AuY2hhaW59PC9zcGFuPjwvdGQ+Cjx0ZD4ke3dob308L3RkPjx0ZCBjbGFzcz0iYW10Ij4kJHtmbXQocC51c2RjKX08L3RkPjx0ZD4ke2xpbmt9PC90ZD48L3RyPmA7Cn0pLmpvaW4oIiIpOwplbC5pbm5lckhUTUwgPSBgPHRhYmxlPjx0aGVhZD48dHI+PHRoPldoZW48L3RoPjx0aD5DaGFpbjwvdGg+PHRoPlBheWVyPC90aD48dGg+VVNEQzwvdGg+PHRoPlR4PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PiR7cm93c308L3Rib2R5PjwvdGFibGU+YDsKfQpjb25zdCBub3RlcyA9IFtdOwppZiAoYmFzZS5lcnJvcikgbm90ZXMucHVzaCgiQmFzZSBmZWVkOiAiICsgYmFzZS5lcnJvcik7CmlmIChzb2wuZXJyb3IpIG5vdGVzLnB1c2goIlNvbGFuYSBmZWVkOiAiICsgc29sLmVycm9yKTsKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInN0YW1wIikudGV4dENvbnRlbnQgPSAiVXBkYXRlZCAiICsgbmV3IERhdGUoKS50b0xvY2FsZVN0cmluZygpICsKIiDCtyBCYXNlIHZpYSBCbG9ja3Njb3V0LCBTb2xhbmEgdmlhIFJQQyIgKyAobm90ZXMubGVuZ3RoID8gIiDCtyAiICsgbm90ZXMuam9pbigiIMK3ICIpIDogIiIpOwp9CmxvYWQoKTsKCmFzeW5jIGZ1bmN0aW9uIGxvYWRTYWxlcygpIHsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzYWxlcyIpOwogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goIi9zYWxlcy1zdGF0cyIpOwogICAgY29uc3QgcyA9IGF3YWl0IHIuanNvbigpOwogICAgY29uc3QgbGFiZWxzID0geyBjcnlwdG86ICJDcnlwdG8gZGF0YSIsIGhhbGFsOiAiSGFsYWwsIG1vc3F1ZXMgJiBwcmF5ZXIiLCBmeDogIkZYIHJhdGVzIiB9OwogICAgY29uc3QgY2hpcCA9IHsgY3J5cHRvOiAiYmFzZSIsIGhhbGFsOiAic29sIiwgZng6ICJiYXNlIiB9OwogICAgY29uc3QgY2F0ID0gKG5hbWUpID0+IHMuYnlfY2F0ZWdvcnkuZmluZCgoYykgPT4gYy5jYXRlZ29yeSA9PT0gbmFtZSkgfHwgeyBuOiAwLCB1c2Q6IDAgfTsKICAgIGNvbnN0IGlkeCA9IHMuaGFsYWxfaW5kZXggfHwge30sIG1pZHggPSBzLm1vc3F1ZV9pbmRleCB8fCB7fTsKICAgIGNvbnN0IGhpbnRzID0geyBjcnlwdG86ICJwYWlkIGNhbGxzIiwgaGFsYWw6ICJwYWlkIGNhbGxzIMK3ICIgKyAoaWR4LnBsYWNlc19pbmRleGVkIHx8IDApLnRvTG9jYWxlU3RyaW5nKCkgKyAiIGhhbGFsIHBsYWNlcywgIiArIChtaWR4Lm1vc3F1ZXNfaW5kZXhlZCB8fCAwKS50b0xvY2FsZVN0cmluZygpICsgIiBtb3NxdWVzIGluZGV4ZWQiLCBmeDogInBhaWQgY2FsbHMgwrcgRUNCIHJhdGVzIiB9OwogICAgY29uc3QgdGlsZXMgPSBPYmplY3Qua2V5cyhsYWJlbHMpLm1hcCgoaykgPT4gYDxkaXYgY2xhc3M9InRpbGUiPjxkaXYgY2xhc3M9ImxhYmVsIj4ke2xhYmVsc1trXX08L2Rpdj48ZGl2IGNsYXNzPSJ2YWx1ZSI+JCR7Zm10KGNhdChrKS51c2QpfTwvZGl2PjxkaXYgY2xhc3M9ImhpbnQiPiR7Y2F0KGspLm59ICR7aGludHNba119PC9kaXY+PC9kaXY+YCkuam9pbigiIik7CiAgICBjb25zdCByb3dzID0gKHMuYnlfZW5kcG9pbnQgfHwgW10pLm1hcCgoZSkgPT4gYDx0cj48dGQ+PGNvZGU+JHtlLnBhdGh9PC9jb2RlPjwvdGQ+PHRkPjxzcGFuIGNsYXNzPSJjaGlwICR7Y2hpcFtlLmNhdGVnb3J5XSB8fCAiYmFzZSJ9Ij4ke2UuY2F0ZWdvcnl9PC9zcGFuPjwvdGQ+PHRkPiR7ZS5ufTwvdGQ+PHRkIGNsYXNzPSJhbXQiPiQke2ZtdChlLnVzZCl9PC90ZD48dGQ+JHtlLmxhc3QgPyBuZXcgRGF0ZShlLmxhc3QpLnRvTG9jYWxlRGF0ZVN0cmluZygpIDogIuKAlCJ9PC90ZD48L3RyPmApLmpvaW4oIiIpOwogICAgZWwuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InRpbGVzIiBzdHlsZT0ibWFyZ2luOjAgMCAxMnB4Ij4ke3RpbGVzfTwvZGl2PgogICAgJHtyb3dzID8gYDx0YWJsZT48dGhlYWQ+PHRyPjx0aD5FbmRwb2ludDwvdGg+PHRoPkNhdGVnb3J5PC90aD48dGg+Q2FsbHM8L3RoPjx0aD5VU0RDPC90aD48dGg+TGFzdDwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4ke3Jvd3N9PC90Ym9keT48L3RhYmxlPmAgOiAnPGRpdiBjbGFzcz0iZW1wdHkiPk5vIHBlci1lbmRwb2ludCBzYWxlcyBsb2dnZWQgeWV0LjwvZGl2Pid9CiAgICA8ZGl2IGNsYXNzPSJub3RlIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij5QZXItZW5kcG9pbnQgYXR0cmlidXRpb24gaXMgbG9nZ2VkIGJ5IHRoZSBBUEkgYXQgc2V0dGxlbWVudCB0aW1lJHtzLnNpbmNlID8gIiAoc2luY2UgIiArIG5ldyBEYXRlKHMuc2luY2UpLnRvTG9jYWxlRGF0ZVN0cmluZygpICsgIikiIDogIiJ9OyBvbi1jaGFpbiB0b3RhbHMgYWJvdmUgaW5jbHVkZSBhbGwgaGlzdG9yeSAoaW5jbHVkaW5nIGRlcG9zaXRzIHlvdSBtYWRlIHlvdXJzZWxmKS48L2Rpdj5gOwogIH0gY2F0Y2ggKGUpIHsgZWwudGV4dENvbnRlbnQgPSAiU2FsZXMgbG9nIHVuYXZhaWxhYmxlOiAiICsgZS5tZXNzYWdlOyB9Cn0KbG9hZFNhbGVzKCk7Cjwvc2NyaXB0Pgo8L2JvZHk+PC9odG1sPgo="), (c) => c.charCodeAt(0)));

