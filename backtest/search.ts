/**
 * Stoic — HONEST in-sample parameter search (Phase 1, gap 1).  [SEARCH]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS (and is NOT)
 * ════════════════════════════════════════════════════════════════════════════
 * The default committed strategy LOSES to buy-and-hold net of cost on every segment
 * (report.json: full -36.48% vs B&H -5.36%; held-out OOS -18.07% vs B&H -16.65%; Sharpe
 * -12.24; 843 trades; win 27.8%). The churn signature (843 trades / 27.8% win / deeply
 * negative Sharpe) points at COST-DOMINATED OVER-TRADING — per-bar conviction flips that
 * each pay the 10+10 bps cost. This module asks, HONESTLY: can throttling that churn —
 * by widening the divergence dead-band, raising the entry threshold, adding a minimum
 * position dwell, and/or trading only at regime extremes — turn the FULL-COVERAGE window
 * (where the advertised two-leg construct is non-degenerate on every bar) into an honest,
 * held-out-OOS beat of buy-and-hold?
 *
 * It searches the four budgeted knobs ON THE IN-SAMPLE SEGMENT ONLY (leading 70% of the
 * full-coverage slice), selects the single best config by in-sample EXCESS-over-B&H, then
 * runs the held-out OOS tail ONCE and reports it UNCONDITIONALLY — win, loss, or break-even.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY (binding — see HONEST_SEARCH_RULES.md §1, §2, §6)
 * ════════════════════════════════════════════════════════════════════════════
 *  - SELECTION IS IN-SAMPLE ONLY. The OOS tail is NEVER an input to any choice. It is run
 *    once, after selection, and reported as-is. The split is the fixed default (oosFraction
 *    0.30); it is never moved to flatter a result.
 *  - The walk-forward is the SAME look-ahead-safe construct as engine.runBacktest (decision
 *    at bar i uses only bars <= i; the rolling z-score window ends at t-1). The three new
 *    knobs (dwell, regime-extremes-only, dead-band override) act only on at-or-before
 *    information, so they cannot introduce look-ahead — a test pins truncation invariance.
 *  - At DEFAULT knobs this harness reproduces engine.runBacktest BYTE-FOR-BYTE on the
 *    sliced bars (a test asserts it), so the knobs are the ONLY thing that differs.
 *  - The cost model stays the labelled 10+10 bps assumption; all returns are net of it.
 *  - report.json AND report-fullcoverage.json are NOT touched. This emits a SEPARATE,
 *    byte-reproducible file (report-search.json) carrying every config evaluated, the
 *    in-sample-selected winner, its UNCONDITIONAL OOS, and a 15+15 bps stress.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  RESULT (committed in report-search.json; reproduced byte-for-byte by the test)
 * ════════════════════════════════════════════════════════════════════════════
 *  NO config beats buy-and-hold net-of-cost on the held-out full-coverage OOS tail — for
 *  any token OR the aggregate. The OOS tail is a RISING market (B&H +4.09% aggregate), and
 *  every throttled contrarian config goes nearly flat there, so it cannot out-earn B&H.
 *  The go/no-go gate (HONEST_SEARCH_RULES.md §6 G1) is therefore NOT met -> edgeFound=false.
 *  The ONE measurable, defensible finding is RISK: the in-sample-selected throttle cuts the
 *  OOS max-drawdown to ~0.6% vs B&H ~4.3% (and the full-window loss from -12.94% to ~+0.02%).
 *  That is a risk-overlay claim, NOT a B&H beat — it is the Phase-1b reframe anchor, proven
 *  by THIS harness. Nothing here is selected on OOS, fabricated, or window-shopped.
 *
 * RUN:  ts-node backtest/search.ts        (writes backtest/report-search.json)
 */

import * as fs from "fs";
import * as path from "path";
import { Bar } from "../src/data/binance";
import { loadAllFixtures, sliceToFullCoverage } from "./run";
import {
  buildCrowdLeg,
  buildFlowLeg,
  rollingZScore,
  readRegime,
  RegimeRead,
  regimeGain,
  ZSCORE_WINDOW,
  ZSCORE_MIN_OBS,
  DIVERGENCE_FULL_Z,
  MOMENTUM_LOOKBACK,
} from "../src/signal/divergence";
import { CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX } from "../src/signal/core";
import { scoreConviction, barFeatures } from "../src/signal/signalEngine";
import { decideTrade, Side } from "../src/agent/decide";
import {
  metricsFromTrace,
  Metrics,
  BarTrace,
  CompletedTrade,
  round12,
  DEFAULT_PARAMS,
} from "./engine";

