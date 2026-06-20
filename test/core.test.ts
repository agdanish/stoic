import { expect } from "chai";
import {
  scoreConvictionBase,
  sizeFromConviction,
  blendScore,
  calibrateEntryThreshold,
  CONVICTION_FLAT,
  CONVICTION_MIN,
  CONVICTION_MAX,
  ENTRY_THRESHOLD,
  CALIBRATION_STEP,
  ENTRY_MIN,
  ENTRY_MAX,
  REGIME_FLATTEN_BAND,
  STRONG_DIVERGENCE,
  type SignalFeatures,
} from "../src/signal/core";
import { decideTrade } from "../src/agent/decide";

/**
 * ============================================================================
 *  src/signal/core.ts + src/agent/decide.ts — deterministic conviction core
 * ============================================================================
 *  Ported (adapted) from Stoic's pdModel / blendScore / calibration tests.
 *  Keeps the original DISCIPLINE: determinism, monotonicity, BVA at branch
 *  boundaries, strict {0,0} no-op for the advisory blend. Recast for trading:
 *  conviction 0..1000 (500 = flat), size in bps, FN/FP calibration inverted,
 *  long/short/flat decision.
 *
 *  base = 1000·(0.20·trend + 0.20·mom + 0.15·funding + 0.15·flow + 0.30·div)   (norm 0..1)
 *  divEdge = |divergenceBias-500|
 *    divEdge<60          → flatten:  500 + 0.5·(base-500)
 *    60≤divEdge<200      → tempered: 500 + 0.85·(base-500)
 *    divEdge≥200         → full:     base
 *  sizeBps = round(10000·|conviction-500|/500)
 * ============================================================================
 */

// Feature builder: 0..1000 bullish scale; divergence defaults to a strong-edge value
// so the default case exercises the full-weight branch (override it per-test as needed).
const F = (o: any = {}): SignalFeatures => ({
  trend: o.trend ?? 500,
  momentum: o.momentum ?? 500,
  fundingBias: o.funding ?? 500,
  flowBias: o.flow ?? 500,
  divergenceBias: o.div ?? 0, // |0-500| = 500 → strong-divergence (full-weight) branch
  bar: o.bar ?? 0,
});

