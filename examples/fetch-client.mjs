// Minimal x402 client: pays per call from a Base wallet holding USDC.
//   npm i @x402/fetch @x402/evm viem
//   PRIVATE_KEY=0x... node fetch-client.mjs
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const fetchWithPay = wrapFetchWithPayment(fetch, account);

const base = "https://cryptopulse.saascloud.ai";
for (const path of [
  "/api/prayer-times?lat=40.7128&lng=-74.006&method=ISNA",
  "/api/halal/near?lat=40.7128&lng=-74.006&radius_km=3&limit=5",
  "/api/funding-rates?symbols=BTC,ETH",
  "/api/fx?from=USD&to=EUR,GBP&amount=100",
]) {
  const r = await fetchWithPay(base + path);
  console.log(path, r.status, JSON.stringify(await r.json()).slice(0, 300));
}
