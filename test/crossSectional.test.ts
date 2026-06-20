import { expect } from "chai";
import {
  crossSectionalDislocation,
  dislocationToBias,
  PanelToken,
  CROSS_MIN_TOKENS,
  CROSS_DISLOCATION_DEADBAND,
  CROSS_FULL_DISLOCATION,
} from "../src/signal/crossSectional";
import { divergenceSignal } from "../src/signal/divergence";
import { Bar } from "../src/data/binance";

/**
 * ============================================================================
 *  src/signal/crossSectional.ts — the NET-NEW cross-sectional dislocation
 *  differentiator (Originality gap 4)
 * ============================================================================
 *  Covers: panel-axis demean/standardise correctness, the "no cross-section ->
 *  no edge" honesty floor, the contrarian dislocationToBias map (BVA at the
 *  exported thresholds), determinism, AND — the load-bearing one — a DEDICATED
 *  LOOK-AHEAD-INVARIANCE suite asserting that appending / truncating / mutating
 *  FUTURE bars (in ANY panel token) cannot change any PAST cross-sectional
 *  dislocation. This is the property that keeps the differentiator honest.
 * ============================================================================
 */

// ── synthetic, bar-for-bar-aligned panel (CLEARLY synthetic; not market data) ──
// Distinct, finite OHLCV + flow legs per token per bar so the per-token z-scores
// and the cross-sectional demean are well-defined. Arbitrary test fixtures.
function synthBars(n: number, seed: number): Bar[] {
  const bars: Bar[] = [];
  let close = 100 + seed * 7;
  for (let i = 0; i < n; i++) {
    const w = Math.sin((i + seed) * 0.7) * 2 + Math.cos((i + seed) * 0.31);
    close = Math.max(1, close + w);
    bars.push({
      t: 1_700_000_000_000 + i * 3_600_000, // SAME grid across tokens (aligned)
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
      funding: 0.0001 * Math.sin((i + seed) * 0.5),
      longShortRatio: 1 + 0.1 * Math.sin((i + seed) * 0.9),
      takerBuySellRatio: 1 + 0.1 * Math.cos((i + seed) * 0.6),
      openInterest: 1e6 + i * 100,
    });
  }
  return bars;
}

function synthPanel(n: number): PanelToken[] {
  return [
    { symbol: "AAA", bars: synthBars(n, 1) },
    { symbol: "BBB", bars: synthBars(n, 2) },
    { symbol: "CCC", bars: synthBars(n, 3) },
  ];
}