describe("core.scoreConvictionBase", function () {
  // ── M0: exported constants ────────────────────────────────────────────
  describe("M0 · exports", function () {
    it("scale + threshold constants are as documented", function () {
      expect(CONVICTION_FLAT).to.equal(500);
      expect(CONVICTION_MIN).to.equal(0);
      expect(CONVICTION_MAX).to.equal(1000);
      expect(ENTRY_THRESHOLD).to.equal(120);
      expect(REGIME_FLATTEN_BAND).to.equal(60);
      expect(STRONG_DIVERGENCE).to.equal(200);
    });
  });

  // ── M1: bounds ────────────────────────────────────────────────────────
  describe("M1 · bounds", function () {
    it("all-bearish (everything 0) → conviction 0, full size 10000", function () {
      const r = scoreConvictionBase(F({ trend: 0, momentum: 0, funding: 0, flow: 0, div: 0 }));
      expect(r.conviction).to.equal(0);
      expect(r.sizeBps).to.equal(10000);
    });
    it("all-bullish (everything 1000) → conviction 1000, full size 10000", function () {
      const r = scoreConvictionBase(F({ trend: 1000, momentum: 1000, funding: 1000, flow: 1000, div: 1000 }));
      expect(r.conviction).to.equal(1000);
      expect(r.sizeBps).to.equal(10000);
    });
    it("conviction ∈ [0,1000], size ∈ [0,10000] across a sweep", function () {
      for (const div of [0, 200, 300, 440, 500, 560, 700, 800, 1000]) {
        for (const trend of [0, 500, 1000]) {
          const r = scoreConvictionBase(F({ trend, momentum: trend, funding: trend, flow: trend, div }));
          expect(r.conviction).to.be.within(0, 1000);
          expect(r.sizeBps).to.be.within(0, 10000);
        }
      }
    });
  });

  // ── M2: dead-band flatten branch (BVA at REGIME_FLATTEN_BAND = ±60) ────
  describe("M2 · dead-band flatten override", function () {
    it("perfectly neutral (all 500, div 500) → flat conviction 500, size 0", function () {
      const r = scoreConvictionBase(F({ trend: 500, momentum: 500, funding: 500, flow: 500, div: 500 }));
      expect(r.conviction).to.equal(500);
      expect(r.sizeBps).to.equal(0);
      expect(r.driver).to.contain("dead-band");
    });
    it("BVA: div 559 (Δ59 < 60) → dead-band flatten branch", function () {
      const r = scoreConvictionBase(F({ div: 559 }));
      expect(r.driver).to.contain("dead-band");
    });
    it("BVA: div 560 (Δ60, not < 60) → leaves dead-band (tempered branch)", function () {
      const r = scoreConvictionBase(F({ div: 560 }));
      expect(r.driver).to.contain("moderate");
    });
    it("flatten pulls toward neutral but does NOT pin to exactly 500 when base ≠ 500", function () {
      // bullish features, div in dead-band → conviction between 500 and base
      const r = scoreConvictionBase(F({ trend: 1000, momentum: 1000, funding: 1000, flow: 1000, div: 500 }));
      expect(r.conviction).to.be.greaterThan(500);
      expect(r.driver).to.contain("dead-band");
    });
  });

  // ── M3: strong-divergence boundary (BVA at STRONG_DIVERGENCE = ±200) ───
  describe("M3 · strong-divergence boundary", function () {
    it("div 301 (Δ199 < 200) → tempered branch", function () {
      const r = scoreConvictionBase(F({ div: 301 }));
      expect(r.driver).to.contain("moderate");
    });
    it("div 300 (Δ200 ≥ 200) → full-weight branch", function () {
      const r = scoreConvictionBase(F({ div: 300 }));
      expect(r.driver).to.contain("full-weight");
    });
  });

  // ── M4: driver partitions (EP + boundary drivers) ─────────────────────
  describe("M4 · driver classification", function () {
    const cases: [number, string][] = [
      [500, "dead-band"], [559, "dead-band"],
      [560, "moderate"], [600, "moderate"], [699, "moderate"],
      [700, "full-weight"], [1000, "full-weight"], [0, "full-weight"],
    ];
    cases.forEach(([div, label]) =>
      it(`div ${div} → "${label}"`, function () {
        expect(scoreConvictionBase(F({ div })).driver).to.contain(label);
      })
    );
  });

  // ── M5: weight ordering (full-weight branch, div fixed strong) ────────
  describe("M5 · weights", function () {
    it("div(0.30) > trend(0.20) == momentum(0.20) > funding(0.15) == flow(0.15)", function () {
      // Isolate each weight: set one bullish feature to 1000, rest to neutral 500,
      // keep div at a strong-edge value (0) so the full-weight branch is active.
      const baseline = scoreConvictionBase(F({ div: 0 })).conviction; // all-neutral features
      const div = scoreConvictionBase(F({ div: 1000 })).conviction;   // div feature 1000 (but still strong edge by magnitude)
      const trend = scoreConvictionBase(F({ trend: 1000, div: 0 })).conviction;
      const mom = scoreConvictionBase(F({ momentum: 1000, div: 0 })).conviction;
      const funding = scoreConvictionBase(F({ funding: 1000, div: 0 })).conviction;
      const flow = scoreConvictionBase(F({ flow: 1000, div: 0 })).conviction;
      // div contributes the most relative to baseline; trend==momentum; funding==flow; trend>funding
      expect(div - baseline).to.be.greaterThan(trend - baseline);
      expect(trend).to.equal(mom);
      expect(funding).to.equal(flow);
      expect(trend - baseline).to.be.greaterThan(funding - baseline);
    });
  });

  // ── M6: size mapping (re-centred on 500 = flat) ───────────────────────
  describe("M6 · size mapping", function () {
    it("flat conviction 500 → size 0", function () {
      expect(sizeFromConviction(500)).to.equal(0);
    });
    it("extremes 0 and 1000 → full size 10000", function () {
      expect(sizeFromConviction(0)).to.equal(10000);
      expect(sizeFromConviction(1000)).to.equal(10000);
    });
    it("symmetric: 250 and 750 → 5000", function () {
      expect(sizeFromConviction(250)).to.equal(5000);
      expect(sizeFromConviction(750)).to.equal(5000);
    });
    it("size grows monotonically with distance from flat", function () {
      expect(sizeFromConviction(600)).to.be.greaterThan(sizeFromConviction(550));
      expect(sizeFromConviction(400)).to.be.greaterThan(sizeFromConviction(450));
    });
  });

  // ── M7: monotonicity & determinism ────────────────────────────────────
  describe("M7 · monotonicity & determinism", function () {
    it("more bullish flow → higher conviction (full-weight branch)", function () {
      const lo = scoreConvictionBase(F({ flow: 400, div: 0 })).conviction;
      const hi = scoreConvictionBase(F({ flow: 800, div: 0 })).conviction;
      expect(hi).to.be.greaterThan(lo);
    });
    it("identical input → identical output", function () {
      const o = { trend: 321, momentum: 654, funding: 222, flow: 765, div: 180 };
      const a = scoreConvictionBase(F(o)), b = scoreConvictionBase(F(o));
      expect(a.conviction).to.equal(b.conviction);
      expect(a.sizeBps).to.equal(b.sizeBps);
      expect(a.driver).to.equal(b.driver);
    });
  });
});

describe("core.blendScore — bounded advisory is load-bearing (verbatim port)", function () {
  it("offline no-op: a zero advisory leaves the score unchanged (reproducible)", function () {
    expect(blendScore(800, 0, 0)).to.equal(800);
    expect(blendScore(250, 0, 0)).to.equal(250);
  });
  it("a negative advisory lowers the conviction (advisor causally affects the call)", function () {
    expect(blendScore(310, -40, 0.5)).to.equal(290); // -40 * 0.5 = -20
  });
  it("a positive advisory raises it", function () {
    expect(blendScore(280, 40, 1)).to.equal(320);
  });
  it("clamps adjustment to [-50,50] and confidence to [0,1]", function () {
    expect(blendScore(500, -999, 5)).to.equal(450); // adj→-50, conf→1
    expect(blendScore(500, 999, -5)).to.equal(500); // conf→0 → no change
  });
  it("clamps the blended result to 0..1000", function () {
    expect(blendScore(10, -50, 1)).to.equal(0);
    expect(blendScore(990, 50, 1)).to.equal(1000); // 1040 → 1000
  });
});

