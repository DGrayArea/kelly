import { FlowSignal, DEFAULT_SIGNAL } from "./signal";

let fails = 0;
const check = (name: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "pass" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const T0 = 1_000_000;
const feed = (s: FlowSignal, n: number, isBuy: boolean, isTrade = true, t = T0) => {
  for (let i = 0; i < n; i++) s.add(t + i, 10, isBuy, isTrade);
};

// all aggressive buying -> max positive score, lean buy
{
  const s = new FlowSignal();
  feed(s, 10, true);
  const o = s.evaluate(T0 + 10);
  check("all buys -> side buy", o.side === "buy");
  check("all buys -> tfi = +1", Math.abs(o.tfi - 1) < 1e-9, `tfi=${o.tfi}`);
  check("winProb capped at maxEdge", Math.abs(o.winProb - (0.5 + DEFAULT_SIGNAL.maxEdge * DEFAULT_SIGNAL.tradeWeight)) < 1e-9, `p=${o.winProb.toFixed(4)}`);
  check("winProb stays sane (<0.6)", o.winProb < 0.6, `p=${o.winProb.toFixed(4)}`);
}

// all selling -> negative, lean sell
{
  const s = new FlowSignal();
  feed(s, 10, false);
  const o = s.evaluate(T0 + 10);
  check("all sells -> side sell", o.side === "sell");
  check("all sells -> score negative", o.score < 0, `score=${o.score.toFixed(3)}`);
}

// balanced flow -> no signal
{
  const s = new FlowSignal();
  feed(s, 6, true);
  feed(s, 6, false, true, T0 + 100);
  const o = s.evaluate(T0 + 200);
  check("balanced -> no side", o.side === null, `score=${o.score.toFixed(3)}`);
  check("balanced -> p=0.5", Math.abs(o.winProb - 0.5) < 1e-9);
}

// below minTrades -> refuse to signal
{
  const s = new FlowSignal();
  feed(s, 2, true);
  const o = s.evaluate(T0 + 5);
  check("under minTrades -> null", o.side === null, `n=${o.tradeCount}`);
}

// window pruning drops stale samples
{
  const s = new FlowSignal();
  feed(s, 10, true);
  const stale = s.evaluate(T0 + DEFAULT_SIGNAL.windowMs + 5000);
  check("stale samples pruned", stale.tradeCount === 0, `n=${stale.tradeCount}`);
  check("pruned -> no side", stale.side === null);
}

// trades weigh more than resting orders
{
  const a = new FlowSignal();
  feed(a, 10, true, true);            // 10 aggressive buys
  const b = new FlowSignal();
  feed(b, 10, true, false);           // 10 posted bids
  feed(b, 10, true, true);            // + trades so it clears minTrades
  const oa = a.evaluate(T0 + 20);
  check("trade flow dominates", Math.abs(oa.score) > 0.7, `score=${oa.score.toFixed(3)}`);
}

// zero/garbage quantities ignored
{
  const s = new FlowSignal();
  s.add(T0, 0, true, true);
  s.add(T0, NaN, true, true);
  s.add(T0, -5, true, true);
  check("bad quantities rejected", s.size === 0, `size=${s.size}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
