/**
 * Stoic — regime-aware DIRECTIONAL strategy assembly (the new thesis).  [P1]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  THE NEW THESIS (see HONEST_SEARCH_RULES.md)
 * ════════════════════════════════════════════════════════════════════════════
 * The original CONTRARIAN divergence strategy loses to buy-and-hold OOS (a contrarian
 * signal cannot out-earn B&H in a rising market). The honest pivot is a regime-aware
 * DIRECTIONAL core that RIDES bull markets and goes flat/short in bear/chop, with the
 * divergence/positioning signal DEMOTED to a contrarian RISK FILTER. THIS module assembles
 * the full pipeline, in this exact order, for one DAILY bar:
 *
 *   1. DIRECTIONAL CORE   (momentum.ts)   -> trend/momentum bias 0..1000 (rides the trend).
 *   2. F&G CONTRARIAN GATE (regimeGate.ts) -> extreme GREED trims/flattens a long, extreme
 *                                             FEAR favors a long; scales the directional EDGE.
 *   3. DIVERGENCE / FUNDING RISK FILTER    -> when positioning diverges into euphoria
 *      (a LONG bias into extreme greed AND stretched-positive funding = crowded longs
 *      unconfirmed), REDUCE size or VETO the entry. This is the old divergence engine's
 *      contrarian read, demoted to a risk overlay.
 *   4. blendScore (core.ts)                -> fold any bounded advisories (CMC/LLM) through
 *                                             the SAME bounded-blend math; {0,0} = no-op.
 *   5. sizeFromConviction (core.ts)        -> magnitude bps from the final conviction.
 *   6. decideTrade (decide.ts)             -> long/flat/short + flip, gated by entryThreshold.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONEST DATA SCOPE (binding — do not overclaim)
 * ════════════════════════════════════════════════════════════════════════════
 *  - The multi-year DAILY backtest data (history.ts DailyBar) carries OHLCV + Fear&Greed +
 *    FUNDING only. So the RISK FILTER on the backtest path uses FUNDING-vs-price + F&G
 *    euphoria — funding has deep history. The Binance long/short ACCOUNT ratio and taker
 *    buy/sell ratio legs only have ~30d history, so they are NOT used in the multi-year
 *    backtest; they remain a RECENT/LIVE refinement (the optional `positioning` hook on a
 *    StrategyBarInput, fed only when a live snapshot supplies them). This is stated, not hidden.
 *  - The directional core RIDES the trend (trend-following), the OPPOSITE sign of the old
 *    contrarian engine — by design. The contrarian read survives ONLY as the gate + filter.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY (the property test/strategy.test.ts pins)
 * ════════════════════════════════════════════════════════════════════════════
 *  Every input to the decision at bar i is bounded to information at-or-before bar i:
 *    - momentumSignal reads closes[0..i] only (forward EMA recurrence + past-return),
 *    - the F&G gate + funding filter read ONLY bar i's own fearGreed / funding,
 *    - decideTrade is a pure per-bar branch using the PREVIOUS side.
 *  The backtest engine holds the decision at bar i INTO bar i+1, so reading bar i's own
 *  close/F&G/funding is not look-ahead (the decision precedes the move it is paid on).
 *  Appending or truncating bars at index > i therefore cannot change the decision at bar i;
 *  a dedicated truncation-invariance test asserts this.
 *
 * ALL tunable knobs are EXPORTED CONSTANTS (the backtester + in-sample search sweep THESE;
 * nothing is hard-coded). Pure: no Date / no random / no IO. Deterministic.
 */

import { DailyBar } from "../data/history";
import {
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  blendScore,
  sizeFromConviction,
  ENTRY_THRESHOLD,
} from "./core";
import { decideTrade, TradeDecision, Side } from "../agent/decide";
import { Advisory, NO_ADVICE } from "../data/cmc";
import {
  momentumSignal,
  MomentumBar,
  MomentumOpts,
  EMA_FAST,
  EMA_SLOW,
  MOMENTUM_LOOKBACK,
} from "./momentum";
import {
  applyRegimeGate,
  RegimeGateRead,
  readRegimeGate,
} from "./regimeGate";

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Re-export the directional + gate knobs so the backtester/search have ONE import surface
// and can never drift from the modules' own thresholds.
export {
  EMA_FAST,
  EMA_SLOW,
  MOMENTUM_LOOKBACK,
  TREND_FULL_SEP,
  MOMENTUM_FULL_RET,
  TREND_WEIGHT,
  MOMENTUM_WEIGHT,
} from "./momentum";
export {
  FEAR_EXTREME,
  GREED_EXTREME,
  GATE_MAX,
  GATE_MIN,
} from "./regimeGate";
export { ENTRY_THRESHOLD, ENTRY_MIN, ENTRY_MAX } from "./core";

