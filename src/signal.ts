/**
 * Signal layer: turn raw market events into an edge estimate that Kelly can size.
 *
 * On a CLOB the cheapest real edge is order-flow imbalance. Two variants here:
 *
 *   Trade-flow imbalance (TFI)  - who is crossing the spread. Aggressive buyers
 *     lifting offers is a stronger short-horizon signal than resting orders,
 *     because a taker has revealed urgency by paying the spread.
 *
 *   Book-flow imbalance (BFI)   - the balance of newly posted bids vs asks.
 *     Weaker and easier to spoof (an order can be cancelled; a trade cannot be
 *     undone), so it is weighted lower.
 *
 * Both are computed over a rolling time window and combined into a directional
 * score in [-1, 1]. The score is then mapped to a win probability, deliberately
 * conservatively: even a strong imbalance only nudges p a little above 0.5,
 * because short-horizon flow is a weak predictor and overstating p is exactly
 * how a Kelly-sized bettor goes bust.
 */

export interface SignalConfig {
  /** Rolling window in ms. */
  windowMs: number;
  /** Weight of trade flow vs book flow. */
  tradeWeight: number;
  /** Max deviation from p=0.5 the signal is ever allowed to claim. */
  maxEdge: number;
  /** Ignore the signal until this many trades are in the window. */
  minTrades: number;
}

export const DEFAULT_SIGNAL: SignalConfig = {
  windowMs: 60_000,
  tradeWeight: 0.75,
  maxEdge: 0.08, // p is clamped to [0.42, 0.58]
  minTrades: 5,
};

interface FlowSample {
  ts: number;
  qty: number;
  isBuy: boolean;
  isTrade: boolean;
}

export interface SignalOutput {
  /** Directional score in [-1, 1]. Positive = upward pressure. */
  score: number;
  /** Kelly inputs. winProb is for the side implied by score's sign. */
  winProb: number;
  payoffRatio: number;
  /** Which way to lean, or null when there is no actionable signal. */
  side: "buy" | "sell" | null;
  tradeCount: number;
  tfi: number;
  bfi: number;
}

export class FlowSignal {
  private samples: FlowSample[] = [];

  constructor(private cfg: SignalConfig = DEFAULT_SIGNAL) {}

  add(ts: number, qty: number, isBuy: boolean, isTrade: boolean) {
    if (!Number.isFinite(qty) || qty <= 0) return;
    this.samples.push({ ts, qty, isBuy, isTrade });
    this.prune(ts);
  }

  private prune(now: number) {
    const cutoff = now - this.cfg.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i].ts < cutoff) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  /** Signed imbalance of a subset, in [-1, 1]. */
  private imbalance(isTrade: boolean): number {
    let buy = 0;
    let sell = 0;
    for (const s of this.samples) {
      if (s.isTrade !== isTrade) continue;
      if (s.isBuy) buy += s.qty;
      else sell += s.qty;
    }
    const total = buy + sell;
    if (total <= 0) return 0;
    return (buy - sell) / total;
  }

  evaluate(now = Date.now()): SignalOutput {
    this.prune(now);
    const tradeCount = this.samples.filter((s) => s.isTrade).length;

    const tfi = this.imbalance(true);
    const bfi = this.imbalance(false);
    const w = this.cfg.tradeWeight;
    const score = w * tfi + (1 - w) * bfi;

    if (tradeCount < this.cfg.minTrades || score === 0) {
      return { score, winProb: 0.5, payoffRatio: 1, side: null, tradeCount, tfi, bfi };
    }

    // Map |score| -> edge, capped. Conservative by construction.
    const edge = Math.min(Math.abs(score), 1) * this.cfg.maxEdge;
    const winProb = 0.5 + edge;

    return {
      score,
      winProb,
      // Symmetric exit assumption; Phase 3 can fit this from realised moves.
      payoffRatio: 1,
      side: score > 0 ? "buy" : "sell",
      tradeCount,
      tfi,
      bfi,
    };
  }

  get size() {
    return this.samples.length;
  }
}
