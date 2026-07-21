/**
 * Phase 0: read-only. Connects to Monad, reads a Kuru market's params and L2 book.
 * Signs nothing, sends nothing. Safe to run without a private key.
 */
import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import { activeNetwork, NETWORK } from "./config";

const BANKROLL_USD = 25; // Agent Arena prefunds each agent with $25

function fmt(n: number, dp = 6) {
  return Number.isFinite(n) ? n.toFixed(dp) : "n/a";
}

async function main() {
  const net = activeNetwork();
  const marketName = process.env.MARKET || "MON-USDC";
  const marketAddress = (net.markets as Record<string, string>)[marketName];

  if (!marketAddress) {
    throw new Error(
      `Unknown market "${marketName}" on ${NETWORK}. Available: ${Object.keys(net.markets).join(", ")}`
    );
  }

  console.log(`\nnetwork      ${NETWORK}`);
  console.log(`rpc          ${net.rpcUrl}`);
  console.log(`market       ${marketName} @ ${marketAddress}`);

  const provider = new ethers.providers.JsonRpcProvider(net.rpcUrl);

  const [chain, block] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
  ]);
  console.log(`chainId      ${chain.chainId}`);
  console.log(`block        ${block}`);

  // --- market params (fees, precision, size limits) ---
  const mp = await KuruSdk.ParamFetcher.getMarketParams(provider, marketAddress);

  const makerBps = mp.makerFeeBps.toNumber();
  const takerBps = mp.takerFeeBps.toNumber();

  console.log(`\n--- market params ---`);
  console.log(`base/quote   ${mp.baseAssetAddress} / ${mp.quoteAssetAddress}`);
  console.log(`decimals     base ${mp.baseAssetDecimals} · quote ${mp.quoteAssetDecimals}`);
  console.log(`tickSize     ${mp.tickSize.toString()}`);
  console.log(`minSize      ${mp.minSize.toString()}`);
  console.log(`maxSize      ${mp.maxSize.toString()}`);
  console.log(`fees         maker ${makerBps} bps · taker ${takerBps} bps`);

  // --- L2 book ---
  const book = await KuruSdk.OrderBook.getFormattedL2OrderBook(
    provider,
    marketAddress,
    mp
  );

  const bids = book.bids.filter((l) => l[1] > 0);
  const asks = book.asks.filter((l) => l[1] > 0);
  const bestBid = bids.length ? bids[0][0] : NaN;
  const bestAsk = asks.length ? asks[asks.length - 1][0] : NaN;

  // asks may come back descending; normalise to find the true best (lowest) ask
  const trueBestAsk = asks.length ? Math.min(...asks.map((l) => l[0])) : NaN;
  const trueBestBid = bids.length ? Math.max(...bids.map((l) => l[0])) : NaN;

  const mid = (trueBestBid + trueBestAsk) / 2;
  const spread = trueBestAsk - trueBestBid;
  const spreadBps = (spread / mid) * 10_000;

  console.log(`\n--- L2 book (block ${book.blockNumber}) ---`);
  console.log(`levels       ${bids.length} bids · ${asks.length} asks`);
  console.log(`best bid     ${fmt(trueBestBid)}`);
  console.log(`best ask     ${fmt(trueBestAsk)}`);
  console.log(`mid          ${fmt(mid)}`);
  console.log(`spread       ${fmt(spread)}  (${fmt(spreadBps, 2)} bps)`);

  console.log(`\ntop 5 asks (price × size)`);
  [...asks]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 5)
    .reverse()
    .forEach((l) => console.log(`  ${fmt(l[0])}  ×  ${fmt(l[1], 4)}`));
  console.log(`  ${"-".repeat(28)}`);
  console.log(`top 5 bids (price × size)`);
  [...bids]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5)
    .forEach((l) => console.log(`  ${fmt(l[0])}  ×  ${fmt(l[1], 4)}`));

  // --- the number that decides strategy viability on a $25 bankroll ---
  const roundTripTakerBps = takerBps * 2;
  const roundTripMakerBps = makerBps * 2;
  console.log(`\n--- cost of doing business on $${BANKROLL_USD} ---`);
  console.log(`round-trip taker   ${roundTripTakerBps} bps  =  $${fmt((roundTripTakerBps / 10_000) * BANKROLL_USD, 4)} per full-size flip`);
  console.log(`round-trip maker   ${roundTripMakerBps} bps  =  $${fmt((roundTripMakerBps / 10_000) * BANKROLL_USD, 4)} per full-size flip`);
  console.log(`spread is ${fmt(spreadBps, 1)} bps; taker round-trip is ${roundTripTakerBps} bps`);
  console.log(
    spreadBps > roundTripTakerBps
      ? `  -> crossing the spread can pay for itself here`
      : `  -> crossing the spread LOSES to fees; must post passively (maker)`
  );
  console.log();
}

main().catch((e) => {
  console.error("\nERROR:", e.message || e);
  process.exit(1);
});
