/**
 * Replay harness: run the strategy over a recorded tape.
 *
 * Deliberate about what this does NOT model, so the numbers are not oversold:
 *   - no queue position (a passive order may never fill)
 *   - no market impact from our own size
 *   - spread cost approximated by a flat bps, since the tape stores events, not
 *     full book snapshots
 *   - fills assumed at mark +/- half spread
 *
 * So treat the output as a signal-quality check, not a profit forecast. The
 * baselines exist for exactly that reason: a strategy that cannot beat "always
 * long" and "random entry" has no edge worth sizing.
 */
import * as fs from "fs";
import * as path from "path";
import { FlowSignal, DEFAULT_SIGNAL } from "./signal";
import { RiskState, positionSize, DEFAULT_SIZING } from "./kelly";

const SPREAD_BPS = Number(process.env.SPREAD_BPS || 5);
const HOLD_MS = Number(process.env.HOLD_MS || 30_000);
const START_BANKROLL = Number(process.env.BANKROLL_USD || 25);

/**
 * Measured on Monad mainnet: ~1.32M gas per Kuru order at 102 gwei, MON ~= $0.0229
 * => ~$0.00308 per transaction, two transactions per round trip.
 *
 * This is a FIXED cost, so its bps impact scales inversely with position size:
 * negligible on a $25 position (2.5 bps), ruinous on a $1 one (62 bps). Fixed
 * costs punish small bets, which pulls directly against Kelly conservatism.
 */
const GAS_USD_PER_TX = Number(process.env.GAS_USD_PER_TX || 0.00308);

interface Ev {
  kind: "order" | "trade";
  ts: number;
  price: number;
  size?: number;
  filledSize?: number;
  isBuy: boolean;
}

interface Position {
  side: "buy" | "sell";
  entry: number;
  notional: number;
  openedAt: number;
}

interface Result {
  name: string;
  bankroll: number;
  trades: number;
  wins: number;
  maxDD: number;
}

function loadTape(file: string): Ev[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => Number.isFinite(e.price) && e.price > 0)
    .sort((a, b) => a.ts - b.ts);
}

/** Close a position and return the realised PnL in quote terms. */
function closePnl(pos: Position, exit: number): number {
  const dir = pos.side === "buy" ? 1 : -1;
  const gross = pos.notional * ((exit - pos.entry) / pos.entry) * dir;
  // spread scales with size; gas does not
  const spreadCost = pos.notional * (SPREAD_BPS / 10_000) * 2;
  const gasCost = GAS_USD_PER_TX * 2;
  return gross - spreadCost - gasCost;
}

type Decide = (e: Ev, mark: number) => "buy" | "sell" | null;

function run(name: string, events: Ev[], decide: Decide, useKelly: boolean): Result {
  const risk = new RiskState(START_BANKROLL);
  let bankroll = START_BANKROLL;
  let peak = bankroll;
  let maxDD = 0;
  let pos: Position | null = null;
  let trades = 0;
  let wins = 0;
  let mark = events.find((e) => e.kind === "trade")?.price ?? events[0].price;

  for (const e of events) {
    if (e.kind === "trade") mark = e.price;

    // exit on hold expiry
    if (pos && e.ts - pos.openedAt >= HOLD_MS) {
      const pnl = closePnl(pos, mark);
      bankroll += pnl;
      trades++;
      if (pnl > 0) wins++;
      pos = null;
      risk.update(bankroll);
      peak = Math.max(peak, bankroll);
      maxDD = Math.max(maxDD, peak > 0 ? (peak - bankroll) / peak : 0);
    }

    if (pos) continue;
    if (risk.blockedReason(e.ts)) continue;

    const side = decide(e, mark);
    if (!side) continue;

    const notional = useKelly
      ? positionSize(bankroll, { winProb: lastWinProb, payoffRatio: 1 })
      : bankroll * DEFAULT_SIZING.maxFractionOfBankroll;

    if (notional <= 0) continue;

    pos = { side, entry: mark, notional, openedAt: e.ts };
    risk.markActed(e.ts);
  }

  return { name, bankroll, trades, wins, maxDD };
}

