/**
 * Stoic — NET-NEW divergence core (the ORIGINALITY engine).  [M2 / M2z]
 *
 * THIS is the differentiator the BNB-Hack Track-2 submission turns on. The bare
 * "sentiment divergence" idea is the canned Track-2 example and scores ZERO on
 * Originality; the net-new extension here is:
 *
 *   a REGIME-GATED, ROLLING-WINDOW Z-SCORED positioning/attention-vs-flow DIVERGENCE
 *
 * computed strictly look-ahead-safe (the z-score at bar t uses ONLY bars < t):
 *
 *   crowdLeg(t)  = positioning / attention  (funding rate + long/short ACCOUNT ratio
 *                  [+ optional CMC social/narrative momentum when keyed])
 *   flowLeg(t)   = realised order flow       (taker buy/sell ratio + price momentum)
 *
 *   divergence(t) = zscore(crowdLeg, W)[t] - zscore(flowLeg, W)[t]
 *
 *   POSITIVE divergence  = crowd is positioned MORE bullish than flow confirms
 *                          -> crowded longs unsupported by buying -> CONTRARIAN SHORT bias.
 *   NEGATIVE divergence  = crowd is positioned MORE bearish than flow confirms
 *                          -> crowded shorts into real buying     -> CONTRARIAN LONG bias.
 *
 * The signed divergence is then mapped onto core.ts's 0..1000 BULLISH `divergenceBias`
 * scale (500 = no divergence) and gated by a REGIME read (Fear&Greed extreme + funding
 * regime) before it is folded through the deterministic conviction core.
 *
 * PROVENANCE / HONESTY (see D:\BNB\BNB_BUILD_PLAN.md sections 2, 4):
 *   - NET-NEW: Stoic's `scoreIssuer` is stateless / per-row with NO rolling window.
 *     The rolling-window z-score + the two-series divergence + the regime gate are
 *     all new code; they are NOT a reuse of the cap-not-floor sentiment override.
 *   - LOOK-AHEAD SAFE (the property the dedicated M2z test pins): `rollingZScore`
 *     consumes the window ending at index t-1 (bars strictly BEFORE t). Appending or
 *     truncating FUTURE bars cannot change any past z-score or conviction.
 *   - The crowd leg's optional CMC social/narrative term folds through `blendScore`
 *     and degrades to a strict {0,0} no-op offline — keeping the backtest reproducible.
 *   - ALL thresholds are exported constants (single-sourced for the SKILL.md + backtester).
 */

import { Bar } from "../data/binance";
import {
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  blendScore,
} from "./core";
import { Advisory, NO_ADVICE } from "../data/cmc";

// ── numeric helpers (pure) ──────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED THRESHOLD CONSTANTS  (single source of truth — the SKILL.md and the
//  backtester MUST cite THESE; do not hard-code copies anywhere downstream).
// ════════════════════════════════════════════════════════════════════════════

/** Rolling z-score lookback window (bars). Default for hourly bars. */
export const ZSCORE_WINDOW = 48;
/**
 * Minimum number of PAST observations required before a z-score is defined. Below
 * this the leg is "warming up" and the z-score is reported as 0 (no edge) — never
 * NaN, never a partial-window guess. Keeps early bars honest and deterministic.
 */
export const ZSCORE_MIN_OBS = 12;
/**
 * Divergence (in z-units, crowd-z minus flow-z) magnitude that maps to a FULL-weight
 * contrarian conviction. |divergence| >= this saturates the divergenceBias scale.
 */
export const DIVERGENCE_FULL_Z = 2.5;
/**
 * Divergence dead-band (z-units). |divergence| < this is treated as NO actionable
 * divergence -> divergenceBias pinned to neutral (500). Folds into core's dead-band.
 */
export const DIVERGENCE_DEADBAND_Z = 0.5;

// ── regime-gate thresholds ──────────────────────────────────────────────────
/** Fear&Greed <= this = EXTREME FEAR regime (contrarian-long environment). 0..100. */
export const FEAR_EXTREME = 25;
/** Fear&Greed >= this = EXTREME GREED regime (contrarian-short environment). 0..100. */
export const GREED_EXTREME = 75;
/**
 * |funding rate| (fraction per interval) above which the derivatives market is in a
 * STRETCHED funding regime — crowded one way — which AMPLIFIES a contrarian divergence
 * read. e.g. 0.0005 = 5bp/interval. Below this funding is "normal" and the gate is neutral.
 */
