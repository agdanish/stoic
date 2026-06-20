/**
 * Stoic — deterministic conviction core.
 *
 * This is the QUANT half of the signal agent: it turns a row of features into a
 * single number — a conviction score on 0..1000 where 500 = FLAT (no edge),
 * <500 = short bias, >500 = long bias — and maps that conviction to a position
 * size in basis points. Keeping it deterministic (no Date / no random / no IO)
 * is what makes the backtest byte-reproducible (rebuts "one lucky run").
 *
 * PROVENANCE / HONEST RELABELING (see D:\BNB\BNB_BUILD_PLAN.md section 2):
 *   The functions here are PORTED from Stoic's `agent/pdModel.ts`:
 *     - `blendScore`            : TRUE verbatim reuse (bounded advisory blend, {0,0} = strict no-op).
 *     - `sizeFromConviction`    : the `pdFromScore` monotone-map math, re-centred on 500 = flat
 *                                 and re-codomained as position-size bps instead of PD bps.
 *     - `calibrateEntryThreshold`: the `calibrateAlarmThreshold` bounded online-update math,
 *                                 outcome semantics recast for trading (FN = missed move -> loosen,
 *                                 FP = chop/whipsaw trade -> tighten).
 *     - `scoreConvictionBase`   : STRUCTURAL SCAFFOLDING ONLY from `scoreIssuer` — a weighted
 *                                 feature blend + a neutral-override BRANCH + integer clamp/round.
 *
 *   IMPORTANT (anti-overclaim): the *differentiator* — the regime-gated, rolling-window
 *   z-scored positioning/attention-vs-flow DIVERGENCE — is NET-NEW and lands in M2
 *   (src/signal/divergence.ts + the divergence term inside scoreConviction). The
 *   neutral-override branch below is a PLACEHOLDER hook for that gate, NOT the divergence
 *   engine itself, and is deliberately labelled as such. Stoic's `scoreIssuer` is
 *   stateless/per-row with no rolling window; do not present this file as the edge.
 */

// ── numeric helpers (pure) ──────────────────────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
/** Normalise a 0..1000 feature into 0..1. */
const norm = (x: number) => clamp(x / 1000, 0, 1);

// ── conviction scale constants (single-sourced; the engine + SKILL.md read these) ──
export const CONVICTION_MIN = 0;
export const CONVICTION_MAX = 1000;
export const CONVICTION_FLAT = 500; // 500 = no edge / flat

/**
 * Per-row trading features, each normalised onto a 0..1000 BULLISH scale
 * (0 = maximally bearish for that feature, 1000 = maximally bullish).
 * These mirror the SHAPE of Stoic's `Signals` but are renamed honestly for trading.
 * The rolling-window divergence term (M2) is fed in via `divergenceBias`.
 */
export interface SignalFeatures {
  trend: number;          // 0..1000  price-trend / EMA-stack alignment (bullish)
  momentum: number;       // 0..1000  RSI/MACD momentum (bullish)
  fundingBias: number;    // 0..1000  derivatives funding read (500 = neutral funding)
  flowBias: number;       // 0..1000  taker buy/sell + volume flow (bullish)
  divergenceBias: number; // 0..1000  NET-NEW divergence term (M2); 500 = no divergence
  bar: number;            // bar index / timestamp marker (provenance only, not scored)
}

export interface ConvictionResult {
  conviction: number; // 0..1000 (500 = flat)
  sizeBps: number;    // 0..10000 position-size basis points (10000 = full allocation)
  rationale: string;
  driver: string;
}

// ── neutral-override (PLACEHOLDER for the M2 regime gate) ─────────────────────
// Recast of Stoic's distress-override thresholds, expressed on the 0..1000
// divergence/regime scale (500 = neutral). These are HOOKS — the real regime read
// (Fear&Greed + funding regime) and the real divergence math arrive in M2.
export const REGIME_FLATTEN_BAND = 60;  // |divergenceBias-500| < this -> no edge, pull toward flat
export const STRONG_DIVERGENCE = 200;   // |divergenceBias-500| >= this -> high-conviction branch

/**
 * Deterministic base conviction from a weighted feature blend.
 *
 * STRUCTURE ported from `scoreIssuer`: a transparent weighted base + a single
 * branch override + integer clamp/round. Reinterpreted for trading:
 *   base 0..1000 (500 = flat) from trend / momentum / funding / flow / divergence,
 *   then a neutral-override BRANCH that pulls toward flat when the divergence term
 *   is inside the dead-band (no edge) — the placeholder for the M2 regime gate.
 */
