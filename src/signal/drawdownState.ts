/**
 * Stoic — DRAWDOWN-BUCKET EXPOSURE SCALER (the drawdown overlay).  [A5]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS  (and what it HONESTLY is NOT)
 * ════════════════════════════════════════════════════════════════════════════
 * A pure, look-ahead-safe state machine that tracks the running equity PEAK and the
 * point-in-time UNDERWATER depth dd = 1 - equity/peak, and maps that depth to a
 * multiplicative EXPOSURE multiplier in (0, 1]. Deeper underwater -> smaller exposure.
 *
 * This is a DRAWDOWN OVERLAY, not an alpha source. It cannot, by construction, generate
 * return — it only ever CUTS exposure after equity has already fallen off its peak, so it
 * trades expected return for a shallower drawdown (and it can lag re-entry on a sharp
 * recovery, costing return). It is the trading analogue of a de-risking / vol-target rule,
 * not an edge. The committed ablation (A5 vs A1) reports the marginal OOS Δreturn / ΔmaxDD /
 * ΔSharpe AS-IS; if it does not bite (no non-trivial OOS maxDD reduction) it is a disclosed,
 * inert monitor exactly like the risk filter (A3) — never dressed up as a driver.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY  (the property the truncation-invariance test pins)
 * ════════════════════════════════════════════════════════════════════════════
 * The multiplier applied to the position DECIDED at bar i (and held INTO bar i+1) is a pure
 * function of the equity curve REALIZED up to and including bar i — never a future bar. The
 * walk feeds equity in one bar at a time, in order, calling `update(equity_i)` only after
 * bar i's already-decided return has been booked, then reads `multiplier()` to scale the
 * NEXT position. Because the running peak + dd depend only on the prefix of the equity series
 * seen so far, appending or mutating any FUTURE bar cannot change a multiplier already
 * emitted for a PAST bar. A dedicated truncation/append-invariance test asserts this.
 *
 * Pure: no Date / no random / no IO. Deterministic. All bucket edges + multipliers are
 * EXPORTED CONSTANTS so the harness / search read THESE and nothing is hard-coded inline.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  BUCKET CALIBRATION PROVENANCE (IN-SAMPLE only — no OOS peeking)
 * ════════════════════════════════════════════════════════════════════════════
 * The bucket EDGES were chosen against the IN-SAMPLE 70% drawdown profile of the locked
 * config ONLY (the in-sample aggregate strategy maxDrawdown sits ~31%, with the curve
 * spending meaningful time in the 5-15% and 15-25% underwater bands). The edges bracket
 * those observed bands; the multipliers are a monotone de-risking ladder (1.0 / 0.66 / 0.4 /
 * 0.2). The held-out OOS 30% was NOT consulted when picking these — it is measured once,
 * after the fact, and reported unconditionally. The numbers are deliberately round (not
 * fit-to-the-third-decimal) to avoid the appearance of OOS-tuned curve-fitting.
 */

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED BUCKET CONSTANTS  (the de-risking ladder — single-sourced)
// ════════════════════════════════════════════════════════════════════════════

/**
 * One drawdown bucket: while the point-in-time underwater depth dd is in
 * [minDrawdown, nextBucket.minDrawdown), exposure is scaled by `multiplier`.
 * The first bucket starts at 0; buckets are listed shallow -> deep.
 */
export interface DrawdownBucket {
  /** Inclusive lower edge of this bucket's underwater depth (fraction in [0,1)). */
  minDrawdown: number;
  /** Exposure multiplier applied while dd is in this bucket (0..1]. */
  multiplier: number;
  /** Human-readable label (provenance only). */
  label: string;
}

/** Underwater band edges (fraction off the running peak). IN-SAMPLE-biased, round by design. */
export const DD_EDGE_SHALLOW = 0.05; // < 5% underwater  -> full exposure
export const DD_EDGE_MID = 0.15;     // 5-15% underwater  -> first de-risk
export const DD_EDGE_DEEP = 0.25;    // 15-25% underwater -> second de-risk; >= 25% -> floor

/** Exposure multipliers for each band (monotone non-increasing de-risking ladder). */
export const DD_MULT_FULL = 1.0;   // dd < 5%
export const DD_MULT_MID = 0.66;   // 5% <= dd < 15%
export const DD_MULT_DEEP = 0.4;   // 15% <= dd < 25%
export const DD_MULT_FLOOR = 0.2;  // dd >= 25%

/**
 * The de-risking ladder, shallow -> deep. EXPORTED so the ablation harness / any search reads
 * THESE constants and the math can never drift from a hard-coded inline table.
 *
 * IN-SAMPLE rationale (no OOS peeking): edges bracket the in-sample drawdown bands of the
 * locked long-only+ema30/80 config; multipliers de-risk monotonically as the account goes
 * deeper underwater. Deliberately round to avoid OOS curve-fit appearance.
 */
