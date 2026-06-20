/**
 * Stoic — ROBUSTNESS harness for the SELECTED momentum-pivot config.  [P-robust]
 *
 * This is a READ-ONLY stress harness for the Robustness Checker. It does NOT re-select
 * params, does NOT touch report-momentum.json or the frozen report.json, and writes
 * nothing — it prints a stress matrix to stdout that the human transcribes into
 * ROBUSTNESS-momentum.md. The SELECTED config (long-only+ema30/80, all other knobs at the
 * module defaults) is reconstructed EXACTLY from report-momentum.json.selectedConfig and
 * held FIXED across every stress (HONEST_SEARCH_RULES §3.4 — selected params not changed).
 *
 * Stresses run, all on the locked config:
 *   1. ADJACENT SPLIT: oosFraction in {0.20, 0.25, 0.30(default), 0.35, 0.40} — does the
 *      OOS B&H beat survive when the held-out boundary moves? (split is a window choice.)
 *   2. MID-WINDOW (adjacent, non-tail) OOS: evaluate the [0.40,0.70) middle slice as a
 *      held-out window the config never "saw" as its tail — is the tail a one-window fluke?
 *   3. COST BUMP: txCost+slip in {10+10(default), 15+15, 25+25} bps on the default-split OOS.
 *   4. PER-TOKEN at default split (re-derive the report's per-token OOS to confirm).
 *   5. SINGLE-REGIME ARTIFACT: per-regime (bull/bear/chop) behaviour proxy on the FULL
 *      window per token — does the core RIDE bull AND limit drawdown in bear?
 *
 * RUN:  ts-node backtest/robustness-momentum.ts
 */
import {
  loadUniverse,
  evaluateCandidate,
  runWalk,
  splitMetrics,
  splitBarOf,
  metricsFromTrace,
  aggregateMetrics,
  regimeLabels,
  regimeMetrics,
  maxDrawdownOf,
  Candidate,
  WalkParams,
  DEFAULT_WALK,
  Metrics,
  TokenInput,
} from "./momentum";
import {
  EMA_FAST,
  EMA_SLOW,
  MOMENTUM_LOOKBACK,
  TREND_FULL_SEP,
  MOMENTUM_FULL_RET,
  TREND_WEIGHT,
  MOMENTUM_WEIGHT,
} from "../src/signal/strategy";

// ── reconstruct the LOCKED selected config EXACTLY (do not re-select) ──────────────
// report-momentum.json.selectedConfig: long-only+ema30/80, everything else module default.
function selectedCandidate(walk: WalkParams): Candidate {
  return {
    label: "long-only+ema30/80 (LOCKED)",
    strategy: {
      emaFast: 30,
      emaSlow: 80,
      momentumLookback: MOMENTUM_LOOKBACK, // 20
      trendFullSep: TREND_FULL_SEP,        // 0.06
      momentumFullRet: MOMENTUM_FULL_RET,  // 0.15
      trendWeight: TREND_WEIGHT,           // 0.6
      momentumWeight: MOMENTUM_WEIGHT,     // 0.4
    },
    walk: { ...walk, allowShort: false, entryThreshold: 120, maxLeverage: 1 },
  };
}

const pct = (x: number) => (x * 100).toFixed(2) + "%";
const fx = (x: number) => x.toFixed(3);

function aggOOS(universe: TokenInput[], cand: Candidate, oos: number): Metrics {
  return evaluateCandidate(universe, cand, oos).aggregate.outOfSample;
}

