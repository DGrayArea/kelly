# kelly

Autonomous trading agent for [Kuru](https://kuru.io) (hybrid CLOB-AMM) on Monad.
Built for the Kuru **Agent Arena** bracket tournament ($25 prefunded per agent,
winners take losers' bankrolls, top 8 split $100k).

Named for the **Kelly criterion** — though see "The finding that broke the thesis"
below, because the maths did not survive contact with real gas costs.

---

## Quick start

```bash
npm install
npm run book      # one-shot: read live order book + fees + spread
npm run agent     # dry-run: stream live events, record tape to data/*.jsonl
npm run replay    # backtest recorded tape with baselines
npm test          # kelly + signal unit tests (27 assertions)
```

`RUN_SECONDS=3600 npm run agent` records for an hour then exits cleanly.
**Recording is a plain node process — run it as long as you like, it costs nothing.**

Nothing here can trade. `agent.ts` constructs no signer and refuses to start if
`DRY_RUN=false`.

---

## Verified facts about Kuru on Monad

Measured on mainnet, not assumed:

| Fact | Value |
|---|---|
| Chain ID | 143 |
| Trading fees | **0 bps maker, 0 bps taker** |
| Spread (MON-USDC) | ~3.5–6 bps |
| Gas price | ~102 gwei |
| Gas per Kuru order | **~1.32M** (sampled 836k–1.7M) |
| Cost per transaction | **~$0.00308** |
| `pricePrecision` | 1e8 |
| `sizePrecision` | 1e10 |
| WSS endpoint | `wss://rpc.monad.xyz` (works, push-based) |
| `eth_getLogs` limit | **100 blocks** per query on public RPC |

Contract addresses are in `src/config.ts` (mainnet + testnet).

---

## Two SDK bugs worth knowing

**1. `MarketListener.listenForTrades` is broken in `@kuru-labs/kuru-sdk@0.0.95`.**
The `Trade` event emits 8 args:

```
orderId, makerAddress, isBuy, price, updatedSize, takerAddress, txOrigin, filledSize
```

The SDK destructures only 6, so `makerAddress` lands in `isBuy`, `isBuy` in
`price`, and so on. It throws `invalid BigNumber value (value=true)` on the first
real event. `src/feed.ts` reads args **by name** instead, which is immune to this.

**2. The two events use different price scales.** This one fails *silently*:

- `OrderCreated.price` is uint32, scaled by `pricePrecision` (1e8)
- `Trade.price` is uint256, scaled by **1e18** (WAD)

Decode both the same way and trade prices come out ~1e10 too large, quietly
poisoning every downstream signal. Verified against the live L2 mid.

---

## FINAL VERDICT (31h / 7,554 trades)

After a full multi-session recording across a day/night cycle, the question is
settled and it is quantitative, not hand-wavy:

**The flow signal is genuinely predictive, and it is exactly half as large as it
needs to be.**

- Trade-flow imbalance predicts 120s direction at a **56.3% hit rate** over 4,818
  clear-imbalance samples. That is a real, statistically meaningful edge, not noise.
- Converted to money, that edge is worth **~5.9 bps per trade**.
- The cheapest possible round-trip cost, betting the entire $25 bankroll at once,
  is **12.5 bps** (2.5 bps gas + 10 bps spread).
- So even in the best case the edge covers **47% of cost**. At Kelly-sized $1
  positions it covers **8%**.

Every strategy lost money at every hold period (60s–600s) once real costs were
applied. The signal is not the problem; the bankroll-to-cost ratio is. On $25,
fixed gas makes a real 56% edge unprofitable.

**Conclusion for the Arena: with a $25 prefunded bankroll and these costs, there is
no viable active trading strategy on this market.** The correct play is extreme
selectivity — trade rarely, large, on the strongest imbalance, and let opponents
who overtrade bleed 12–25% of their stack to gas. Winning is about spending less,
not predicting better.

---

## The finding that broke the thesis

The project was designed around fractional Kelly: bet small, survive, grind out a
bracket. **Real gas costs make that impossible on a $25 bankroll.**

Gas is a *fixed* cost per transaction, so its bps impact scales inversely with
position size:

| position | gas (round trip) | + spread | total | viable? |
|---|---|---|---|---|
| $1 (Kelly-sized) | 61.6 bps | 10 | **71.6 bps** | never |
| $5 | 12.3 bps | 10 | 22.3 bps | never |
| $10 | 6.2 bps | 10 | 16.2 bps | only at 300s holds |
| $25 (all-in) | 2.5 bps | 10 | 12.5 bps | only at 300s holds |

Against observed median absolute moves of 4.8 bps (30s), 7.9 (60s), 12.2 (120s),
17.6 (300s). With gas included, the 30s strategy had a **0% win rate — all 43
trades lost.**

**Fixed costs punish small bets, which is the exact opposite of what Kelly wants.**

### The counterintuitive implication

Gas bleed on a $25 bankroll, before any trading loss:

| round trips | gas cost | % of bankroll |
|---|---|---|
| 100 | $0.62 | 2.5% |
| 500 | $3.08 | 12.3% |
| 1000 | $6.16 | 24.6% |

So in a bracket, **extreme selectivity likely wins**: trade 2–3 times on real
conviction at large size with long holds, and let opponents who built busy
high-frequency bots bleed themselves out. Doing almost nothing beats overtrading.

This also undermines a market-making pivot: MM needs many fills and constant
requoting, and every quote and cancel burns $0.003.

---

## Current state

| Component | Status |
|---|---|
| `src/config.ts` | Addresses, network, safety gate |
| `src/feed.ts` | WSS push feed, correct decoding |
| `src/kelly.ts` | Fractional Kelly, drawdown halt, cooldown (tested) |
| `src/signal.ts` | Order-flow imbalance -> edge estimate (tested) |
| `src/replay.ts` | Backtest w/ baselines, gas + spread modelled |
| `src/agent.ts` | Dry-run harness, records tape |

**No edge has been demonstrated.** The replay verdict is honest about this: it
reports `NO EDGE` when the strategy only beats baselines by betting less, and
`INCONCLUSIVE` below 30 trades.

### What the backtest does NOT model
- queue position (a passive order may never fill)
- market impact from our own size
- adverse selection on fills (you get filled when you're wrong)
- spread approximated as flat bps, since tape stores events not book snapshots

---

## Next steps

1. **Collect more tape.** `RUN_SECONDS=28800 npm run agent` overnight, across
   varied conditions. 40 minutes of one flat market is not enough to conclude
   anything about signal quality. Costs nothing to run.
2. **Invert the sizer**: replace the 20% *cap* with a gas-aware position *floor*
   (~$10 min, keeping gas under ~6 bps), plus a hard lifetime trade-count limit.
3. **Add a "trade rarely" baseline** to test the do-almost-nothing thesis directly.
4. **Confirm Arena round-resolution rules.** If a round is decided on relative
   bankroll rather than elimination, conservatism loses to a bigger sizer who
   happened not to blow up. This changes the optimal Kelly fraction materially.
