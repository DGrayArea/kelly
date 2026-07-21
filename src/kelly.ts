/**
 * Position sizing and survival guards.
 *
 * The Kelly criterion maximises the expected log-growth of a bankroll:
 *
 *     f* = (p*b - q) / b        p = win prob, q = 1-p, b = win/loss payoff ratio
 *
 * Full Kelly is growth-optimal but has violent drawdowns: it is only "optimal"
 * if you get infinite repeated bets and never face elimination. This agent
 * plays a single-elimination bracket, where going bust ends the tournament, so
 * ruin is not just costly, it is terminal. We therefore run FRACTIONAL Kelly.
 *
 * Half-Kelly keeps ~75% of the growth rate for ~50% of the volatility, which is
 * the trade we want. The default here is more conservative still.
 */

export interface KellyInput {
  /** Estimated probability the trade is a winner, 0..1 */
  winProb: number;
  /** Payoff ratio: average win / average loss. b=1 means even money. */
  payoffRatio: number;
}

export interface SizingConfig {
  /** Scales full Kelly down. 0.5 = half-Kelly. */
  fraction: number;
  /** Never risk more than this share of bankroll on one position. */
  maxFractionOfBankroll: number;
  /** Stop trading once bankroll falls this far below its peak. */
  maxDrawdown: number;
  /** Minimum seconds between actions, to stop the agent thrashing. */
  cooldownSec: number;
}

export const DEFAULT_SIZING: SizingConfig = {
  fraction: 0.35,
  maxFractionOfBankroll: 0.2,
  maxDrawdown: 0.35,
  cooldownSec: 20,
};

/** Raw Kelly fraction. Returns <= 0 when the bet has no edge (do not trade). */
export function kellyFraction({ winProb, payoffRatio }: KellyInput): number {
  if (!(winProb > 0 && winProb < 1) || !(payoffRatio > 0)) return 0;
  const q = 1 - winProb;
  return (winProb * payoffRatio - q) / payoffRatio;
}

/**
 * Kelly, scaled down and clamped. This is the number the agent actually uses.
 * Never returns negative (that would imply taking the other side, which the
 * strategy layer decides, not the sizer).
 */
export function sizedFraction(
  input: KellyInput,
  cfg: SizingConfig = DEFAULT_SIZING
): number {
  const raw = kellyFraction(input);
  if (raw <= 0) return 0;
  return Math.min(raw * cfg.fraction, cfg.maxFractionOfBankroll);
}

/** Position size in quote currency. */
export function positionSize(
  bankroll: number,
  input: KellyInput,
  cfg: SizingConfig = DEFAULT_SIZING
): number {
  return bankroll * sizedFraction(input, cfg);
}

/**
 * Tracks bankroll health and decides whether the agent is allowed to act.
 * This is the survival layer: it exists to stop a losing streak becoming
 * elimination.
 */
export class RiskState {
  private peak: number;
  private lastActionAt = 0;
  private halted = false;
  private haltReason = "";

  constructor(
    public bankroll: number,
    private cfg: SizingConfig = DEFAULT_SIZING
  ) {
    this.peak = bankroll;
  }

  update(bankroll: number) {
    this.bankroll = bankroll;
    if (bankroll > this.peak) this.peak = bankroll;
    if (this.drawdown() >= this.cfg.maxDrawdown && !this.halted) {
      this.halted = true;
      this.haltReason = `drawdown ${(this.drawdown() * 100).toFixed(1)}% >= limit ${(this.cfg.maxDrawdown * 100).toFixed(0)}%`;
    }
  }

  drawdown(): number {
    if (this.peak <= 0) return 0;
    return Math.max(0, (this.peak - this.bankroll) / this.peak);
  }

  /** Why the agent may not act right now, or null if it may. */
  blockedReason(nowMs = Date.now()): string | null {
    if (this.halted) return `HALTED: ${this.haltReason}`;
    const since = (nowMs - this.lastActionAt) / 1000;
    if (this.lastActionAt && since < this.cfg.cooldownSec) {
      return `cooldown ${(this.cfg.cooldownSec - since).toFixed(1)}s remaining`;
    }
    return null;
  }

  markActed(nowMs = Date.now()) {
    this.lastActionAt = nowMs;
  }

  get isHalted() {
    return this.halted;
  }

  snapshot() {
    return {
      bankroll: this.bankroll,
      peak: this.peak,
      drawdown: this.drawdown(),
      halted: this.halted,
      haltReason: this.haltReason || null,
    };
  }
}
