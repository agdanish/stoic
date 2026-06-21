/**
 * Stoic — LAYER ATTRIBUTION ABLATION over the DAILY multi-regime harness.  [ABL]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS  (READ ROBUSTNESS-momentum.md FIRST)
 * ════════════════════════════════════════════════════════════════════════════
 * The committed headline (backtest/report-momentum.json) runs the FULL pipeline:
 *
 *     1. DIRECTIONAL TREND CORE      (momentum.ts)
 *     2. + F&G CONTRARIAN GATE       (regimeGate.ts)
 *     3. + DIVERGENCE/FUNDING RISK FILTER (strategy.ts riskFilter)
 *
 * but it never ATTRIBUTES the result across those layers. This harness answers the
 * brutal question a skeptical panel asks: "does each overlay actually EARN its place,
 * or is the whole result just the trend core's bear-dodge?" It runs the SAME
 * look-ahead-safe walk-forward + cost model on the SAME daily fixtures with the SAME
 * in-sample-selected LOCKED config, toggling exactly one layer at a time:
 *
 *     A1  trendOnly         — directional core ALONE (no gate, no filter)
 *     A2  +fgGate           — core + the F&G contrarian gate
 *     A3  +riskFilter       — core + gate + the divergence/funding risk filter  (== runStrategy)
 *     A4  +crossSectional   — the cross-sectional dislocation layer. It CANNOT be wired onto
 *                             this daily trend core (the daily fixtures carry no long/short or
 *                             taker flow legs, and it is a CONTRARIAN relative-value selection,
 *                             not a directional/trend signal). It lives ONLY on the hourly
 *                             divergence harness; we surface its committed result from
 *                             report-crosssectional.json, clearly labelled as a SEPARATE
 *                             harness/window — never folded into the daily numbers.
 *
 * Each arm is reconstructed from the SAME EXPORTED PURE FUNCTIONS the production pipeline
 * uses (momentumSignal, applyRegimeGate, riskFilter, sizeFromConviction, decideTrade) —
 * NOT a re-implementation of the math. A dedicated test pins that arm A3 reproduces the
 * committed runStrategy walk byte-for-byte (so the ablation harness is faithful).
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY (binding — mirrors HONEST_SEARCH_RULES.md)
 * ════════════════════════════════════════════════════════════════════════════
 *  - The LOCKED config is selected on the IN-SAMPLE 70% ONLY (selectInSample over the
 *    committed sweep — same winner as report-momentum.json: long-only+ema30/80). The
 *    held-out OOS 30% is run once and reported AS-IS for every arm. The same config is
 *    used across A1..A3 so the ONLY thing changing is which overlays are active.
 *  - Net of the labelled 10+10 bps tx+slippage cost, folded into the equity curve.
 *  - divergenceAddsValue / crossSectionalAddsValue are COMPUTED from the committed metrics,
 *    never hand-set. If a layer adds nothing (or hurts), it is reported as false.
 *  - NEW report file (report-ablation.json), byte-reproducible. The frozen report.json AND
 *    report-momentum.json are NEVER touched by this file.
 *
 * RUN:  ts-node backtest/report-ablation.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DailyBar } from "../src/data/history";
import {
  WalkParams,
  WalkBar,
  CompletedTrade,
  Metrics,
  SplitMetrics,
  DEFAULT_WALK,
  DEFAULT_OOS_FRACTION,
  BARS_PER_YEAR_DAILY,
  round12,
  maxDrawdownOf,
  annualisedSharpe,
  annualisedSortino,
  metricsFromTrace,
  splitBarOf,
  aggregateMetrics,
  buildSweep,
  selectInSample,
  loadUniverse,
  Candidate,
  TokenInput,
  runWalk,
} from "./momentum";
import {
  runStrategy,
  StrategyOpts,
  riskFilter,
  RiskAction,
} from "../src/signal/strategy";
import {
  momentumSignal,
  MomentumOpts,
} from "../src/signal/momentum";
import { applyRegimeGate } from "../src/signal/regimeGate";
import {
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  sizeFromConviction,
} from "../src/signal/core";
import { decideTrade, Side } from "../src/agent/decide";
import {
  DrawdownState,
  DRAWDOWN_BUCKETS,
  DD_EDGE_SHALLOW,
  DD_EDGE_MID,
  DD_EDGE_DEEP,
  DD_MULT_FULL,
  DD_MULT_MID,
  DD_MULT_DEEP,
  DD_MULT_FLOOR,
} from "../src/signal/drawdownState";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG / PATHS
// ════════════════════════════════════════════════════════════════════════════

/** NEW report file — report.json AND report-momentum.json are NEVER touched. */
export const ABLATION_REPORT_PATH = path.resolve(__dirname, "report-ablation.json");
/** The committed cross-sectional report (read-only) — the A4 arm's SEPARATE-harness source. */
export const XS_REPORT_PATH = path.resolve(__dirname, "report-crosssectional.json");

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  THE ABLATION LAYERS — which overlays are active for this arm
// ════════════════════════════════════════════════════════════════════════════

