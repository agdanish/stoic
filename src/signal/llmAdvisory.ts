/**
 * Stoic — OPTIONAL LLM advisory layer.  [M3]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  THE DETERMINISTIC ENGINE IS THE PRODUCT. THIS FILE IS OPTIONAL POLISH.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The conviction call is produced *entirely* by the deterministic core
 * (src/signal/divergence.ts + src/signal/core.ts + signalEngine.scoreConviction).
 * That is what the SKILL emits and the backtester walks, and it is fully
 * reproducible (no Date / no random / no IO). This module adds, AS A NO-OP-SAFE
 * EXTRA, two things a human reviewer likes to see:
 *
 *   1. `tradeRationale(...)`  → a short, human-readable sentence or two explaining
 *      the CURRENT conviction. Pure prose; never changes the number. Falls back to
 *      the deterministic engine's own `rationale` string when there is no key / on
 *      any error.
 *
 *   2. `convictionNudge(...)` → a BOUNDED `{ adjustment, confidence }` advisory of
 *      exactly the same shape every CMC adapter emits (src/data/cmc.Advisory), so it
 *      folds through `core.blendScore` like any other advisory. With NO key, or on
 *      ANY error/parse failure, it returns the strict no-op `{ adjustment: 0,
 *      confidence: 0 }` — which `blendScore` treats as a pass-through, leaving the
 *      conviction (and therefore the backtest) byte-identical.
 *
 * Because the no-op path is the DEFAULT and FAILS SILENTLY BY DESIGN, offline runs,
 * unit tests, and the backtest never depend on the network or on the LLM. Removing
 * this file changes nothing about the deterministic result; wiring in a key only
 * adds prose + a small, bounded nudge that can never dominate the engine.
 *
 * WIRING (ported VERBATIM from Stoic's agent/zai.ts):
 *   - OpenAI-compatible Chat Completions endpoint.
 *   - temperature 0, top_p 1, fixed seed 42, pinned model id → reproducible output.
 *   - `response_format: { type: "json_object" }` for the bounded nudge so we can
 *     parse strict JSON.
 *   - env: ZAI_API_KEY (gate — absent ⇒ no-op), ZAI_BASE_URL (override), ZAI_MODEL
 *     (default `glm-4.5-flash`).
 *
 * The two prompts below are the ONLY domain change vs zai.ts: recast from RWA credit
 * underwriting to crypto trading conviction.
 */

import type { ConvictionResult } from "./core";
import type { Advisory } from "../data/cmc";
import { NO_ADVICE } from "../data/cmc";

const SEED = 42;

/** True when an LLM key is configured. Otherwise every entry here is a strict no-op. */
export function hasLlmKey(): boolean {
  return !!(process.env.ZAI_API_KEY && process.env.ZAI_API_KEY.trim());
}

/**
 * The minimal, look-ahead-safe snapshot of the current bar handed to the LLM. These are
 * the SAME 0..1000 bullish feature reads the deterministic engine already scored for this
 * bar (500 = neutral / no edge) plus the engine's own conviction output — nothing from a
 * future bar. The LLM only ever sees information the deterministic call already used.
 */
export interface AdvisoryContext {
  symbol?: string;        // e.g. "BTC" (provenance only)
  bar?: number;           // bar index (provenance only)
  trend: number;          // 0..1000  price-trend read (bullish)
  momentum: number;       // 0..1000  RSI/MACD momentum (bullish)
  fundingBias: number;    // 0..1000  derivatives funding read (500 = neutral)
  flowBias: number;       // 0..1000  taker buy/sell + volume flow (bullish)
  divergenceBias: number; // 0..1000  NET-NEW regime-gated divergence term (500 = no edge)
}

// ════════════════════════════════════════════════════════════════════════════
//  (1) tradeRationale — human-readable prose ONLY (never moves the number)
// ════════════════════════════════════════════════════════════════════════════

const RATIONALE_SYSTEM =
  "You are a senior crypto derivatives strategist at Stoic. Given one bar's " +
  "feature reads (each 0-1000, 500 = neutral) and the model's conviction (0-1000, " +
  "500 = flat, >500 = long bias, <500 = short bias), write a concise 2-3 sentence " +
  "rationale for the CURRENT conviction. Name the dominant driver explicitly (e.g. " +
  "positioning/flow divergence, funding, momentum, trend). Be decisive and specific. " +
  "Do not restate every number, do not give price targets, and do not change the call — " +
  "you are only explaining it.";

