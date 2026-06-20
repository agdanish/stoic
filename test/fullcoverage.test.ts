/**
 * Stoic — FULL-COVERAGE backtest tests.  [gaps 1+5]
 *
 * The default report.json runs the full ~4-month window, but the futures flow legs
 * (longShortRatio / takerBuySellRatio / openInterest) are present on only ~17.4% of bars,
 * so on ~82% of bars the advertised two-leg positioning-vs-flow construct collapses to
 * z(funding)-z(momentum) — the MEASURED thing is narrower than the ADVERTISED thing.
 *
 * FULL_COVERAGE mode (backtest/run.ts:sliceToFullCoverage + buildFullCoverageReport)
 * slices each fixture to the contiguous tail where ALL THREE flow legs are present, so the
 * construct is non-degenerate on every bar. These tests pin the honesty guarantees of that
 * path WITHOUT touching report.json:
 *
 *   (a) COVERAGE — every flow leg is ~100% present on every sliced fixture, and BOTH legs
 *       (buildCrowdLeg, buildFlowLeg) are FINITE on every bar (the degeneracy fix).
 *   (b) BYTE-REPRODUCIBLE — buildFullCoverageReport over the fixed committed fixtures
 *       serializes to the exact bytes committed in backtest/report-fullcoverage.json.
 *   (c) ANTI-CHERRY-PICK — the slice is chosen by COVERAGE, not by result: the slice
 *       indices are independent of params, all tokens are disclosed, and the held-out OOS
 *       segment is present and well-formed (NOT asserted positive — honesty over a faked win).
 *   (d) NO LOOK-AHEAD — truncation invariance holds on the sliced series too.
 *   (e) ISOLATION — the default report.json bytes are unchanged by the full-coverage path.
 *
 * Pure + offline: reads the committed fixtures + committed report files; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import { loadBarsFixture, SYMBOLS, BarsFixture } from "../src/data/fetchHistory";
import { buildCrowdLeg, buildFlowLeg } from "../src/signal/divergence";
import { runBacktest, DEFAULT_PARAMS, BacktestParams } from "../backtest/engine";
import {
  buildReport,
  buildFullCoverageReport,
  sliceToFullCoverage,
  serializeReport,
  loadAllFixtures,
  REPORT_PATH,
  FULLCOV_REPORT_PATH,
  DEFAULT_OOS_FRACTION,
} from "../backtest/run";

const PARAMS: BacktestParams = DEFAULT_PARAMS;

// ════════════════════════════════════════════════════════════════════════════
//  (a) COVERAGE — the sliced fixtures are fully covered + both legs finite everywhere
// ════════════════════════════════════════════════════════════════════════════
describe("full-coverage slice — every flow leg present, both legs non-degenerate", () => {
  it("each sliced fixture has ~100% coverage on every flow leg (measured == advertised)", () => {
    for (const s of SYMBOLS) {
      const { fixture } = sliceToFullCoverage(loadBarsFixture(s));
      expect(fixture, `${s} produced no full-coverage slice`).to.not.equal(null);
      const f = fixture as BarsFixture;
      expect(f.bars.length, `${s} slice empty`).to.be.greaterThan(0);
      for (const key of ["longShortRatio", "takerBuySellRatio", "openInterest", "funding"] as const) {
        expect(f.coverage[key], `${s} ${key} coverage below 100%`).to.equal(1);
      }
    }
  });

  it("buildCrowdLeg AND buildFlowLeg are FINITE on EVERY bar of the slice (the degeneracy fix)", () => {
    for (const s of SYMBOLS) {
      const { fixture } = sliceToFullCoverage(loadBarsFixture(s));
      const f = fixture as BarsFixture;
      const crowd = buildCrowdLeg(f.bars);
      const flow = buildFlowLeg(f.bars);
      // momentum needs MOMENTUM_LOOKBACK past bars; the crowd leg is finite from bar 0
      // (funding + L/S ratio present). Both legs must be finite on every bar where the
      // flow momentum term is defined — i.e. the whole slice except the warm-up prefix.
      crowd.forEach((c, i) => expect(isFinite(c), `${s} crowd[${i}] non-finite`).to.equal(true));
      flow.forEach((fl, i) => expect(isFinite(fl), `${s} flow[${i}] non-finite`).to.equal(true));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) BYTE-REPRODUCIBLE — the committed report-fullcoverage.json regenerates exactly
// ════════════════════════════════════════════════════════════════════════════
describe("full-coverage report — byte-reproducible from fixed fixtures", () => {
  it("buildFullCoverageReport serializes deterministically (same input → byte-identical)", () => {
    const fx = loadAllFixtures();
    const a = serializeReport(buildFullCoverageReport(fx, PARAMS, DEFAULT_OOS_FRACTION));
    const b = serializeReport(buildFullCoverageReport(fx, PARAMS, DEFAULT_OOS_FRACTION));
    expect(a).to.equal(b);
  });

  it("matches committed backtest/report-fullcoverage.json byte-for-byte (run `FULL_COVERAGE=1 npm run backtest`)", () => {
    expect(
      fs.existsSync(FULLCOV_REPORT_PATH),
      "report-fullcoverage.json missing — run `FULL_COVERAGE=1 npm run backtest`"
    ).to.equal(true);
    const committed = fs.readFileSync(FULLCOV_REPORT_PATH, "utf8");
    const rebuilt = serializeReport(buildFullCoverageReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION));
    expect(rebuilt).to.equal(committed);
  });

  it("carries NO wall-clock field (stays diff-stable)", () => {
    const report = buildFullCoverageReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);
    expect(report).to.not.have.property("generatedAt");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) ANTI-CHERRY-PICK — slice chosen by coverage (not result); OOS present, all tokens shown
// ════════════════════════════════════════════════════════════════════════════
describe("full-coverage report — anti-cherry-pick: slice chosen by coverage, not by result", () => {
  const report = buildFullCoverageReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);

  it("the slice indices are INDEPENDENT of the backtest params (chosen by coverage alone)", () => {
    // Different cost params must not change WHICH bars are sliced — only the result.
    const cheap: BacktestParams = { ...PARAMS, txCostBps: 1, slippageBps: 1 };
    const expensive: BacktestParams = { ...PARAMS, txCostBps: 50, slippageBps: 50 };
    for (const s of SYMBOLS) {
      const fx = loadBarsFixture(s);
      const a = sliceToFullCoverage(fx);
      const b = sliceToFullCoverage(fx);
      expect(a.startIndex).to.equal(b.startIndex);
      expect(a.endIndex).to.equal(b.endIndex);
    }
    // params never feed sliceToFullCoverage; the report's fullCoverage block still pins them
    expect(report.fullCoverage).to.not.equal(undefined);
    // sanity: the cheap/expensive runs share the SAME sliced bar window per token
    const rc = buildFullCoverageReport(loadAllFixtures(), cheap, DEFAULT_OOS_FRACTION);
    const re = buildFullCoverageReport(loadAllFixtures(), expensive, DEFAULT_OOS_FRACTION);
    for (let i = 0; i < SYMBOLS.length; i++) {
      expect(rc.fullCoverage!.perToken[i].sliceStartIndex).to.equal(re.fullCoverage!.perToken[i].sliceStartIndex);
      expect(rc.fullCoverage!.perToken[i].sliceEndIndex).to.equal(re.fullCoverage!.perToken[i].sliceEndIndex);
    }
  });

  it("discloses ALL tokens evaluated in the fullCoverage provenance block (no hiding losers)", () => {
    expect(report.fullCoverage!.perToken.map((t) => t.symbol)).to.deep.equal(SYMBOLS);
    for (const t of report.fullCoverage!.perToken) {
      expect(t.sliceStartIndex).to.be.greaterThan(-1);
      expect(t.sliceEndIndex).to.be.greaterThanOrEqual(t.sliceStartIndex);
      expect(t.slicedBars).to.be.greaterThan(0);
      expect(t.slicedBars).to.be.lessThanOrEqual(t.originalBars);
    }
  });

  it("EVERY token has held-out OOS metrics present + well-formed (NOT asserted positive)", () => {
    expect(report.perToken.length).to.equal(SYMBOLS.length);
    for (const p of report.perToken) {
      const oos = p.outOfSample;
      for (const key of ["totalReturn", "winRate", "maxDrawdown", "sharpe", "sortino", "buyAndHoldReturn"] as const) {
        expect(isFinite(oos[key]), `${p.symbol}.outOfSample.${key} not finite`).to.equal(true);
      }
      expect(oos.bars).to.be.greaterThan(0);
      expect(oos.startBar).to.equal(p.inSample.endBar); // held-out tail disjoint from in-sample
      expect(oos.endBar).to.be.greaterThan(oos.startBar);
      // NO expect(...).greaterThan(0): the held-out edge is reported as-is, never required +ve.
    }
  });

  it("default 0.30 split is preserved on the full-coverage window (no split-shopping)", () => {
    expect(report.params.oosFraction).to.equal(DEFAULT_OOS_FRACTION);
    for (const p of report.perToken) {
      // splitBar = floor(bars * 0.70); in-sample + held-out reconstruct the full slice
      expect(p.inSample.bars + p.outOfSample.bars).to.equal(p.bars);
      expect(p.inSample.endBar).to.equal(Math.floor(p.bars * (1 - DEFAULT_OOS_FRACTION)));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) NO LOOK-AHEAD — truncation invariance on the sliced series
// ════════════════════════════════════════════════════════════════════════════
describe("full-coverage backtest — look-ahead safety on the sliced series", () => {
  it("truncating the sliced series at bar k leaves every trace row < k byte-identical", () => {
    for (const s of SYMBOLS) {
      const { fixture } = sliceToFullCoverage(loadBarsFixture(s));
      const bars = (fixture as BarsFixture).bars;
      const resFull = runBacktest(bars, PARAMS);
      const k = Math.floor(bars.length * 0.6);
      const resTrunc = runBacktest(bars.slice(0, k + 1), PARAMS);
      for (let i = 0; i < k; i++) {
        expect(resTrunc.trace[i].equity).to.equal(resFull.trace[i].equity, `${s} equity[${i}] changed under truncation`);
        expect(resTrunc.trace[i].side).to.equal(resFull.trace[i].side, `${s} side[${i}] changed under truncation`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (e) ISOLATION — the full-coverage path never touches the default report
// ════════════════════════════════════════════════════════════════════════════
describe("full-coverage report — isolation from the default report.json", () => {
  it("writes to a SEPARATE path (report-fullcoverage.json != report.json)", () => {
    expect(FULLCOV_REPORT_PATH).to.not.equal(REPORT_PATH);
  });

  it("the default report.json still regenerates byte-for-byte (frozen baseline retained)", () => {
    const committed = fs.readFileSync(REPORT_PATH, "utf8");
    const rebuilt = serializeReport(buildReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION));
    expect(rebuilt).to.equal(committed);
  });

  it("the default report has NO fullCoverage block; the full-coverage report DOES", () => {
    const def = buildReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);
    const fc = buildFullCoverageReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);
    expect(def.fullCoverage).to.equal(undefined);
    expect(fc.fullCoverage).to.not.equal(undefined);
  });
});
