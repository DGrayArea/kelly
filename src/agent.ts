/**
 * Phase 1: dry-run harness.
 *
 * Streams live Kuru market events, records them to JSONL for replay/backtest,
 * maintains a mark price, and runs the decision loop. It NEVER signs: there is
 * no signer constructed anywhere in this file.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import {
  activeNetwork,
  marketAddress,
  MARKET,
  NETWORK,
  DRY_RUN,
  BANKROLL_USD,
} from "./config";
import { MarketFeed, MarketEvent } from "./feed";
import { RiskState, positionSize, DEFAULT_SIZING } from "./kelly";

const DATA_DIR = path.join(__dirname, "..", "data");

function ts() {
  return new Date().toISOString().slice(11, 23);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public Monad RPC is flaky; an unattended agent must not die on one timeout. */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 5
): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const wait = Math.min(1000 * 2 ** (i - 1), 8000);
      console.log(
        `${ts()}  ${label} failed (${i}/${attempts}): ${(e?.message || e).toString().slice(0, 60)} · retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main() {
  if (!DRY_RUN) {
    console.error(
      "refusing to run: agent.ts is the dry-run harness and never signs.\n" +
        "Unset DRY_RUN=false, or use the (not yet written) live runner."
    );
    process.exit(1);
  }

  const net = activeNetwork();
  const market = marketAddress();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tape = path.join(
    DATA_DIR,
    `${NETWORK}-${MARKET}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.jsonl`
  );
  const sink = fs.createWriteStream(tape, { flags: "a" });

  console.log(`\nkelly · dry run`);
  console.log(`network   ${NETWORK}  (${MARKET} @ ${market})`);
  console.log(`ws        ${net.wsUrl}`);
  console.log(`tape      ${tape}`);
  console.log(`bankroll  $${BANKROLL_USD.toFixed(2)}`);
  console.log(
    `sizing    ${DEFAULT_SIZING.fraction}x Kelly · cap ${(DEFAULT_SIZING.maxFractionOfBankroll * 100).toFixed(0)}% · halt at ${(DEFAULT_SIZING.maxDrawdown * 100).toFixed(0)}% DD\n`
  );

  const provider = new ethers.providers.JsonRpcProvider(net.rpcUrl);
  const mp = await withRetry("getMarketParams", () =>
    KuruSdk.ParamFetcher.getMarketParams(provider, market)
  );

  // seed a mark price from the current book so we aren't flying blind
  const book = await withRetry("getL2OrderBook", () =>
    KuruSdk.OrderBook.getFormattedL2OrderBook(provider, market, mp)
  );
  const bids = book.bids.filter((l) => l[1] > 0).map((l) => l[0]);
  const asks = book.asks.filter((l) => l[1] > 0).map((l) => l[0]);
  let mark = (Math.max(...bids) + Math.min(...asks)) / 2;
  console.log(`${ts()}  seed mark ${mark.toFixed(6)}\n`);

  const risk = new RiskState(BANKROLL_USD);
  let orders = 0;
  let trades = 0;
  let volume = 0;

  const feed = new MarketFeed(net.wsUrl, market, mp);

  const record = (e: MarketEvent) => sink.write(JSON.stringify(e) + "\n");

  feed.onOrder((e) => {
    orders++;
    record(e);
    if (orders % 25 === 0) {
      console.log(
        `${ts()}  orders=${orders} trades=${trades} vol=${volume.toFixed(2)} mark=${mark.toFixed(6)}`
      );
    }
  });

  feed.onTrade((e) => {
    trades++;
    record(e);
    if (Number.isFinite(e.price) && e.price > 0) mark = e.price;
    volume += Number.isFinite(e.filledSize) ? e.filledSize : 0;

    // --- decision point (dry run) ---
    const blocked = risk.blockedReason();
    if (blocked) return;

    // Placeholder edge estimate. Phase 3 replaces this with a real signal;
    // right now it exists to prove the sizing path end to end.
    const winProb = 0.5;
    const payoffRatio = 1.0;
    const size = positionSize(risk.bankroll, { winProb, payoffRatio });

    if (size <= 0) return; // no edge -> Kelly says do not bet

    console.log(
      `${ts()}  WOULD TRADE ${e.isBuy ? "BUY " : "SELL"} $${size.toFixed(2)} @ ${e.price.toFixed(6)}  (dry)`
    );
    risk.markActed();
  });

  feed.onStatus((s) => console.log(`${ts()}  [feed] ${s}`));

  const runSeconds = Number(process.env.RUN_SECONDS || 0);
  console.log(
    `${ts()}  listening${runSeconds ? ` for ${runSeconds}s` : ""}. ctrl-c to stop.\n`
  );

  const shutdown = async () => {
    console.log(
      `\n${ts()}  stopping. orders=${orders} trades=${trades} vol=${volume.toFixed(2)}`
    );
    console.log(`${ts()}  risk ${JSON.stringify(risk.snapshot())}`);
    console.log(`${ts()}  tape written to ${tape}`);
    await feed.close();
    sink.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (runSeconds > 0) setTimeout(shutdown, runSeconds * 1000);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  process.exit(1);
});