// ════════════════════════════════════════════════════════════════════════════
//  EXPORTED KNOB CONSTANTS  (the RISK FILTER — the backtester + search sweep THESE)
// ════════════════════════════════════════════════════════════════════════════

/**
 * |funding rate| (fraction per 8h settle) at/above which derivatives positioning is in a
 * STRETCHED regime — crowded one way. A LONG directional bias into stretched-POSITIVE
 * funding (crowded longs) AND extreme greed is the "euphoric positioning" the risk filter
 * trims/vetoes. Matches divergence.ts FUNDING_STRETCHED so the two overlays agree.
 */
export const FUNDING_STRETCHED = 0.0005;
/**
 * Size REDUCTION applied by the risk filter when euphoric positioning is detected but not
 * extreme enough to veto: the directional edge is scaled by this (0..1). e.g. 0.5 = halve
 * the conviction edge (cut size ~in half) on a crowded-long-into-greed entry.
 */
export const RISK_FILTER_TRIM = 0.5;
/**
 * VETO threshold: when the F&G greed intensity (regimeGate.ts, 0..1) is at/above this AND
 * funding is stretched-positive AND the directional bias is LONG, the entry is VETOED
 * (conviction pinned to FLAT) — the strongest euphoria, crowded longs, no entry. 0..1.
 */
export const RISK_FILTER_VETO_INTENSITY = 0.6;

// ════════════════════════════════════════════════════════════════════════════
//  PER-BAR INPUT + OUTPUT
// ════════════════════════════════════════════════════════════════════════════

/**
 * The OPTIONAL recent/live positioning refinement. The multi-year backtest leaves this
 * undefined (no longShort/taker history on the free daily data). A LIVE snapshot may supply
 * the Binance long/short ACCOUNT ratio + taker buy/sell ratio for the CURRENT bar to sharpen
 * the euphoria read; it is read ONLY for the bar it is attached to (look-ahead-safe).
 */
export interface PositioningRefinement {
  /** Global long/short ACCOUNT ratio (>1 = more long accounts = crowded long). */
  longShortRatio?: number;
  /** Taker buy/sell volume ratio (>1 = aggressive buying = flow confirms). */
  takerBuySellRatio?: number;
}

/** Everything the strategy needs to decide ONE bar (already index-aligned to the series). */
export interface StrategyBarInput {
  bar: number;
  /** The directional read for THIS bar (momentum.ts; look-ahead-safe). */
  momentum: MomentumBar;
  /** This bar's Fear & Greed value (undefined -> gate/filter become pass-throughs). */
  fearGreed?: number;
  /** This bar's funding rate (fraction per settle; undefined -> filter sees no positioning). */
  funding?: number;
  /** Optional recent/live positioning refinement (NOT used in the multi-year backtest). */
  positioning?: PositioningRefinement;
  /** Optional bounded advisories (CMC technicals/regime, LLM) folded through blendScore. */
  advisories?: Advisory[];
}

export type RiskAction = "pass" | "trim" | "veto";

/** The full per-bar strategy record (what the backtester walks). */
export interface StrategyBar {
  bar: number;
  /** Directional bias from the core, 0..1000 (500 = no edge). */
  directionalBias: number;
  /** Directional bias AFTER the F&G contrarian gate. */
  gatedBias: number;
  /** The regime gate read (label / favoured / intensity). */
  regime: RegimeGateRead;
  /** Multiplicative gain the F&G gate applied to the directional edge. */
  gateGain: number;
  /** What the divergence/funding risk filter did this bar. */
  riskAction: RiskAction;
  /** Final conviction 0..1000 (500 = flat), after gate + filter + advisories. */
  conviction: number;
  /** Position-size bps from the final conviction. */
  sizeBps: number;
  /** Human-readable rationale (provenance). */
  rationale: string;
}

// ── strategy options (single object; the report echoes exactly what it ran) ─────
export interface StrategyOpts extends MomentumOpts {
  /** |funding| stretched threshold for the risk filter (default FUNDING_STRETCHED). */
  fundingStretched?: number;
  /** Size-reduction factor on a trim (default RISK_FILTER_TRIM). */
  riskTrim?: number;
  /** Greed intensity at/above which a crowded-long entry is vetoed (default …VETO_INTENSITY). */
  riskVetoIntensity?: number;
  /**
   * Optional per-bar advisory provider (e.g. live CMC technicals/regime, LLM). Called with
   * the bar input; returns bounded advisories folded through blendScore. The provider MUST
   * be look-ahead-safe (use only info at-or-before the bar). Omitted -> deterministic core.
   */
  advisoryProvider?: (input: StrategyBarInput) => Advisory[];
}

