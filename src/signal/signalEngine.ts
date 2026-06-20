/**
 * Stoic — public signal engine.  [M2]
 *
 * This is the SINGLE entry the CMC Skill (SKILL.md) and the backtester call. It ties
 * together:
 *   - the NET-NEW regime-gated rolling-window z-scored divergence core (divergence.ts),
 *   - the deterministic conviction blend + size map + entry calibrator (core.ts, ported
 *     STRUCTURE from Stoic's pdModel), and
 *   - the OPTIONAL, no-op-safe CMC / LLM bounded advisories folded through blendScore.
 *
 * Two layers, by design:
 *   1. `runDivergence(bars, opts)` — the look-ahead-safe BATCH pass over a bar series.
 *      It computes the per-bar divergenceBias (divergence.ts) then folds it through the
 *      conviction core to produce, for every bar, a conviction (0..1000, 500=flat) + size.
 *      This is what the backtester walks. LOOK-AHEAD SAFE: bar t depends only on bars < t.
 *   2. `scoreConviction(signalsAtBar)` — the per-bar PUBLIC entry. Given the already-
 *      computed signals AT one bar (the divergence bias + the per-bar feature reads + any
 *      optional advisories), it returns the conviction call for THAT bar. The SKILL emits
 *      one of these per replayed bar; the backtester calls it inside its walk.
 *
 * PROVENANCE / HONESTY (see D:\BNB\BNB_BUILD_PLAN.md sections 2, 4):
 *   - The divergence + regime gate are NET-NEW (divergence.ts). The weighted blend / size
 *     map / calibrator STRUCTURE is ported from Stoic's pdModel via core.ts.
 *   - Every CMC/LLM advisory folds through blendScore and is a strict {0,0} no-op offline,
 *     so the deterministic engine is the product and the backtest stays byte-reproducible.
 *   - ALL thresholds are exported constants in core.ts / divergence.ts; nothing is
 *     hard-coded here. The SKILL.md and backtester cite those constants.
 */

import { Bar } from "../data/binance";
import {
  SignalFeatures,
  ConvictionResult,
  scoreConvictionBase,
  sizeFromConviction,
  blendScore,
  calibrateEntryThreshold,
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  ENTRY_THRESHOLD,
} from "./core";
import {
  divergenceSignal,
  DivergenceBar,
  DivergenceOpts,
  crowdAttentionAdvisory,
  ZSCORE_WINDOW,
  ZSCORE_MIN_OBS,
} from "./divergence";
import { Advisory, NO_ADVICE } from "../data/cmc";

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Re-export the load-bearing constants so the SKILL/backtester have ONE import surface
// and can never drift from the engine's own thresholds.
export {
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  ENTRY_THRESHOLD,
  ENTRY_MIN,
  ENTRY_MAX,
  CALIBRATION_STEP,
  REGIME_FLATTEN_BAND,
  STRONG_DIVERGENCE,
  calibrateEntryThreshold,
  sizeFromConviction,
  blendScore,
} from "./core";
export {
  ZSCORE_WINDOW,
  ZSCORE_MIN_OBS,
  DIVERGENCE_FULL_Z,
  DIVERGENCE_DEADBAND_Z,
  FEAR_EXTREME,
  GREED_EXTREME,
  FUNDING_STRETCHED,
  REGIME_GATE_MAX,
  REGIME_GATE_MIN,
  MOMENTUM_LOOKBACK,
} from "./divergence";

// ════════════════════════════════════════════════════════════════════════════
//  scoreConviction — the PUBLIC per-bar entry (SKILL.md + backtester call this)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Everything the engine needs to score ONE bar's conviction. Field semantics match
 * core.SignalFeatures' 0..1000 BULLISH convention; the divergenceBias is produced by the
 * look-ahead-safe divergence core (divergence.ts) for this bar. Optional advisories are
 * bounded {adjustment,confidence} that fold through blendScore — each a strict {0,0}
 * no-op when its source is absent (offline / no key).
 */
export interface SignalsAtBar {
  bar: number;            // bar index (provenance only)
  trend: number;          // 0..1000  price-trend / EMA-stack alignment (bullish)
  momentum: number;       // 0..1000  RSI/MACD momentum (bullish)
  fundingBias: number;    // 0..1000  derivatives funding read (500 = neutral)
  flowBias: number;       // 0..1000  taker buy/sell + volume flow (bullish)
  divergenceBias: number; // 0..1000  NET-NEW regime-gated divergence term (500 = no edge)
  /** Optional bounded advisories (CMC technicals/regime/attention, LLM rationale). */
  advisories?: Advisory[];
}

