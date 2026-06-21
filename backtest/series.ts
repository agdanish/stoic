/**
 * Stoic — REAL per-bar backtest SERIES emitter (the "make the chart honest" file).  [P1]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * backtest/momentum.ts already produces a look-ahead-safe per-bar {equity, buyHoldEquity}
 * curve (runWalk, ~lines 209-315) and report-momentum.json locks the SELECTED config
 * (long-only + EMA 30/80, the `long-only+ema30/80` sweep winner). The dashboard's equity /
 * underwater chart was previously an ILLUSTRATIVE shape pinned to the summary endpoints.
 *
 * THIS emitter runs that SAME selected config on the SAME committed daily fixtures and
 * captures the ACTUAL per-bar series so the dashboard can plot the real curve:
 *
 *   - strategy equity, buy&hold equity, and derived underwater depth (1 - equity/runningPeak)
 *   - per token AND an equal-weight aggregate (mean of the per-token equities, re-derived
 *     into its own underwater curve), for the OUT-OF-SAMPLE window AND the FULL window.
 *
 * It is purely ADDITIVE: it NEVER touches report-momentum.json or report.json, never
 * re-selects, never moves the split. It reuses runWalk/splitBarOf/regimeLabels from
 * momentum.ts verbatim, so the numbers are the SAME numbers the report committed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY
 * ════════════════════════════════════════════════════════════════════════════
 *  - These are the REAL committed per-bar values (look-ahead-safe; the momentum tests pin
 *    that truncating the series leaves every past equity point byte-identical).
 *  - The series RECONCILES with report-momentum.json: the final strategy equity over the OOS
 *    window equals 1 + aggregate.outOfSample.totalReturn (within rounding), and the max
 *    underwater depth equals aggregate.outOfSample.maxDrawdown. A test asserts both.
 *  - No alpha is claimed: the OOS strategy total return is a small LOSS (~-0.32%); the win is
 *    a bear-dodge (a far shallower drawdown than buy-and-hold), which the underwater pane shows.
 *
 *  Output: backtest/series-momentum.json (byte-reproducible — no Date / no random at compute
 *  time; a test asserts `ts-node backtest/series.ts` regenerates it byte-for-byte).
 *
 * RUN:  ts-node backtest/series.ts
 *       OOS_FRACTION=0.3 ts-node backtest/series.ts   (held-out tail fraction; default 0.3)
 */

import * as fs from "fs";
import * as path from "path";
import {
  runWalk,
  splitBarOf,
  regimeLabels,
  round12,
  loadUniverse,
  candidateConfig,
  buildSweep,
  selectInSample,
  DEFAULT_WALK,
  DEFAULT_OOS_FRACTION,
  WalkParams,
  Candidate,
  TokenInput,
  Regime,
} from "./momentum";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG / PATHS
// ════════════════════════════════════════════════════════════════════════════

/** NEW series file — report-momentum.json / report.json are NEVER touched by this run. */
export const SERIES_PATH = path.resolve(__dirname, "series-momentum.json");

/** Round to 6 dp for a compact-but-faithful per-bar series (the report rounds to 12 dp). */
export function round6(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 1e6) / 1e6;
}

// ════════════════════════════════════════════════════════════════════════════
//  PER-BAR SERIES over a [startBar, endBar) slice (re-based to 1.0 at the slice start)
// ════════════════════════════════════════════════════════════════════════════

export interface SeriesWindow {
  /** first bar index of the slice (inclusive) in the full walk. */
  startBar: number;
  /** last bar index of the slice (exclusive). */
  endBar: number;
  /** number of bars actually emitted. */
  bars: number;
  /** strategy equity per bar, re-based to 1.0 at the bar BEFORE the slice (or 1.0 if none). */
  equity: number[];
  /** buy-and-hold equity per bar over the same bars, re-based the same way. */
  buyHoldEquity: number[];
  /** underwater depth per bar = 1 - equity/runningPeak (strategy curve), in [0,1]. */
  underwater: number[];
  /** buy-and-hold underwater depth per bar (same definition on the B&H curve). */
  buyHoldUnderwater: number[];
  /** final strategy equity (== last equity); == 1 + slice total return. */
  finalEquity: number;
  /** final buy-and-hold equity. */
  finalBuyHoldEquity: number;
  /** max strategy underwater depth over the slice (== the slice maxDrawdown). */
  maxUnderwater: number;
  /** max buy-and-hold underwater depth over the slice. */
  maxBuyHoldUnderwater: number;
}