describe("calibrateEntryThreshold — adaptive trade selectivity", function () {
  it("no change when the call was correct (no FP/FN)", function () {
    expect(calibrateEntryThreshold(ENTRY_THRESHOLD, {})).to.equal(ENTRY_THRESHOLD);
    expect(calibrateEntryThreshold(ENTRY_THRESHOLD, { falseNegative: false, falsePositive: false }))
      .to.equal(ENTRY_THRESHOLD);
  });

  it("false NEGATIVE (missed move) LOWERS the threshold (trade MORE)", function () {
    expect(calibrateEntryThreshold(ENTRY_THRESHOLD, { falseNegative: true }))
      .to.equal(ENTRY_THRESHOLD - CALIBRATION_STEP);
  });

  it("false POSITIVE (chop trade) RAISES the threshold (trade LESS)", function () {
    expect(calibrateEntryThreshold(ENTRY_THRESHOLD, { falsePositive: true }))
      .to.equal(ENTRY_THRESHOLD + CALIBRATION_STEP);
  });

  it("clamps to [ENTRY_MIN, ENTRY_MAX]", function () {
    let hi = ENTRY_MAX;
    for (let i = 0; i < 20; i++) hi = calibrateEntryThreshold(hi, { falsePositive: true });
    expect(hi).to.equal(ENTRY_MAX);
    let lo = ENTRY_MIN;
    for (let i = 0; i < 20; i++) lo = calibrateEntryThreshold(lo, { falseNegative: true });
    expect(lo).to.equal(ENTRY_MIN);
  });

  it("converges over a sequence of outcomes (learns from its record)", function () {
    let t = ENTRY_THRESHOLD;
    t = calibrateEntryThreshold(t, { falsePositive: true });
    t = calibrateEntryThreshold(t, { falsePositive: true });
    t = calibrateEntryThreshold(t, { falsePositive: true });
    expect(t).to.equal(ENTRY_THRESHOLD + 3 * CALIBRATION_STEP);
    t = calibrateEntryThreshold(t, { falseNegative: true }); // one missed move walks it back a step
    expect(t).to.equal(ENTRY_THRESHOLD + 2 * CALIBRATION_STEP);
  });

  it("is deterministic (same input → same output)", function () {
    const a = calibrateEntryThreshold(130, { falsePositive: true });
    const b = calibrateEntryThreshold(130, { falsePositive: true });
    expect(a).to.equal(b);
  });
});

describe("decideTrade — pure long/short/flat branch logic", function () {
  it("inside the threshold band → FLAT, size 0", function () {
    // |conviction-500| = 100 < ENTRY_THRESHOLD(120)
    const d = decideTrade(null, 600, 8000);
    expect(d.side).to.equal("flat");
    expect(d.sizeBps).to.equal(0);
    expect(d.flip).to.equal(false);
  });
  it("BVA: exactly at the threshold (Δ120) → FLAT (strict >)", function () {
    const d = decideTrade(null, 620, 5000);
    expect(d.side).to.equal("flat");
  });
  it("BVA: just past the threshold (Δ121) long → LONG with size", function () {
    const d = decideTrade(null, 621, 5000);
    expect(d.side).to.equal("long");
    expect(d.sizeBps).to.equal(5000);
  });
  it("conviction below flat by more than threshold → SHORT", function () {
    const d = decideTrade(null, 300, 4000);
    expect(d.side).to.equal("short");
    expect(d.sizeBps).to.equal(4000);
  });
  it("detects a directional flip long→short", function () {
    const d = decideTrade("long", 300, 4000);
    expect(d.side).to.equal("short");
    expect(d.flip).to.equal(true);
  });
  it("no flip when staying on the same side", function () {
    const d = decideTrade("long", 800, 6000);
    expect(d.side).to.equal("long");
    expect(d.flip).to.equal(false);
  });
  it("flat does not count as a flip", function () {
    const d = decideTrade("long", 540, 1000); // Δ40 < 120 → flat
    expect(d.side).to.equal("flat");
    expect(d.flip).to.equal(false);
  });
  it("respects a custom (calibrated) threshold", function () {
    // Δ100: flat at default 120, but a trade at a loosened 60 threshold
    expect(decideTrade(null, 600, 5000, 120).side).to.equal("flat");
    expect(decideTrade(null, 600, 5000, 60).side).to.equal("long");
  });
  it("is deterministic", function () {
    const a = decideTrade("short", 720, 4400);
    const b = decideTrade("short", 720, 4400);
    expect(a).to.deep.equal(b);
  });
});