export function scoreConvictionBase(f: SignalFeatures): ConvictionResult {
  // Weighted bullish blend on 0..1 then scaled to 0..1000.
  // Weights sum to 1.0; divergence carries the largest weight as the intended edge.
  const base =
    1000 *
    (0.20 * norm(f.trend) +
      0.20 * norm(f.momentum) +
      0.15 * norm(f.fundingBias) +
      0.15 * norm(f.flowBias) +
      0.30 * norm(f.divergenceBias));

  const divEdge = Math.abs(f.divergenceBias - CONVICTION_FLAT); // distance from "no divergence"

  let conviction: number;
  let driver: string;

  if (divEdge < REGIME_FLATTEN_BAND) {
    // Dead-band: no actionable divergence -> pull conviction toward FLAT.
    // (PLACEHOLDER for the M2 regime gate; not the divergence engine itself.)
    conviction = CONVICTION_FLAT + 0.5 * (base - CONVICTION_FLAT);
    driver = "no actionable divergence (dead-band) → flatten toward neutral";
  } else if (divEdge >= STRONG_DIVERGENCE) {
    // Strong divergence -> take the blended conviction at full weight.
    conviction = base;
    driver = "strong positioning/flow divergence → full-weight conviction";
  } else {
    // Moderate divergence -> blended conviction, modestly de-emphasised.
    conviction = CONVICTION_FLAT + 0.85 * (base - CONVICTION_FLAT);
    driver = "moderate divergence → tempered conviction";
  }

  conviction = Math.round(clamp(conviction, CONVICTION_MIN, CONVICTION_MAX));
  const sizeBps = sizeFromConviction(conviction);

  const rationale =
    `Stoic conviction ${conviction}/1000 (500=flat), size ${(sizeBps / 100).toFixed(1)}%. ` +
    `Inputs: trend ${f.trend}, momentum ${f.momentum}, funding ${f.fundingBias}, ` +
    `flow ${f.flowBias}, divergence ${f.divergenceBias} (Δ${divEdge} from neutral). ` +
    `Driver: ${driver}.`;

  return { conviction, sizeBps, rationale, driver };
}

/**
 * Monotone position-size (bps) from a 0..1000 conviction — the `pdFromScore`
 * mapping, re-centred on 500 = flat. Distance from flat scales size linearly:
 *   conviction 500 -> 0 bps, conviction 1000 (or 0) -> 10000 bps.
 * Sign of the edge is decided downstream by `decideTrade`; this is magnitude only.
 */
export const sizeFromConviction = (conviction: number): number =>
  Math.round(10000 * (Math.abs(clamp(conviction, CONVICTION_MIN, CONVICTION_MAX) - CONVICTION_FLAT) / CONVICTION_FLAT));

/**
 * Blend a bounded advisory (adjustment -50..50, confidence 0..1) into a deterministic
 * conviction score (pure, tested). Used for the OPTIONAL LLM rationale (llmAdvisory)
 * AND every key-gated CMC adapter: a non-zero advisory genuinely moves the conviction,
 * while an offline no-op ({0,0}) returns the score unchanged so seeds / tests / the
 * backtest stay reproducible. PORTED VERBATIM from Stoic's `blendScore`.
 */
export function blendScore(pdScore: number, adjustment: number, confidence: number): number {
  const adj = Math.max(-50, Math.min(50, Math.round(adjustment)));
  const conf = Math.max(0, Math.min(1, confidence));
  return Math.max(0, Math.min(1000, Math.round(pdScore + adj * conf)));
}

// ── entry-threshold band constants (single-sourced with the engine + SKILL.md) ──
export const ENTRY_THRESHOLD = 120;        // |conviction-500| must exceed this to take a trade
export const CALIBRATION_STEP = 10;        // entry-threshold nudge per resolved outcome
export const ENTRY_MIN = 60;
export const ENTRY_MAX = 220;

/**
 * Nudge the entry threshold from a RESOLVED backtest outcome (deterministic, bounded).
 *   - false NEGATIVE (a real move happened but we stayed flat / missed it) -> LOWER threshold
 *     (we become MORE willing to trade next time)
 *   - false POSITIVE (we traded into chop/whipsaw and it reverted)         -> RAISE threshold
 *     (we become LESS willing to trade next time)
 * One bounded parameter, updated from realised outcomes: an honest, auditable
 * calibration loop — not opaque ML, but the agent genuinely adapts its trade
 * selectivity to its own track record. PORTED from `calibrateAlarmThreshold`
 * (the bounded-nudge math is identical; the FN/FP semantics are recast for trading,
 * so the directions are inverted vs the credit-alarm version).
 */
export function calibrateEntryThreshold(
  current: number,
  outcome: { falseNegative?: boolean; falsePositive?: boolean }
): number {
  let t = current;
  if (outcome.falseNegative) t -= CALIBRATION_STEP; // missed a move -> loosen (trade more)
  if (outcome.falsePositive) t += CALIBRATION_STEP; // chop trade    -> tighten (trade less)
  return Math.max(ENTRY_MIN, Math.min(ENTRY_MAX, t));
}