/**
 * Derive a re-based per-bar series over [startBar, endBar) from a raw equity array (which is
 * cumulative from bar 0). Re-basing to the bar BEFORE the slice makes the slice LOCAL — exactly
 * the convention metricsFromTrace uses (so finalEquity == 1 + the report's slice totalReturn).
 * Pure.
 */
export function sliceSeries(
  equityAll: number[],
  buyHoldAll: number[],
  startBar: number,
  endBar: number
): SeriesWindow {
  const baseEq = startBar - 1 >= 0 ? equityAll[startBar - 1] : 1.0;
  const baseBH = startBar - 1 >= 0 ? buyHoldAll[startBar - 1] : 1.0;

  // unrounded re-based equity (for the maxUnderwater scalar — single-rounding, matching
  // momentum.ts maxDrawdownOf so the scalar reconciles to the report's maxDrawdown to 6dp) ...
  const equityRaw: number[] = [];
  const buyHoldRaw: number[] = [];
  // ... and the 6dp-rounded arrays (compact per-bar plotting payload).
  const equity: number[] = [];
  const buyHoldEquity: number[] = [];
  for (let i = startBar; i < endBar; i++) {
    const e = baseEq !== 0 ? equityAll[i] / baseEq : 0;
    const b = baseBH !== 0 ? buyHoldAll[i] / baseBH : 0;
    equityRaw.push(e);
    buyHoldRaw.push(b);
    equity.push(round6(e));
    buyHoldEquity.push(round6(b));
  }

  const underwater = underwaterOf(equity);
  const buyHoldUnderwater = underwaterOf(buyHoldEquity);

  return {
    startBar,
    endBar,
    bars: equity.length,
    equity,
    buyHoldEquity,
    underwater,
    buyHoldUnderwater,
    finalEquity: equity.length ? equity[equity.length - 1] : 1,
    finalBuyHoldEquity: buyHoldEquity.length ? buyHoldEquity[buyHoldEquity.length - 1] : 1,
    maxUnderwater: maxDrawdownExact(equityRaw),
    maxBuyHoldUnderwater: maxDrawdownExact(buyHoldRaw),
  };
}

/** Underwater depth per point = 1 - e/runningPeak (running peak over the slice), 6dp. Pure. */
export function underwaterOf(equity: number[]): number[] {
  let peak = -Infinity;
  return equity.map((e) => {
    if (e > peak) peak = e;
    const d = peak > 0 ? 1 - e / peak : 0;
    return round6(d < 0 ? 0 : d);
  });
}

/**
 * Max underwater depth (== max drawdown) computed on UNROUNDED equity with a SINGLE round at the
 * end — identical convention to momentum.ts maxDrawdownOf — so the scalar reconciles to the
 * report's maxDrawdown to 6dp (avoids per-bar double-rounding drift at the boundary). Pure.
 */
export function maxDrawdownExact(equity: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equity) {
    if (!isFinite(e)) continue;
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return round6(maxDd);
}

/** Max of an already-6dp underwater array (pooled-curve disclosure scalar; not reconciled). Pure. */
function maxOf(xs: number[]): number {
  let m = 0;
  for (const x of xs) if (x > m) m = x;
  return round6(m);
}

// ════════════════════════════════════════════════════════════════════════════
//  SELECT THE COMMITTED WINNER (the SAME config report-momentum.json locked)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Re-derive the selected winner EXACTLY as buildReport does (in-sample selection over the
 * disclosed sweep). This is the `long-only+ema30/80` config; we re-run it to get its per-bar
 * series. We NEVER re-select on anything new — same universe, same sweep, same objective.
 */
export function selectedWinner(universe: TokenInput[], oosFraction: number): Candidate {
  const sweep = buildSweep(DEFAULT_WALK);
  const { winner } = selectInSample(universe, sweep, oosFraction);
  return winner;
}

// ════════════════════════════════════════════════════════════════════════════
//  AGGREGATE (equal-weight over tokens) — mean of the per-token re-based equities
// ════════════════════════════════════════════════════════════════════════════

/** An aggregate series: the pooled mean curve for PLOTTING + the report's mean-of-per-token
 *  headline scalars for RECONCILIATION (report-momentum.json's aggregate is a mean of per-token
 *  metrics, NOT a metric of the pooled curve — so we expose both, clearly labelled). */