export const SEARCH_REPORT_PATH = path.resolve(__dirname, "report-search.json");
export const SEARCH_OOS_FRACTION = 0.3;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  KNOBS
// ════════════════════════════════════════════════════════════════════════════
export interface SearchKnobs {
  /** Divergence dead-band in z-units. Widening pins more bars to neutral (fewer trades). */
  deadbandZ: number;
  /** |conviction-500| must exceed this to trade. Raising -> more selective. */
  entryThreshold: number;
  /** Min bars a directional position must persist before a flip/flat is honoured (anti-churn). */
  minDwell: number;
  /** If true, a non-flat side requires a non-neutral regime favour (extreme fear/greed/stretched). */
  regimeExtremesOnly: boolean;
}

/** The DEFAULT knobs reproduce engine.runBacktest exactly (deadband 0.5 = DIVERGENCE_DEADBAND_Z). */
export const DEFAULT_KNOBS: SearchKnobs = {
  deadbandZ: 0.5,
  entryThreshold: DEFAULT_PARAMS.entryThreshold,
  minDwell: 0,
  regimeExtremesOnly: false,
};

/**
 * divergence -> 0..1000 bias with a CONFIGURABLE dead-band. Identical math to
 * divergence.divergenceToBias; only the dead-band constant is parameterised so the search
 * can widen it. Pure.
 */
function divergenceToBiasWith(divergence: number, gain: number, deadbandZ: number): number {
  if (!isFinite(divergence)) return CONVICTION_FLAT;
  const sign = divergence > 0 ? 1 : divergence < 0 ? -1 : 0;
  const mag = Math.abs(divergence);
  if (mag < deadbandZ) return CONVICTION_FLAT;
  const span = Math.max(1e-9, DIVERGENCE_FULL_Z - deadbandZ);
  const norm = clamp(((mag - deadbandZ) * gain) / span, 0, 1);
  return Math.round(clamp(CONVICTION_FLAT - sign * norm * CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX));
}

/**
 * Parameterised walk-forward. Mirrors engine.runBacktest's mechanics EXACTLY (decision at
 * bar i uses only bars <= i; position held into i+1; cost on |Δ signed notional|), with the
 * four knobs applied at decision time using only at-or-before information. Look-ahead-safe.
 * Pure given (bars, knobs, costBps).
 */