// ════════════════════════════════════════════════════════════════════════════
//  THE RISK FILTER — divergence/funding-into-euphoria size reduction / veto
// ════════════════════════════════════════════════════════════════════════════

/**
 * The contrarian RISK FILTER, demoted from the original divergence engine. Given the GATED
 * directional bias + this bar's regime, funding and optional live positioning, it decides
 * whether to PASS, TRIM (reduce size), or VETO (flatten) — and returns the resulting
 * conviction edge factor (0..1 applied to the gated edge).
 *
 * Trigger (euphoric positioning, contrarian to a LONG):
 *   - directional bias is LONG (edge > 0), AND
 *   - regime is EXTREME GREED, AND
 *   - funding is STRETCHED POSITIVE (crowded longs paying to be long).
 *   Optionally sharpened by live positioning: a high long/short ratio (very crowded long)
 *   with taker flow NOT confirming (taker <= 1) strengthens the euphoria read.
 *
 * Decision:
 *   - greed intensity >= veto threshold  -> VETO  (edge factor 0 -> flat).
 *   - else                                -> TRIM  (edge factor = riskTrim).
 *   - trigger not met                     -> PASS  (edge factor 1).
 *
 * Symmetric short guard: a SHORT bias into EXTREME FEAR + stretched-NEGATIVE funding
 * (crowded shorts into capitulation) is likewise euphoric-on-the-downside and is trimmed/
 * vetoed — don't press a short into a washed-out, crowded-short tape. Pure.
 */
export function riskFilter(
  gatedBias: number,
  regime: RegimeGateRead,
  funding: number | undefined,
  opts: { fundingStretched?: number; riskTrim?: number; riskVetoIntensity?: number } = {},
  positioning?: PositioningRefinement
): { action: RiskAction; edgeFactor: number; note: string } {
  const fundingStretched = opts.fundingStretched ?? FUNDING_STRETCHED;
  const riskTrim = clamp(opts.riskTrim ?? RISK_FILTER_TRIM, 0, 1);
  const vetoIntensity = clamp(opts.riskVetoIntensity ?? RISK_FILTER_VETO_INTENSITY, 0, 1);

  const edge = gatedBias - CONVICTION_FLAT;
  const dirSign: -1 | 0 | 1 = edge > 0 ? 1 : edge < 0 ? -1 : 0;
  if (dirSign === 0) return { action: "pass", edgeFactor: 1, note: "flat — no positioning risk" };

  const fundKnown = funding !== undefined && isFinite(funding);
  const stretchedPos = fundKnown && (funding as number) >= fundingStretched;
  const stretchedNeg = fundKnown && (funding as number) <= -fundingStretched;

  // Optional live-positioning sharpener: crowded long unconfirmed by taker flow.
  const lsr = positioning?.longShortRatio;
  const taker = positioning?.takerBuySellRatio;
  const crowdedLongUnconfirmed =
    lsr !== undefined && isFinite(lsr) && lsr > 1.2 && (taker === undefined || (isFinite(taker) && taker <= 1));
  const crowdedShortUnconfirmed =
    lsr !== undefined && isFinite(lsr) && lsr < 0.83 && (taker === undefined || (isFinite(taker) && taker >= 1));

  // LONG into extreme GREED + crowded longs -> euphoric long.
  if (dirSign === 1 && regime.label === "extreme-greed" && (stretchedPos || crowdedLongUnconfirmed)) {
    if (regime.intensity >= vetoIntensity) {
      return { action: "veto", edgeFactor: 0, note: "VETO long: extreme greed + crowded longs (euphoria)" };
    }
    return { action: "trim", edgeFactor: riskTrim, note: "TRIM long: greed + stretched-positive funding" };
  }

  // SHORT into extreme FEAR + crowded shorts -> euphoric (capitulation) short.
  if (dirSign === -1 && regime.label === "extreme-fear" && (stretchedNeg || crowdedShortUnconfirmed)) {
    if (regime.intensity >= vetoIntensity) {
      return { action: "veto", edgeFactor: 0, note: "VETO short: extreme fear + crowded shorts (capitulation)" };
    }
    return { action: "trim", edgeFactor: riskTrim, note: "TRIM short: fear + stretched-negative funding" };
  }

  return { action: "pass", edgeFactor: 1, note: "no euphoric-positioning divergence" };
}

// ════════════════════════════════════════════════════════════════════════════
//  scoreStrategyBar — the per-bar PUBLIC entry (the backtester calls this in its walk)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Score ONE bar through the full pipeline (directional core -> F&G gate -> risk filter ->
 * blendScore -> sizeFromConviction). Returns the StrategyBar record (conviction + size +
 * provenance). Look-ahead-safe by construction: it consumes only the precomputed momentum
 * read for THIS bar plus the bar's own F&G/funding — never a future bar. Pure.
 */
