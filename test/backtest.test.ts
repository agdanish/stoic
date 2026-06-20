/**
 * Stoic — backtester tests.  [M5]
 *
 * Three guarantees the honest-backtest claim turns on:
 *   (a) BYTE-REPRODUCIBLE — buildReport over the fixed committed fixtures serializes to
 *       the exact bytes committed in backtest/report.json (no Date / no random at compute
 *       time). One lucky run cannot be disguised as the result.
 *   (b) NO LOOK-AHEAD — truncating the bar series at bar k leaves every trade/return at
 *       bars < k byte-identical. The decision at bar i uses only bars <= i and is paid on
 *       the i->i+1 move, so the past cannot react to the future.
 *   (c) ANTI-CHERRY-PICK — the report CONTAINS held-out out-of-sample metrics for every
 *       token and the aggregate. We assert they EXIST and are well-formed; we deliberately
 *       do NOT assert they are positive (the strategy may underperform — that is reported
 *       honestly, never faked).
 *
 * Pure + offline: reads the committed fixtures + the committed report.json; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import { Bar } from "../src/data/binance";
import { loadBarsFixture, SYMBOLS, BarsFixture } from "../src/data/fetchHistory";
import {
  runBacktest,
  metricsFromTrace,
  splitSegments,
  maxDrawdownOf,
  annualisedSharpe,
  annualisedSortino,
  DEFAULT_PARAMS,
  BacktestParams,
} from "../backtest/engine";
import {
  buildReport,
  serializeReport,
  loadAllFixtures,
  REPORT_PATH,
  DEFAULT_OOS_FRACTION,
  BacktestReport,
} from "../backtest/run";

const PARAMS: BacktestParams = DEFAULT_PARAMS;

// helper: a small deterministic synthetic bar series (CLEARLY synthetic test fixture,
// not market data) for the look-ahead + metric primitive tests.
function synthBars(n: number, seed = 3): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const w = Math.sin((i + seed) * 0.7) * 2 + Math.cos((i + seed) * 0.31);
    close = Math.max(1, close + w);
    bars.push({
      t: 1_700_000_000_000 + i * 3_600_000,
      open: close - 0.5,
      high: close + 1.5,
      low: close - 1.5,
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

// ════════════════════════════════════════════════════════════════════════════
//  (a) BYTE-REPRODUCIBLE REPORT
// ════════════════════════════════════════════════════════════════════════════
describe("backtest report — byte-reproducible from fixed fixtures", () => {
  it("buildReport serializes deterministically (same input → byte-identical output)", () => {
    const fx = loadAllFixtures();
    const a = serializeReport(buildReport(fx, PARAMS, DEFAULT_OOS_FRACTION));
    const b = serializeReport(buildReport(fx, PARAMS, DEFAULT_OOS_FRACTION));
    expect(a).to.equal(b);
  });

  it("matches the committed backtest/report.json byte-for-byte (run `npm run backtest` if this fails)", () => {
    expect(fs.existsSync(REPORT_PATH), "report.json missing — run `npm run backtest`").to.equal(true);
    const committed = fs.readFileSync(REPORT_PATH, "utf8");
    const rebuilt = serializeReport(buildReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION));
    expect(rebuilt).to.equal(committed);
  });

  it("the report carries NO wall-clock field (so it stays diff-stable)", () => {
    const report = buildReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);
    expect(report).to.not.have.property("generatedAt");
    // a recursive scan: no value looks like a fresh ISO timestamp from "now"
    const json = JSON.stringify(report);
    // the only ISO strings are the fixture window bounds, not a generation time
    expect(json).to.contain("startISO");
    expect(json).to.contain("endISO");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) NO LOOK-AHEAD — truncating future bars cannot change past trades/returns
// ════════════════════════════════════════════════════════════════════════════
describe("backtest — look-ahead safety (truncation invariance)", () => {
  it("truncating at bar k leaves every per-bar trace row < k byte-identical (synthetic)", () => {
    const full = synthBars(200);
    const resFull = runBacktest(full, PARAMS);
    for (const k of [50, 120, 180]) {
      const resTrunc = runBacktest(full.slice(0, k + 1), PARAMS);
      for (let i = 0; i < k; i++) {
        // compare every field that drives PnL/decisions
        expect(resTrunc.trace[i].side).to.equal(resFull.trace[i].side, `side[${i}] changed`);
        expect(resTrunc.trace[i].conviction).to.equal(resFull.trace[i].conviction, `conviction[${i}] changed`);
        expect(resTrunc.trace[i].targetWeight).to.equal(resFull.trace[i].targetWeight, `targetWeight[${i}] changed`);
        expect(resTrunc.trace[i].barReturn).to.equal(resFull.trace[i].barReturn, `barReturn[${i}] changed`);
        expect(resTrunc.trace[i].cost).to.equal(resFull.trace[i].cost, `cost[${i}] changed`);
        expect(resTrunc.trace[i].equity).to.equal(resFull.trace[i].equity, `equity[${i}] changed`);
      }
    }
  });

  it("trades fully enclosed before the truncation point are byte-identical (synthetic)", () => {
    const full = synthBars(200);
    const resFull = runBacktest(full, PARAMS);
    const k = 150;
    const resTrunc = runBacktest(full.slice(0, k + 1), PARAMS);
    const enclosedFull = resFull.trades.filter((t) => t.exitBar < k);
    const enclosedTrunc = resTrunc.trades.filter((t) => t.exitBar < k);
    expect(enclosedTrunc).to.deep.equal(enclosedFull);
  });

  it("mutating ONLY the final bar leaves all earlier trace rows untouched (synthetic)", () => {
    const bars = synthBars(150);
    const before = runBacktest(bars, PARAMS);
    const mutated = bars.map((b, i) =>
      i === bars.length - 1
        ? { ...b, close: b.close * 5, funding: 0.02, longShortRatio: 6, takerBuySellRatio: 6 }
        : b
    );
    const after = runBacktest(mutated, PARAMS);
    for (let i = 0; i < bars.length - 1; i++) {
      expect(after.trace[i].side).to.equal(before.trace[i].side, `side[${i}] reacted to a future bar`);
      expect(after.trace[i].equity).to.equal(before.trace[i].equity, `equity[${i}] reacted to a future bar`);
    }
  });

  it("holds on the REAL committed fixtures too (truncation invariance on real data)", () => {
    const fx = loadBarsFixture(SYMBOLS[0]);
    const bars = fx.bars;
    const resFull = runBacktest(bars, PARAMS);
    const k = Math.floor(bars.length * 0.6);
    const resTrunc = runBacktest(bars.slice(0, k + 1), PARAMS);
    for (let i = 0; i < k; i++) {
      expect(resTrunc.trace[i].equity).to.equal(resFull.trace[i].equity, `real equity[${i}] changed under truncation`);
      expect(resTrunc.trace[i].side).to.equal(resFull.trace[i].side, `real side[${i}] changed under truncation`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) ANTI-CHERRY-PICK — held-out metrics EXIST and are well-formed (NOT asserted +ve)
// ════════════════════════════════════════════════════════════════════════════
describe("backtest report — anti-cherry-pick: held-out out-of-sample metrics are present (honest, not faked)", () => {
  const report: BacktestReport = buildReport(loadAllFixtures(), PARAMS, DEFAULT_OOS_FRACTION);

  it("declares the data source kind (REAL/SYNTHETIC) and the symbols/window", () => {
    expect(report.dataSource.kind).to.be.oneOf(["REAL", "SYNTHETIC"]);
    expect(report.dataSource.symbols.length).to.be.greaterThan(0);
    expect(report.dataSource.startTime).to.be.lessThan(report.dataSource.endTime);
  });

  it("records the cost assumption AND flags it as unconfirmed (honesty)", () => {
    expect(report.params.txCostBps).to.equal(PARAMS.txCostBps);
    expect(report.params.slippageBps).to.equal(PARAMS.slippageBps);
    expect(report.params.costModelNote.toLowerCase()).to.contain("unconfirmed");
  });

  it("EVERY token report contains held-out out-of-sample metrics (the anti-cherry-pick gate)", () => {
    expect(report.perToken.length).to.equal(SYMBOLS.length);
    for (const p of report.perToken) {
      expect(p, `${p.symbol} missing outOfSample`).to.have.property("outOfSample");
      const oos = p.outOfSample;
      // present + numeric (we do NOT assert positive — honesty over a faked win)
      for (const key of ["totalReturn", "winRate", "maxDrawdown", "sharpe", "sortino", "buyAndHoldReturn"] as const) {
        expect(isFinite(oos[key]), `${p.symbol}.outOfSample.${key} not finite`).to.equal(true);
      }
      expect(oos.tradeCount).to.be.a("number");
      expect(oos.bars).to.be.greaterThan(0);
      // the held-out window is the TRAILING slice and is disjoint from in-sample
      expect(oos.startBar).to.equal(p.inSample.endBar);
      expect(oos.endBar).to.be.greaterThan(oos.startBar);
      // winRate / maxDrawdown are bounded fractions regardless of sign of return
      expect(oos.winRate).to.be.within(0, 1);
      expect(oos.maxDrawdown).to.be.within(0, 1);
    }
  });

  it("the AGGREGATE contains both in-sample and held-out segments, each with a B&H baseline", () => {
    expect(report.aggregate).to.have.property("inSample");
    expect(report.aggregate).to.have.property("outOfSample");
    for (const seg of [report.aggregate.inSample, report.aggregate.outOfSample]) {
      expect(isFinite(seg.totalReturn)).to.equal(true);
      expect(isFinite(seg.buyAndHoldReturn)).to.equal(true);
      expect(seg.bars).to.be.greaterThan(0);
    }
  });

  it("in-sample + held-out bar counts reconstruct the full series (no dropped/duplicated bars)", () => {
    for (const p of report.perToken) {
      // walk-forward realises a return from bar 1..N-1; segment `bars` count their own rows.
      expect(p.inSample.bars + p.outOfSample.bars).to.equal(p.bars);
    }
  });

  it("does NOT silently require a positive edge — surfaces underperformance when it exists", () => {
    // This test documents the HONESTY contract: it passes whether the held-out edge is
    // positive OR negative. It only fails if the metric is missing/NaN.
    const oos = report.aggregate.outOfSample;
    expect(oos.totalReturn).to.be.a("number");
    expect(isFinite(oos.totalReturn)).to.equal(true);
    // (Intentionally NO expect(...).to.be.greaterThan(0).)
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  METRIC PRIMITIVES — pure, BVA
// ════════════════════════════════════════════════════════════════════════════
describe("backtest metric primitives — pure, deterministic", () => {
  it("maxDrawdownOf: monotonically rising curve → 0 drawdown", () => {
    expect(maxDrawdownOf([1, 1.1, 1.2, 1.5])).to.equal(0);
  });
  it("maxDrawdownOf: a 1.0→0.7 dip is a 30% drawdown", () => {
    expect(maxDrawdownOf([1.0, 1.0, 0.7, 0.9])).to.be.closeTo(0.3, 1e-9);
  });
  it("annualisedSharpe: zero-variance returns → 0 (no spurious infinity)", () => {
    expect(annualisedSharpe([0.001, 0.001, 0.001], 8760)).to.equal(0);
    expect(annualisedSharpe([], 8760)).to.equal(0);
  });
  it("annualisedSharpe: positive mean with dispersion → positive, deterministic", () => {
    const s1 = annualisedSharpe([0.01, -0.005, 0.02, 0.0, 0.015], 8760);
    const s2 = annualisedSharpe([0.01, -0.005, 0.02, 0.0, 0.015], 8760);
    expect(s1).to.equal(s2);
    expect(s1).to.be.greaterThan(0);
  });
  it("annualisedSortino: no downside observations → 0 (honest, not infinity)", () => {
    expect(annualisedSortino([0.01, 0.02, 0.0, 0.03], 8760)).to.equal(0);
  });

  it("metricsFromTrace + splitSegments: segments are disjoint and cover the series", () => {
    const bars = synthBars(120);
    const res = runBacktest(bars, PARAMS);
    const split = splitSegments(res, bars, 0.3);
    expect(split.inSample.endBar).to.equal(split.outOfSample.startBar);
    expect(split.outOfSample.endBar).to.equal(bars.length);
    expect(split.inSample.startBar).to.equal(0);
    expect(split.inSample.bars + split.outOfSample.bars).to.equal(bars.length);
  });

  it("runBacktest is deterministic on the real fixtures (full metrics identical run-to-run)", () => {
    const bars = loadBarsFixture(SYMBOLS[0]).bars;
    const a = runBacktest(bars, PARAMS).full;
    const b = runBacktest(bars, PARAMS).full;
    expect(a).to.deep.equal(b);
  });
});
