/**
 * Stoic — NET-NEW differentiator: CROSS-SECTIONAL positioning-vs-flow
 * DISLOCATION across a token panel (BTC / ETH / BNB).  [M2x — Originality gap 4]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  THE INSIGHT (why this is NOT the canned example, and NOT the per-token engine)
 * ════════════════════════════════════════════════════════════════════════════
 * The canned Track-2 idea is "is sentiment diverging from price?". The per-token engine
 * in divergence.ts already extends that into a TIME-SERIES construct:
 *
 *     divergence_token(t) = z(crowd_token, W)[t] − z(flow_token, W)[t]
 *
 * i.e. "is THIS token's crowd offside vs THIS token's realised flow, relative to ITS OWN
 * recent history?". That is a per-asset, time-series question.
 *
 * The cross-sectional construct here asks a DIFFERENT, relative-value question, the way
 * an equities stat-arb desk asks it:
 *
 *     "Across the WHOLE panel {BTC,ETH,BNB} AT THIS INSTANT, which token's
 *      positioning-vs-flow divergence is the OUTLIER relative to its peers?"
 *
 * Concretely, at each bar t we take the per-token time-series divergence values, DEMEAN
 * them across the panel (subtract the cross-sectional mean), and re-standardise by the
 * cross-sectional dispersion:
 *
 *     dislocation_token(t) = (divergence_token(t) − meanₚ divergence(t)) / stdₚ divergence(t)
 *
 * where meanₚ / stdₚ are taken ACROSS THE PANEL at bar t (NOT over time).
 *
 *  WHY THIS IS NOT REDUNDANT WITH THE PER-TOKEN ENGINE — the non-obvious part:
 *  The cross-sectional DEMEAN removes the common (market-wide / beta) component of
 *  divergence. When the ENTIRE crypto market is crowded long, every token shows positive
 *  per-token divergence and the per-token engine fires SHORT on all three — that is just
 *  shorting market beta, not an edge. Subtracting the panel mean leaves only the
 *  IDIOSYNCRATIC dislocation: the token whose crowd is offside RELATIVE TO ITS PEERS.
 *  That residual is the cleaner mean-reversion target (a token can revert toward the
 *  panel without the whole market having to move). Fading only the MOST cross-sectionally
 *  dislocated token (|dislocation| ≥ a threshold) is a market-neutral-flavoured selection
 *  the per-token engine cannot express, because the per-token engine has no concept of
 *  "relative to the other tokens".
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY (the property the dedicated test pins)
 * ════════════════════════════════════════════════════════════════════════════
 *  Every input is a per-token divergence value, each computed by divergence.ts strictly
 *  from bars < t (the rolling z-score window ends at t−1). The cross-sectional step at
 *  bar t reads ONLY the panel's already-past-derived values AT bar t — no future bar and
 *  no future cross-section. Therefore appending or truncating bars at index ≥ t cannot
 *  change any past dislocation. A dedicated truncation-invariance test pins this.
 *
 *  Pure: no Date / no random / no IO. Deterministic given the aligned panel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY
 * ════════════════════════════════════════════════════════════════════════════
 *  - This is NET-NEW exported logic; it does not touch report.json, the default engine
 *    path, or any committed result. It is validated by the SAME P1 full-coverage harness
 *    on the IN-SAMPLE segment only, with the held-out OOS reported UNCONDITIONALLY
 *    (see backtest/crossSectional.ts + report-crosssectional.json).
 *  - A bar where fewer than CROSS_MIN_TOKENS tokens have a defined (non-warming) per-token
 *    divergence has NO cross-section -> dislocation 0 (no edge), never fabricated.
 *  - All thresholds are exported constants (single source of truth).
 */

import { Bar } from "../data/binance";
import { divergenceSignal, DivergenceBar, DivergenceOpts } from "./divergence";

// ── numeric helper (pure) ───────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED THRESHOLD CONSTANTS (single source of truth)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimum number of tokens that must carry a defined (non-warming, finite) per-token
 * divergence at a bar before a cross-section is well-defined. Below this there is no
 * meaningful "relative to peers" comparison -> dislocation 0 for every token that bar.
 * 2 is the floor (one token vs one peer); the panel default is 3 (BTC/ETH/BNB).
 */