export function runBacktestKnobs(
  bars: Bar[],
  knobs: SearchKnobs,
  txBps: number = DEFAULT_PARAMS.txCostBps,
  slipBps: number = DEFAULT_PARAMS.slippageBps
): { trace: BarTrace[]; trades: CompletedTrade[] } {
  const crowd = buildCrowdLeg(bars);
  const flow = buildFlowLeg(bars, MOMENTUM_LOOKBACK);
  const crowdZ = rollingZScore(crowd, ZSCORE_WINDOW, ZSCORE_MIN_OBS);
  const flowZ = rollingZScore(flow, ZSCORE_WINDOW, ZSCORE_MIN_OBS);
  const costRate = (txBps + slipBps) / 10000;

  const trace: BarTrace[] = [];
  const trades: CompletedTrade[] = [];

  let equity = 1.0;
  let buyHold = 1.0;
  let prevWeight = 0;
  let prevSide: Side | null = null;

  let openSide: Side | null = null;
  let openEntryBar = 0;
  let openEntryPrice = 0;
  let openCostAccrued = 0;

  let curHeldSide: Side = "flat";
  let barsInSide = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r = isFinite(prevClose) && prevClose !== 0 && isFinite(b.close) ? b.close / prevClose - 1 : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    const divergence = crowdZ[i] - flowZ[i];
    const signDiv: -1 | 0 | 1 = divergence > 0 ? -1 : divergence < 0 ? 1 : 0;
    const regime: RegimeRead = readRegime({ funding: b.funding });
    const gain = regimeGain(regime, signDiv);
    const divergenceBias = divergenceToBiasWith(divergence, gain, knobs.deadbandZ);

    const feats = barFeatures(bars, i, MOMENTUM_LOOKBACK);
    const scored = scoreConviction({
      bar: i,
      trend: feats.trend,
      momentum: feats.momentum,
      fundingBias: feats.fundingBias,
      flowBias: feats.flowBias,
      divergenceBias,
    });

    let side: Side = decideTrade(prevSide, scored.conviction, scored.sizeBps, knobs.entryThreshold).side;
    if (!DEFAULT_PARAMS.allowShort && side === "short") side = "flat";

    // regime-extremes-only gate (uses only this bar's regime read)
    if (knobs.regimeExtremesOnly && side !== "flat" && regime.favored === 0) side = "flat";

    // min-dwell / cooldown: suppress a flip/flat until the held position has dwelled enough
    if (knobs.minDwell > 0 && (curHeldSide === "long" || curHeldSide === "short")) {
      if (side !== curHeldSide && barsInSide < knobs.minDwell) side = curHeldSide;
    }

    const magnitude = (scored.sizeBps / 10000) * DEFAULT_PARAMS.maxLeverage;
    const targetWeight = side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    const cost = Math.abs(targetWeight - prevWeight) * costRate;
    if (cost > 0) equity *= 1 - cost;

    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross = openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
        trades.push({
          entryBar: openEntryBar, exitBar: i, side: openSide,
          entryPrice: openEntryPrice, exitPrice, netReturn: round12(gross - (openCostAccrued + cost)),
        });
        openSide = null;
        openCostAccrued = 0;
      }
      if (side === "long" || side === "short") {
        openSide = side;
        openEntryBar = i;
        openEntryPrice = b.close;
        openCostAccrued = cost;
      }
    } else if (openSide === "long" || openSide === "short") {
      openCostAccrued += cost;
    }

    if (side === curHeldSide) barsInSide++;
    else { curHeldSide = side; barsInSide = 1; }

    trace.push({
      bar: i, t: b.t, close: b.close, conviction: scored.conviction, side,
      targetWeight: round12(targetWeight), barReturn: round12(barReturn),
      cost: round12(cost), equity: round12(equity), buyHoldEquity: round12(buyHold),
    });

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side;
  }

  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross = openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
    trades.push({
      entryBar: openEntryBar, exitBar: bars.length - 1, side: openSide,
      entryPrice: openEntryPrice, exitPrice, netReturn: round12(gross - openCostAccrued),
    });
  }

  return { trace, trades };
}

// ════════════════════════════════════════════════════════════════════════════
//  SEGMENT METRICS + AGGREGATION
// ════════════════════════════════════════════════════════════════════════════
export interface KnobSegments {
  inSample: Metrics;
  outOfSample: Metrics;
  full: Metrics;
}

export function segmentsForKnobs(
  bars: Bar[],
  knobs: SearchKnobs,
  txBps?: number,
  slipBps?: number
): KnobSegments {
  const { trace, trades } = runBacktestKnobs(bars, knobs, txBps, slipBps);
  const n = bars.length;
  const splitBar = Math.floor(n * (1 - SEARCH_OOS_FRACTION));
  return {
    inSample: metricsFromTrace(trace, trades, 0, splitBar),
    outOfSample: metricsFromTrace(trace, trades, splitBar, n),
    full: metricsFromTrace(trace, trades, 0, n),
  };
}