describe("crossSectional.crossSectionalDislocation — panel-axis demean (look-ahead-safe)", function () {
  it("exported constants are as documented", function () {
    expect(CROSS_MIN_TOKENS).to.equal(2);
    expect(CROSS_DISLOCATION_DEADBAND).to.equal(0.75);
    expect(CROSS_FULL_DISLOCATION).to.equal(2.0);
  });

  it("returns one record per bar for every panel token (index-aligned)", function () {
    const panel = synthPanel(120);
    const out = crossSectionalDislocation(panel);
    for (const p of panel) {
      expect(out[p.symbol]).to.be.an("array");
      expect(out[p.symbol].length).to.equal(p.bars.length);
    }
  });

  it("dislocation is the panel-DEMEANED, panel-standardised divergence (idiosyncratic residual)", function () {
    const panel = synthPanel(120);
    const out = crossSectionalDislocation(panel);
    // pick a bar where all three tokens are defined (warming is over after the z-window)
    const i = 110;
    const symbols = panel.map((p) => p.symbol);
    const recs = symbols.map((s) => out[s][i]);
    // all three should share the SAME cross-sectional mean + std + token count at this bar
    const mean0 = recs[0].panelMean;
    const std0 = recs[0].panelStd;
    recs.forEach((r) => {
      expect(r.panelMean).to.be.closeTo(mean0, 1e-12);
      expect(r.panelStd).to.be.closeTo(std0, 1e-12);
      expect(r.tokensInCross).to.equal(recs[0].tokensInCross);
    });
    // for each defined token, dislocation == (own − mean) / std
    recs.forEach((r) => {
      if (r.tokensInCross >= CROSS_MIN_TOKENS && std0 > 1e-12 && isFinite(r.ownDivergence)) {
        expect(r.dislocation).to.be.closeTo((r.ownDivergence - mean0) / std0, 1e-9);
      }
    });
    // the cross-sectional dislocations across the panel sum to ~0 (demeaned property)
    const sum = recs.reduce((a, r) => a + r.dislocation, 0);
    expect(sum).to.be.closeTo(0, 1e-9);
  });

  it("fewer than CROSS_MIN_TOKENS defined → no cross-section → dislocation 0 (no fabricated edge)", function () {
    // single-token panel: there is never a cross-section → every dislocation must be 0
    const solo: PanelToken[] = [{ symbol: "AAA", bars: synthBars(120, 1) }];
    const out = crossSectionalDislocation(solo);
    out["AAA"].forEach((r) => {
      expect(r.dislocation).to.equal(0);
      expect(r.isPanelOutlier).to.equal(false);
      expect(r.tokensInCross).to.be.at.most(1);
    });
  });

  it("warming bars (insufficient per-token history) contribute nothing to the cross-section", function () {
    const panel = synthPanel(40);
    const out = crossSectionalDislocation(panel);
    // early bars are warming for every token → no cross-section → dislocation 0
    for (const p of panel) {
      expect(out[p.symbol][0].dislocation).to.equal(0);
      expect(out[p.symbol][0].tokensInCross).to.equal(0);
    }
  });

  it("at most ONE token per bar is flagged the panel outlier (the most dislocated)", function () {
    const panel = synthPanel(160);
    const out = crossSectionalDislocation(panel);
    const n = panel[0].bars.length;
    for (let i = 0; i < n; i++) {
      const flags = panel.filter((p) => out[p.symbol][i].isPanelOutlier).length;
      expect(flags).to.be.at.most(1);
    }
  });

  it("the panel outlier (when flagged) has the largest |dislocation| and clears the dead-band", function () {
    const panel = synthPanel(160);
    const out = crossSectionalDislocation(panel);
    const n = panel[0].bars.length;
    for (let i = 0; i < n; i++) {
      const recs = panel.map((p) => out[p.symbol][i]);
      const outlier = recs.find((r) => r.isPanelOutlier);
      if (outlier) {
        const maxAbs = Math.max(...recs.map((r) => Math.abs(r.dislocation)));
        expect(Math.abs(outlier.dislocation)).to.be.closeTo(maxAbs, 1e-12);
        expect(Math.abs(outlier.dislocation)).to.be.at.least(CROSS_DISLOCATION_DEADBAND);
      }
    }
  });

  it("is deterministic (identical panel → identical dislocation series)", function () {
    const a = crossSectionalDislocation(synthPanel(100));
    const b = crossSectionalDislocation(synthPanel(100));
    expect(a).to.deep.equal(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  DEDICATED LOOK-AHEAD-INVARIANCE SUITE — the load-bearing originality property
// ════════════════════════════════════════════════════════════════════════════
describe("LOOK-AHEAD INVARIANCE — future bars (any panel token) cannot change a PAST dislocation", function () {
  it("prefix equality: dislocation[0..k] is identical whether or not bars > k exist", function () {
    const full = synthPanel(150);
    const outFull = crossSectionalDislocation(full);
    for (const k of [40, 90, 130]) {
      const truncated: PanelToken[] = full.map((p) => ({ symbol: p.symbol, bars: p.bars.slice(0, k + 1) }));
      const outTrunc = crossSectionalDislocation(truncated);
      for (const p of full) {
        for (let i = 0; i <= k; i++) {
          expect(outTrunc[p.symbol][i].dislocation).to.equal(
            outFull[p.symbol][i].dislocation,
            `${p.symbol} dislocation[${i}] changed when bars > ${k} were truncated`
          );
          expect(outTrunc[p.symbol][i].isPanelOutlier).to.equal(
            outFull[p.symbol][i].isPanelOutlier,
            `${p.symbol} isPanelOutlier[${i}] changed when bars > ${k} were truncated`
          );
        }
      }
    }
  });

  it("appending wild FUTURE bars (in every token) does not alter any earlier dislocation", function () {
    const base = synthPanel(80);
    const outBase = crossSectionalDislocation(base);
    const extended: PanelToken[] = base.map((p, k) => ({
      symbol: p.symbol,
      bars: [
        ...p.bars,
        // wild future bars on the SAME grid, distinct per token
        { t: 1_700_000_000_000 + 80 * 3_600_000, open: 1, high: 9999, low: 0.1, close: 9999 - k * 100, volume: 1, funding: 0.05, longShortRatio: 9, takerBuySellRatio: 9, openInterest: 9e9 },
        { t: 1_700_000_000_000 + 81 * 3_600_000, open: 1, high: 9999, low: 0.1, close: 0.5 + k, volume: 1, funding: -0.05, longShortRatio: 0.1, takerBuySellRatio: 0.1, openInterest: 1 },
      ],
    }));
    const outExt = crossSectionalDislocation(extended);
    for (const p of base) {
      for (let i = 0; i < p.bars.length; i++) {
        expect(outExt[p.symbol][i].dislocation).to.equal(
          outBase[p.symbol][i].dislocation,
          `${p.symbol} dislocation[${i}] changed after appending future bars`
        );
      }
    }
  });

  it("mutating the LAST bar of ONE token leaves ALL past dislocations of EVERY token untouched", function () {
    const base = synthPanel(100);
    const outBefore = crossSectionalDislocation(base);
    // mutate only the final bar of the first token, drastically
    const mutated: PanelToken[] = base.map((p, k) =>
      k === 0
        ? {
            symbol: p.symbol,
            bars: p.bars.map((b, i) =>
              i === p.bars.length - 1
                ? { ...b, close: b.close * 100, funding: 0.09, longShortRatio: 12, takerBuySellRatio: 12 }
                : b
            ),
          }
        : p
    );
    const outAfter = crossSectionalDislocation(mutated);
    for (const p of base) {
      for (let i = 0; i < p.bars.length - 1; i++) {
        expect(outAfter[p.symbol][i].dislocation).to.equal(
          outBefore[p.symbol][i].dislocation,
          `${p.symbol} dislocation[${i}] reacted to a future-bar mutation in another token`
        );
      }
    }
  });

  it("the cross-sectional dislocation never reads a future per-token divergence", function () {
    // sanity: the per-token divergence at i is itself look-ahead-safe; the cross-section at i
    // only reads divergence[i] across tokens. Compose the two and assert prefix equality holds
    // even when the per-token series are recomputed on truncated bars.
    const full = synthPanel(120);
    const k = 70;
    const truncated: PanelToken[] = full.map((p) => ({ symbol: p.symbol, bars: p.bars.slice(0, k + 1) }));
    // per-token divergence at i must match between full and truncated (already pinned in
    // divergence.test.ts) — re-assert here at the composition boundary for clarity.
    for (const p of full) {
      const dFull = divergenceSignal(p.bars);
      const dTrunc = divergenceSignal(p.bars.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(dTrunc[i].divergence).to.equal(dFull[i].divergence, `${p.symbol} per-token divergence[${i}] changed on truncation`);
      }
    }
    // and therefore the cross-section composed from them is unchanged too
    const outFull = crossSectionalDislocation(full);
    const outTrunc = crossSectionalDislocation(truncated);
    for (const p of full) {
      for (let i = 0; i <= k; i++) {
        expect(outTrunc[p.symbol][i].dislocation).to.equal(outFull[p.symbol][i].dislocation);
      }
    }
  });
});

describe("crossSectional.dislocationToBias — signed dislocation → 0..1000 (contrarian, BVA)", function () {
  const FLAT = 500;
  it("|dislocation| just below the dead-band → exactly 500 (no edge)", function () {
    expect(dislocationToBias(CROSS_DISLOCATION_DEADBAND - 0.001)).to.equal(FLAT);
    expect(dislocationToBias(-(CROSS_DISLOCATION_DEADBAND - 0.001))).to.equal(FLAT);
  });
  it("exactly at the dead-band edge → still 500 (strict <)", function () {
    expect(dislocationToBias(CROSS_DISLOCATION_DEADBAND)).to.equal(FLAT);
  });
  it("CONTRARIAN: POSITIVE dislocation → bias BELOW 500 (fade the over-positioned outlier → SHORT)", function () {
    expect(dislocationToBias(1.2)).to.be.lessThan(FLAT);
  });
  it("CONTRARIAN: NEGATIVE dislocation → bias ABOVE 500 (LONG the under-positioned outlier)", function () {
    expect(dislocationToBias(-1.2)).to.be.greaterThan(FLAT);
  });
  it("saturates: |dislocation| ≥ CROSS_FULL_DISLOCATION → pinned to 0 / 1000", function () {
    expect(dislocationToBias(CROSS_FULL_DISLOCATION + 3)).to.equal(0);
    expect(dislocationToBias(-(CROSS_FULL_DISLOCATION + 3))).to.equal(1000);
  });
  it("monotonic in magnitude: larger |dislocation| → further from 500", function () {
    const a = Math.abs(dislocationToBias(1.0) - FLAT);
    const b = Math.abs(dislocationToBias(1.7) - FLAT);
    expect(b).to.be.greaterThan(a);
  });
  it("non-finite dislocation → neutral 500 (defensive)", function () {
    expect(dislocationToBias(NaN)).to.equal(FLAT);
  });
  it("output is always an integer within [0,1000]", function () {
    for (const d of [-3, -1.5, -1, -0.8, -0.7, 0, 0.7, 0.8, 1, 1.5, 3]) {
      const v = dislocationToBias(d);
      expect(v).to.be.within(0, 1000);
      expect(Number.isInteger(v)).to.equal(true);
    }
  });
});