export const DRAWDOWN_BUCKETS: ReadonlyArray<DrawdownBucket> = [
  { minDrawdown: 0,             multiplier: DD_MULT_FULL,  label: "dd<5% — full exposure" },
  { minDrawdown: DD_EDGE_SHALLOW, multiplier: DD_MULT_MID,   label: "5-15% underwater — de-risk to 0.66x" },
  { minDrawdown: DD_EDGE_MID,     multiplier: DD_MULT_DEEP,  label: "15-25% underwater — de-risk to 0.4x" },
  { minDrawdown: DD_EDGE_DEEP,    multiplier: DD_MULT_FLOOR, label: ">=25% underwater — floor 0.2x" },
];

// ════════════════════════════════════════════════════════════════════════════
//  PURE BUCKET MAP  (dd -> multiplier)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map a point-in-time underwater depth dd (fraction in [0,1]) to its exposure multiplier
 * via DRAWDOWN_BUCKETS. MONOTONE NON-INCREASING in dd by construction (deeper underwater =>
 * smaller-or-equal multiplier) — the monotonicity test pins this. A non-finite or negative
 * dd is treated as 0 (no drawdown -> full exposure); dd is clamped into [0,1].
 *
 * Pure: depends only on its argument and the exported bucket table.
 */
export function multiplierForDrawdown(
  dd: number,
  buckets: ReadonlyArray<DrawdownBucket> = DRAWDOWN_BUCKETS
): number {
  const d = isFinite(dd) ? Math.max(0, Math.min(1, dd)) : 0;
  // buckets are shallow -> deep; pick the deepest bucket whose lower edge dd has reached.
  let mult = buckets.length > 0 ? buckets[0].multiplier : 1;
  for (const b of buckets) {
    if (d >= b.minDrawdown) mult = b.multiplier;
    else break;
  }
  return mult;
}

// ════════════════════════════════════════════════════════════════════════════
//  THE STATE MACHINE  (running peak + point-in-time dd, look-ahead-safe by feed order)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Tracks the running equity PEAK and the current underwater depth from a SEQUENTIALLY-fed
 * equity series. The contract that makes it look-ahead-safe:
 *
 *   1. The walk decides bar i's position using `multiplier()` BEFORE booking any return that
 *      depends on a future bar.
 *   2. It then calls `update(equity_i)` once bar i's already-realized equity is known.
 *
 * So the multiplier scaling the position held INTO bar i+1 reflects ONLY equity realized
 * through bar i — never bar i+1's move. Feeding the same prefix of equities always yields the
 * same peak/dd/multiplier, regardless of any later equities (none have been fed yet). Pure
 * (no IO/Date/random); deterministic given the fed sequence.
 */
export class DrawdownState {
  private peak: number;
  private equity: number;
  private buckets: ReadonlyArray<DrawdownBucket>;

  constructor(
    initialEquity: number = 1.0,
    buckets: ReadonlyArray<DrawdownBucket> = DRAWDOWN_BUCKETS
  ) {
    this.peak = isFinite(initialEquity) && initialEquity > 0 ? initialEquity : 1.0;
    this.equity = this.peak;
    this.buckets = buckets;
  }

  /** Feed one bar's REALIZED equity. Updates the running peak (monotone non-decreasing). */
  update(equity: number): void {
    if (!isFinite(equity)) return; // carry the last good state across a non-finite point
    this.equity = equity;
    if (equity > this.peak) this.peak = equity;
  }

  /** Current underwater depth dd = 1 - equity/peak (point-in-time, in [0,1]). */
  drawdown(): number {
    if (!(this.peak > 0)) return 0;
    const dd = 1 - this.equity / this.peak;
    return isFinite(dd) && dd > 0 ? Math.min(1, dd) : 0;
  }

  /** Running equity peak seen so far (provenance/inspection). */
  currentPeak(): number {
    return this.peak;
  }

  /** Exposure multiplier for the CURRENT underwater depth (what scales the next position). */
  multiplier(): number {
    return multiplierForDrawdown(this.drawdown(), this.buckets);
  }
}

/**
 * Convenience: given a FULL realized-equity series, return the per-bar exposure multiplier
 * that the walk would have applied to the position DECIDED at each bar i — i.e. the multiplier
 * derived from equity[0..i] (the prefix THROUGH bar i). multipliers[i] therefore scales the
 * position held INTO bar i+1, using only information realized at-or-before bar i.
 *
 * This is the same prefix-only computation the live walk does inline; exposed as a pure helper
 * so tests can assert truncation/append invariance directly. Pure + deterministic.
 */
export function multipliersForEquitySeries(
  equity: number[],
  initialEquity: number = 1.0,
  buckets: ReadonlyArray<DrawdownBucket> = DRAWDOWN_BUCKETS
): number[] {
  const state = new DrawdownState(initialEquity, buckets);
  const out: number[] = [];
  for (const e of equity) {
    state.update(e);
    out.push(state.multiplier());
  }
  return out;
}