function meanMetrics(items: Metrics[]): Metrics {
  const n = items.length || 1;
  const r = (x: number) => round12(x / n);
  const s = items.reduce(
    (a, m) => ({
      totalReturn: a.totalReturn + m.totalReturn,
      winRate: a.winRate + m.winRate,
      maxDrawdown: a.maxDrawdown + m.maxDrawdown,
      sharpe: a.sharpe + m.sharpe,
      sortino: a.sortino + m.sortino,
      tradeCount: a.tradeCount + m.tradeCount,
      bars: a.bars + m.bars,
      buyAndHoldReturn: a.buyAndHoldReturn + m.buyAndHoldReturn,
    }),
    { totalReturn: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, sortino: 0, tradeCount: 0, bars: 0, buyAndHoldReturn: 0 }
  );
  return {
    totalReturn: r(s.totalReturn), winRate: r(s.winRate), maxDrawdown: r(s.maxDrawdown),
    sharpe: r(s.sharpe), sortino: r(s.sortino), tradeCount: s.tradeCount, bars: s.bars,
    buyAndHoldReturn: r(s.buyAndHoldReturn),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  THE SEARCH GRID (fixed BEFORE the search; HONEST_SEARCH_RULES.md §6 budget <=24)
// ════════════════════════════════════════════════════════════════════════════
//  deadbandZ ∈ {0.5,0.75,1.0}; entryThreshold ∈ {120,200,300}; minDwell ∈ {0,1,3,6,12};
//  regimeExtremesOnly ∈ {off,on}. Swept one axis at a time around the default, plus a few
//  sensible combos — 18 configs total (within budget). Order is FIXED and deterministic.
export const SEARCH_GRID: { name: string; knobs: SearchKnobs }[] = (() => {
  const out: { name: string; knobs: SearchKnobs }[] = [];
  const add = (name: string, k: Partial<SearchKnobs>) => out.push({ name, knobs: { ...DEFAULT_KNOBS, ...k } });
  add("DEFAULT", {});
  add("deadbandZ=0.75", { deadbandZ: 0.75 });
  add("deadbandZ=1.0", { deadbandZ: 1.0 });
  add("entry=200", { entryThreshold: 200 });
  add("entry=300", { entryThreshold: 300 });
  add("dwell=1", { minDwell: 1 });
  add("dwell=3", { minDwell: 3 });
  add("dwell=6", { minDwell: 6 });
  add("dwell=12", { minDwell: 12 });
  add("regimeOnly", { regimeExtremesOnly: true });
  add("entry=300+dwell=6", { entryThreshold: 300, minDwell: 6 });
  add("entry=300+dwell=12", { entryThreshold: 300, minDwell: 12 });
  add("deadbandZ=1.0+dwell=6", { deadbandZ: 1.0, minDwell: 6 });
  add("deadbandZ=1.0+entry=300", { deadbandZ: 1.0, entryThreshold: 300 });
  add("deadbandZ=1.0+entry=300+dwell=6", { deadbandZ: 1.0, entryThreshold: 300, minDwell: 6 });
  add("deadbandZ=1.0+entry=300+dwell=12", { deadbandZ: 1.0, entryThreshold: 300, minDwell: 12 });
  add("regimeOnly+dwell=6", { regimeExtremesOnly: true, minDwell: 6 });
  add("regimeOnly+entry=300", { regimeExtremesOnly: true, entryThreshold: 300 });
  return out;
})();

// ════════════════════════════════════════════════════════════════════════════
//  REPORT SHAPE
// ════════════════════════════════════════════════════════════════════════════
export interface SliceInfo { symbol: string; bars: number; }

export interface ConfigInSample {
  name: string;
  knobs: SearchKnobs;
  /** equal-weight aggregate over tokens, IN-SAMPLE ONLY (the only thing selection sees). */
  inSampleAggregate: Metrics;
  /** in-sample excess = aggregate in-sample totalReturn − aggregate in-sample B&H. */
  inSampleExcessOverBH: number;
}

export interface PerTokenSegments {
  symbol: string;
  inSample: Metrics;
  outOfSample: Metrics;
  full: Metrics;
}

export interface EvaluatedConfig {
  name: string;
  knobs: SearchKnobs;
  perToken: PerTokenSegments[];
  aggregate: KnobSegments;
}

export interface SearchReport {
  what: string;
  honesty: string[];
  window: {
    note: string;
    oosFraction: number;
    perToken: SliceInfo[];
  };
  costModelNote: string;
  searchGrid: { count: number; budgetNote: string; configs: string[] };
  /** Every config's IN-SAMPLE aggregate (the full disclosure of what selection saw). */
  inSampleTable: ConfigInSample[];
  selection: {
    rule: string;
    selectedConfig: string;
    selectedKnobs: SearchKnobs;
    inSampleAggregate: Metrics;
    inSampleExcessOverBH: number;
  };
  /** UNCONDITIONAL held-out OOS for the DEFAULT and the SELECTED config (run once, after). */
  heldOut: {
    default: EvaluatedConfig;
    selected: EvaluatedConfig;
  };
  /** 15+15 bps cost-bump stress on the selected config (HONEST_SEARCH_RULES.md §3.4). */
  stress15bps: EvaluatedConfig;
  /** Buy-and-hold OOS max-drawdown baseline for the risk-overlay (Phase-1b) reframe. */
  riskOverlay: {
    note: string;
    perToken: { symbol: string; strategyOosMaxDD: number; buyHoldOosMaxDD: number; buyHoldOosReturn: number }[];
    aggregate: { strategyOosMaxDD: number; buyHoldOosMaxDD: number };
  };
  verdict: {
    edgeFound: boolean;
    beatsBuyHoldOOS: boolean;
    gateG1Met: boolean;
    summary: string;
    decision: string;
  };
}

function evaluate(symbolsBars: { symbol: string; bars: Bar[] }[], name: string, knobs: SearchKnobs, txBps?: number, slipBps?: number): EvaluatedConfig {
  const perToken: PerTokenSegments[] = symbolsBars.map((s) => {
    const seg = segmentsForKnobs(s.bars, knobs, txBps, slipBps);
    return { symbol: s.symbol, inSample: seg.inSample, outOfSample: seg.outOfSample, full: seg.full };
  });
  const aggregate: KnobSegments = {
    inSample: meanMetrics(perToken.map((p) => p.inSample)),
    outOfSample: meanMetrics(perToken.map((p) => p.outOfSample)),
    full: meanMetrics(perToken.map((p) => p.full)),
  };
  return { name, knobs, perToken, aggregate };
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILD THE SEARCH REPORT  (pure given the committed fixtures)
// ════════════════════════════════════════════════════════════════════════════
export function buildSearchReport(): SearchReport {
  const symbolsBars = loadAllFixtures().map((fx) => {
    const sliced = sliceToFullCoverage(fx).fixture;
    if (!sliced) throw new Error(`[search] ${fx.symbol}: no full-coverage slice`);
    return { symbol: fx.symbol, bars: sliced.bars };
  });

  // 1) IN-SAMPLE table for EVERY config (selection sees ONLY these).
  const inSampleTable: ConfigInSample[] = SEARCH_GRID.map(({ name, knobs }) => {
    const evalc = evaluate(symbolsBars, name, knobs);
    const is = evalc.aggregate.inSample;
    return {
      name, knobs,
      inSampleAggregate: is,
      inSampleExcessOverBH: round12(is.totalReturn - is.buyAndHoldReturn),
    };
  });

  // 2) SELECT on in-sample excess (return − B&H); tie-break by higher in-sample return,
  //    then by FEWER trades (prefer the less-overfit / lower-churn config), then by name
  //    (stable). Deterministic — never peeks at OOS.
  const ranked = [...inSampleTable].sort((a, b) =>
    (b.inSampleExcessOverBH - a.inSampleExcessOverBH) ||
    (b.inSampleAggregate.totalReturn - a.inSampleAggregate.totalReturn) ||
    (a.inSampleAggregate.tradeCount - b.inSampleAggregate.tradeCount) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
  const winner = ranked[0];

  // 3) Held-out OOS — run ONCE for DEFAULT and the SELECTED config, reported as-is.
  const heldOutDefault = evaluate(symbolsBars, "DEFAULT", DEFAULT_KNOBS);
  const heldOutSelected = evaluate(symbolsBars, winner.name, winner.knobs);

  // 4) 15+15 bps stress on the selected config (Rule 3.4).
  const stress15 = evaluate(symbolsBars, winner.name, winner.knobs, 15, 15);

  // 5) Risk-overlay baseline: strategy vs B&H OOS max-drawdown.
  const riskPer = heldOutSelected.perToken.map((p) => ({
    symbol: p.symbol,
    strategyOosMaxDD: p.outOfSample.maxDrawdown,
    buyHoldOosMaxDD: round12(buyHoldOosMaxDD(symbolsBars.find((s) => s.symbol === p.symbol)!.bars)),
    buyHoldOosReturn: p.outOfSample.buyAndHoldReturn,
  }));
  const riskAgg = {
    strategyOosMaxDD: round12(riskPer.reduce((a, c) => a + c.strategyOosMaxDD, 0) / riskPer.length),
    buyHoldOosMaxDD: round12(riskPer.reduce((a, c) => a + c.buyHoldOosMaxDD, 0) / riskPer.length),
  };

  // 6) VERDICT — strict G1: does the SELECTED config beat B&H net-of-cost on the held-out
  //    OOS for >=1 token OR the aggregate? (strictly greater)
  const aggBeat = heldOutSelected.aggregate.outOfSample.totalReturn > heldOutSelected.aggregate.outOfSample.buyAndHoldReturn;
  const anyTokenBeat = heldOutSelected.perToken.some((p) => p.outOfSample.totalReturn > p.outOfSample.buyAndHoldReturn);
  const gateG1Met = aggBeat || anyTokenBeat;

  return {
    what:
      "Phase-1 honest in-sample parameter search over the FULL-COVERAGE slice (the contiguous " +
      "tail where all flow legs are present, so the advertised two-leg construct is non-degenerate " +
      "on every bar). Goal: throttle the cost-dominated over-trading (843 trades / 27.8% win on the " +
      "default full window) into an honest, held-out-OOS beat of buy-and-hold. Selection is " +
      "in-sample only; OOS is reported unconditionally; report.json / report-fullcoverage.json are untouched.",
    honesty: [
      "SELECTION IN-SAMPLE ONLY: configs are ranked by in-sample aggregate excess-over-B&H; the held-out OOS tail is NEVER an input to any choice (HONEST_SEARCH_RULES.md §1, §2).",
      "OOS RUN ONCE, AFTER selection, and reported as-is — win, loss, or break-even — for the selected config AND the default, per token and aggregate.",
      "LOOK-AHEAD SAFE: same walk-forward as engine.runBacktest (decision at bar i uses bars <= i; z-window ends at t-1); the new knobs act only on at-or-before info. A test pins truncation invariance.",
      "FAITHFUL: at DEFAULT knobs this harness reproduces engine.runBacktest byte-for-byte on the sliced bars (a test asserts it), so the knobs are the ONLY difference.",
      "COST: the labelled 10+10 bps assumption; all returns net of it; a 15+15 bps stress is included (Rule 3.4).",
      "ISOLATION: report.json and report-fullcoverage.json are not produced or touched here; this is a separate byte-reproducible file.",
    ],
    window: {
      note:
        "FULL-COVERAGE slice of the committed REAL Binance fixtures (chosen by data coverage, not by result — same slice as report-fullcoverage.json). Default 0.30 split; in-sample = leading 70%, held-out OOS = trailing 30%.",
      oosFraction: SEARCH_OOS_FRACTION,
      perToken: symbolsBars.map((s) => ({ symbol: s.symbol, bars: s.bars.length })),
    },
    costModelNote:
      "Transaction cost + slippage are a CONFIGURABLE ASSUMPTION (default 10 bps each), charged on |Δ signed notional| per position change. The exact organizer cost/slippage model is UNCONFIRMED.",
    searchGrid: {
      count: SEARCH_GRID.length,
      budgetNote:
        "Fixed before the search (HONEST_SEARCH_RULES.md §6): deadbandZ∈{0.5,0.75,1.0}, entryThreshold∈{120,200,300}, minDwell∈{0,1,3,6,12}, regimeExtremesOnly∈{off,on}, swept one axis at a time around the default plus a few combos. The budget is not widened after seeing results.",
      configs: SEARCH_GRID.map((c) => c.name),
    },
    inSampleTable,
    selection: {
      rule: "argmax in-sample aggregate (totalReturn − buyAndHoldReturn); tie-break higher in-sample return, then fewer trades, then name. OOS never consulted.",
      selectedConfig: winner.name,
      selectedKnobs: winner.knobs,
      inSampleAggregate: winner.inSampleAggregate,
      inSampleExcessOverBH: winner.inSampleExcessOverBH,
    },
    heldOut: { default: heldOutDefault, selected: heldOutSelected },
    stress15bps: stress15,
    riskOverlay: {
      note:
        "The selected throttle is FLAT-ish on the held-out OOS (a rising B&H tail), so it does NOT out-earn B&H — but it draws down far less. This is the measurable, defensible Phase-1b risk-overlay claim (proven by this same harness), NOT a B&H beat.",
      perToken: riskPer,
      aggregate: riskAgg,
    },
    verdict: {
      edgeFound: gateG1Met,
      beatsBuyHoldOOS: gateG1Met,
      gateG1Met,
      summary: gateG1Met
        ? "A config beats B&H net-of-cost on the held-out full-coverage OOS — see selection + heldOut.selected."
        : "NO config beats buy-and-hold net-of-cost on the held-out full-coverage OOS tail — for any token OR the aggregate. The OOS tail is a RISING market (aggregate B&H +4.09%) and the in-sample-selected throttle goes nearly flat there (aggregate OOS -0.27% vs B&H +4.09%; every token loses to B&H). The throttle DOES cut OOS max-drawdown to ~0.6% vs B&H ~4.3% and turns the full-window loss (-12.94%) to ~+0.02%, but that is a RISK claim, not a B&H beat.",
      decision: gateG1Met
        ? "PHASE 1: lead with this full-coverage held-out-OOS B&H beat; retain the frozen full-window loss labelled as the original honest result."
        : "PHASE 1b (HONEST_SEARCH_RULES.md §7): the go/no-go gate G1 is NOT met within the fixed budget. Do NOT fabricate, fish further, loosen the cost model, move the split, or select on OOS. Reposition the deliverable as a reproducible, look-ahead-safe positioning-vs-flow divergence / risk-overlay research tool; re-anchor value on the measurable drawdown-reduction claim above; state plainly that the headline B&H benchmark was not beaten and why the reframed claim is the honest value proposition. The frozen baseline (report.json) is retained unchanged.",
    },
  };
}

/** B&H max-drawdown over the held-out OOS tail of a sliced series (for the risk-overlay note). */
function buyHoldOosMaxDD(bars: Bar[]): number {
  const n = bars.length;
  const splitBar = Math.floor(n * (1 - SEARCH_OOS_FRACTION));
  const oos = bars.slice(splitBar);
  let eq = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  for (let i = 1; i < oos.length; i++) {
    const r = oos[i - 1].close !== 0 ? oos[i].close / oos[i - 1].close - 1 : 0;
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const dd = (peak - eq) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/** Deterministic serialization (2-space indent + trailing newline) for byte reproducibility. */
export function serializeSearchReport(report: SearchReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function main(): void {
  const report = buildSearchReport();
  fs.writeFileSync(SEARCH_REPORT_PATH, serializeSearchReport(report), "utf8");
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const sel = report.heldOut.selected.aggregate;
  console.log(`[stoic] search: ${SEARCH_GRID.length} in-sample configs over the full-coverage slice.`);
  console.log(`  SELECTED (in-sample): ${report.selection.selectedConfig}  ${JSON.stringify(report.selection.selectedKnobs)}`);
  console.log(`    in-sample agg: ret=${pct(report.selection.inSampleAggregate.totalReturn)} vs B&H ${pct(report.selection.inSampleAggregate.buyAndHoldReturn)} (excess ${pct(report.selection.inSampleExcessOverBH)})`);
  console.log(`    HELD-OUT  agg: ret=${pct(sel.outOfSample.totalReturn)} vs B&H ${pct(sel.outOfSample.buyAndHoldReturn)} | trades=${sel.outOfSample.tradeCount} | maxDD=${pct(sel.outOfSample.maxDrawdown)}`);
  console.log(`    risk-overlay: strategy OOS maxDD ${pct(report.riskOverlay.aggregate.strategyOosMaxDD)} vs B&H ${pct(report.riskOverlay.aggregate.buyHoldOosMaxDD)}`);
  console.log(`  VERDICT: edgeFound=${report.verdict.edgeFound}  beatsBuyHoldOOS=${report.verdict.beatsBuyHoldOOS}  gateG1Met=${report.verdict.gateG1Met}`);
  console.log(`  -> ${report.verdict.decision.split(":")[0]}`);
  console.log(`[stoic] search: wrote ${SEARCH_REPORT_PATH}`);
}

if (require.main === module) main();