// carries the win prob from the signal into the sizer for the strategy run
let lastWinProb = 0.5;

function main() {
  const dir = path.join(__dirname, "..", "data");
  const arg = process.argv[2];
  const files = arg
    ? [arg]
    : fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(dir, f));

  if (!files.length) {
    console.error("no tape found in data/. Run `npm run agent` first.");
    process.exit(1);
  }

  const events: Ev[] = files.flatMap(loadTape).sort((a, b) => a.ts - b.ts);
  const trades = events.filter((e) => e.kind === "trade");

  if (trades.length < 20) {
    console.error(
      `only ${trades.length} trades in tape; need ~20+ for anything meaningful. Record longer.`
    );
    process.exit(1);
  }

  const spanMin = (events[events.length - 1].ts - events[0].ts) / 60000;
  console.log(`\nkelly · replay`);
  console.log(`tapes     ${files.length}`);
  console.log(`events    ${events.length} (${trades.length} trades) over ${spanMin.toFixed(1)} min`);
  console.log(`assumes   ${SPREAD_BPS} bps spread + $${GAS_USD_PER_TX.toFixed(5)}/tx gas · ${HOLD_MS / 1000}s hold\n`);

  // --- strategy: flow imbalance, Kelly sized ---
  const sig = new FlowSignal(DEFAULT_SIGNAL);
  const strategy: Decide = (e, _mark) => {
    const qty = e.kind === "trade" ? e.filledSize ?? 0 : e.size ?? 0;
    sig.add(e.ts, qty, e.isBuy, e.kind === "trade");
    const out = sig.evaluate(e.ts);
    lastWinProb = out.winProb;
    return out.side;
  };

  // --- baselines ---
  let flipped = false;
  const alwaysLong: Decide = () => (flipped ? null : "buy");
  let seed = 42;
  const random: Decide = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296 > 0.97 ? (seed % 2 ? "buy" : "sell") : null;
  };

  const results = [
    run("flow + Kelly", events, strategy, true),
    run("always long", events, alwaysLong, false),
    run("random entry", events, random, false),
  ];

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    pad("strategy", 16) + pad("final", 10) + pad("return", 10) + pad("trades", 8) + pad("win%", 8) + "maxDD"
  );
  console.log("-".repeat(60));
  for (const r of results) {
    const ret = ((r.bankroll - START_BANKROLL) / START_BANKROLL) * 100;
    const wr = r.trades ? (r.wins / r.trades) * 100 : 0;
    console.log(
      pad(r.name, 16) +
        pad("$" + r.bankroll.toFixed(2), 10) +
        pad((ret >= 0 ? "+" : "") + ret.toFixed(2) + "%", 10) +
        pad(String(r.trades), 8) +
        pad(wr.toFixed(0) + "%", 8) +
        (r.maxDD * 100).toFixed(1) + "%"
    );
  }

  const strat = results[0];
  const best = Math.max(results[1].bankroll, results[2].bankroll);
  const beatBaselines = strat.bankroll > best;
  const profitable = strat.bankroll > START_BANKROLL;
  const MIN_TRADES = 30; // below this, any result is noise

  console.log();
  if (strat.trades === 0) {
    console.log("verdict   signal never fired. Loosen minTrades or record longer.");
  } else if (strat.trades < MIN_TRADES) {
    console.log(
      `verdict   INCONCLUSIVE. Only ${strat.trades} trades (need ${MIN_TRADES}+). ` +
        `Result is noise regardless of sign.`
    );
  } else if (profitable && beatBaselines) {
    console.log("verdict   profitable AND beat baselines. Worth pursuing.");
  } else if (beatBaselines && !profitable) {
    // losing less than a bad baseline is not an edge
    console.log(
      "verdict   NO EDGE. Beat baselines only by losing less (smaller/fewer bets), " +
        "not by predicting direction. Do not size up."
    );
  } else {
    console.log("verdict   NO EDGE. Did not beat baselines.");
  }
  console.log(
    "note      small sample and an approximated spread. Treat as signal check, not forecast.\n"
  );
}

main();
