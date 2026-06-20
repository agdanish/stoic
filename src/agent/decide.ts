/**
 * Stoic — pure trade-decision logic.
 *
 * PORTED from Stoic's `agent/index.ts` `decideActions` (L45-52): pure, BVA-tested
 * branch logic. The credit-domain branches (earlyWarning / proposeDefault) are
 * recast for trading as a long/short/flat decision plus a directional-flip flag.
 * Kept strictly PURE (no Date / no random / no IO) so the backtest is reproducible.
 *
 * Convention (single-sourced with src/signal/core.ts):
 *   conviction 0..1000, 500 = FLAT. We trade only when the conviction's distance
 *   from flat exceeds the (calibratable) entry threshold; direction follows the sign.
 */
import { CONVICTION_FLAT, ENTRY_THRESHOLD } from "../signal/core";

export type Side = "long" | "short" | "flat";

export interface TradeDecision {
  side: Side;       // long | short | flat
  sizeBps: number;  // 0 when flat; otherwise the conviction-derived size
  flip: boolean;    // true when the side reversed vs the previous bar (long<->short)
}

/**
 * Decide the trade for the current bar from its conviction + size, given the
 * previous bar's side. PURE branch logic:
 *   - |conviction-500| <= threshold  -> FLAT (no edge), size 0
 *   - conviction > 500               -> LONG
 *   - conviction < 500               -> SHORT
 *   - flip = the side reversed long<->short vs the previous side
 *
 * `threshold` defaults to ENTRY_THRESHOLD but is a parameter so the backtester can
 * feed the value produced by `calibrateEntryThreshold` (online calibration).
 */
export function decideTrade(
  prevSide: Side | null,
  conviction: number,
  sizeBps: number,
  threshold: number = ENTRY_THRESHOLD
): TradeDecision {
  const edge = conviction - CONVICTION_FLAT;

  if (Math.abs(edge) <= threshold) {
    return { side: "flat", sizeBps: 0, flip: false };
  }

  const side: Side = edge > 0 ? "long" : "short";
  const flip =
    (prevSide === "long" && side === "short") ||
    (prevSide === "short" && side === "long");

  return { side, sizeBps, flip };
}
