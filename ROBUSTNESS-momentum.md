# ROBUSTNESS-momentum.md — stress test of the SELECTED momentum-pivot config

**Role:** Robustness Checker. **Scope:** stress the *locked* selected config without
changing any parameter. **Binding contract:** the honest-search contract: in-sample-only selection, full stress
disclosure, and a go/no-go gate (beat buy-and-hold net-of-cost on the held-out window, else reposition on the lower-drawdown floor). Nothing here re-selects, moves the split to
flatter a number, or peeks-then-fishes — the config is fixed and every window/cost is
disclosed, win or lose.

## What was tested (params held FIXED)

The selected config from `backtest/report-momentum.json` (`selectedConfig`), reconstructed
**exactly** and never altered:

```
long-only+ema30/80 : emaFast=30 emaSlow=80 momentumLookback=20 trendFullSep=0.06
                     momentumFullRet=0.15 trendWeight=0.6 momentumWeight=0.4
                     entryThreshold=120 allowShort=false maxLeverage=1
```

Universe (all REAL, all disclosed, no cherry-pick): BTCUSDT, ETHUSDT, BNBUSDT — 1000 daily
bars each (`fixtures/daily/*`, `_synthetic=false`, F&G coverage 0.999, funding 1.000).

Reproduce every number below with:

```
ts-node backtest/robustness-momentum.ts      # read-only stress harness; writes nothing
```

It imports the same exported functions the committed backtest uses (`loadUniverse`,
`evaluateCandidate`, `runWalk`, `metricsFromTrace`, `regimeMetrics`, …) so the stress
shares the committed walk-forward and cost model. It touches neither `report-momentum.json`
nor the frozen `report.json`.

## Pre-flight (unconditional)

| Check | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `npm test` | **498 passing** |
| Look-ahead suite (truncation invariance incl. real fixtures) | green |
| `report-momentum.json` byte-reproducible | yes (`ts-node backtest/momentum.ts` → no diff) |
| Frozen `backtest/report.json` | byte-IDENTICAL, untouched |

## Stress results (all on the LOCKED config)

### 1. Adjacent split — move the held-out boundary (cost 10+10 bps)

| oosFraction | strat OOS | B&H OOS | excess | beat? | tokens beating |
|---|---|---|---|---|---|
| 0.20 | -0.62% | -34.20% | **+33.58%** | YES | 3/3 |
| 0.25 | -3.21% | -47.81% | **+44.60%** | YES | 3/3 |
| 0.30 *(default)* | -0.32% | -43.50% | **+43.19%** | YES | 3/3 |
| 0.35 | +17.95% | -27.57% | **+45.52%** | YES | 3/3 |
| 0.40 | +14.64% | -27.79% | **+42.43%** | YES | 3/3 |

The OOS absolute-return beat survives **every** adjacent split and holds 3/3 tokens at each.
Robust to the split-boundary choice — **but see §2 and §5: every tail-OOS window in this
dataset ends in the 2026 drawdown, so all five tails share the same bear-dodge mechanism.**

### 2. Mid-window [40%,70%) — an adjacent, NON-tail held-out slice (cost 10+10)

| token | strat | B&H | excess | beat? | strat MDD | B&H MDD |
|---|---|---|---|---|---|---|
| BTCUSDT | +33.53% | +68.67% | -35.14% | no | 0.086 | 0.281 |
| ETHUSDT | +38.23% | +73.12% | -34.89% | no | 0.231 | 0.632 |
| BNBUSDT | +4.65% | +45.92% | -41.27% | no | 0.124 | 0.291 |
| **AGG** | +25.47% | +62.57% | **-37.10%** | **no** | 0.147 | 0.401 |

**This is the load-bearing finding.** In a bull-dominated middle window the strategy
**LOSES to B&H on absolute return by ~37%** on all three tokens. It still cuts drawdown
roughly in half (0.147 vs 0.401), but its Sharpe is **lower** (1.072 vs 1.357 — §6). The
absolute beat is therefore **not** a property of the strategy; it is a property of the
held-out window being a drawdown.

### 3. Cost bump (default split 0.30 OOS)

| cost | strat OOS | B&H OOS | excess | beat? | Sharpe (S vs B&H) | MDD (S vs B&H) | riskAdjWin? |
|---|---|---|---|---|---|---|---|
| 10+10 | -0.32% | -43.50% | +43.19% | YES 3/3 | -0.595 vs -1.000 | 0.177 vs 0.583 | YES |
| **15+15** | -0.91% | -43.50% | **+42.59%** | YES 3/3 | -0.656 vs -1.000 | 0.181 vs 0.583 | YES |
| **25+25** | -2.09% | -43.50% | **+41.42%** | YES 3/3 | -0.772 vs -1.000 | 0.187 vs 0.583 | YES |

The tail-OOS beat and the risk-adjusted win **survive +5/+5 (15+15) and even +15/+15
(25+25) bps**. The config is low-turnover (7 / 1 / 3 trades on the OOS tail — §4), so it is
**not cost-fragile**. Cost is not where the fragility lives.

### 4. Per-token, default split 0.30 OOS (cost 10+10)

| token | strat | B&H | excess | beat? | Sharpe (S vs B&H) | MDD (S vs B&H) | trades |
|---|---|---|---|---|---|---|---|
| BTCUSDT | -7.53% | -42.91% | +35.38% | YES | -2.037 vs -1.281 | 0.089 vs 0.512 | 7 |
| ETHUSDT | -11.90% | -58.92% | +47.02% | YES | -0.539 vs -1.271 | 0.230 vs 0.675 | 1 |
| BNBUSDT | +18.48% | -28.68% | +47.16% | YES | +0.789 vs -0.450 | 0.213 vs 0.562 | 3 |