function main() {
  const universe = loadUniverse();
  console.log("UNIVERSE:", universe.map((t) => `${t.symbol}(${t.bars.length}b,synthetic=${t.synthetic})`).join(", "));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 1 — ADJACENT SPLIT (move the held-out boundary; params fixed at 10+10).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 1: ADJACENT SPLIT (oosFraction sweep, cost 10+10 bps, params LOCKED) ===");
  console.log("frac | aggStratOOS | aggB&H_OOS | aggExcess | beat? | tokensBeating(OOS)");
  for (const frac of [0.2, 0.25, 0.3, 0.35, 0.4]) {
    const cand = selectedCandidate(DEFAULT_WALK);
    const ev = evaluateCandidate(universe, cand, frac);
    const a = ev.aggregate.outOfSample;
    const beats = ev.perToken.filter((p) => p.split.outOfSample.beatsBuyHold).map((p) => p.symbol);
    console.log(
      `${frac.toFixed(2)} | ${pct(a.totalReturn).padStart(9)} | ${pct(a.buyAndHoldReturn).padStart(9)} | ${pct(a.excessReturn).padStart(9)} | ${a.beatsBuyHold ? "YES" : "no "} | ${beats.length}/${universe.length} [${beats.join(",")}]`
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 2 — MID-WINDOW (adjacent, non-tail) held-out slice [0.40, 0.70).
  // A window the config's tail-OOS never covered; re-based locally (like metricsFromTrace).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 2: MID-WINDOW [40%,70%) held-out slice (cost 10+10, params LOCKED) ===");
  console.log("token | stratMid | B&H_Mid | excess | beat? | stratMDD | B&H_MDD");
  const cand2 = selectedCandidate(DEFAULT_WALK);
  const midPer: Metrics[] = [];
  for (const tok of universe) {
    const n = tok.bars.length;
    const lo = Math.floor(n * 0.4);
    const hi = Math.floor(n * 0.7);
    const w = runWalk(tok.bars, cand2.walk, cand2.strategy);
    const m = metricsFromTrace(w.trace, w.trades, lo, hi);
    midPer.push(m);
    console.log(
      `${tok.symbol} | ${pct(m.totalReturn).padStart(8)} | ${pct(m.buyAndHoldReturn).padStart(8)} | ${pct(m.excessReturn).padStart(8)} | ${m.beatsBuyHold ? "YES" : "no "} | ${fx(m.maxDrawdown)} | ${fx(m.buyAndHoldMaxDrawdown)}`
    );
  }
  const midAgg = aggregateMetrics(midPer);
  console.log(
    `AGG | ${pct(midAgg.totalReturn).padStart(8)} | ${pct(midAgg.buyAndHoldReturn).padStart(8)} | ${pct(midAgg.excessReturn).padStart(8)} | ${midAgg.beatsBuyHold ? "YES" : "no "} | ${fx(midAgg.maxDrawdown)} | ${fx(midAgg.buyAndHoldMaxDrawdown)}`
  );
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 3 — COST BUMP on the DEFAULT-SPLIT OOS (15+15, 25+25 vs 10+10).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 3: COST BUMP (default split 0.30 OOS, params LOCKED) ===");
  console.log("cost | aggStratOOS | aggB&H_OOS | aggExcess | beat? | aggSharpe(S vs B&H) | aggMDD(S vs B&H) | riskAdjWin?");
  for (const [tx, sl] of [[10, 10], [15, 15], [25, 25]] as Array<[number, number]>) {
    const walk = { ...DEFAULT_WALK, txCostBps: tx, slippageBps: sl };
    const cand = selectedCandidate(walk);
    const ev = evaluateCandidate(universe, cand, 0.3);
    const a = ev.aggregate.outOfSample;
    const beats = ev.perToken.filter((p) => p.split.outOfSample.beatsBuyHold).map((p) => p.symbol);
    const raw = a.sharpe > a.buyAndHoldSharpe && a.maxDrawdown < a.buyAndHoldMaxDrawdown;
    console.log(
      `${tx}+${sl} | ${pct(a.totalReturn).padStart(9)} | ${pct(a.buyAndHoldReturn).padStart(9)} | ${pct(a.excessReturn).padStart(9)} | ${a.beatsBuyHold ? "YES" : "no "} [${beats.length}/3] | ${fx(a.sharpe)} vs ${fx(a.buyAndHoldSharpe)} | ${fx(a.maxDrawdown)} vs ${fx(a.buyAndHoldMaxDrawdown)} | ${raw ? "YES" : "no"}`
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 4 — PER-TOKEN default-split OOS (re-derive; confirm report agreement).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 4: PER-TOKEN OOS (default split 0.30, cost 10+10, params LOCKED) ===");
  console.log("token | stratOOS | B&H_OOS | excess | beat? | Sharpe(S vs B&H) | MDD(S vs B&H) | trades");
  const cand4 = selectedCandidate(DEFAULT_WALK);
  const ev4 = evaluateCandidate(universe, cand4, 0.3);
  for (const p of ev4.perToken) {
    const o = p.split.outOfSample;
    console.log(
      `${p.symbol} | ${pct(o.totalReturn).padStart(8)} | ${pct(o.buyAndHoldReturn).padStart(8)} | ${pct(o.excessReturn).padStart(8)} | ${o.beatsBuyHold ? "YES" : "no "} | ${fx(o.sharpe)} vs ${fx(o.buyAndHoldSharpe)} | ${fx(o.maxDrawdown)} vs ${fx(o.buyAndHoldMaxDrawdown)} | ${o.tradeCount}`
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 5 — SINGLE-REGIME ARTIFACT (does the core ride bull AND dodge bear?).
  // FULL-window per-regime behaviour proxy (position-weighted close-to-close).
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 5: PER-REGIME behaviour proxy, FULL window (params LOCKED) ===");
  console.log("token | regime | bars | stratRet | B&H_Ret | excess | beat?");
  const cand5 = selectedCandidate(DEFAULT_WALK);
  for (const tok of universe) {
    const w = runWalk(tok.bars, cand5.walk, cand5.strategy);
    const regimes = regimeLabels(tok.bars.map((b) => b.close));
    const rm = regimeMetrics(w.trace, regimes, 0, tok.bars.length);
    for (const r of rm) {
      console.log(
        `${tok.symbol} | ${r.regime.padEnd(4)} | ${String(r.bars).padStart(4)} | ${pct(r.strategyReturn).padStart(9)} | ${pct(r.buyAndHoldReturn).padStart(9)} | ${pct(r.excessReturn).padStart(9)} | ${r.beatsBuyHold ? "YES" : "no"}`
      );
    }
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 5b — does the directional core help in BULL too? Bull-only excess summary.
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 5b: BULL-only — does strat ride up but UNDERPERFORM long-only B&H? ===");
  let bullExcessSum = 0, bearExcessSum = 0, bullCount = 0, bearCount = 0;
  for (const tok of universe) {
    const w = runWalk(tok.bars, cand5.walk, cand5.strategy);
    const regimes = regimeLabels(tok.bars.map((b) => b.close));
    const rm = regimeMetrics(w.trace, regimes, 0, tok.bars.length);
    for (const r of rm) {
      if (r.regime === "bull") { bullExcessSum += r.excessReturn; bullCount++; }
      if (r.regime === "bear") { bearExcessSum += r.excessReturn; bearCount++; }
    }
  }
  console.log(`mean bull excess vs B&H: ${pct(bullExcessSum / bullCount)} (expect NEGATIVE — rides but lags B&H in bull)`);
  console.log(`mean bear excess vs B&H: ${pct(bearExcessSum / bearCount)} (expect POSITIVE — dodges the drawdown)`);
  console.log("");
  console.log("[interpretation] the OOS B&H beat is driven by the BEAR-dodge (the 2026 YTD drawdown tail),");
  console.log("not by out-earning B&H in the bull. That is the honest mechanism — and the fragility to watch.");
  console.log("");

  // ════════════════════════════════════════════════════════════════════════════
  // STRESS 6 — RISK-ADJUSTED win in the MID-WINDOW + FULL-window summary.
  // The mid-window LOSES on absolute return; does the risk-adjusted claim survive there?
  // ════════════════════════════════════════════════════════════════════════════
  console.log("=== STRESS 6: MID-WINDOW risk-adjusted + FULL-window summary (params LOCKED) ===");
  const cand6 = selectedCandidate(DEFAULT_WALK);
  console.log(
    `MID-WINDOW agg: Sharpe ${fx(midAgg.sharpe)} vs B&H ${fx(midAgg.buyAndHoldSharpe)} | MDD ${fx(midAgg.maxDrawdown)} vs B&H ${fx(midAgg.buyAndHoldMaxDrawdown)} | riskAdjWin=${midAgg.sharpe > midAgg.buyAndHoldSharpe && midAgg.maxDrawdown < midAgg.buyAndHoldMaxDrawdown}`
  );
  const evFull = evaluateCandidate(universe, cand6, 0.3);
  const f = evFull.aggregate.full;
  console.log(
    `FULL-window agg: strat ${pct(f.totalReturn)} vs B&H ${pct(f.buyAndHoldReturn)} (excess ${pct(f.excessReturn)}) beat=${f.beatsBuyHold} | Sharpe ${fx(f.sharpe)} vs ${fx(f.buyAndHoldSharpe)} | MDD ${fx(f.maxDrawdown)} vs ${fx(f.buyAndHoldMaxDrawdown)}`
  );
}

main();