export const CROSS_MIN_TOKENS = 2;

/**
 * Cross-sectional dislocation magnitude (in cross-sectional z-units) below which a token
 * is NOT considered the actionable outlier -> dislocation reported but no contrarian
 * selection. Mirrors the per-token DIVERGENCE_DEADBAND_Z in spirit but on the panel axis.
 */
export const CROSS_DISLOCATION_DEADBAND = 0.75;

// ════════════════════════════════════════════════════════════════════════════
//  CROSS-SECTIONAL DISLOCATION (look-ahead-safe; panel-axis demean + standardise)
// ════════════════════════════════════════════════════════════════════════════

/** Per-token, per-bar cross-sectional dislocation record. */
export interface DislocationBar {
  bar: number;            // bar index (provenance; index-aligned to the panel grid)
  t: number;              // bar open time (ms)
  /** This token's per-token TIME-SERIES divergence at the bar (crowdZ − flowZ), or NaN if warming. */
  ownDivergence: number;
  /** Cross-sectional mean of the panel's divergence at this bar (the common/beta component). */
  panelMean: number;
  /** Cross-sectional dispersion (population std) of the panel's divergence at this bar. */
  panelStd: number;
  /** Number of tokens that contributed a defined divergence at this bar. */
  tokensInCross: number;
  /**
   * Cross-sectional dislocation = (ownDivergence − panelMean) / panelStd, the IDIOSYNCRATIC
   * residual after the market-wide component is removed. 0 when the cross-section is
   * undefined (fewer than CROSS_MIN_TOKENS) or zero-dispersion. Sign convention matches the
   * per-token engine's divergence sign (positive = crowd more bullish than flow vs peers).
   */
  dislocation: number;
  /**
   * True iff this token is the MOST dislocated in the panel at this bar AND |dislocation|
   * clears CROSS_DISLOCATION_DEADBAND — i.e. the one to fade (market-neutral-flavoured pick).
   */
  isPanelOutlier: boolean;
}

/**
 * One token's aligned panel input: its symbol and the bars it contributes. ALL panels MUST
 * share the same bar grid (same length, same per-index timestamps) so the cross-section at
 * index i compares like-for-like. The caller is responsible for the alignment (the
 * full-coverage slices in this repo are bar-for-bar aligned across BTC/ETH/BNB).
 */
export interface PanelToken {
  symbol: string;
  bars: Bar[];
}

/**
 * Compute the per-token cross-sectional dislocation series for a panel, LOOK-AHEAD SAFE.
 *
 * Steps (all using only information at-or-before each bar):
 *   1. For each token, compute the per-token TIME-SERIES divergence via divergenceSignal
 *      (divergence.ts) — each value uses only bars < t (rolling z-score window ends at t−1).
 *   2. At each bar index i, gather the DEFINED (non-warming, finite) per-token divergences
 *      across the panel, compute their cross-sectional mean + population std.
 *   3. dislocation_token(i) = (own − mean) / std  (0 if < CROSS_MIN_TOKENS or std ≈ 0).
 *   4. Flag the single most-dislocated token (max |dislocation|) per bar as the outlier
 *      iff its |dislocation| ≥ CROSS_DISLOCATION_DEADBAND.
 *
 * Returns a record-per-token, each an array index-aligned to that token's bars. The panels
 * MUST be length-aligned; a panel shorter than the grid contributes only where it has bars.
 * Pure given (panel, opts).
 *
 * @param panel aligned per-token bar series (same grid across tokens)
 * @param opts  forwarded to divergenceSignal (z-window / minObs / momentum / regime)
 */