/**
 * Score the conviction for ONE bar. This is the public surface the Skill emits per bar
 * and the backtester invokes inside its walk.
 *
 *   1. blend the per-bar features into a base conviction via core.scoreConvictionBase
 *      (the ported weighted-blend + dead-band/strong-divergence branch + integer clamp),
 *   2. fold each optional advisory through blendScore (each {0,0} = strict no-op),
 *   3. recompute the size from the final conviction and return a ConvictionResult.
 *
 * Deterministic, pure (no Date / no random / no IO). The advisories ORDER is fixed by the
 * caller's array, so the result is reproducible. The divergenceBias MUST already be the
 * look-ahead-safe value from divergenceSignal for this bar — scoreConviction never sees
 * future bars, so it cannot introduce look-ahead.
 */
export function scoreConviction(s: SignalsAtBar): ConvictionResult {
  const features: SignalFeatures = {
    trend: clampFeature(s.trend),
    momentum: clampFeature(s.momentum),
    fundingBias: clampFeature(s.fundingBias),
    flowBias: clampFeature(s.flowBias),
    divergenceBias: clampFeature(s.divergenceBias),
    bar: s.bar,
  };

  // 1) deterministic base conviction (ported pdModel structure + regime dead-band branch)
  const base = scoreConvictionBase(features);

  // 2) fold optional bounded advisories through blendScore (each {0,0} no-op offline)
  let conviction = base.conviction;
  let advNote = "";
  const advisories = s.advisories ?? [];
  for (const a of advisories) {
    const adv = a ?? NO_ADVICE;
    const before = conviction;
    conviction = blendScore(conviction, adv.adjustment, adv.confidence);
    if (conviction !== before) {
      const d = conviction - before;
      advNote += ` ${d >= 0 ? "+" : ""}${d}`;
    }
  }

  // 3) recompute size from the final (advisory-blended) conviction
  conviction = Math.round(clamp(conviction, CONVICTION_MIN, CONVICTION_MAX));
  const sizeBps = sizeFromConviction(conviction);

  const rationale =
    base.rationale +
    (advNote ? ` Advisory net adj:${advNote.trim()} → conviction ${conviction}.` : "");

  return { conviction, sizeBps, rationale, driver: base.driver };
}

/** Clamp a raw 0..1000 feature; non-finite -> neutral 500 (honest no-edge default). */
function clampFeature(x: number): number {
  if (!isFinite(x)) return CONVICTION_FLAT;
  return clamp(x, CONVICTION_MIN, CONVICTION_MAX);
}

// ════════════════════════════════════════════════════════════════════════════
//  runDivergence — the look-ahead-safe BATCH pass the backtester walks
// ════════════════════════════════════════════════════════════════════════════

/** Per-bar feature reads (0..1000 bullish) derived directly from a bar. */
export interface BarFeatures {
  trend: number;
  momentum: number;
  fundingBias: number;
  flowBias: number;
}

export interface EngineBar {
  bar: number;
  t: number;
  divergence: DivergenceBar;     // the full look-ahead-safe divergence record
  conviction: number;            // 0..1000 (500 = flat)
  sizeBps: number;               // position-size bps from the conviction
  driver: string;
  rationale: string;
}

export interface RunOpts extends DivergenceOpts {
  /**
   * Optional per-bar advisory provider (e.g. live CMC technicals/regime/attention or LLM
   * rationale). Called with the bar + its divergence record; returns bounded advisories
   * folded through blendScore. Omitted -> deterministic engine only (reproducible). The
   * provider MUST itself be look-ahead-safe (use only info at-or-before the bar).
   */
  advisoryProvider?: (bar: Bar, div: DivergenceBar, i: number) => Advisory[];
}

/**
 * Walk a full bar series and produce a per-bar conviction call, LOOK-AHEAD SAFE end to end.
 *
 *   - divergenceSignal computes the divergenceBias for every bar using only bars < t
 *     (rolling z-score window ends at t-1),
 *   - per-bar features (trend/momentum/funding/flow) are derived from at-or-before info,
 *   - scoreConviction folds them (plus any optional advisories) into the conviction.
 *
 * This is exactly what the backtester replays; because every input at bar t is bounded to
 * information available at t, appending future bars cannot change any past EngineBar.
 */
