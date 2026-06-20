import { expect } from "chai";
import {
  tradeRationale,
  convictionNudge,
  hasLlmKey,
  type AdvisoryContext,
} from "../src/signal/llmAdvisory";
import type { ConvictionResult } from "../src/signal/core";

/**
 * ============================================================================
 *  src/signal/llmAdvisory.ts — OPTIONAL, no-op-safe LLM advisory layer  [M3]
 * ============================================================================
 *  The deterministic engine is the product. This layer is optional polish that
 *  FAILS SILENTLY BY DESIGN: with no ZAI_API_KEY (the default everywhere — tests,
 *  CI, the backtest), it makes NO network call and:
 *    - convictionNudge → the STRICT no-op { adjustment: 0, confidence: 0 }
 *      (blendScore treats that as a pass-through → conviction unchanged)
 *    - tradeRationale  → the deterministic engine's own rationale (prose fallback)
 *
 *  These tests pin that contract. They are pure / offline: we delete ZAI_API_KEY
 *  so the no-key branch is taken before any fetch. The assertions guarantee the
 *  backtest stays byte-reproducible regardless of whether a key is present.
 *  (Mirrors Stoic's discipline for the ported zai.ts wiring.)
 * ============================================================================
 */

// A representative bar context + deterministic conviction result (long-biased).
const CTX: AdvisoryContext = {
  symbol: "BTC",
  bar: 42,
  trend: 640,
  momentum: 580,
  fundingBias: 470,
  flowBias: 610,
  divergenceBias: 760,
};

const RESULT: ConvictionResult = {
  conviction: 712,
  sizeBps: 4240,
  rationale: "Stoic conviction 712/1000 (500=flat). Driver: strong divergence.",
  driver: "strong positioning/flow divergence → full-weight conviction",
};

describe("llmAdvisory — OPTIONAL, no-op-safe (no-network path)", function () {
  // Ensure NO key for every test in this block, restore afterwards so we never
  // leak env state into other suites.
  let savedKey: string | undefined;
  beforeEach(function () {
    savedKey = process.env.ZAI_API_KEY;
    delete process.env.ZAI_API_KEY;
  });
  afterEach(function () {
    if (savedKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = savedKey;
  });

  describe("hasLlmKey", function () {
    it("reports false when no key is configured", function () {
      expect(hasLlmKey()).to.equal(false);
    });
    it("reports false for a blank/whitespace key (still a no-op)", function () {
      process.env.ZAI_API_KEY = "   ";
      expect(hasLlmKey()).to.equal(false);
    });
  });

  describe("convictionNudge — strict {0,0} no-op offline", function () {
    it("returns exactly { adjustment: 0, confidence: 0 } with no key", async function () {
      const adv = await convictionNudge(CTX, RESULT);
      expect(adv).to.deep.equal({ adjustment: 0, confidence: 0 });
    });

    it("the {0,0} no-op leaves a blendScore conviction UNCHANGED (pass-through)", async function () {
      // This is the load-bearing guarantee: the offline nudge cannot move the number.
      const { blendScore } = await import("../src/signal/core");
      const adv = await convictionNudge(CTX, RESULT);
      expect(blendScore(RESULT.conviction, adv.adjustment, adv.confidence)).to.equal(
        RESULT.conviction
      );
    });

    it("is deterministic offline (same input → same {0,0})", async function () {
      const a = await convictionNudge(CTX, RESULT);
      const b = await convictionNudge(CTX, RESULT);
      expect(a).to.deep.equal(b);
    });

    it("does not throw and stays a no-op for a flat / neutral bar", async function () {
      const flatCtx: AdvisoryContext = {
        trend: 500,
        momentum: 500,
        fundingBias: 500,
        flowBias: 500,
        divergenceBias: 500,
      };
      const flatRes: ConvictionResult = {
        conviction: 500,
        sizeBps: 0,
        rationale: "flat",
        driver: "no actionable divergence (dead-band) → flatten toward neutral",
      };
      const adv = await convictionNudge(flatCtx, flatRes);
      expect(adv).to.deep.equal({ adjustment: 0, confidence: 0 });
    });
  });

  describe("tradeRationale — deterministic prose fallback offline", function () {
    it("returns the engine's own rationale verbatim with no key (no network)", async function () {
      const text = await tradeRationale(CTX, RESULT);
      expect(text).to.equal(RESULT.rationale);
    });

    it("is deterministic offline (same input → same prose)", async function () {
      const a = await tradeRationale(CTX, RESULT);
      const b = await tradeRationale(CTX, RESULT);
      expect(a).to.equal(b);
    });
  });
});
