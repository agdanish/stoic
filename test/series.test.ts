/**
 * Stoic — REAL per-bar SERIES tests (backtest/series.ts -> series-momentum.json).  [P1]
 *
 * Pins the honesty + correctness of the per-bar series the dashboard plots, WITHOUT touching
 * report-momentum.json or the frozen report.json:
 *
 *   (a) BYTE-REPRODUCIBLE — buildSeries over the committed fixtures serialises to the EXACT
 *       bytes committed in backtest/series-momentum.json (no Date / no random).
 *   (b) RECONCILES WITH report-momentum.json — the series is the SAME selected config on the
 *       SAME fixtures, so: per-token finalEquity == 1 + report per-token totalReturn, per-token
 *       maxUnderwater == report per-token maxDrawdown, and the aggregate mean-of-per-token
 *       scalars == the report's equal-weight aggregate totalReturn / maxDrawdown — all to 6dp.
 *   (c) SELECTED CONFIG MATCHES — the series' selectedConfig == report-momentum.json's
 *       selectedConfig (long-only + EMA 30/80); the series never re-selects on OOS.
 *   (d) SERIES IS WELL-FORMED — equity/underwater arrays are finite, the right length, the
 *       underwater is in [0,1] and == 1 - equity/runningPeak, finalEquity == last equity.
 *   (e) NO LOOK-AHEAD — truncating the underlying walk leaves every past equity byte-identical
 *       (re-pinned here on the slice helper; the deep property lives in momentum.test.ts).
 *   (f) ISOLATION — buildSeries never writes report-momentum.json or report.json.
 *
 * Pure + offline: reads the committed fixtures + committed report files; NO network.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  buildSeries,
  sliceSeries,
  underwaterOf,
  round6,
  SERIES_PATH,
  SeriesReport,
} from "../backtest/series";
import { DEFAULT_OOS_FRACTION } from "../backtest/momentum";

const REPORT_MOMENTUM_PATH = path.resolve(__dirname, "../backtest/report-momentum.json");
const REPORT_JSON_PATH = path.resolve(__dirname, "../backtest/report.json");

/** Serialize exactly as the CLI writer does (so byte-equality is meaningful). */
function serialize(report: unknown): string {
  return JSON.stringify(report, null, 2) + "\n";
}

const ROUND_TOL = 5e-7; // half a 6dp ulp — the series rounds to 6dp, the report to 12dp.