export interface AggregateSeries extends SeriesWindow {
  /** mean of the per-token finalEquity == 1 + report aggregate slice totalReturn. */
  meanFinalEquity: number;
  /** mean of the per-token finalBuyHoldEquity == 1 + report aggregate slice B&H totalReturn. */
  meanFinalBuyHoldEquity: number;
  /** mean of the per-token maxUnderwater == report aggregate slice maxDrawdown. */
  meanMaxUnderwater: number;
  /** mean of the per-token maxBuyHoldUnderwater == report aggregate slice B&H maxDrawdown. */
  meanMaxBuyHoldUnderwater: number;
}

/**
 * Equal-weight aggregate.
 *
 *   - For PLOTTING: a pooled mean curve — the arithmetic mean of the per-token re-based equity
 *     curves at each aligned bar offset (token curves share the same length over the same split).
 *     `underwater` is derived from THIS pooled curve (a faithful aggregate drawdown path).
 *   - For RECONCILIATION with report-momentum.json: the report's aggregate is an equal-weight
 *     MEAN OF PER-TOKEN metrics (see aggregateMetrics in momentum.ts), NOT a metric of the pooled
 *     curve. So `meanFinalEquity` / `meanMaxUnderwater` carry that convention: meanFinalEquity ==
 *     mean(per-token finalEquity) == 1 + report aggregate totalReturn, and meanMaxUnderwater ==
 *     mean(per-token maxUnderwater) == report aggregate maxDrawdown. The test pins both.
 *
 * Pure.
 */
