/**
 * Stoic — Phase-1 in-sample parameter-search tests.  [gap 1]
 *
 * Pins the honesty guarantees of backtest/search.ts WITHOUT touching report.json or
 * report-fullcoverage.json:
 *
 *   (a) FAITHFUL — at DEFAULT knobs the search harness (runBacktestKnobs) reproduces
 *       engine.runBacktest BYTE-FOR-BYTE on the sliced bars, so the knobs are the ONLY
 *       thing that differs from the committed full-coverage run.
 *   (b) NO LOOK-AHEAD — truncating the sliced series at bar k leaves every knobbed trace
 *       row < k byte-identical, for the SELECTED (non-default) knobs too (the new dwell /
 *       regime-extremes / dead-band knobs act only on at-or-before info).
 *   (c) BYTE-REPRODUCIBLE — buildSearchReport serializes to the exact committed bytes.
 *   (d) IN-SAMPLE-ONLY SELECTION — the selected config is the in-sample-excess argmax, and
 *       it is computed WITHOUT consulting OOS (perturbing only the OOS tail cannot change
 *       which config is selected).
 *   (e) HONEST VERDICT — the committed verdict (edgeFound / beatsBuyHoldOOS) matches a
 *       freshly-recomputed strict B&H comparison on the held-out OOS; not asserted positive.
 *
 * Pure + offline: reads the committed fixtures + committed report-search.json; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import { loadAllFixtures, sliceToFullCoverage } from "../backtest/run";
import { runBacktest, DEFAULT_PARAMS, metricsFromTrace } from "../backtest/engine";
import {
  buildSearchReport,
  serializeSearchReport,
  runBacktestKnobs,
  segmentsForKnobs,
  DEFAULT_KNOBS,
  SEARCH_GRID,
  SEARCH_REPORT_PATH,
  SearchKnobs,
} from "../backtest/search";

function slicedBars(symbol: string) {
  const fx = loadAllFixtures().find((f) => f.symbol === symbol)!;
  return sliceToFullCoverage(fx).fixture!.bars;
}
const SYMS = loadAllFixtures().map((f) => f.symbol);

// ════════════════════════════════════════════════════════════════════════════
//  (a) FAITHFUL — default knobs == engine.runBacktest on the sliced bars
// ════════════════════════════════════════════════════════════════════════════
describe("search harness — faithful to engine.runBacktest at default knobs", () => {
  it("reproduces engine.runBacktest BYTE-FOR-BYTE on every sliced fixture (knobs are the only difference)", () => {
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const eng = runBacktest(bars, DEFAULT_PARAMS);
      const mine = runBacktestKnobs(bars, DEFAULT_KNOBS);
      expect(mine.trace, `${s} trace mismatch`).to.deep.equal(eng.trace);
      expect(mine.trades, `${s} trades mismatch`).to.deep.equal(eng.trades);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) NO LOOK-AHEAD — truncation invariance with the SELECTED (non-default) knobs
// ════════════════════════════════════════════════════════════════════════════
describe("search harness — look-ahead safety with dwell / regime / dead-band knobs", () => {
  const selected: SearchKnobs = buildSearchReport().selection.selectedKnobs;

  it("truncating the sliced series at bar k leaves every trace row < k byte-identical (selected knobs)", () => {
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const full = runBacktestKnobs(bars, selected);
      const k = Math.floor(bars.length * 0.6);
      const trunc = runBacktestKnobs(bars.slice(0, k + 1), selected);
      for (let i = 0; i < k; i++) {
        expect(trunc.trace[i].side).to.equal(full.trace[i].side, `${s} side[${i}] changed under truncation`);
        expect(trunc.trace[i].equity).to.equal(full.trace[i].equity, `${s} equity[${i}] changed under truncation`);
        expect(trunc.trace[i].conviction).to.equal(full.trace[i].conviction, `${s} conviction[${i}] changed under truncation`);
      }
    }
  });

  it("holds for a dwell+regime+wide-deadband combo too (every new knob is look-ahead-safe)", () => {
    const knobs: SearchKnobs = { deadbandZ: 1.0, entryThreshold: 300, minDwell: 12, regimeExtremesOnly: true };
    for (const s of SYMS) {
      const bars = slicedBars(s);
      const full = runBacktestKnobs(bars, knobs);
      const k = Math.floor(bars.length * 0.5);
      const trunc = runBacktestKnobs(bars.slice(0, k + 1), knobs);
      for (let i = 0; i < k; i++) {
        expect(trunc.trace[i].side).to.equal(full.trace[i].side, `${s} side[${i}] changed under truncation`);
        expect(trunc.trace[i].equity).to.equal(full.trace[i].equity, `${s} equity[${i}] changed under truncation`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) BYTE-REPRODUCIBLE — committed report-search.json regenerates exactly
// ════════════════════════════════════════════════════════════════════════════
describe("search report — byte-reproducible from fixed fixtures", () => {
  it("buildSearchReport serializes deterministically (same input → byte-identical)", () => {
    expect(serializeSearchReport(buildSearchReport())).to.equal(serializeSearchReport(buildSearchReport()));
  });

  it("matches the committed backtest/report-search.json byte-for-byte (run `ts-node backtest/search.ts` if this fails)", () => {
    expect(fs.existsSync(SEARCH_REPORT_PATH), "report-search.json missing — run `ts-node backtest/search.ts`").to.equal(true);
    const committed = fs.readFileSync(SEARCH_REPORT_PATH, "utf8");
    expect(serializeSearchReport(buildSearchReport())).to.equal(committed);
  });

  it("carries NO wall-clock field (stays diff-stable)", () => {
    const json = JSON.stringify(buildSearchReport());
    expect(json).to.not.contain("generatedAt");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) IN-SAMPLE-ONLY SELECTION — OOS is never an input to the choice
// ════════════════════════════════════════════════════════════════════════════
describe("search — selection is in-sample only (OOS never consulted)", () => {
  const report = buildSearchReport();

  it("the selected config is the argmax of in-sample excess-over-B&H in the disclosed table", () => {
    const maxExcess = Math.max(...report.inSampleTable.map((c) => c.inSampleExcessOverBH));
    const sel = report.inSampleTable.find((c) => c.name === report.selection.selectedConfig)!;
    expect(sel.inSampleExcessOverBH).to.be.closeTo(maxExcess, 1e-9);
    expect(report.selection.inSampleExcessOverBH).to.be.closeTo(sel.inSampleExcessOverBH, 1e-12);
  });

  it("perturbing ONLY the held-out OOS tail does not change the in-sample selection metric", () => {
    // The in-sample aggregate of a config must be invariant to mutations confined to the
    // OOS tail — i.e. selection genuinely cannot see OOS. We verify the in-sample segment
    // metrics are unchanged when the trailing 30% of bars are mutated.
    for (const { knobs } of SEARCH_GRID) {
      for (const s of SYMS) {
        const bars = slicedBars(s);
        const n = bars.length;
        const splitBar = Math.floor(n * 0.7);
        const mutated = bars.map((b, i) =>
          i >= splitBar ? { ...b, close: b.close * 1.5, funding: 0.01, longShortRatio: 5, takerBuySellRatio: 5 } : b
        );
        const segA = segmentsForKnobs(bars, knobs).inSample;
        const segB = segmentsForKnobs(mutated, knobs).inSample;
        expect(segB.totalReturn, `${s} in-sample reacted to an OOS-tail mutation`).to.equal(segA.totalReturn);
        expect(segB.tradeCount).to.equal(segA.tradeCount);
      }
    }
  });

  it("discloses ALL configs evaluated (no hiding the ones that did not win)", () => {
    expect(report.inSampleTable.map((c) => c.name)).to.deep.equal(SEARCH_GRID.map((c) => c.name));
    expect(report.searchGrid.count).to.equal(SEARCH_GRID.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (e) HONEST VERDICT — committed verdict matches a fresh strict B&H comparison
// ════════════════════════════════════════════════════════════════════════════
describe("search — held-out verdict reported as-is (not faked, not asserted positive)", () => {
  const report = buildSearchReport();

  it("EVERY token has held-out OOS metrics for the selected config (present + finite)", () => {
    expect(report.heldOut.selected.perToken.length).to.equal(SYMS.length);
    for (const p of report.heldOut.selected.perToken) {
      for (const key of ["totalReturn", "winRate", "maxDrawdown", "sharpe", "sortino", "buyAndHoldReturn"] as const) {
        expect(isFinite(p.outOfSample[key]), `${p.symbol}.outOfSample.${key} not finite`).to.equal(true);
      }
    }
  });

  it("the committed edgeFound / beatsBuyHoldOOS verdict equals a fresh strict B&H comparison on OOS", () => {
    const sel = report.heldOut.selected;
    const aggBeat = sel.aggregate.outOfSample.totalReturn > sel.aggregate.outOfSample.buyAndHoldReturn;
    const anyTokenBeat = sel.perToken.some((p) => p.outOfSample.totalReturn > p.outOfSample.buyAndHoldReturn);
    const expected = aggBeat || anyTokenBeat;
    expect(report.verdict.gateG1Met).to.equal(expected);
    expect(report.verdict.edgeFound).to.equal(expected);
    expect(report.verdict.beatsBuyHoldOOS).to.equal(expected);
    // (Intentionally NO expect(expected).to.be.true — the result is reported as-is.)
  });

  it("includes a 15+15 bps cost-bump stress on the selected config (Rule 3.4)", () => {
    expect(report.stress15bps.name).to.equal(report.selection.selectedConfig);
    expect(isFinite(report.stress15bps.aggregate.outOfSample.totalReturn)).to.equal(true);
  });

  it("the frozen default-window report.json is NOT touched by the search path", () => {
    // search.ts only writes report-search.json; rebuilding the search must not depend on or
    // alter report.json. We assert the search report path is distinct.
    expect(SEARCH_REPORT_PATH.endsWith("report-search.json")).to.equal(true);
  });
});