export const FUNDING_STRETCHED = 0.0005;
/**
 * Regime gain applied to the divergence edge. When the regime CONFIRMS the contrarian
 * read (e.g. extreme greed + positive divergence), the edge is scaled up to this; when
 * the regime CONTRADICTS it, down toward REGIME_GATE_MIN. 1.0 = regime-neutral.
 */
export const REGIME_GATE_MAX = 1.35;
export const REGIME_GATE_MIN = 0.5;

/** Price-momentum lookback (bars) for the flow leg's momentum component. */
export const MOMENTUM_LOOKBACK = 12;

// ════════════════════════════════════════════════════════════════════════════
//  ROLLING Z-SCORE — look-ahead-safe (the core M2z property)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Rolling z-score of `series`, computed STRICTLY from bars BEFORE each index.
 *
 *   z[t] = (series[t] - mean(series[t-W .. t-1])) / std(series[t-W .. t-1])
 *
 * i.e. the window that NORMALISES bar t ENDS at t-1 — bar t itself and every FUTURE
 * bar are excluded. This is the no-look-ahead invariant the backtest depends on:
 * appending or truncating bars at index >= t cannot change z[t]. Properties:
 *   - fewer than ZSCORE_MIN_OBS past observations -> z = 0 (warming up; never NaN).
 *   - zero-variance window (all past values equal) -> z = 0 (no dispersion -> no signal).
 *   - a non-finite series value -> that bar's z is 0 and the value is skipped from
 *     future windows (defensive; mirrors the data adapters' "absent means absent").
 *
 * Pure: no Date / no random / no IO. O(n·W); fine for backtest bar counts.
 *
 * @param series per-bar leg values (may contain non-finite entries; handled defensively)
 * @param window lookback length W (defaults to ZSCORE_WINDOW)
 * @param minObs minimum past observations before a z is defined (defaults to ZSCORE_MIN_OBS)
 */
export function rollingZScore(
  series: number[],
  window: number = ZSCORE_WINDOW,
  minObs: number = ZSCORE_MIN_OBS
): number[] {
  const n = series.length;
  const out = new Array<number>(n).fill(0);
  const W = Math.max(1, Math.floor(window));
  const need = Math.max(1, Math.floor(minObs));

  for (let t = 0; t < n; t++) {
    const x = series[t];
    if (!isFinite(x)) {
      out[t] = 0;
      continue;
    }
    // Window of PAST values only: indices [t-W, t-1], skipping non-finite entries.
    const lo = Math.max(0, t - W);
    let sum = 0;
    let count = 0;
    for (let j = lo; j < t; j++) {
      const v = series[j];
      if (isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count < need) {
      out[t] = 0; // warming up — not enough history to normalise honestly
      continue;
    }
    const mean = sum / count;
    let sse = 0;
    for (let j = lo; j < t; j++) {
      const v = series[j];
      if (isFinite(v)) {
        const d = v - mean;
        sse += d * d;
      }
    }
    // Population std over the past window. Zero variance -> no dispersion -> z = 0.
    const std = Math.sqrt(sse / count);
    out[t] = std > 1e-12 ? (x - mean) / std : 0;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  LEG CONSTRUCTION — crowd (positioning/attention) vs flow (realised order flow)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the CROWD-leg raw series from the bars: derivatives POSITIONING.
 *
 *   crowd = (funding rate, scaled to comparable units) + (long/short ACCOUNT ratio lean)
 *
 * Both are LEVELS of how bullish the crowd is POSITIONED:
 *   - funding > 0  -> longs pay shorts -> crowd leaning long.
 *   - longShortRatio > 1 -> more long accounts than short -> crowd leaning long.
 * A bar missing both legs contributes a non-finite entry (NaN), so rollingZScore
 * skips it from windows rather than fabricating a value. Pure; reads bars[i] only.
 *
 * Note (optional CMC social/narrative term): the live CMC social/attention momentum is
 * NOT a per-bar historical series on the free Binance backtest data, so it is folded in
 * as a bounded ADVISORY at score time (see divergenceSignal's `crowdAdvisory`), not baked
 * into this historical leg — keeping the backtest reproducible and honestly labelled.
 */
export function buildCrowdLeg(bars: Bar[]): number[] {
  return bars.map((b) => {
    const parts: number[] = [];
    // Funding is a small fraction; ×10000 puts it on a ~basis-point scale comparable
    // to the L/S lean term after z-scoring (z-scoring removes the absolute scale anyway,
    // but keeping them comparable avoids one term dominating the pre-z sum).
    if (b.funding !== undefined && isFinite(b.funding)) parts.push(b.funding * 10000);
    // longShortRatio centred at 1.0 (parity); scaled ×100 for the same comparability reason.
    if (b.longShortRatio !== undefined && isFinite(b.longShortRatio)) {
      parts.push((b.longShortRatio - 1) * 100);
    }
    if (parts.length === 0) return NaN; // no positioning data this bar -> absent
    // Average the available positioning components (so a bar with one leg isn't penalised).
    return parts.reduce((a, c) => a + c, 0) / parts.length;
  });
}

/**
 * Build the FLOW-leg raw series from the bars: REALISED order flow.
 *
 *   flow = (taker buy/sell ratio lean) + (price momentum over MOMENTUM_LOOKBACK)
 *
 * Both measure what BUYERS ACTUALLY DID, not how the crowd is positioned:
 *   - takerBuySellRatio > 1 -> aggressive market buying dominates.
 *   - price momentum > 0    -> price actually rose (flow confirmed by tape).
 * Momentum at bar i uses close[i] vs close[i-LOOKBACK] — both are <= i, so this is
 * itself look-ahead-safe (no future close is read). A bar with neither component
 * contributes NaN (skipped from windows). Pure.
 */
export function buildFlowLeg(
  bars: Bar[],
  momentumLookback: number = MOMENTUM_LOOKBACK
): number[] {
  const L = Math.max(1, Math.floor(momentumLookback));
  return bars.map((b, i) => {
    const parts: number[] = [];
    // Taker buy/sell ratio centred at 1.0 (balanced); ×100 for comparability.
    if (b.takerBuySellRatio !== undefined && isFinite(b.takerBuySellRatio)) {
      parts.push((b.takerBuySellRatio - 1) * 100);
    }
    // Price momentum: pct change vs L bars ago (only PAST closes; look-ahead-safe).
    if (i >= L) {
      const past = bars[i - L]?.close;
      if (past !== undefined && isFinite(past) && past !== 0 && isFinite(b.close)) {
        parts.push(((b.close - past) / past) * 100); // pct change
      }
    }
    if (parts.length === 0) return NaN; // no flow data this bar -> absent
    return parts.reduce((a, c) => a + c, 0) / parts.length;
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  REGIME GATE — Fear&Greed + funding regime
// ════════════════════════════════════════════════════════════════════════════

/** Snapshot of the macro/derivatives regime at (or as-of) a bar. */
export interface RegimeContext {
  /** Fear & Greed index 0..100 (from CMC get_global_metrics_latest). Undefined = unknown. */
  fearGreed?: number;
  /** Funding rate (fraction per interval) for the bar's symbol. Undefined = unknown. */
  funding?: number;
}

export type RegimeLabel =
  | "extreme-fear"
  | "extreme-greed"
  | "stretched-funding"
  | "neutral"
  | "unknown";

export interface RegimeRead {
  label: RegimeLabel;
  /**
   * Directional bias the regime FAVOURS for a contrarian signal, as a sign:
   *   +1 = regime favours LONG bias (extreme fear / crowded shorts)
   *   -1 = regime favours SHORT bias (extreme greed / crowded longs)
   *    0 = neutral / unknown regime
   */
  favored: -1 | 0 | 1;
  /** Whether funding is in the STRETCHED regime (amplifies the contrarian read). */
  stretched: boolean;
}

/**
 * Read the regime from Fear&Greed + funding. Deterministic, pure.
 *   - F&G <= FEAR_EXTREME      -> extreme-fear, favours LONG (+1).
 *   - F&G >= GREED_EXTREME     -> extreme-greed, favours SHORT (-1).
 *   - else, |funding| stretched -> "stretched-funding", favours the side OPPOSITE the
 *     crowd's funding lean (positive funding = crowded long -> favours SHORT).
 *   - else neutral (favored 0). Missing both inputs -> "unknown".
 */
export function readRegime(ctx: RegimeContext): RegimeRead {
  const fgKnown = ctx.fearGreed !== undefined && isFinite(ctx.fearGreed);
  const fundKnown = ctx.funding !== undefined && isFinite(ctx.funding);
  const stretched = fundKnown && Math.abs(ctx.funding as number) >= FUNDING_STRETCHED;

  if (fgKnown) {
    const fg = clamp(ctx.fearGreed as number, 0, 100);
    if (fg <= FEAR_EXTREME) return { label: "extreme-fear", favored: 1, stretched };
    if (fg >= GREED_EXTREME) return { label: "extreme-greed", favored: -1, stretched };
  }
  if (stretched) {
    const f = ctx.funding as number;
    // crowded longs (funding>0) -> favour SHORT; crowded shorts (funding<0) -> favour LONG.
    return { label: "stretched-funding", favored: f > 0 ? -1 : 1, stretched: true };
  }
  if (!fgKnown && !fundKnown) return { label: "unknown", favored: 0, stretched: false };
  return { label: "neutral", favored: 0, stretched };
}

/**
 * Regime GAIN applied to the divergence edge. When the regime's favoured direction
 * AGREES with the contrarian signal direction, amplify (up to REGIME_GATE_MAX); when it
 * DISAGREES, dampen (down toward REGIME_GATE_MIN); neutral/unknown regime -> 1.0.
 * Stretched funding nudges the amplification further. Pure; bounded to [MIN, MAX].
 *
 * @param signalSign sign of the divergence-implied bias: +1 long, -1 short, 0 flat.
 */
export function regimeGain(regime: RegimeRead, signalSign: -1 | 0 | 1): number {
  if (signalSign === 0 || regime.favored === 0) {
    return regime.stretched ? clamp(1.0 + 0.1, REGIME_GATE_MIN, REGIME_GATE_MAX) : 1.0;
  }
  const agree = regime.favored === signalSign;
  let g = agree ? REGIME_GATE_MAX : REGIME_GATE_MIN;
  // Stretched funding makes a contrarian read more reliable. When the regime AGREES,
  // gain is already at REGIME_GATE_MAX (clamped); when it DISAGREES, dampen a touch more.
  if (regime.stretched && !agree) g *= 0.9;
  return clamp(g, REGIME_GATE_MIN, REGIME_GATE_MAX);
}

// ════════════════════════════════════════════════════════════════════════════
//  DIVERGENCE -> divergenceBias  (signed z-divergence onto core's 0..1000 scale)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map a signed divergence (crowd-z minus flow-z, in z-units) + a regime gain onto the
 * 0..1000 BULLISH `divergenceBias` scale core.ts consumes (500 = no divergence).
 *
 * CONTRARIAN sign convention: POSITIVE divergence (crowd more bullish than flow) is a
 * BEARISH (short) signal -> divergenceBias BELOW 500. Negative divergence -> ABOVE 500.
 * Inside the dead-band -> exactly 500 (no edge). |divergence| at DIVERGENCE_FULL_Z (after
 * the regime gain) saturates to 0 / 1000. Deterministic, pure, integer-clamped.
 */
export function divergenceToBias(divergence: number, gain: number = 1): number {
  if (!isFinite(divergence)) return CONVICTION_FLAT;
  const sign = divergence > 0 ? 1 : divergence < 0 ? -1 : 0;
  const mag = Math.abs(divergence);
  if (mag < DIVERGENCE_DEADBAND_Z) return CONVICTION_FLAT; // no actionable divergence

  // Effective magnitude after the dead-band, scaled by the regime gain, normalised to
  // the saturating span [DEADBAND, FULL]. 0 at the dead-band edge, 1 at FULL_Z.
  const span = Math.max(1e-9, DIVERGENCE_FULL_Z - DIVERGENCE_DEADBAND_Z);
  const norm = clamp(((mag - DIVERGENCE_DEADBAND_Z) * gain) / span, 0, 1);

  // CONTRARIAN: positive divergence -> bearish (below 500). 500 distance is the half-span.
  const bias = CONVICTION_FLAT - sign * norm * CONVICTION_FLAT;
  return Math.round(clamp(bias, CONVICTION_MIN, CONVICTION_MAX));
}

// ── per-bar divergence record (what the engine + backtester consume) ──────────
export interface DivergenceBar {
  bar: number;            // bar index (provenance)
  t: number;              // bar open time (ms)
  crowdZ: number;         // z-score of the crowd leg (look-ahead-safe)
  flowZ: number;          // z-score of the flow leg (look-ahead-safe)
  divergence: number;     // crowdZ - flowZ (signed, z-units)
  regime: RegimeLabel;    // regime label at this bar
  gain: number;           // regime gain applied
  divergenceBias: number; // 0..1000 bias fed into the conviction core (500 = no edge)
  warming: boolean;       // true while either leg has insufficient history
}

export interface DivergenceOpts {
  window?: number;          // z-score window (defaults ZSCORE_WINDOW)
  minObs?: number;          // min past obs (defaults ZSCORE_MIN_OBS)
  momentumLookback?: number; // flow-momentum lookback (defaults MOMENTUM_LOOKBACK)
  /**
   * Optional per-bar regime context. If a single RegimeContext is given it is applied to
   * every bar (e.g. a latest F&G snapshot for a live read). If an array is given it is
   * indexed per bar. If omitted, regime is read per-bar from the bar's own funding only.
   */
  regime?: RegimeContext | RegimeContext[];
}

/**
 * Compute the full per-bar divergence series from bars (LOOK-AHEAD SAFE end to end).
 *
 * Steps (all using only information at-or-before each bar):
 *   1. build crowd + flow legs from the bars,
 *   2. rolling z-score each leg (window ends at t-1 — strictly past),
 *   3. divergence(t) = crowdZ(t) - flowZ(t),
 *   4. read the regime (per-bar funding, plus any supplied F&G context),
 *   5. apply the regime gain and map to divergenceBias (contrarian).
 *
 * The returned array is the SAME length as `bars`, index-aligned. Pure.
 */
export function divergenceSignal(bars: Bar[], opts: DivergenceOpts = {}): DivergenceBar[] {
  const window = opts.window ?? ZSCORE_WINDOW;
  const minObs = opts.minObs ?? ZSCORE_MIN_OBS;
  const momentumLookback = opts.momentumLookback ?? MOMENTUM_LOOKBACK;

  const crowd = buildCrowdLeg(bars);
  const flow = buildFlowLeg(bars, momentumLookback);
  const crowdZ = rollingZScore(crowd, window, minObs);
  const flowZ = rollingZScore(flow, window, minObs);

  return bars.map((b, i) => {
    // Per-bar regime context: array (indexed), single (broadcast), or bar-derived funding.
    let ctx: RegimeContext;
    if (Array.isArray(opts.regime)) {
      ctx = opts.regime[i] ?? { funding: b.funding };
    } else if (opts.regime) {
      ctx = { fearGreed: opts.regime.fearGreed, funding: opts.regime.funding ?? b.funding };
    } else {
      ctx = { funding: b.funding };
    }

    const divergence = crowdZ[i] - flowZ[i];
    const sign: -1 | 0 | 1 =
      divergence > 0 ? -1 : divergence < 0 ? 1 : 0; // CONTRARIAN: +div -> short(-1)
    const regime = readRegime(ctx);
    const gain = regimeGain(regime, sign);
    const divergenceBias = divergenceToBias(divergence, gain);

    // "warming" iff either leg hadn't enough history to define a z at this bar. We detect
    // this honestly by recomputing the available past-observation count for bar i.
    const warming = pastObsCount(crowd, i, window) < minObs || pastObsCount(flow, i, window) < minObs;

    return {
      bar: i,
      t: b.t,
      crowdZ: crowdZ[i],
      flowZ: flowZ[i],
      divergence,
      regime: regime.label,
      gain,
      divergenceBias,
      warming,
    };
  });
}

/** Count finite past observations in [i-W, i-1] (mirrors rollingZScore's window). Pure. */
function pastObsCount(series: number[], i: number, window: number): number {
  const W = Math.max(1, Math.floor(window));
  const lo = Math.max(0, i - W);
  let c = 0;
  for (let j = lo; j < i; j++) if (isFinite(series[j])) c++;
  return c;
}

/**
 * Optional bounded CROWD advisory from live CMC social/narrative MOMENTUM. This is the
 * place the (key-gated) CMC attention leg enters the crowd side WITHOUT contaminating the
 * reproducible historical backtest: it returns a bounded {adjustment,confidence} that the
 * engine folds through blendScore, and degrades to the strict {0,0} no-op when absent.
 *
 * HONEST LABEL: this is attention/narrative MOMENTUM (mention/narrative velocity), not
 * sentiment polarity — same caveat as Stoic's elfa.ts. A rising-attention crowd that the
 * flow does not confirm STRENGTHENS the contrarian read, so positive attention momentum
 * nudges the conviction toward the contrarian (here: modestly bearish) side, bounded small.
 */
export function crowdAttentionAdvisory(narrativeMomentum?: number): Advisory {
  if (narrativeMomentum === undefined || !isFinite(narrativeMomentum)) return { ...NO_ADVICE };
  // Contrarian: surging crowd attention unconfirmed by flow -> mild bearish nudge.
  return {
    adjustment: clamp(Math.round(-narrativeMomentum * 0.3), -20, 20),
    confidence: 0.25,
  };
}

/** Re-export blendScore through this module so callers have one import surface. */
export { blendScore };