export function scoreStrategyBar(input: StrategyBarInput, opts: StrategyOpts = {}): StrategyBar {
  // 1) DIRECTIONAL CORE — the trend/momentum bias for this bar (already computed).
  const directionalBias = clamp(input.momentum.directional, CONVICTION_MIN, CONVICTION_MAX);

  // 2) F&G CONTRARIAN GATE — extreme greed trims a long, extreme fear favors a long.
  const gated = applyRegimeGate(directionalBias, input.fearGreed);
  const gatedBias = gated.gatedBias;
  const regime = gated.regime;

  // 3) DIVERGENCE / FUNDING RISK FILTER — euphoric positioning reduces size / vetoes.
  const risk = riskFilter(gatedBias, regime, input.funding, opts, input.positioning);
  const gatedEdge = gatedBias - CONVICTION_FLAT;
  let conviction = Math.round(
    clamp(CONVICTION_FLAT + gatedEdge * risk.edgeFactor, CONVICTION_MIN, CONVICTION_MAX)
  );

  // 4) blendScore — fold any bounded advisories (CMC/LLM). Each {0,0} = strict no-op.
  let advNote = "";
  const advisories = input.advisories ?? [];
  for (const a of advisories) {
    const adv = a ?? NO_ADVICE;
    const before = conviction;
    conviction = blendScore(conviction, adv.adjustment, adv.confidence);
    if (conviction !== before) {
      const d = conviction - before;
      advNote += ` ${d >= 0 ? "+" : ""}${d}`;
    }
  }

  // 5) sizeFromConviction — magnitude bps from the final conviction.
  conviction = Math.round(clamp(conviction, CONVICTION_MIN, CONVICTION_MAX));
  const sizeBps = sizeFromConviction(conviction);

  const rationale =
    `Stoic directional ${directionalBias} → gate(${regime.label}, ×${gated.gain.toFixed(2)}) ` +
    `${gatedBias} → risk:${risk.action} → conviction ${conviction}/1000, size ${(sizeBps / 100).toFixed(1)}%. ` +
    `${risk.note}.` +
    (advNote ? ` Advisory net:${advNote.trim()} → ${conviction}.` : "");

  return {
    bar: input.bar,
    directionalBias,
    gatedBias,
    regime,
    gateGain: gated.gain,
    riskAction: risk.action,
    conviction,
    sizeBps,
    rationale,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  runStrategy — the look-ahead-safe BATCH pass the backtester walks
// ════════════════════════════════════════════════════════════════════════════

/**
 * Walk a full DAILY bar series and produce a per-bar StrategyBar, LOOK-AHEAD SAFE end to end.
 *
 *   - momentumSignal computes the directional read for every bar from closes[0..i] only,
 *   - each bar's F&G gate + funding risk filter read only that bar's own fearGreed/funding,
 *   - scoreStrategyBar assembles the conviction; no step sees a future bar.
 *
 * The optional advisoryProvider is invoked per bar and must itself be look-ahead-safe.
 * Returns one StrategyBar per input bar, index-aligned. Pure + deterministic.
 */
export function runStrategy(bars: DailyBar[], opts: StrategyOpts = {}): StrategyBar[] {
  const closes = bars.map((b) => b.close);
  const moms = momentumSignal(closes, opts);

  return bars.map((b, i) => {
    const input: StrategyBarInput = {
      bar: i,
      momentum: moms[i],
      fearGreed: b.fearGreed,
      funding: b.funding,
    };
    if (opts.advisoryProvider) input.advisories = opts.advisoryProvider(input);
    return scoreStrategyBar(input, opts);
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  strategyDecision — conviction -> long/flat/short via decideTrade
// ════════════════════════════════════════════════════════════════════════════

/**
 * Turn a StrategyBar's conviction + size into a trade DECISION (long/flat/short + flip) via
 * the SAME pure per-bar branch (decideTrade) the original engine uses, given the previous
 * bar's side. The directional sign now FOLLOWS the trend (conviction > 500 -> long), which
 * is what makes this strategy RIDE the trend rather than fade it. `threshold` defaults to
 * ENTRY_THRESHOLD but is a parameter so the backtester can sweep / calibrate it. Pure.
 */
export function strategyDecision(
  prevSide: Side | null,
  sb: StrategyBar,
  threshold: number = ENTRY_THRESHOLD
): TradeDecision {
  return decideTrade(prevSide, sb.conviction, sb.sizeBps, threshold);
}

/** Re-export the readRegimeGate helper so a live path has one import surface. */
export { readRegimeGate };
