/**
 * Stoic — Fear&Greed CONTRARIAN regime gate (the regime overlay).  [P1]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS
 * ════════════════════════════════════════════════════════════════════════════
 * The DIRECTIONAL core (momentum.ts) decides the long/flat/short bias. THIS module is the
 * CONTRARIAN regime OVERLAY that modulates that bias using CoinMarketCap's own guidance for
 * the Fear & Greed index:
 *
 *   - EXTREME GREED  -> the market is "overvalued" / euphoric -> TRIM or FLATTEN a long
 *     (a long into extreme greed is buying the top); the gate scales the long bias DOWN.
 *   - EXTREME FEAR   -> the market is a "bargain" / capitulating -> FAVOR a long
 *     (fear is the time to accumulate); the gate keeps/boosts a long bias and DAMPENS a
 *     short bias (don't press shorts into a washed-out tape).
 *   - NEUTRAL F&G    -> the gate is a pass-through (gain 1.0); the directional core rules.
 *
 * This is the SAME contrarian Fear&Greed thesis the original divergence engine used
 * (divergence.ts readRegime), now applied as a RISK/REGIME modulation of a DIRECTIONAL core
 * rather than as the whole signal — and it is data-supported over the multi-year DAILY
 * window (the alternative.me historical F&G, ~100% daily coverage; see history.ts).
 *
 * The gate is expressed as a MULTIPLICATIVE GAIN on the directional EDGE (distance from the
 * 500 flat line), bounded to [GATE_MIN, GATE_MAX], plus the regime's favoured contrarian
 * direction. strategy.ts applies the gain to the directional bias's distance from 500.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY / LOOK-AHEAD
 * ════════════════════════════════════════════════════════════════════════════
 *  - F&G is joined to each DAILY bar by UTC date (history.ts) — same-day-open info only, no
 *    future print. The gate reads ONLY that bar's F&G value, so it is look-ahead-safe.
 *  - Thresholds are EXPORTED CONSTANTS (single source of truth; the backtester + in-sample
 *    search sweep THESE). The contrarian extreme bands re-use the SAME numeric values as
 *    divergence.ts (FEAR<=25, GREED>=75) so the two overlays agree on what "extreme" means.
 *
 * Pure: no Date / no random / no IO. Deterministic.
 */

// ── numeric helpers (pure) ──────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED KNOB CONSTANTS  (the backtester + in-sample search sweep THESE)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fear & Greed <= this = EXTREME FEAR regime (contrarian-LONG environment: a bargain).
 * 0..100. Matches divergence.ts FEAR_EXTREME so the two overlays share the same "extreme".
 */
export const FEAR_EXTREME = 25;
/**
 * Fear & Greed >= this = EXTREME GREED regime (contrarian-SHORT/TRIM environment: euphoric).
 * 0..100. Matches divergence.ts GREED_EXTREME.
 */
export const GREED_EXTREME = 75;
/**
 * The midpoint of the F&G scale (50 = balanced). Used to scale how far into an extreme the
 * reading is, so the gate strength RAMPS from the extreme band edge toward the 0 / 100 ends
 * rather than switching on like a step (a 76 greed is a gentler trim than a 95 greed).
 */
export const FG_MID = 50;
/**
 * MULTIPLICATIVE gain bounds applied to the directional EDGE. When the regime CONFIRMS the
 * directional bias (e.g. extreme fear + a long bias) the edge is scaled UP toward GATE_MAX;
 * when it CONTRADICTS (extreme greed + a long bias = buying the top) it is scaled DOWN
 * toward GATE_MIN (trim/flatten). Neutral F&G -> 1.0 (pass-through). 1.0 = regime-neutral.
 */
export const GATE_MAX = 1.25;
export const GATE_MIN = 0.4;

export type RegimeLabel = "extreme-fear" | "extreme-greed" | "neutral" | "unknown";

export interface RegimeGateRead {
  label: RegimeLabel;
  /**
   * The directional bias the CONTRARIAN regime FAVOURS, as a sign:
   *   +1 = regime favours LONG  (extreme fear -> bargain),
   *   -1 = regime favours SHORT/TRIM (extreme greed -> euphoria),
   *    0 = neutral / unknown regime (no contrarian tilt).
   */
  favored: -1 | 0 | 1;
  /**
   * How deep into the extreme the F&G print is, 0..1 (0 at the band edge, 1 at the 0/100
   * end). 0 outside an extreme band. The gate ramps with this so deeper extremes modulate
   * harder. Look-ahead-safe (reads only the bar's own F&G).
   */
  intensity: number;
}