All 3 tokens beat B&H net of cost on the tail-OOS. **Note honestly:** BTC and ETH have
**negative** absolute OOS returns — they "beat" only because B&H lost *more*. BTC's OOS
Sharpe is also *worse* than B&H (-2.04 vs -1.28); its win is purely the drawdown
(0.089 vs 0.512). Only BNB is an unambiguous positive-return, higher-Sharpe, lower-DD win.

### 5. Single-regime artifact check — per-regime behaviour proxy, FULL window

| token | regime | bars | strat | B&H | excess | beat? |
|---|---|---|---|---|---|---|
| BTCUSDT | bull | 278 | +101.30% | +174.63% | -73.34% | no |
| BTCUSDT | bear | 143 | -0.96% | -50.98% | +50.02% | YES |
| BTCUSDT | chop | 579 | -18.73% | +79.49% | -98.22% | no |
| ETHUSDT | bull | 350 | +108.82% | +468.01% | -359.18% | no |
| ETHUSDT | bear | 309 | 0.00% | -81.14% | +81.14% | YES |
| ETHUSDT | chop | 341 | -29.01% | +1.69% | -30.70% | no |
| BNBUSDT | bull | 311 | +231.81% | +639.84% | -408.03% | no |
| BNBUSDT | bear | 127 | 0.00% | -56.98% | +56.98% | YES |
| BNBUSDT | chop | 562 | -38.15% | -10.89% | -27.27% | no |

Mean bull excess vs B&H: **-280.19%** · mean bear excess vs B&H: **+62.71%**.

The mechanism is unambiguous and consistent on all 3 tokens: the directional core **rides
the bull but materially lags long-only B&H** (it sizes in late and trims), **goes flat
through the bear and dodges the drawdown** (+50–81% excess), and **leaks in chop**
(false trend flips). It is *not* a single-token artifact — the same shape holds for BTC,
ETH and BNB. It *is* a single-mechanism result: **all of the edge is the bear-dodge.**

### 6. Risk-adjusted win across windows + full-window summary

| window | strat Sharpe | B&H Sharpe | strat MDD | B&H MDD | riskAdjWin (Sharpe↑ AND MDD↓)? | abs. beat? |
|---|---|---|---|---|---|---|
| Tail-OOS 0.30 | -0.595 | -1.000 | 0.177 | 0.583 | **YES** | YES |
| Mid-window [40,70) | 1.072 | 1.357 | 0.147 | 0.401 | **no** (Sharpe lower) | no |
| Full window | 0.715 | 0.757 | 0.295 | 0.583 | **no** (Sharpe lower) | no |

The **higher-Sharpe-AND-lower-MDD** risk-adjusted win holds **only in the bear-tailed
OOS**. The single metric robust across **every** window and cost is **lower maximum
drawdown** (0.177 vs 0.583 tail; 0.147 vs 0.401 mid; 0.295 vs 0.583 full).

## VERDICT — ROBUST or FRAGILE? (disclosed, not dressed up)

- **Absolute-return OOS beat (gate G1): REAL on the disclosed window(s), but REGIME-FRAGILE.**
  It is genuine and survives every adjacent split (0.20–0.40, 3/3 tokens) and cost bumps to
  25+25 bps — so it is **not** a knife-edge of one split or of the cost assumption. But §2
  and §5 show *why* it holds: the held-out tail (and every adjacent tail) ends in the 2026
  drawdown, and the strategy's entire edge is going flat in bears. In a bull-dominated
  held-out window it **loses to B&H by ~37%**. The beat is a **bear-dodge, not alpha**, and
  for BTC/ETH it is a "lost less" beat (negative absolute returns). **This fragility is
  disclosed; the beat must never be presented as regime-independent out-performance.**

- **Risk-adjusted win (higher Sharpe AND lower MDD): holds only in the bear-tailed OOS** —
  it does **not** survive the bull mid-window or the full window (Sharpe falls below B&H
  there). So it is **not** a universal claim either.

- **Lower maximum drawdown: ROBUST.** It is the one claim that holds on every window
  (tail-OOS, mid-window, full) and every cost level tested, on all three tokens. This is
  exactly the committed Phase-1b floor ("lower OOS max-drawdown than
  B&H"). It is the honest, defensible spine of the result.

**Bottom line for the submission:** lead with what is robust — a **regime-aware directional
overlay that roughly halves drawdown vs buy-and-hold across bull, bear and chop, and that
out-returns B&H specifically when the forward window contains a bear leg.** Present the
held-out absolute-return beat truthfully as **window/regime-conditional (a bear-dodge), not
as standalone alpha**, and keep the "lower drawdown" claim as the headline. Do **not** imply
a regime-independent beat the data does not support.

## Honesty notes

- No parameter was changed; the config is the committed `selectedConfig` verbatim.
- The split was not moved to flatter a result; §1 reports a full fraction sweep, all shown.
- All 3 tokens and all windows (5 splits, mid-window, full) are disclosed — winners and
  losers. BTC/ETH OOS "beats" are explicitly flagged as negative-absolute "lost-less" beats.
- Cost stays the labelled 10+10 bps assumption; the bumped 15+15 and 25+25 runs are shown
  next to it, all net-of-cost.
- `backtest/robustness-momentum.ts` is a read-only harness — it writes no report and does
  not touch the frozen `report.json` or `report-momentum.json` (both verified byte-identical
  after the run). It is not imported by any test; `tsc` stays exit 0 and the 498-test suite
  stays green with it present.