export function crossSectionalDislocation(
  panel: PanelToken[],
  opts: DivergenceOpts = {}
): Record<string, DislocationBar[]> {
  const out: Record<string, DislocationBar[]> = {};
  if (panel.length === 0) return out;

  // 1) per-token TIME-SERIES divergence (look-ahead-safe; bars < t)
  const perToken: { symbol: string; divs: DivergenceBar[] }[] = panel.map((p) => ({
    symbol: p.symbol,
    divs: divergenceSignal(p.bars, opts),
  }));

  // grid length = the longest panel; tokens index-align where they have bars
  const gridLen = Math.max(...panel.map((p) => p.bars.length));

  // initialise output arrays
  for (const p of perToken) out[p.symbol] = [];

  for (let i = 0; i < gridLen; i++) {
    // 2) gather the DEFINED per-token divergences at this bar (skip warming / non-finite)
    const present: { idx: number; symbol: string; divergence: number; t: number }[] = [];
    for (let k = 0; k < perToken.length; k++) {
      const rec = perToken[k].divs[i];
      // A token contributes iff it has a bar here, is NOT warming, and the divergence is finite.
      if (rec && !rec.warming && isFinite(rec.divergence)) {
        present.push({ idx: k, symbol: perToken[k].symbol, divergence: rec.divergence, t: rec.t });
      }
    }

    const n = present.length;
    const haveCross = n >= CROSS_MIN_TOKENS;

    // 3) cross-sectional mean + population std across the panel AT THIS BAR
    let mean = 0;
    let std = 0;
    if (haveCross) {
      mean = present.reduce((a, c) => a + c.divergence, 0) / n;
      let sse = 0;
      for (const p of present) {
        const d = p.divergence - mean;
        sse += d * d;
      }
      std = Math.sqrt(sse / n);
    }

    // dislocation per present token; identify the panel outlier (max |dislocation|)
    let outlierIdx = -1;
    let outlierAbs = -Infinity;
    const dislocByTokenIdx = new Map<number, { mean: number; std: number; tokens: number; disloc: number; own: number }>();
    for (const p of present) {
      const disloc = haveCross && std > 1e-12 ? (p.divergence - mean) / std : 0;
      dislocByTokenIdx.set(p.idx, { mean, std, tokens: n, disloc, own: p.divergence });
      const a = Math.abs(disloc);
      if (a > outlierAbs) {
        outlierAbs = a;
        outlierIdx = p.idx;
      }
    }
    const outlierFires = outlierIdx >= 0 && outlierAbs >= CROSS_DISLOCATION_DEADBAND;

    // 4) emit a record for EVERY token in the panel that has a bar at i
    for (let k = 0; k < perToken.length; k++) {
      const rec = perToken[k].divs[i];
      if (!rec) continue; // this token has no bar at this grid index
      const info = dislocByTokenIdx.get(k);
      out[perToken[k].symbol].push({
        bar: i,
        t: rec.t,
        ownDivergence: info ? info.own : NaN,
        panelMean: info ? info.mean : 0,
        panelStd: info ? info.std : 0,
        tokensInCross: info ? info.tokens : 0,
        dislocation: info ? info.disloc : 0,
        isPanelOutlier: outlierFires && k === outlierIdx,
      });
    }
  }

  return out;
}

/**
 * Map a signed cross-sectional dislocation onto the 0..1000 BULLISH divergenceBias scale
 * the conviction core consumes (500 = no edge), using the SAME contrarian convention as
 * the per-token engine: POSITIVE dislocation (this token's crowd more bullish than its
 * peers, vs flow) -> bias BELOW 500 (SHORT this token relative to the panel); NEGATIVE ->
 * ABOVE 500 (LONG). Below the dead-band -> exactly 500. Saturates at CROSS_FULL_DISLOCATION.
 *
 * This is the bridge that lets the cross-sectional term be backtested by the SAME engine
 * + cost model as the per-token construct (drop-in divergenceBias), so the comparison is
 * apples-to-apples. Deterministic, pure, integer-clamped.
 */
export const CROSS_FULL_DISLOCATION = 2.0;

export function dislocationToBias(
  dislocation: number,
  flat = 500,
  min = 0,
  max = 1000
): number {
  if (!isFinite(dislocation)) return flat;
  const sign = dislocation > 0 ? 1 : dislocation < 0 ? -1 : 0;
  const mag = Math.abs(dislocation);
  if (mag < CROSS_DISLOCATION_DEADBAND) return flat;
  const span = Math.max(1e-9, CROSS_FULL_DISLOCATION - CROSS_DISLOCATION_DEADBAND);
  const norm = clamp((mag - CROSS_DISLOCATION_DEADBAND) / span, 0, 1);
  // CONTRARIAN: positive dislocation -> bearish (below flat).
  return Math.round(clamp(flat - sign * norm * flat, min, max));
}