/**
 * Read the CONTRARIAN regime from a single bar's Fear & Greed value.
 *   - F&G <= FEAR_EXTREME  -> extreme-fear, favours LONG (+1), intensity ramps to 1 at F&G 0.
 *   - F&G >= GREED_EXTREME  -> extreme-greed, favours SHORT/TRIM (-1), intensity to 1 at 100.
 *   - else neutral (favored 0, intensity 0).
 *   - undefined / non-finite F&G -> "unknown" (favored 0) — the gate becomes a pass-through.
 * Deterministic, pure.
 */
export function readRegimeGate(fearGreed?: number): RegimeGateRead {
  if (fearGreed === undefined || !isFinite(fearGreed)) {
    return { label: "unknown", favored: 0, intensity: 0 };
  }
  const fg = clamp(fearGreed, 0, 100);
  if (fg <= FEAR_EXTREME) {
    // intensity: 0 at the band edge (FEAR_EXTREME), 1 at the extreme end (0).
    const intensity = FEAR_EXTREME > 0 ? clamp((FEAR_EXTREME - fg) / FEAR_EXTREME, 0, 1) : 0;
    return { label: "extreme-fear", favored: 1, intensity };
  }
  if (fg >= GREED_EXTREME) {
    // intensity: 0 at the band edge (GREED_EXTREME), 1 at the extreme end (100).
    const denom = 100 - GREED_EXTREME;
    const intensity = denom > 0 ? clamp((fg - GREED_EXTREME) / denom, 0, 1) : 0;
    return { label: "extreme-greed", favored: -1, intensity };
  }
  return { label: "neutral", favored: 0, intensity: 0 };
}

/**
 * MULTIPLICATIVE gain the regime gate applies to the directional EDGE, given the regime read
 * and the sign of the DIRECTIONAL bias (+1 long, -1 short, 0 flat).
 *
 *   - regime AGREES with the directional sign (extreme fear + long, or extreme greed + short)
 *     -> CONFIRM: scale the edge UP toward GATE_MAX, ramped by intensity.
 *   - regime CONTRADICTS the directional sign (extreme greed + long = buying the top, or
 *     extreme fear + short = pressing a washed-out tape)
 *     -> TRIM: scale the edge DOWN toward GATE_MIN, ramped by intensity (deeper extreme ->
 *        harder trim toward flat).
 *   - neutral / unknown regime, or flat directional sign -> 1.0 (pass-through).
 *
 * Bounded to [GATE_MIN, GATE_MAX]. Pure.
 *
 * @param regime   the contrarian regime read (readRegimeGate).
 * @param dirSign  sign of the DIRECTIONAL bias from momentum.ts: +1 long, -1 short, 0 flat.
 */
export function regimeGateGain(regime: RegimeGateRead, dirSign: -1 | 0 | 1): number {
  if (regime.favored === 0 || dirSign === 0) return 1.0;
  const agree = regime.favored === dirSign;
  if (agree) {
    // confirm: 1.0 at the band edge (intensity 0) up to GATE_MAX at the extreme end.
    return clamp(1.0 + (GATE_MAX - 1.0) * regime.intensity, GATE_MIN, GATE_MAX);
  }
  // contradict: 1.0 at the band edge (intensity 0) down to GATE_MIN at the extreme end.
  return clamp(1.0 - (1.0 - GATE_MIN) * regime.intensity, GATE_MIN, GATE_MAX);
}

/**
 * Apply the contrarian regime gate to a DIRECTIONAL bias on the 0..1000 scale, returning the
 * gated bias on the SAME scale (500 = flat). The gate scales the EDGE (distance from 500) by
 * regimeGateGain; the SIGN of the directional bias is preserved (the gate trims/boosts size,
 * it does not flip direction). Integer-clamped to [0,1000]. Pure.
 *
 *   gatedEdge = (directionalBias - 500) * gain;  gatedBias = round(clamp(500 + gatedEdge)).
 *
 * @param directionalBias 0..1000 directional bias from momentum.ts (500 = no edge).
 * @param fearGreed       the bar's Fear & Greed value (undefined -> pass-through).
 */
export function applyRegimeGate(
  directionalBias: number,
  fearGreed?: number
): { gatedBias: number; gain: number; regime: RegimeGateRead } {
  const regime = readRegimeGate(fearGreed);
  const edge = directionalBias - 500;
  const dirSign: -1 | 0 | 1 = edge > 0 ? 1 : edge < 0 ? -1 : 0;
  const gain = regimeGateGain(regime, dirSign);
  const gatedBias = Math.round(clamp(500 + edge * gain, 0, 1000));
  return { gatedBias, gain, regime };
}