export function aggregateSeries(perToken: SeriesWindow[]): AggregateSeries {
  if (perToken.length === 0) {
    return {
      startBar: 0, endBar: 0, bars: 0, equity: [], buyHoldEquity: [],
      underwater: [], buyHoldUnderwater: [], finalEquity: 1, finalBuyHoldEquity: 1,
      maxUnderwater: 0, maxBuyHoldUnderwater: 0,
      meanFinalEquity: 1, meanFinalBuyHoldEquity: 1, meanMaxUnderwater: 0, meanMaxBuyHoldUnderwater: 0,
    };
  }
  const len = Math.min(...perToken.map((s) => s.bars));
  const equity: number[] = [];
  const buyHoldEquity: number[] = [];
  for (let i = 0; i < len; i++) {
    let e = 0;
    let b = 0;
    for (const s of perToken) {
      e += s.equity[i];
      b += s.buyHoldEquity[i];
    }
    equity.push(round6(e / perToken.length));
    buyHoldEquity.push(round6(b / perToken.length));
  }
  const underwater = underwaterOf(equity);
  const buyHoldUnderwater = underwaterOf(buyHoldEquity);
  const mean = (f: (s: SeriesWindow) => number) =>
    round6(perToken.reduce((a, s) => a + f(s), 0) / perToken.length);
  return {
    startBar: perToken[0].startBar,
    endBar: perToken[0].endBar,
    bars: len,
    equity,
    buyHoldEquity,
    underwater,
    buyHoldUnderwater,
    finalEquity: equity.length ? equity[equity.length - 1] : 1,
    finalBuyHoldEquity: buyHoldEquity.length ? buyHoldEquity[buyHoldEquity.length - 1] : 1,
    maxUnderwater: maxOf(underwater),
    maxBuyHoldUnderwater: maxOf(buyHoldUnderwater),
    meanFinalEquity: mean((s) => s.finalEquity),
    meanFinalBuyHoldEquity: mean((s) => s.finalBuyHoldEquity),
    meanMaxUnderwater: mean((s) => s.maxUnderwater),
    meanMaxBuyHoldUnderwater: mean((s) => s.maxBuyHoldUnderwater),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILD THE SERIES OBJECT (deterministic; no Date / no random)
// ════════════════════════════════════════════════════════════════════════════

export interface TokenSeries {
  symbol: string;
  synthetic: boolean;
  bars: number;
  splitBar: number;
  /** look-ahead-safe trailing-trend regime label per bar over the FULL series (disclosure). */
  regimes: Regime[];
  outOfSample: SeriesWindow;
  full: SeriesWindow;
}

export interface SeriesReport {
  note: string;
  source: string;
  selectedConfig: Record<string, number | boolean | string>;
  params: { oosFraction: number; rounding: number };
  perToken: TokenSeries[];
  aggregate: { outOfSample: AggregateSeries; full: AggregateSeries };
  reconciliation: {
    note: string;
    aggregate: {
      outOfSampleFinalEquity: number;
      outOfSampleMaxUnderwater: number;
      fullFinalEquity: number;
      fullMaxUnderwater: number;
    };
  };
}

export function buildSeries(oosFraction: number, walk: WalkParams = DEFAULT_WALK): SeriesReport {
  const universe = loadUniverse();
  const winner = selectedWinner(universe, oosFraction);

  const perTokenOOS: SeriesWindow[] = [];
  const perTokenFull: SeriesWindow[] = [];

  const perToken: TokenSeries[] = universe.map((tok) => {
    const result = runWalk(tok.bars, winner.walk, winner.strategy);
    const equityAll = result.trace.map((r) => r.equity);
    const buyHoldAll = result.trace.map((r) => r.buyHoldEquity);
    const n = tok.bars.length;
    const splitBar = splitBarOf(n, oosFraction);

    const oos = sliceSeries(equityAll, buyHoldAll, splitBar, n);
    const full = sliceSeries(equityAll, buyHoldAll, 0, n);
    perTokenOOS.push(oos);
    perTokenFull.push(full);

    return {
      symbol: tok.symbol,
      synthetic: tok.synthetic,
      bars: n,
      splitBar,
      regimes: regimeLabels(tok.bars.map((b) => b.close)),
      outOfSample: oos,
      full,
    };
  });

  const aggOOS = aggregateSeries(perTokenOOS);
  const aggFull = aggregateSeries(perTokenFull);

  return {
    note:
      "REAL per-bar backtest series for the SELECTED momentum config (long-only + EMA 30/80) " +
      "on the SAME committed daily fixtures as report-momentum.json. Look-ahead-safe (see " +
      "test/momentum.test.ts truncation invariance). Strategy equity / buy&hold equity / " +
      "underwater depth (1 - equity/runningPeak) per bar, re-based to 1.0 at each window's " +
      "start. Aggregate = equal-weight mean of the per-token re-based equity curves. NO alpha " +
      "is claimed: the OOS strategy total return is a small LOSS; the win is a far shallower " +
      "drawdown (the underwater pane). report-momentum.json / report.json are UNTOUCHED.",
    source:
      "backtest/series.ts -> runWalk(momentum.ts) on loadUniverse() fixtures with the in-sample " +
      "selected winner (re-derived via selectInSample, never re-selected on OOS).",
    selectedConfig: candidateConfig(winner),
    params: { oosFraction, rounding: 6 },
    perToken,
    aggregate: { outOfSample: aggOOS, full: aggFull },
    reconciliation: {
      note:
        "These per-bar finals reconcile with report-momentum.json. The report's aggregate is an " +
        "equal-weight MEAN OF PER-TOKEN metrics, so the reconciling scalars are the mean-of-" +
        "per-token values: aggregate.<window>.meanFinalEquity == 1 + report aggregate.<window>." +
        "totalReturn, and aggregate.<window>.meanMaxUnderwater == report aggregate.<window>." +
        "maxDrawdown (within 6dp rounding). The aggregate.equity/underwater arrays are the pooled " +
        "mean CURVE for plotting (a distinct, equally-honest aggregate path). The test pins all.",
      aggregate: {
        outOfSampleFinalEquity: aggOOS.meanFinalEquity,
        outOfSampleMaxUnderwater: aggOOS.meanMaxUnderwater,
        fullFinalEquity: aggFull.meanFinalEquity,
        fullMaxUnderwater: aggFull.meanMaxUnderwater,
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI ENTRY — write the byte-reproducible series
// ════════════════════════════════════════════════════════════════════════════

export function writeSeries(report: SeriesReport): void {
  fs.writeFileSync(SERIES_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
}

export function main(): void {
  const oosFraction = Number(process.env.OOS_FRACTION) || DEFAULT_OOS_FRACTION;
  const report = buildSeries(oosFraction);
  writeSeries(report);

  const a = report.aggregate.outOfSample;
  console.log(`[stoic] per-bar series -> ${SERIES_PATH}`);
  console.log(`  selected: ${report.selectedConfig.label}`);
  console.log(
    `  OOS aggregate: ${a.bars} bars, final strat equity ${a.finalEquity} (return ${((a.finalEquity - 1) * 100).toFixed(2)}%) vs B&H ${a.finalBuyHoldEquity}`
  );
  console.log(
    `  OOS max underwater: strat ${(a.maxUnderwater * 100).toFixed(2)}% vs B&H ${(a.maxBuyHoldUnderwater * 100).toFixed(2)}%`
  );
}

if (require.main === module) {
  main();
}