export function runDivergence(bars: Bar[], opts: RunOpts = {}): EngineBar[] {
  const divs = divergenceSignal(bars, opts);

  return bars.map((b, i) => {
    const div = divs[i];
    const feats = barFeatures(bars, i, opts.momentumLookback);
    const advisories = opts.advisoryProvider ? opts.advisoryProvider(b, div, i) : undefined;

    const result = scoreConviction({
      bar: i,
      trend: feats.trend,
      momentum: feats.momentum,
      fundingBias: feats.fundingBias,
      flowBias: feats.flowBias,
      divergenceBias: div.divergenceBias,
      advisories,
    });

    return {
      bar: i,
      t: b.t,
      divergence: div,
      conviction: result.conviction,
      sizeBps: result.sizeBps,
      driver: result.driver,
      rationale: result.rationale,
    };
  });
}

/**
 * Derive the per-bar 0..1000 bullish feature reads from a bar (and only PAST bars for the
 * momentum term). These are MODEST, transparent reads — the divergence term carries the
 * edge; these give the conviction core context. Look-ahead-safe (close[i] vs close[i-L]).
 *
 *   - trend       : EMA-free price-trend proxy = close vs a short trailing average of past
 *                   closes; rising -> bullish.
 *   - momentum    : recent return sign/scale over MOMENTUM_LOOKBACK (past closes only).
 *   - fundingBias : funding-rate lean centred at 500 (positive funding = crowded long ->
 *                   we read the funding feature itself as mildly bullish-positioning, while
 *                   the CONTRARIAN interpretation lives in the divergence term).
 *   - flowBias    : taker buy/sell lean centred at 500 (>1 ratio -> buying -> bullish).
 */
export function barFeatures(
  bars: Bar[],
  i: number,
  momentumLookback: number = 12
): BarFeatures {
  const b = bars[i];
  const L = Math.max(1, Math.floor(momentumLookback));

  // trend: close vs trailing mean of the prior up-to-L closes (PAST only).
  let trend = CONVICTION_FLAT;
  {
    const lo = Math.max(0, i - L);
    let sum = 0;
    let n = 0;
    for (let j = lo; j < i; j++) {
      if (isFinite(bars[j].close)) {
        sum += bars[j].close;
        n++;
      }
    }
    if (n > 0 && isFinite(b.close) && sum > 0) {
      const mean = sum / n;
      const pct = (b.close - mean) / mean; // fraction
      // ±5% deviation maps roughly across the half-scale; bounded.
      trend = clamp(CONVICTION_FLAT + (pct / 0.05) * CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX);
    }
  }

  // momentum: pct return vs L bars ago (PAST close only).
  let momentum = CONVICTION_FLAT;
  if (i >= L) {
    const past = bars[i - L]?.close;
    if (past !== undefined && isFinite(past) && past !== 0 && isFinite(b.close)) {
      const pct = (b.close - past) / past;
      momentum = clamp(CONVICTION_FLAT + (pct / 0.05) * CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX);
    }
  }

  // fundingBias: funding lean, centred at 500. (positioning read; contrarian view is in divergence)
  let fundingBias = CONVICTION_FLAT;
  if (b.funding !== undefined && isFinite(b.funding)) {
    const bps = b.funding * 10000; // basis points
    fundingBias = clamp(CONVICTION_FLAT + bps * 30, CONVICTION_MIN, CONVICTION_MAX);
  }

  // flowBias: taker buy/sell lean, centred at 500. (>1 -> buying dominates -> bullish)
  let flowBias = CONVICTION_FLAT;
  if (b.takerBuySellRatio !== undefined && isFinite(b.takerBuySellRatio)) {
    const lean = b.takerBuySellRatio - 1; // 0 = balanced
    flowBias = clamp(CONVICTION_FLAT + lean * 500, CONVICTION_MIN, CONVICTION_MAX);
  }

  return { trend, momentum, fundingBias, flowBias };
}

// ── default opts (single-sourced; the SKILL.md "replay instructions" cite these) ──
export const DEFAULT_RUN_OPTS: Required<Pick<DivergenceOpts, "window" | "minObs">> = {
  window: ZSCORE_WINDOW,
  minObs: ZSCORE_MIN_OBS,
};