/**
 * Short human-readable rationale for the current conviction. PROSE ONLY — this never
 * changes the deterministic conviction. With no key, or on any error, it returns the
 * deterministic engine's own `result.rationale` so the agent always has a sensible memo
 * offline. (Ported VERBATIM from zai.ts `creditMemo`; only the prompt + payload changed.)
 */
export async function tradeRationale(
  ctx: AdvisoryContext,
  result: ConvictionResult
): Promise<string> {
  const key = process.env.ZAI_API_KEY;
  if (!key) return result.rationale; // deterministic offline fallback (prose stays sensible)

  // Read endpoint config at call time so .env overrides reliably apply.
  const base = process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4";
  const model = process.env.ZAI_MODEL || "glm-4.5-flash";

  const user = JSON.stringify({
    symbol: ctx.symbol,
    bar: ctx.bar,
    features: {
      trend: ctx.trend,
      momentum: ctx.momentum,
      fundingBias: ctx.fundingBias,
      flowBias: ctx.flowBias,
      divergenceBias: ctx.divergenceBias,
    },
    conviction: result.conviction,
    sizeBps: result.sizeBps,
    driver: result.driver,
  });

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        top_p: 1,
        seed: SEED,
        messages: [
          { role: "system", content: RATIONALE_SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res || !(res as any).ok) return result.rationale;
    const j: any = await res.json();
    const text: string | undefined = j?.choices?.[0]?.message?.content;
    return text ? text.trim() : result.rationale;
  } catch {
    return result.rationale; // network/API failure -> deterministic fallback
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  (2) convictionNudge — a BOUNDED {adjustment, confidence} advisory (no-op-safe)
// ════════════════════════════════════════════════════════════════════════════

const NUDGE_SYSTEM =
  "You are a senior crypto derivatives strategist at Stoic. Given one bar's " +
  "feature reads (each 0-1000, 500 = neutral) and a deterministic conviction score " +
  "(0-1000, higher = more long-biased), decide whether soft/qualitative factors justify " +
  "a SMALL adjustment to that conviction. Respond ONLY with strict JSON: " +
  '{"adjustment": <integer between -50 and 50, negative = more bearish>, "confidence": ' +
  "<number 0..1>}. Keep |adjustment| small — the deterministic model already captures " +
  "the positioning/flow divergence edge and the regime gate; you are only nudging.";

/**
 * A BOUNDED `{ adjustment, confidence }` nudge to the deterministic conviction, returned in
 * exactly the `src/data/cmc.Advisory` shape so the engine folds it through `core.blendScore`
 * alongside every CMC advisory. With NO key, or on ANY error / parse failure, returns the
 * STRICT NO-OP `{ adjustment: 0, confidence: 0 }` — `blendScore` treats that as a pass-through,
 * so the conviction (and the whole backtest) is byte-identical to the no-LLM run.
 *
 * This is the only path here that can move the number, and even then it is clamped by
 * `blendScore` to |adjustment| <= 50 and confidence in [0,1], so a single LLM call can shift
 * the conviction by at most 50 points out of 1000 — it can never override the engine.
 *
 * (Ported VERBATIM from zai.ts `scoreAdvisory`; only the prompt + payload changed. The
 * {0,0} no-op at every exit is the same fail-silent contract.)
 */
export async function convictionNudge(
  ctx: AdvisoryContext,
  result: ConvictionResult
): Promise<Advisory> {
  const key = process.env.ZAI_API_KEY;
  if (!key) return { ...NO_ADVICE }; // deterministic offline no-op {0,0}

  const base = process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4";
  const model = process.env.ZAI_MODEL || "glm-4.5-flash";
  const user = JSON.stringify({
    symbol: ctx.symbol,
    bar: ctx.bar,
    features: {
      trend: ctx.trend,
      momentum: ctx.momentum,
      fundingBias: ctx.fundingBias,
      flowBias: ctx.flowBias,
      divergenceBias: ctx.divergenceBias,
    },
    conviction: result.conviction,
    driver: result.driver,
  });

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        top_p: 1,
        seed: SEED,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NUDGE_SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res || !(res as any).ok) return { ...NO_ADVICE };
    const j: any = await res.json();
    const text: string | undefined = j?.choices?.[0]?.message?.content;
    if (!text) return { ...NO_ADVICE };
    const parsed = JSON.parse(text);
    return {
      adjustment: Math.round(Number(parsed.adjustment) || 0),
      confidence: Number(parsed.confidence) || 0,
    };
  } catch {
    return { ...NO_ADVICE }; // any failure -> deterministic no-op {0,0}
  }
}