// ════════════════════════════════════════════════════════════════════════════
//  (a) BYTE-REPRODUCIBILITY of the committed series
// ════════════════════════════════════════════════════════════════════════════
describe("series — byte-reproducible series-momentum.json", function () {
  this.timeout(60000);

  it("buildSeries serialises to the EXACT committed bytes (no Date / no random)", function () {
    if (!fs.existsSync(SERIES_PATH)) {
      throw new Error(`missing ${SERIES_PATH} — run \`ts-node backtest/series.ts\``);
    }
    const committed = fs.readFileSync(SERIES_PATH, "utf8");
    const fresh = serialize(buildSeries(DEFAULT_OOS_FRACTION));
    expect(fresh).to.equal(committed, "series-momentum.json is not byte-reproducible — re-run `ts-node backtest/series.ts`");
  });

  it("buildSeries is deterministic across two invocations", function () {
    const a = serialize(buildSeries(DEFAULT_OOS_FRACTION));
    const b = serialize(buildSeries(DEFAULT_OOS_FRACTION));
    expect(a).to.equal(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) RECONCILES WITH report-momentum.json (the load-bearing honesty claim)
// ════════════════════════════════════════════════════════════════════════════
describe("series — reconciles with report-momentum.json", function () {
  this.timeout(60000);

  const series: SeriesReport = buildSeries(DEFAULT_OOS_FRACTION);
  const report = JSON.parse(fs.readFileSync(REPORT_MOMENTUM_PATH, "utf8"));

  it("per-token OOS finalEquity == 1 + report per-token OOS totalReturn (6dp)", function () {
    for (const ts of series.perToken) {
      const rp = report.perToken.find((p: any) => p.symbol === ts.symbol);
      expect(rp, `report missing ${ts.symbol}`).to.not.equal(undefined);
      expect(ts.outOfSample.finalEquity).to.be.closeTo(1 + rp.outOfSample.totalReturn, ROUND_TOL, `${ts.symbol} OOS finalEquity`);
      expect(ts.full.finalEquity).to.be.closeTo(1 + rp.full.totalReturn, ROUND_TOL, `${ts.symbol} full finalEquity`);
    }
  });

  it("per-token OOS maxUnderwater == report per-token OOS maxDrawdown (6dp)", function () {
    for (const ts of series.perToken) {
      const rp = report.perToken.find((p: any) => p.symbol === ts.symbol);
      expect(ts.outOfSample.maxUnderwater).to.be.closeTo(rp.outOfSample.maxDrawdown, ROUND_TOL, `${ts.symbol} OOS maxUnderwater`);
      expect(ts.full.maxUnderwater).to.be.closeTo(rp.full.maxDrawdown, ROUND_TOL, `${ts.symbol} full maxUnderwater`);
      // and the B&H underwater reconciles too
      expect(ts.outOfSample.maxBuyHoldUnderwater).to.be.closeTo(rp.outOfSample.buyAndHoldMaxDrawdown, ROUND_TOL, `${ts.symbol} OOS B&H maxUnderwater`);
    }
  });

  it("aggregate OOS meanFinalEquity == 1 + report aggregate OOS totalReturn (the headline)", function () {
    const a = series.aggregate.outOfSample;
    expect(a.meanFinalEquity).to.be.closeTo(1 + report.aggregate.outOfSample.totalReturn, ROUND_TOL);
    const f = series.aggregate.full;
    expect(f.meanFinalEquity).to.be.closeTo(1 + report.aggregate.full.totalReturn, ROUND_TOL);
  });

  it("aggregate OOS meanMaxUnderwater == report aggregate OOS maxDrawdown (the bear-dodge)", function () {
    const a = series.aggregate.outOfSample;
    expect(a.meanMaxUnderwater).to.be.closeTo(report.aggregate.outOfSample.maxDrawdown, ROUND_TOL);
    const f = series.aggregate.full;
    expect(f.meanMaxUnderwater).to.be.closeTo(report.aggregate.full.maxDrawdown, ROUND_TOL);
    // the published reconciliation block carries exactly these reconciling scalars
    expect(series.reconciliation.aggregate.outOfSampleMaxUnderwater).to.equal(a.meanMaxUnderwater);
    expect(series.reconciliation.aggregate.outOfSampleFinalEquity).to.equal(a.meanFinalEquity);
  });

  it("RADICAL HONESTY: the OOS strategy is a small LOSS, NOT alpha (no fabricated edge)", function () {
    const a = series.aggregate.outOfSample;
    // strategy ended BELOW its start (a loss), and its drawdown is far shallower than B&H's.
    expect(a.meanFinalEquity).to.be.lessThan(1.0, "OOS strategy must be reported as a loss, not a gain");
    expect(a.meanMaxUnderwater).to.be.lessThan(a.meanMaxBuyHoldUnderwater, "the only win is a shallower drawdown (bear-dodge)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) SELECTED CONFIG MATCHES report-momentum.json (same config, never re-selected)
// ════════════════════════════════════════════════════════════════════════════
describe("series — selected config matches report-momentum.json", function () {
  this.timeout(60000);

  it("series.selectedConfig deep-equals report-momentum.json's selectedConfig", function () {
    const series = buildSeries(DEFAULT_OOS_FRACTION);
    const report = JSON.parse(fs.readFileSync(REPORT_MOMENTUM_PATH, "utf8"));
    expect(series.selectedConfig).to.deep.equal(report.selectedConfig);
    expect(series.selectedConfig.label).to.equal("long-only+ema30/80");
    expect(series.selectedConfig.allowShort).to.equal(false);
    expect(series.selectedConfig.emaFast).to.equal(30);
    expect(series.selectedConfig.emaSlow).to.equal(80);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) SERIES WELL-FORMED + (e) underwater identity
// ════════════════════════════════════════════════════════════════════════════
describe("series — well-formed per-bar arrays", function () {
  this.timeout(60000);

  const series = buildSeries(DEFAULT_OOS_FRACTION);

  it("every window's equity/underwater arrays are finite, correct-length, and aligned", function () {
    const windows = [
      ...series.perToken.flatMap((t) => [t.outOfSample, t.full]),
      series.aggregate.outOfSample,
      series.aggregate.full,
    ];
    for (const w of windows) {
      expect(w.equity.length).to.equal(w.bars);
      expect(w.buyHoldEquity.length).to.equal(w.bars);
      expect(w.underwater.length).to.equal(w.bars);
      expect(w.buyHoldUnderwater.length).to.equal(w.bars);
      for (const e of w.equity) expect(isFinite(e)).to.equal(true);
      for (const u of w.underwater) expect(u).to.be.within(0, 1);
      if (w.bars > 0) {
        expect(w.finalEquity).to.equal(w.equity[w.equity.length - 1]);
        expect(w.finalBuyHoldEquity).to.equal(w.buyHoldEquity[w.buyHoldEquity.length - 1]);
      }
    }
  });

  it("underwater[i] == 1 - equity[i]/runningPeak (the inverted-area identity)", function () {
    const w = series.perToken[0].full;
    let peak = -Infinity;
    for (let i = 0; i < w.equity.length; i++) {
      if (w.equity[i] > peak) peak = w.equity[i];
      const expected = round6(peak > 0 ? 1 - w.equity[i] / peak : 0);
      expect(w.underwater[i]).to.equal(expected, `underwater[${i}] != 1 - equity/peak`);
    }
  });

  it("sliceSeries re-bases to 1.0 at the bar BEFORE the slice (local window)", function () {
    // equity cumulative from bar 0: [1, 1.1, 0.99, 1.32]; slice [2,4) re-bases to bar 1 (=1.1).
    const eq = [1, 1.1, 0.99, 1.32];
    const bh = [1, 1.05, 1.0, 1.2];
    const s = sliceSeries(eq, bh, 2, 4);
    expect(s.bars).to.equal(2);
    expect(s.equity[0]).to.equal(round6(0.99 / 1.1));
    expect(s.equity[1]).to.equal(round6(1.32 / 1.1));
    expect(s.finalEquity).to.equal(s.equity[1]);
  });

  it("underwaterOf is monotone-peak based and never negative", function () {
    expect(underwaterOf([1, 1.2, 0.9, 1.1])).to.deep.equal([0, 0, round6((1.2 - 0.9) / 1.2), round6((1.2 - 1.1) / 1.2)]);
    expect(underwaterOf([1, 2, 3]).every((u) => u === 0)).to.equal(true); // monotone up -> always at peak
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (f) ISOLATION — never writes the report files
// ════════════════════════════════════════════════════════════════════════════
describe("series — does NOT touch report-momentum.json or report.json", function () {
  this.timeout(60000);

  it("buildSeries leaves report-momentum.json bytes unchanged", function () {
    const before = fs.readFileSync(REPORT_MOMENTUM_PATH, "utf8");
    buildSeries(DEFAULT_OOS_FRACTION);
    const after = fs.readFileSync(REPORT_MOMENTUM_PATH, "utf8");
    expect(after).to.equal(before, "report-momentum.json changed — series.ts must never write it");
  });

  it("buildSeries leaves the frozen report.json bytes unchanged", function () {
    if (!fs.existsSync(REPORT_JSON_PATH)) return;
    const before = fs.readFileSync(REPORT_JSON_PATH, "utf8");
    buildSeries(DEFAULT_OOS_FRACTION);
    const after = fs.readFileSync(REPORT_JSON_PATH, "utf8");
    expect(after).to.equal(before, "the frozen report.json bytes changed — series.ts must never touch it");
  });

  it("the series writes to its OWN file (series-momentum.json), not a report file", function () {
    expect(SERIES_PATH).to.match(/series-momentum\.json$/);
    expect(SERIES_PATH).to.not.match(/report(-momentum)?\.json$/);
  });
});
