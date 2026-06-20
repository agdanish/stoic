/**
 * Stoic — DIRECTIONAL trend/momentum core (the regime-aware pivot's engine).  [P1]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS (see HONEST_SEARCH_RULES.md)
 * ════════════════════════════════════════════════════════════════════════════
 * The original CONTRARIAN divergence strategy has NO edge: it loses to buy-and-hold
 * out-of-sample because a contrarian signal cannot out-earn B&H in a rising market.
 * The honest pivot is a DIFFERENT THESIS on BETTER (longer, multi-regime) DAILY data:
 *
 *   a regime-aware DIRECTIONAL core that RIDES bull markets (tracks B&H when trend is up)
 *   and goes FLAT / SHORT in bear/chop (avoids the drawdown B&H eats),
 *
 * with the divergence/positioning signal DEMOTED to a contrarian RISK FILTER (strategy.ts)
 * and the Fear&Greed read used as a contrarian regime GATE (regimeGate.ts).
 *
 * THIS module is ONLY the directional core: it turns a DailyBar series into a per-bar
 * trend/momentum read on core.ts's 0..1000 BULLISH scale (500 = no directional edge,
 * >500 = long bias, <500 = short/flat bias). It does NOT decide size or trade — that is
 * strategy.ts's job (momentum -> F&G gate -> risk filter -> blendScore -> decideTrade).
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY (the property test/strategy.test.ts pins)
 * ════════════════════════════════════════════════════════════════════════════
 *  Every read for bar i uses ONLY closes at indices <= i (the bar's own close and PAST
 *  closes). The backtest engine HOLDS the position decided at bar i INTO bar i+1 and earns
 *  close[i+1]/close[i]-1, so reading close[i] at bar i is NOT look-ahead (the decision
 *  strictly precedes the move it is paid on — same convention as signalEngine.barFeatures
 *  and backtest/engine.ts). Appending or truncating bars at index > i cannot change the
 *  read at bar i: the EMAs are a forward recurrence over closes[0..i] only. A dedicated
 *  truncation-invariance test asserts this.
 *
 * Pure: no Date / no random / no IO. Deterministic given the close series, so the daily
 * backtest the next agent builds stays byte-reproducible.
 *
 * ALL tunable thresholds are EXPORTED CONSTANTS (single source of truth — the backtester
 * and the in-sample search sweep THESE; nothing is hard-coded downstream).
 */

import {
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
} from "./core";

// ── numeric helpers (pure) ──────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED KNOB CONSTANTS  (the backtester + in-sample search sweep THESE)
// ════════════════════════════════════════════════════════════════════════════

/**
 * FAST EMA span (bars). The fast/slow EMA crossover is the trend backbone: fast above slow
 * = up-trend (long bias), fast below slow = down-trend (short/flat bias). Daily default.
 */
export const EMA_FAST = 20;
/** SLOW EMA span (bars). Wider = fewer, more durable regime flips. Daily default. */
export const EMA_SLOW = 50;
/**
 * Momentum lookback (bars) for the price-return confirmation leg. The directional read is
 * the trend (EMA stack) CONFIRMED by recent realised return over this lookback. Daily.
 */
export const MOMENTUM_LOOKBACK = 20;
/**
 * EMA-separation (as a fraction of the slow EMA) that maps to a FULL-weight directional
 * read. |fastEMA - slowEMA| / slowEMA >= this saturates the trend term to 0 / 1000. e.g.
 * 0.06 = the fast EMA sitting 6% above/below the slow EMA is a maximal trend signal.
 */
export const TREND_FULL_SEP = 0.06;
/**
 * Momentum return (fraction over MOMENTUM_LOOKBACK) that maps to a FULL-weight momentum
 * read. |return| >= this saturates the momentum term. e.g. 0.15 = +15% over the lookback
 * is a maximal momentum signal. Daily-scaled (larger than the hourly defaults).
 */
export const MOMENTUM_FULL_RET = 0.15;
/**
 * Blend weight of the TREND (EMA-stack) term vs the MOMENTUM (return) term in the combined
 * directional read. trend carries the regime backbone; momentum confirms/vetoes it.
 * weights sum to 1.0.
 */
export const TREND_WEIGHT = 0.6;
export const MOMENTUM_WEIGHT = 0.4;
/**
 * Minimum PAST closes required before the directional read is defined. Below this the core
 * is "warming up" and reports a NEUTRAL 500 (no edge) — never NaN, never a partial guess.
 * Defaults to the slow EMA span so the slow EMA has seeded over a full span first.
 */
export const MIN_OBS = EMA_SLOW;

// ════════════════════════════════════════════════════════════════════════════
//  EMA SERIES — look-ahead-safe forward recurrence over closes[0..i]
// ════════════════════════════════════════════════════════════════════════════

/**
 * Exponential moving average of `closes`, as a per-index series. ema[i] depends ONLY on
 * closes[0..i] (a forward recurrence), so appending/truncating closes at index > i cannot
 * change ema[i] — the look-ahead invariant. Non-finite closes are carried (ema holds its
 * last value) rather than poisoning the recurrence with NaN.
 *
 *   alpha = 2 / (span + 1);  ema[0] = closes[0];  ema[i] = alpha*closes[i] + (1-alpha)*ema[i-1].
 *
 * Pure. Returns a series the SAME length as `closes`.
 */
export function ema(closes: number[], span: number): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(NaN);
  const s = Math.max(1, Math.floor(span));
  const alpha = 2 / (s + 1);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    if (!isFinite(c)) {
      out[i] = prev; // carry the last finite EMA (no NaN poisoning); stays NaN if none yet
      continue;
    }
    if (!isFinite(prev)) {
      prev = c; // seed on the first finite close
    } else {
      prev = alpha * c + (1 - alpha) * prev;
    }
    out[i] = prev;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  PER-BAR DIRECTIONAL READ
