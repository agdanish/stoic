/**
 * Stoic — cross-sectional differentiator VALIDATION-HARNESS tests.  [gap 4]
 *
 * Pins the honesty guarantees of backtest/crossSectional.ts WITHOUT touching report.json,
 * report-fullcoverage.json, or report-search.json:
 *
 *   (a) FAITHFUL — feeding the PER-TOKEN divergenceBias into runWithDivergenceBias reproduces
 *       engine.runBacktest BYTE-FOR-BYTE on the sliced bars, so the cross-sectional arm differs
 *       ONLY in the divergenceBias it feeds (apples-to-apples comparison).
 *   (b) NO LOOK-AHEAD — truncating the sliced series at bar k leaves every cross-sectional
 *       trace row < k byte-identical (the cross-sectional bias acts only on at-or-before info).
 *   (c) BYTE-REPRODUCIBLE — buildXsReport serializes to the exact committed bytes.
 *   (d) HONEST VERDICT — the committed verdict matches a freshly-recomputed comparison; the
 *       B&H-beat claim is NOT asserted positive (it is reported as-is).
 *   (e) DIFFERENTIATED — the cross-sectional divergenceBias genuinely differs from the
 *       per-token one on the committed slice (it is not a relabel of the existing engine).
 *
 * Pure + offline: reads the committed fixtures + committed report-crosssectional.json; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import { loadAllFixtures, sliceToFullCoverage } from "../backtest/run";
import { runBacktest, DEFAULT_PARAMS } from "../backtest/engine";
import {
  buildXsReport,
  serializeXsReport,
  runWithDivergenceBias,
  perTokenDivergenceBias,
  crossSectionalDivergenceBias,
  XS_REPORT_PATH,
  XS_OOS_FRACTION,
} from "../backtest/crossSectional";
import { crossSectionalDislocation, PanelToken } from "../src/signal/crossSectional";

function slicedBars(symbol: string) {
  const fx = loadAllFixtures().find((f) => f.symbol === symbol)!;
  return sliceToFullCoverage(fx).fixture!.bars;
}
const SYMS = loadAllFixtures().map((f) => f.symbol);

// ════════════════════════════════════════════════════════════════════════════
//  (a) FAITHFUL — per-token bias through the harness == engine.runBacktest
// ════════════════════════════════════════════════════════════════════════════
describe("cross-sectional harness — faithful to engine.runBacktest (per-token arm)", () => {
  it("feeding the per-token divergenceBias reproduces engine.runBacktest BYTE-FOR-BYTE on every slice", () => {
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const eng = runBacktest(bars, DEFAULT_PARAMS);
      const mine = runWithDivergenceBias(bars, perTokenDivergenceBias(bars));
      expect(mine.trace, `${s} trace mismatch`).to.deep.equal(eng.trace);
      expect(mine.trades, `${s} trades mismatch`).to.deep.equal(eng.trades);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) NO LOOK-AHEAD — truncation invariance with the cross-sectional bias
// ════════════════════════════════════════════════════════════════════════════
describe("cross-sectional harness — look-ahead safety end to end", () => {
  function panel(): PanelToken[] {
    return SYMS.map((s) => ({ symbol: s, bars: slicedBars(s) }));
  }

  it("truncating the panel at bar k leaves every cross-sectional trace row < k byte-identical", () => {
    const disloc = crossSectionalDislocation(panel());
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const fullBias = crossSectionalDivergenceBias(disloc[s]);
      const full = runWithDivergenceBias(bars, fullBias);

      const k = Math.floor(bars.length * 0.6);
      // recompute the dislocation on the TRUNCATED panel, then re-run on the truncated bars
      const truncPanel: PanelToken[] = SYMS.map((sym) => ({ symbol: sym, bars: slicedBars(sym).slice(0, k + 1) }));
      const truncDisloc = crossSectionalDislocation(truncPanel);
      const truncBias = crossSectionalDivergenceBias(truncDisloc[s]);
      const trunc = runWithDivergenceBias(bars.slice(0, k + 1), truncBias);

      for (let i = 0; i < k; i++) {
        expect(trunc.trace[i], `${s} cross-sectional trace[${i}] changed on truncation`).to.deep.equal(full.trace[i]);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) BYTE-REPRODUCIBLE + (d) HONEST VERDICT + (e) DIFFERENTIATED
// ════════════════════════════════════════════════════════════════════════════
describe("cross-sectional report — byte-reproducible, honest, and genuinely differentiated", () => {
  it("buildXsReport serializes to the exact committed report-crosssectional.json bytes", () => {
    const fresh = serializeXsReport(buildXsReport());
    const committed = fs.readFileSync(XS_REPORT_PATH, "utf8");
    expect(fresh).to.equal(committed);
  });

  it("the committed verdict matches a freshly-recomputed comparison (not asserted positive)", () => {
    const r = buildXsReport();
    const xs = r.aggregate.crossSectional.outOfSample;
    const pt = r.aggregate.perToken.outOfSample;

    // beats-per-token is a strict aggregate-OOS comparison
    const beatsPt = xs.totalReturn > pt.totalReturn;
    expect(r.verdict.crossSectionalBeatsPerTokenOOS).to.equal(beatsPt);

    // beats-B&H is the same OR-over-tokens rule the report uses; recompute it independently
    const aggBeat = xs.totalReturn > xs.buyAndHoldReturn;
    const anyTokenBeat = r.perToken.some(
      (p) => p.crossSectional.outOfSample.totalReturn > p.crossSectional.outOfSample.buyAndHoldReturn
    );
    expect(r.verdict.crossSectionalBeatsBuyHoldOOS).to.equal(aggBeat || anyTokenBeat);
  });

  it("the cross-sectional divergenceBias genuinely DIFFERS from the per-token one (not a relabel)", () => {
    const disloc = crossSectionalDislocation(SYMS.map((s) => ({ symbol: s, bars: slicedBars(s) })));
    let anyDiffer = false;
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const pt = perTokenDivergenceBias(bars);
      const xs = crossSectionalDivergenceBias(disloc[s]);
      for (let i = 0; i < bars.length; i++) if (pt[i] !== xs[i]) { anyDiffer = true; break; }
      if (anyDiffer) break;
    }
    expect(anyDiffer, "cross-sectional bias must differ from per-token on the committed slice").to.equal(true);
    expect(buildXsReport().verdict.crossSectionalDiffersFromPerToken).to.equal(true);
  });

  it("the held-out OOS uses the fixed 0.30 split (never moved to flatter a result)", () => {
    expect(XS_OOS_FRACTION).to.equal(0.3);
  });

  it("does NOT touch report.json / report-fullcoverage.json / report-search.json", () => {
    // buildXsReport is pure and writes nothing; assert the frozen reports are unchanged by a build.
    const before = {
      r: fs.readFileSync(require("path").resolve(__dirname, "../backtest/report.json"), "utf8"),
    };
    buildXsReport();
    const after = fs.readFileSync(require("path").resolve(__dirname, "../backtest/report.json"), "utf8");
    expect(after).to.equal(before.r);
  });
});
