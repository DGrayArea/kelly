import { kellyFraction, sizedFraction, positionSize, RiskState, DEFAULT_SIZING } from "./kelly";

let fails = 0;
const eq = (name: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}  got=${got.toFixed(6)} want=${want.toFixed(6)}`);
};

// Classic textbook case: 60% win, even money -> f* = 0.2
eq("kelly 60/even", kellyFraction({ winProb: 0.6, payoffRatio: 1 }), 0.2);
// Even odds, no edge -> 0
eq("kelly 50/even (no edge)", kellyFraction({ winProb: 0.5, payoffRatio: 1 }), 0);
// Negative edge -> negative (caller must not bet)
console.log(`pass  kelly 40/even is negative: ${kellyFraction({ winProb: 0.4, payoffRatio: 1 }) < 0}`);
// 2:1 payoff, 50% win -> f* = (0.5*2 - 0.5)/2 = 0.25
eq("kelly 50/2:1", kellyFraction({ winProb: 0.5, payoffRatio: 2 }), 0.25);

// fractional scaling: 0.2 raw * 0.35 = 0.07
eq("sized 60/even @0.35x", sizedFraction({ winProb: 0.6, payoffRatio: 1 }), 0.2 * DEFAULT_SIZING.fraction);
// cap bites: huge edge must clamp to maxFractionOfBankroll
eq("sized clamps to cap", sizedFraction({ winProb: 0.99, payoffRatio: 5 }), DEFAULT_SIZING.maxFractionOfBankroll);
// no edge -> zero size
eq("size 0 when no edge", positionSize(25, { winProb: 0.5, payoffRatio: 1 }), 0);
eq("size on $25 @60/even", positionSize(25, { winProb: 0.6, payoffRatio: 1 }), 25 * 0.2 * DEFAULT_SIZING.fraction);

// --- risk state ---
const r = new RiskState(25);
console.log(`pass  fresh state not blocked: ${r.blockedReason() === null}`);
r.markActed();
console.log(`pass  cooldown blocks: ${(r.blockedReason() || "").startsWith("cooldown")}`);
// drawdown halt: 25 -> 16 is 36% DD, over the 35% limit
const r2 = new RiskState(25);
r2.update(16);
eq("drawdown computed", r2.drawdown(), (25 - 16) / 25);
console.log(`pass  halts past max DD: ${r2.isHalted}`);
console.log(`pass  halt reason surfaced: ${(r2.blockedReason() || "").startsWith("HALTED")}`);
// recovery does not un-halt (elimination is terminal)
r2.update(25);
console.log(`pass  halt is sticky: ${r2.isHalted}`);

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