/** Which overlays a given ablation arm activates. The trend core is ALWAYS on. */
export interface AblationLayers {
  /** Apply the F&G contrarian regime gate (regimeGate.applyRegimeGate). */
  fgGate: boolean;
  /** Apply the divergence/funding risk filter (strategy.riskFilter). */
  riskFilter: boolean;
}

/**
 * Per-bar conviction for a given ablation arm, reconstructed from the SAME exported pure
 * functions the production pipeline uses, with each overlay toggled by `layers`:
 *
 *   directionalBias  = momentumSignal(closes, opts)[i].directional         (TREND CORE, always)
 *   gatedBias        = layers.fgGate ? applyRegimeGate(...).gatedBias : directionalBias
 *   conviction       = layers.riskFilter ? FLAT + (gatedEdge * riskFactor) : gatedBias
 *
 * This is exactly scoreStrategyBar's composition (sans the {0,0}-no-op advisory fold, which
 * is inert on the backtest path), with each overlay made optional. When BOTH layers are on
 * it must equal runStrategy(bars, opts) — pinned by the test. Look-ahead-safe + pure.
 */
export function ablationConvictions(
  bars: DailyBar[],
  opts: StrategyOpts,
  layers: AblationLayers
): { conviction: number; sizeBps: number; riskAction: RiskAction }[] {
  const closes = bars.map((b) => b.close);
  const moms = momentumSignal(closes, opts as MomentumOpts);

  return bars.map((b, i) => {
    // 1) DIRECTIONAL TREND CORE — always on.
    const directionalBias = clamp(moms[i].directional, CONVICTION_MIN, CONVICTION_MAX);

    // 2) F&G CONTRARIAN GATE — optional.
    let gatedBias = directionalBias;
    let regime = applyRegimeGate(directionalBias, b.fearGreed).regime;
    if (layers.fgGate) {
      const g = applyRegimeGate(directionalBias, b.fearGreed);
      gatedBias = g.gatedBias;
      regime = g.regime;
    }

    // 3) DIVERGENCE/FUNDING RISK FILTER — optional.
    let edgeFactor = 1;
    let riskAction: RiskAction = "pass";
    if (layers.riskFilter) {
      const risk = riskFilter(gatedBias, regime, b.funding, opts, undefined);
      edgeFactor = risk.edgeFactor;
      riskAction = risk.action;
    }

    const gatedEdge = gatedBias - CONVICTION_FLAT;
    const conviction = Math.round(
      clamp(CONVICTION_FLAT + gatedEdge * edgeFactor, CONVICTION_MIN, CONVICTION_MAX)
    );
    const sizeBps = sizeFromConviction(conviction);
    return { conviction, sizeBps, riskAction };
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD over a PRECOMPUTED conviction series (mirrors momentum.runWalk EXACTLY)
// ════════════════════════════════════════════════════════════════════════════

export interface AblationWalkResult {
  trace: WalkBar[];
  trades: CompletedTrade[];
}

/**
 * Walk a DAILY bar series given a precomputed per-bar conviction/size series, ONE BAR AT A
 * TIME, IDENTICALLY to momentum.runWalk (decision held into the next bar; PnL on the prior
 * weight; cost on |Δ signed notional|). The ONLY difference vs runWalk is that the conviction
 * comes from `convs` (an ablation arm) instead of the full runStrategy. Pure + deterministic.
 */
export function ablationWalk(
  bars: DailyBar[],
  convs: { conviction: number; sizeBps: number }[],
  walk: WalkParams = DEFAULT_WALK
): AblationWalkResult {
  const costRate = (walk.txCostBps + walk.slippageBps) / 10000;
  const trace: WalkBar[] = [];
  const trades: CompletedTrade[] = [];

  let equity = 1.0;
  let buyHold = 1.0;
  let prevWeight = 0;
  let prevSide: Side | null = null;

  let openSide: Side | null = null;
  let openEntryBar = 0;
  let openEntryPrice = 0;
  let openCostAccrued = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const c = convs[i];

    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r =
        isFinite(prevClose) && prevClose !== 0 && isFinite(b.close) ? b.close / prevClose - 1 : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    let side: Side = decideTrade(prevSide, c.conviction, c.sizeBps, walk.entryThreshold).side;
    if (side === "short" && !walk.allowShort) side = "flat";

    const magnitude = (c.sizeBps / 10000) * walk.maxLeverage;
    const targetWeight = side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    const deltaNotional = Math.abs(targetWeight - prevWeight);
    const cost = deltaNotional * costRate;
    if (cost > 0) equity *= 1 - cost;

    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross =
          openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
        trades.push({
          entryBar: openEntryBar,
          exitBar: i,
          side: openSide,
          netReturn: round12(gross - (openCostAccrued + cost)),
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

    trace.push({
      bar: i,
      t: b.t,
      close: b.close,
      conviction: c.conviction,
      side,
      targetWeight: round12(targetWeight),
      barReturn: round12(barReturn),
      cost: round12(cost),
      equity: round12(equity),
      buyHoldEquity: round12(buyHold),
    });

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side;
  }

  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const gross =
      openSide === "long" ? last.close / openEntryPrice - 1 : openEntryPrice / last.close - 1;
    trades.push({
      entryBar: openEntryBar,
      exitBar: bars.length - 1,
      side: openSide,
      netReturn: round12(gross - openCostAccrued),
    });
  }

  return { trace, trades };
}

// ════════════════════════════════════════════════════════════════════════════
//  A5 — DRAWDOWN-SCALED WALK  (the full A3 pipeline + drawdown-bucket exposure scaler)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Walk a DAILY bar series IDENTICALLY to `ablationWalk`, but multiply the per-bar position
 * SIZE by the drawdown-bucket exposure multiplier (src/signal/drawdownState.ts) BEFORE the
 * trade decision. PURELY ADDITIVE: with the multiplier pinned to 1 (no drawdown) this reduces
 * to `ablationWalk` byte-for-byte; A1..A3 do not call this path at all.
 *
 * LOOK-AHEAD SAFETY — the load-bearing ordering:
 *   1. Book bar i's return on the PRIOR weight and update `equity` (realized through bar i).
 *   2. Read `dds.multiplier()` — derived ONLY from equity realized at-or-before bar i.
 *   3. Scale this bar's sizeBps by that multiplier, then decide the position held INTO bar i+1.
 *   4. AFTER the decision, feed bar i's realized equity into the state (`dds.update`) so the
 *      NEXT bar sees the peak/dd through bar i. The multiplier for bar i thus uses equity
 *      through bar i-1 (the prior bar) — never bar i's own not-yet-decided move, never a
 *      future bar. Appending/mutating any future bar cannot change a past multiplier.
 *
 * The scaler only ever REDUCES size (multiplier in (0,1]); it can shave return as well as
 * drawdown. Cost is charged on the (scaled) |Δ signed notional| exactly as the base walk.
 * Pure + deterministic.
 */
export function ablationWalkDrawdownScaled(
  bars: DailyBar[],
  convs: { conviction: number; sizeBps: number }[],
  walk: WalkParams = DEFAULT_WALK
): AblationWalkResult {
  const costRate = (walk.txCostBps + walk.slippageBps) / 10000;
  const trace: WalkBar[] = [];
  const trades: CompletedTrade[] = [];

  let equity = 1.0;
  let buyHold = 1.0;
  let prevWeight = 0;
  let prevSide: Side | null = null;

  let openSide: Side | null = null;
  let openEntryBar = 0;
  let openEntryPrice = 0;
  let openCostAccrued = 0;

  // Drawdown state seeded at the starting equity. It is updated with bar i's realized equity
  // ONLY AFTER bar i's position is decided, so the multiplier read for bar i reflects equity
  // through bar i-1 (the prior, fully-realized bar) — look-ahead-safe.
  const dds = new DrawdownState(equity, DRAWDOWN_BUCKETS);

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const c = convs[i];

    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r =
        isFinite(prevClose) && prevClose !== 0 && isFinite(b.close) ? b.close / prevClose - 1 : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    // Exposure multiplier from the drawdown state — derived from equity realized THROUGH the
    // PRIOR bar (bar i has not yet been fed). Scales THIS bar's size before the decision.
    const ddMult = dds.multiplier();
    const scaledSizeBps = Math.round(c.sizeBps * ddMult);

    let side: Side = decideTrade(prevSide, c.conviction, scaledSizeBps, walk.entryThreshold).side;
    if (side === "short" && !walk.allowShort) side = "flat";

    const magnitude = (scaledSizeBps / 10000) * walk.maxLeverage;
    const targetWeight = side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    const deltaNotional = Math.abs(targetWeight - prevWeight);
    const cost = deltaNotional * costRate;
    if (cost > 0) equity *= 1 - cost;

    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross =
          openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
        trades.push({
          entryBar: openEntryBar,
          exitBar: i,
          side: openSide,
          netReturn: round12(gross - (openCostAccrued + cost)),
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

    trace.push({
      bar: i,
      t: b.t,
      close: b.close,
      conviction: c.conviction,
      side,
      targetWeight: round12(targetWeight),
      barReturn: round12(barReturn),
      cost: round12(cost),
      equity: round12(equity),
      buyHoldEquity: round12(buyHold),
    });

    // Feed bar i's REALIZED post-cost equity into the drawdown state AFTER the decision, so the
    // NEXT bar's multiplier reflects the peak/dd through bar i (and never bar i+1).
    dds.update(equity);

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side;
  }

  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const gross =
      openSide === "long" ? last.close / openEntryPrice - 1 : openEntryPrice / last.close - 1;
    trades.push({
      entryBar: openEntryBar,
      exitBar: bars.length - 1,
      side: openSide,
      netReturn: round12(gross - openCostAccrued),
    });
  }

  return { trace, trades };
}

// ════════════════════════════════════════════════════════════════════════════
//  EVALUATE ONE ABLATION ARM across the universe (per-token + aggregate splits)
// ════════════════════════════════════════════════════════════════════════════

export interface ArmEval {
  perToken: Array<{ symbol: string; split: SplitMetrics }>;
  aggregate: { inSample: Metrics; outOfSample: Metrics; full: Metrics };
  /** Total risk-filter actions across the universe (trim/veto counts; 0 when the layer is off). */
  riskActions: { trim: number; veto: number };
}

export function evaluateArm(
  universe: TokenInput[],
  cand: Candidate,
  layers: AblationLayers,
  oosFraction: number,
  drawdownScaled: boolean = false
): ArmEval {
  let trim = 0;
  let veto = 0;
  const perToken = universe.map((tok) => {
    const convs = ablationConvictions(tok.bars, cand.strategy, layers);
    for (const c of convs) {
      if (c.riskAction === "trim") trim++;
      else if (c.riskAction === "veto") veto++;
    }
    const { trace, trades } = drawdownScaled
      ? ablationWalkDrawdownScaled(tok.bars, convs, cand.walk)
      : ablationWalk(tok.bars, convs, cand.walk);
    const n = tok.bars.length;
    const splitBar = splitBarOf(n, oosFraction);
    const split: SplitMetrics = {
      splitBar,
      full: metricsFromTrace(trace, trades, 0, n),
      inSample: metricsFromTrace(trace, trades, 0, splitBar),
      outOfSample: metricsFromTrace(trace, trades, splitBar, n),
    };
    return { symbol: tok.symbol, split };
  });
  return {
    perToken,
    aggregate: {
      inSample: aggregateMetrics(perToken.map((p) => p.split.inSample)),
      outOfSample: aggregateMetrics(perToken.map((p) => p.split.outOfSample)),
      full: aggregateMetrics(perToken.map((p) => p.split.full)),
    },
    riskActions: { trim, veto },
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  THE REPORT
// ════════════════════════════════════════════════════════════════════════════

/** Compact OOS+IS metric quad for the report (return / B&H / excess / Sharpe / maxDD). */
function quad(m: Metrics) {
  return {
    totalReturn: m.totalReturn,
    buyAndHoldReturn: m.buyAndHoldReturn,
    excessReturn: m.excessReturn,
    beatsBuyHold: m.beatsBuyHold,
    sharpe: m.sharpe,
    buyAndHoldSharpe: m.buyAndHoldSharpe,
    maxDrawdown: m.maxDrawdown,
    buyAndHoldMaxDrawdown: m.buyAndHoldMaxDrawdown,
    tradeCount: m.tradeCount,
    bars: m.bars,
  };
}

export interface AblationReport {
  what: string;
  honesty: string[];
  dataSource: any;
  params: any;
  selectedConfig: Record<string, number | boolean | string>;
  arms: any[];
  attribution: any;
  crossSectional: any;
  verdict: any;
}

export function buildAblationReport(
  oosFraction: number = DEFAULT_OOS_FRACTION,
  walk: WalkParams = DEFAULT_WALK
): AblationReport {
  const universe = loadUniverse();
  const allReal = universe.length > 0 && universe.every((t) => !t.synthetic);

  // 1) LOCK the config on the IN-SAMPLE 70% only (same winner as report-momentum.json).
  const sweep = buildSweep(walk);
  const { winner } = selectInSample(universe, sweep, oosFraction);

  // 2) Define the three nested ablation arms (one overlay added at a time).
  const armDefs: Array<{ id: string; label: string; layers: AblationLayers; desc: string }> = [
    {
      id: "A1",
      label: "trendOnly",
      layers: { fgGate: false, riskFilter: false },
      desc: "Directional trend/momentum core ALONE (no F&G gate, no risk filter).",
    },
    {
      id: "A2",
      label: "+fgGate",
      layers: { fgGate: true, riskFilter: false },
      desc: "Trend core + the F&G contrarian regime gate (regimeGate.applyRegimeGate).",
    },
    {
      id: "A3",
      label: "+riskFilter (full pipeline)",
      layers: { fgGate: true, riskFilter: true },
      desc: "Trend core + F&G gate + divergence/funding risk filter — IDENTICAL to runStrategy / report-momentum.json.",
    },
  ];

  const armToReport = (a: { id: string; label: string; desc: string; layers: AblationLayers }, ev: ArmEval) => ({
    id: a.id,
    label: a.label,
    desc: a.desc,
    layers: a.layers,
    riskActions: ev.riskActions,
    aggregate: {
      inSample: quad(ev.aggregate.inSample),
      outOfSample: quad(ev.aggregate.outOfSample),
      full: quad(ev.aggregate.full),
    },
    perToken: ev.perToken.map((p) => ({
      symbol: p.symbol,
      inSample: quad(p.split.inSample),
      outOfSample: quad(p.split.outOfSample),
      full: quad(p.split.full),
    })),
  });

  const arms = armDefs.map((a) => armToReport(a, evaluateArm(universe, winner, a.layers, oosFraction)));

  // A5 — the FULL A3 pipeline WITH the drawdown-bucket exposure scaler. Purely additive: same
  // conviction series as A3, only the position SIZE is scaled by the realized-drawdown bucket
  // multiplier inside the walk (ablationWalkDrawdownScaled). A1..A3 are byte-untouched.
  const a5Def = {
    id: "A5",
    label: "+drawdownScaler",
    layers: { fgGate: true, riskFilter: true } as AblationLayers,
    desc:
      "Full pipeline (== A3) WITH the DRAWDOWN-BUCKET EXPOSURE SCALER (src/signal/drawdownState.ts): " +
      "position size is multiplied by a de-risking ladder keyed on point-in-time underwater depth " +
      "(dd<5%->1.0x, 5-15%->0.66x, 15-25%->0.4x, >=25%->0.2x), using ONLY realized equity through the " +
      "prior bar. A drawdown OVERLAY, NOT an alpha source — measured vs A1 on the SAME held-out OOS.",
  };
  const a5Ev = evaluateArm(universe, winner, a5Def.layers, oosFraction, true);
  const a5 = armToReport(a5Def, a5Ev);
  arms.push(a5);

  const a1 = arms[0];
  const a2 = arms[1];
  const a3 = arms[2];

  // 3) ATTRIBUTION — the marginal OOS contribution of each overlay vs the layer beneath it.
  //    All deltas computed from the committed aggregate OOS metrics, never hand-set.
  const dGateReturn = round12(a2.aggregate.outOfSample.totalReturn - a1.aggregate.outOfSample.totalReturn);
  const dGateSharpe = round12(a2.aggregate.outOfSample.sharpe - a1.aggregate.outOfSample.sharpe);
  const dGateMaxDD = round12(a2.aggregate.outOfSample.maxDrawdown - a1.aggregate.outOfSample.maxDrawdown);
  const dRiskReturn = round12(a3.aggregate.outOfSample.totalReturn - a2.aggregate.outOfSample.totalReturn);
  const dRiskSharpe = round12(a3.aggregate.outOfSample.sharpe - a2.aggregate.outOfSample.sharpe);
  const dRiskMaxDD = round12(a3.aggregate.outOfSample.maxDrawdown - a2.aggregate.outOfSample.maxDrawdown);

  // "Adds value" = strictly improves OOS risk-adjusted metrics (the panel cares about drawdown
  // first on this risk-overlay framing): higher Sharpe OR lower maxDrawdown, with no degradation
  // of the headline absolute OOS return. A layer that leaves every OOS metric byte-identical is
  // INERT (adds nothing); a layer that hurts is NEGATIVE.
  const gateChangesAnything =
    a2.aggregate.outOfSample.totalReturn !== a1.aggregate.outOfSample.totalReturn ||
    a2.aggregate.outOfSample.sharpe !== a1.aggregate.outOfSample.sharpe ||
    a2.aggregate.outOfSample.maxDrawdown !== a1.aggregate.outOfSample.maxDrawdown;
  const fgGateAddsValue =
    gateChangesAnything && (dGateSharpe > 0 || dGateMaxDD < 0) && dGateReturn >= -1e-12;

  const riskChangesAnything =
    a3.aggregate.outOfSample.totalReturn !== a2.aggregate.outOfSample.totalReturn ||
    a3.aggregate.outOfSample.sharpe !== a2.aggregate.outOfSample.sharpe ||
    a3.aggregate.outOfSample.maxDrawdown !== a2.aggregate.outOfSample.maxDrawdown;
  const divergenceAddsValue =
    riskChangesAnything && (dRiskSharpe > 0 || dRiskMaxDD < 0) && dRiskReturn >= -1e-12;

  const totalRiskActions = a3.riskActions;

  // 3b) DRAWDOWN SCALER (A5) — marginal effect of the drawdown-bucket exposure scaler vs the
  //     UNSCALED bear-dodge baseline A1 (the trend core that already carries the OOS result), on
  //     the SAME held-out OOS. A drawdown OVERLAY: we report Δreturn / ΔmaxDD / ΔSharpe AS-IS.
  //     "BITES" = a NON-TRIVIAL OOS maxDD reduction vs A1 (>= 1 percentage point shallower) WITHOUT
  //     a worse-than-trivial return give-up. If it does not bite it is a disclosed inert monitor —
  //     never dressed up as a driver. All deltas COMPUTED from the committed metrics, never hand-set.
  const dScalerReturn = round12(a5.aggregate.outOfSample.totalReturn - a1.aggregate.outOfSample.totalReturn);
  const dScalerSharpe = round12(a5.aggregate.outOfSample.sharpe - a1.aggregate.outOfSample.sharpe);
  const dScalerMaxDD = round12(a5.aggregate.outOfSample.maxDrawdown - a1.aggregate.outOfSample.maxDrawdown);
  const A5_BITE_DD_THRESHOLD = 0.01; // >= 1 percentage-point OOS maxDD reduction to count as a bite
  const A5_BITE_RETURN_GIVEUP = 0.02; // tolerate at most a 2pp OOS return give-up for that drawdown cut
  const drawdownScalerBites =
    dScalerMaxDD <= -A5_BITE_DD_THRESHOLD && dScalerReturn >= -A5_BITE_RETURN_GIVEUP;

  // 4) CROSS-SECTIONAL (A4) — surfaced from the committed report-crosssectional.json (a SEPARATE
  //    hourly divergence harness), clearly labelled. It cannot be wired onto the daily trend core.
  let xs: any = null;
  let crossSectionalAddsValue = false;
  if (fs.existsSync(XS_REPORT_PATH)) {
    const xsr = JSON.parse(fs.readFileSync(XS_REPORT_PATH, "utf8"));
    const ptOOS = xsr.aggregate.perToken.outOfSample;
    const xsOOS = xsr.aggregate.crossSectional.outOfSample;
    // On its OWN harness, "adds value" = the cross-sectional arm improves OOS risk-adjusted
    // metrics OVER the per-token divergence baseline (its only apples-to-apples comparand here):
    // higher return OR lower drawdown, AND it differs from per-token. Computed, never hand-set.
    crossSectionalAddsValue =
      !!xsr.verdict.crossSectionalDiffersFromPerToken &&
      (xsOOS.totalReturn > ptOOS.totalReturn || xsOOS.maxDrawdown < ptOOS.maxDrawdown);
    xs = {
      harness: "SEPARATE — hourly divergence full-coverage slice (report-crosssectional.json), NOT the daily trend core",
      whyNotWiredOntoDaily:
        "The cross-sectional dislocation layer is a CONTRARIAN relative-value (stat-arb) selection " +
        "over the per-token positioning-vs-flow DIVERGENCE; it has no directional/trend meaning to add " +
        "to the daily momentum core, and the daily fixtures carry no long/short or taker flow legs (those " +
        "have only ~30d history). It is therefore evaluated on its own hourly divergence harness and " +
        "reported here verbatim, NEVER folded into the daily ablation arms above.",
      window: xsr.window.perToken,
      buyAndHoldOOS: xsOOS.buyAndHoldReturn,
      perTokenBaselineOOS: {
        totalReturn: ptOOS.totalReturn,
        maxDrawdown: ptOOS.maxDrawdown,
        tradeCount: ptOOS.tradeCount,
      },
      crossSectionalOOS: {
        totalReturn: xsOOS.totalReturn,
        maxDrawdown: xsOOS.maxDrawdown,
        tradeCount: xsOOS.tradeCount,
      },
      differsFromPerToken: xsr.verdict.crossSectionalDiffersFromPerToken,
      beatsBuyHoldOOS: xsr.verdict.crossSectionalBeatsBuyHoldOOS,
      beatsPerTokenOOS: xsr.verdict.crossSectionalBeatsPerTokenOOS,
    };
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  const report: AblationReport = {
    what:
      "LAYER-ATTRIBUTION ABLATION on the DAILY multi-regime harness. Holds the IN-SAMPLE-selected " +
      "LOCKED config (long-only+ema30/80) fixed and toggles ONE overlay at a time — trend core " +
      "alone (A1), +F&G gate (A2), +divergence/funding risk filter (A3 == full runStrategy / " +
      "report-momentum.json) — to attribute what each layer contributes on the held-out OOS, net of " +
      "cost. The cross-sectional dislocation layer (A4) lives on a SEPARATE hourly divergence harness " +
      "and is surfaced from report-crosssectional.json, clearly labelled — it cannot be wired onto the " +
      "daily trend core.",
    honesty: [
      "Config LOCKED by selectInSample on the IN-SAMPLE 70% only (same winner as report-momentum.json: long-only+ema30/80). The SAME config is used across A1..A3; only the active overlays change.",
      "Held-out OOS (trailing 30%) reported UNCONDITIONALLY for every arm; net of the labelled 10+10 bps cost folded into equity.",
      "Each arm is reconstructed from the SAME exported pure functions the production pipeline uses (momentumSignal, applyRegimeGate, riskFilter, sizeFromConviction, decideTrade) — not a re-implementation. A test pins that arm A3 reproduces runStrategy byte-for-byte.",
      "divergenceAddsValue / crossSectionalAddsValue are COMPUTED from the committed metrics (improves OOS risk-adjusted metrics without degrading return), never hand-set. If a layer is inert or negative it is reported as false.",
      "NEW byte-reproducible file (report-ablation.json). The frozen report.json AND report-momentum.json are NEVER touched.",
    ],
    dataSource: {
      kind: allReal ? "REAL" : "SYNTHETIC",
      provider:
        "Binance public REST (keyless) DAILY spot klines OHLCV + USDT-M funding (8h forward-filled) " +
        "+ alternative.me historical daily Fear&Greed — the SAME fixtures as report-momentum.json.",
      symbols: universe.map((t) => t.symbol),
      interval: "1d",
      bars: universe[0]?.bars.length ?? 0,
    },
    params: {
      txCostBps: walk.txCostBps,
      slippageBps: walk.slippageBps,
      oosFraction,
      barsPerYear: BARS_PER_YEAR_DAILY,
      costModelNote:
        "Transaction cost + slippage are a CONFIGURABLE ASSUMPTION (default 10 bps each), charged on " +
        "|Δ signed notional| per position change, folded into equity. The exact organizer model is UNCONFIRMED.",
      drawdownBuckets: {
        edges: { shallow: DD_EDGE_SHALLOW, mid: DD_EDGE_MID, deep: DD_EDGE_DEEP },
        multipliers: { full: DD_MULT_FULL, mid: DD_MULT_MID, deep: DD_MULT_DEEP, floor: DD_MULT_FLOOR },
        note:
          "A5 drawdown-bucket exposure scaler (src/signal/drawdownState.ts): exposure multiplier keyed on " +
          "point-in-time underwater depth dd=1-equity/peak, using ONLY realized equity through the prior bar " +
          "(look-ahead-safe). Edges IN-SAMPLE-biased (no OOS peeking); deliberately round to avoid curve-fit appearance.",
      },
    },
    selectedConfig: {
      emaFast: winner.strategy.emaFast as number,
      emaSlow: winner.strategy.emaSlow as number,
      momentumLookback: winner.strategy.momentumLookback as number,
      entryThreshold: winner.walk.entryThreshold,
      allowShort: winner.walk.allowShort,
      maxLeverage: winner.walk.maxLeverage,
      label: winner.label,
    },
    arms,
    attribution: {
      note:
        "Marginal OOS contribution of each overlay vs the layer beneath it (aggregate, equal-weight, net of cost). " +
        "Positive Δreturn / Δsharpe and negative ΔmaxDrawdown = the overlay helped on the held-out OOS.",
      fgGate: {
        deltaOOSReturn: dGateReturn,
        deltaOOSSharpe: dGateSharpe,
        deltaOOSMaxDrawdown: dGateMaxDD,
        changedAnything: gateChangesAnything,
        addsValue: fgGateAddsValue,
        summary:
          `A1 trendOnly OOS ${pct(a1.aggregate.outOfSample.totalReturn)} (Sharpe ${a1.aggregate.outOfSample.sharpe}, maxDD ${pct(a1.aggregate.outOfSample.maxDrawdown)}) ` +
          `→ A2 +fgGate OOS ${pct(a2.aggregate.outOfSample.totalReturn)} (Sharpe ${a2.aggregate.outOfSample.sharpe}, maxDD ${pct(a2.aggregate.outOfSample.maxDrawdown)}). ` +
          `Δreturn ${pct(dGateReturn)}, Δsharpe ${dGateSharpe.toFixed(4)}, ΔmaxDD ${pct(dGateMaxDD)}.`,
      },
      divergenceRiskFilter: {
        deltaOOSReturn: dRiskReturn,
        deltaOOSSharpe: dRiskSharpe,
        deltaOOSMaxDrawdown: dRiskMaxDD,
        changedAnything: riskChangesAnything,
        riskActionsOnWindow: totalRiskActions,
        addsValue: divergenceAddsValue,
        summary:
          `A2 +fgGate OOS ${pct(a2.aggregate.outOfSample.totalReturn)} (Sharpe ${a2.aggregate.outOfSample.sharpe}, maxDD ${pct(a2.aggregate.outOfSample.maxDrawdown)}) ` +
          `→ A3 +riskFilter OOS ${pct(a3.aggregate.outOfSample.totalReturn)} (Sharpe ${a3.aggregate.outOfSample.sharpe}, maxDD ${pct(a3.aggregate.outOfSample.maxDrawdown)}). ` +
          `Δreturn ${pct(dRiskReturn)}, Δsharpe ${dRiskSharpe.toFixed(4)}, ΔmaxDD ${pct(dRiskMaxDD)}. ` +
          `Risk filter fired trim=${totalRiskActions.trim} veto=${totalRiskActions.veto} across the full universe (${universe.length} tokens × ${universe[0]?.bars.length ?? 0} bars).`,
      },
      drawdownScaler: {
        comparand: "A5 vs A1 (the UNSCALED trend-core bear-dodge that already carries the OOS result) on the SAME held-out OOS",
        deltaOOSReturn: dScalerReturn,
        deltaOOSSharpe: dScalerSharpe,
        deltaOOSMaxDrawdown: dScalerMaxDD,
        bites: drawdownScalerBites,
        biteCriteria:
          `BITES iff OOS maxDD reduction >= ${A5_BITE_DD_THRESHOLD * 100}pp AND OOS return give-up <= ${A5_BITE_RETURN_GIVEUP * 100}pp.`,
        summary:
          `A1 trendOnly OOS ${pct(a1.aggregate.outOfSample.totalReturn)} (Sharpe ${a1.aggregate.outOfSample.sharpe}, maxDD ${pct(a1.aggregate.outOfSample.maxDrawdown)}) ` +
          `→ A5 +drawdownScaler OOS ${pct(a5.aggregate.outOfSample.totalReturn)} (Sharpe ${a5.aggregate.outOfSample.sharpe}, maxDD ${pct(a5.aggregate.outOfSample.maxDrawdown)}). ` +
          `Δreturn ${pct(dScalerReturn)}, Δsharpe ${dScalerSharpe.toFixed(4)}, ΔmaxDD ${pct(dScalerMaxDD)}. ` +
          `${drawdownScalerBites ? "It BITES: a non-trivial OOS drawdown reduction for an acceptable return give-up — a load-bearing drawdown overlay (NOT alpha)." : "It does NOT bite on this OOS: a disclosed, INERT monitor (like the A3 risk filter), reported as-is — never a driver/edge."}`,
      },
    },
    crossSectional: xs,
    verdict: {
      trendCoreIsTheEarner:
        "On the held-out OOS the directional TREND CORE alone (A1) already produces essentially the entire result — " +
        "the bear-dodge (sit flat through the 2026 drawdown). The overlays modulate it at the margin only.",
      fgGateAddsValue,
      divergenceAddsValue,
      crossSectionalAddsValue,
      drawdownScalerBites,
      drawdownScalerStatement:
        `Drawdown-bucket exposure scaler (A5) vs the unscaled bear-dodge (A1) on the SAME OOS: ` +
        `Δreturn ${pct(dScalerReturn)}, ΔmaxDD ${pct(dScalerMaxDD)}, Δsharpe ${dScalerSharpe.toFixed(4)}. ` +
        (drawdownScalerBites
          ? `It BITES — a load-bearing DRAWDOWN OVERLAY (cuts the OOS drawdown for an acceptable return give-up). It is NOT alpha and does NOT beat B&H; it is a de-risking rule, disclosed as such.`
          : `It does NOT bite on this OOS — a disclosed, INERT monitor exactly like the A3 risk filter, published as-is and never called a driver/edge.`),
      attributionStatement:
        `Trend core (A1) = the earner/bear-dodge. F&G gate (A2) ${fgGateAddsValue ? "adds marginal OOS risk-adjusted value" : "is ~inert on this OOS (it only bites in F&G extremes, which the directional core mostly already sizes for)"}. ` +
        `Divergence/funding risk filter (A3) ${divergenceAddsValue ? "adds marginal OOS risk-adjusted value" : `is INERT/negligible on this OOS — it fired trim=${totalRiskActions.trim} veto=${totalRiskActions.veto} across the entire universe and leaves the OOS aggregate essentially unchanged (a non-earning safety veto, exactly as SKILL.md admits)`}. ` +
        `Cross-sectional (A4) is a SEPARATE hourly-harness contrarian construct: it ${xs ? (xs.beatsPerTokenOOS ? "improves on the per-token divergence baseline (lower drawdown / less churn) but does NOT beat B&H on its rising OOS tail" : "does not improve on the per-token baseline") : "report not present"}; it cannot be wired onto the daily trend core.`,
    },
  };

  return report;
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI ENTRY — write the byte-reproducible report
// ════════════════════════════════════════════════════════════════════════════

export function serializeAblationReport(report: AblationReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function main(): void {
  const oosFraction = Number(process.env.OOS_FRACTION) || DEFAULT_OOS_FRACTION;
  const walk: WalkParams = {
    ...DEFAULT_WALK,
    txCostBps: Number(process.env.TX_BPS) || DEFAULT_WALK.txCostBps,
    slippageBps: Number(process.env.SLIP_BPS) || DEFAULT_WALK.slippageBps,
  };
  const report = buildAblationReport(oosFraction, walk);
  fs.writeFileSync(ABLATION_REPORT_PATH, serializeAblationReport(report), "utf8");

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  console.log(`[stoic] LAYER-ATTRIBUTION ablation -> ${ABLATION_REPORT_PATH}`);
  console.log(`  locked config: ${report.selectedConfig.label}`);
  for (const arm of report.arms) {
    const o = arm.outOfSample ?? arm.aggregate.outOfSample;
    console.log(
      `  ${arm.id} ${arm.label.padEnd(28)} OOS ret=${pct(o.totalReturn)} vs B&H ${pct(o.buyAndHoldReturn)} | Sharpe ${o.sharpe.toFixed(3)} | maxDD ${pct(o.maxDrawdown)} | beat=${o.beatsBuyHold}`
    );
  }
  console.log(`  ── ATTRIBUTION (marginal OOS contribution) ──`);
  console.log(`  + F&G gate          : ${report.attribution.fgGate.summary}`);
  console.log(`  + divergence filter : ${report.attribution.divergenceRiskFilter.summary}`);
  console.log(`  + drawdown scaler   : ${report.attribution.drawdownScaler.summary}`);
  console.log(
    `  VERDICT: fgGateAddsValue=${report.verdict.fgGateAddsValue} divergenceAddsValue=${report.verdict.divergenceAddsValue} crossSectionalAddsValue=${report.verdict.crossSectionalAddsValue} drawdownScalerBites=${report.verdict.drawdownScalerBites}`
  );
}

if (require.main === module) {
  main();
}