// ════════════════════════════════════════════════════════════════════════════

/** Per-bar directional read on core's 0..1000 BULLISH scale (500 = no edge). */
export interface MomentumBar {
  bar: number; // bar index (provenance)
  /** Trend term 0..1000 from the fast/slow EMA stack (500 = no separation). */
  trend: number;
  /** Momentum term 0..1000 from the realised return over MOMENTUM_LOOKBACK (500 = flat). */
  momentum: number;
  /**
   * Combined DIRECTIONAL bias 0..1000 (TREND_WEIGHT*trend + MOMENTUM_WEIGHT*momentum),
   * 500 = no directional edge, >500 = long bias, <500 = short/flat bias. This is what
   * strategy.ts feeds (as the trend+momentum context) into the conviction core.
   */
  directional: number;
  /** Sign of the directional bias: +1 long, -1 short, 0 flat (at exactly 500). */
  sign: -1 | 0 | 1;
  /** True while fewer than MIN_OBS past closes exist (read pinned to neutral 500). */
  warming: boolean;
}

export interface MomentumOpts {
  emaFast?: number;
  emaSlow?: number;
  momentumLookback?: number;
  trendFullSep?: number;
  momentumFullRet?: number;
  trendWeight?: number;
  momentumWeight?: number;
  minObs?: number;
}

/**
 * Map an EMA separation (fastEMA - slowEMA, as a fraction of slowEMA) onto the 0..1000
 * BULLISH trend scale. POSITIVE separation (fast above slow = up-trend) -> ABOVE 500
 * (long bias); negative -> below 500. Saturates to 0 / 1000 at +/-trendFullSep. This is the
 * DIRECTIONAL (trend-following) sign convention — the OPPOSITE of divergence.ts's contrarian
 * mapping, by design: this core RIDES the trend, the divergence overlay fades euphoria.
 */
export function trendToBias(
  fastEMA: number,
  slowEMA: number,
  fullSep: number = TREND_FULL_SEP
): number {
  if (!isFinite(fastEMA) || !isFinite(slowEMA) || slowEMA === 0) return CONVICTION_FLAT;
  const sep = (fastEMA - slowEMA) / Math.abs(slowEMA); // signed fraction
  const span = Math.max(1e-9, fullSep);
  const norm = clamp(sep / span, -1, 1);
  return Math.round(clamp(CONVICTION_FLAT + norm * CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX));
}

/**
 * Map a realised return (fraction over the momentum lookback) onto the 0..1000 BULLISH
 * momentum scale. POSITIVE return -> ABOVE 500 (long bias); saturates at +/-fullRet.
 * DIRECTIONAL sign (trend-following), matching trendToBias.
 */
export function momentumToBias(ret: number, fullRet: number = MOMENTUM_FULL_RET): number {
  if (!isFinite(ret)) return CONVICTION_FLAT;
  const span = Math.max(1e-9, fullRet);
  const norm = clamp(ret / span, -1, 1);
  return Math.round(clamp(CONVICTION_FLAT + norm * CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX));
}

/**
 * Compute the per-bar DIRECTIONAL read for a whole close series, LOOK-AHEAD SAFE end to end.
 *
 *   - fast + slow EMA series are forward recurrences over closes[0..i] (no future close),
 *   - trend term = trendToBias(fastEMA[i], slowEMA[i]) — DIRECTIONAL (fast>slow -> long),
 *   - momentum term = momentumToBias(close[i]/close[i-L] - 1) — PAST close only,
 *   - directional = TREND_WEIGHT*trend + MOMENTUM_WEIGHT*momentum, integer-clamped,
 *   - warming (read pinned to neutral 500) until MIN_OBS past closes exist.
 *
 * Returns one MomentumBar per close, index-aligned. Pure + deterministic.
 */
export function momentumSignal(closes: number[], opts: MomentumOpts = {}): MomentumBar[] {
  const emaFast = opts.emaFast ?? EMA_FAST;
  const emaSlow = opts.emaSlow ?? EMA_SLOW;
  const L = Math.max(1, Math.floor(opts.momentumLookback ?? MOMENTUM_LOOKBACK));
  const fullSep = opts.trendFullSep ?? TREND_FULL_SEP;
  const fullRet = opts.momentumFullRet ?? MOMENTUM_FULL_RET;
  const wT = opts.trendWeight ?? TREND_WEIGHT;
  const wM = opts.momentumWeight ?? MOMENTUM_WEIGHT;
  const minObs = Math.max(1, Math.floor(opts.minObs ?? MIN_OBS));

  const fast = ema(closes, emaFast);
  const slow = ema(closes, emaSlow);

  return closes.map((c, i) => {
    // warming until enough PAST closes exist to seed the slow EMA honestly.
    const warming = i < minObs;

    let trend = CONVICTION_FLAT;
    let momentum = CONVICTION_FLAT;

    if (!warming) {
      trend = trendToBias(fast[i], slow[i], fullSep);

      // momentum: pct return vs L bars ago (PAST close only — i-L < i).
      if (i >= L) {
        const past = closes[i - L];
        if (isFinite(past) && past !== 0 && isFinite(c)) {
          momentum = momentumToBias((c - past) / past, fullRet);
        }
      }
    }

    const directional = Math.round(
      clamp(wT * trend + wM * momentum, CONVICTION_MIN, CONVICTION_MAX)
    );
    const sign: -1 | 0 | 1 =
      directional > CONVICTION_FLAT ? 1 : directional < CONVICTION_FLAT ? -1 : 0;

    return { bar: i, trend, momentum, directional, sign, warming };
  });
}
