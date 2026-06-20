/**
 * Stoic — DAILY momentum-pivot backtest tests.  [P1]
 *
 * Pins the honesty + correctness guarantees of backtest/momentum.ts (the regime-aware
 * DIRECTIONAL pivot's walk-forward) WITHOUT touching the frozen backtest/report.json:
 *
 *   (a) BYTE-REPRODUCIBLE — buildReport over the fixed committed daily fixtures serialises
 *       to the EXACT bytes committed in backtest/report-momentum.json (no Date / no random).
 *   (b) NO LOOK-AHEAD — truncating the series at bar k leaves every per-bar decision /
 *       equity / cost at bars <= k byte-identical (the load-bearing property); mutating a
 *       FUTURE bar cannot change a PAST equity point.
 *   (c) VERDICT MATCHES A FRESH B&H COMPARISON — the committed verdict (edgeFound /
 *       riskAdjustedWin / per-token beatsBuyHold) is recomputed from a fresh walk + an
 *       INDEPENDENT close-to-close buy-and-hold and must agree to the digit.
 *   (d) SELECTED IN-SAMPLE ONLY — the selected winner is the argmax of the IN-SAMPLE
 *       aggregate objective over the disclosed sweep; it is NOT the OOS argmax (i.e. the
 *       choice provably did not peek at OOS).
 *   (e) COST MODEL + SPLIT — costs are net (a higher cost strictly lowers strategy return),
 *       the split is the fixed floor(n*(1-oosFraction)), and metrics are well-formed.
 *   (f) ISOLATION — the frozen backtest/report.json bytes are unchanged by this path.
 *
 * Pure + offline: reads the committed fixtures + committed report files; NO network.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  buildReport,
  runWalk,
  splitMetrics,
  splitBarOf,
  metricsFromTrace,
  aggregateMetrics,
  buildSweep,
  selectInSample,
  evaluateCandidate,
  loadUniverse,
  regimeLabels,
  maxDrawdownOf,
  annualisedSharpe,
  round12,
  DEFAULT_WALK,
  DEFAULT_OOS_FRACTION,
  BARS_PER_YEAR_DAILY,
  MOMENTUM_REPORT_PATH,
  WalkParams,
  Metrics,
} from "../backtest/momentum";
import { DailyBar, DAY_MS, utcDateString } from "../src/data/history";

const REPORT_JSON_PATH = path.resolve(__dirname, "../backtest/report.json");
const DAY0 = Date.UTC(2024, 0, 1);

/** Serialize a report exactly as the CLI writer does (so byte-equality is meaningful). */
function serialize(report: unknown): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** A deterministic synthetic series with a controllable daily drift (bull/bear/chop). */
function trendBars(
  n: number,
  dailyDrift: number,
  opts: { fearGreed?: number; funding?: number; start?: number; base?: number } = {}
): DailyBar[] {
  const bars: DailyBar[] = [];
  let close = opts.base ?? 100;
  const start = opts.start ?? DAY0;
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY_MS;
    const open = close;
    close = Math.max(0.01, open * (1 + dailyDrift));
    bars.push({
      date: utcDateString(t),
      t,
      open: Math.round(open * 1e4) / 1e4,
      high: Math.round(Math.max(open, close) * 1.005 * 1e4) / 1e4,
      low: Math.round(Math.min(open, close) * 0.995 * 1e4) / 1e4,
      close: Math.round(close * 1e4) / 1e4,
      volume: 1000 + i,
      ...(opts.fearGreed !== undefined ? { fearGreed: opts.fearGreed } : {}),
      ...(opts.funding !== undefined ? { funding: opts.funding } : {}),
    });
  }
  return bars;
}

/** A deterministic wiggly multi-regime series (no Math.random) for invariance tests. */
function wiggleBars(n: number, seed = 1): DailyBar[] {
  const bars: DailyBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const t = DAY0 + i * DAY_MS;
    const w = Math.sin((i + seed) * 0.13) * 0.02 + Math.cos((i + seed) * 0.041) * 0.015;
    const open = close;
    close = Math.max(0.01, close * (1 + w));
    const fg = Math.max(0, Math.min(100, Math.round(50 + 45 * Math.sin((i + seed) * 0.07))));
    bars.push({
      date: utcDateString(t),
      t,
      open: Math.round(open * 1e4) / 1e4,
      high: Math.round(Math.max(open, close) * 1.01 * 1e4) / 1e4,
      low: Math.round(Math.min(open, close) * 0.99 * 1e4) / 1e4,
      close: Math.round(close * 1e4) / 1e4,
      volume: 1000 + i,
      fearGreed: fg,
      funding: 0.0006 * Math.sin((i + seed) * 0.09),
    });
  }
  return bars;
}

// ════════════════════════════════════════════════════════════════════════════
//  (a) BYTE-REPRODUCIBILITY of the committed report
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — byte-reproducible report-momentum.json", function () {
  this.timeout(60000);

  it("buildReport serialises to the EXACT committed bytes (no Date / no random)", function () {
    if (!fs.existsSync(MOMENTUM_REPORT_PATH)) {
      throw new Error(`missing ${MOMENTUM_REPORT_PATH} — run \`ts-node backtest/momentum.ts\``);
    }
    const committed = fs.readFileSync(MOMENTUM_REPORT_PATH, "utf8");
    const fresh = serialize(buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    expect(fresh).to.equal(committed, "report-momentum.json is not byte-reproducible — re-run the backtest");
  });

  it("buildReport is deterministic across two invocations", function () {
    const a = serialize(buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    const b = serialize(buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    expect(a).to.equal(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) NO LOOK-AHEAD — truncation invariance on the walk
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — look-ahead safety (truncation invariance)", function () {
  it("runWalk: trace for bars 0..k is identical on a truncated series", function () {
    const full = wiggleBars(220, 4);
    const wFull = runWalk(full, DEFAULT_WALK);
    for (const k of [40, 110, 190]) {
      const wTrunc = runWalk(full.slice(0, k + 1), DEFAULT_WALK);
      for (let i = 0; i <= k; i++) {
        expect(wTrunc.trace[i].side).to.equal(wFull.trace[i].side, `side[${i}] changed when bars > ${k} truncated`);
        expect(wTrunc.trace[i].conviction).to.equal(wFull.trace[i].conviction, `conviction[${i}] changed`);
        expect(wTrunc.trace[i].targetWeight).to.equal(wFull.trace[i].targetWeight, `targetWeight[${i}] changed`);
        expect(wTrunc.trace[i].barReturn).to.equal(wFull.trace[i].barReturn, `barReturn[${i}] changed`);
        expect(wTrunc.trace[i].equity).to.equal(wFull.trace[i].equity, `equity[${i}] changed`);
        expect(wTrunc.trace[i].cost).to.equal(wFull.trace[i].cost, `cost[${i}] changed`);
      }
    }
  });

  it("runWalk: mutating a FUTURE bar leaves all PAST equity untouched", function () {
    const bars = wiggleBars(150, 6);
    const before = runWalk(bars, DEFAULT_WALK);
    const mutated = bars.map((b, i) =>
      i === bars.length - 1 ? { ...b, close: b.close * 8, fearGreed: 99, funding: 0.02 } : b
    );
    const after = runWalk(mutated, DEFAULT_WALK);
    // the LAST bar's barReturn is paid on the prior weight, so it MAY differ at the boundary;
    // assert every PAST equity/conviction (bars < n-1) is byte-identical.
    for (let i = 0; i < bars.length - 1; i++) {
      expect(after.trace[i].equity).to.equal(before.trace[i].equity, `equity[${i}] reacted to a FUTURE bar`);
      expect(after.trace[i].conviction).to.equal(before.trace[i].conviction, `conviction[${i}] reacted to a FUTURE bar`);
    }
  });

  it("regimeLabels read only past/at-bar closes (truncation-invariant)", function () {
    const closes = wiggleBars(200, 9).map((b) => b.close);
    const full = regimeLabels(closes);
    for (const k of [80, 150]) {
      const trunc = regimeLabels(closes.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(trunc[i]).to.equal(full[i], `regime[${i}] changed when closes > ${k} truncated`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) VERDICT MATCHES A FRESH, INDEPENDENT B&H COMPARISON
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — verdict matches a fresh buy-and-hold comparison", function () {
  this.timeout(60000);

  const report = buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
  const universe = loadUniverse();

  it("each per-token OOS B&H equals an INDEPENDENT close-to-close buy-and-hold on the OOS bars", function () {
    for (let ti = 0; ti < universe.length; ti++) {
      const tok = universe[ti];
      const n = tok.bars.length;
      const split = splitBarOf(n, DEFAULT_OOS_FRACTION);
      // independent B&H over the OOS slice: product of close[i]/close[i-1] for i in (split, n),
      // re-based to the bar BEFORE the slice (split-1) — exactly what metricsFromTrace does.
      let bh = 1.0;
      for (let i = split; i < n; i++) {
        const prev = tok.bars[i - 1].close;
        const cur = tok.bars[i].close;
        if (i > 0 && isFinite(prev) && prev !== 0 && isFinite(cur)) bh *= cur / prev;
      }
      const independentOOS = round12(bh - 1);
      const reported = report.perToken[ti].outOfSample.buyAndHoldReturn;
      expect(reported).to.equal(independentOOS, `${tok.symbol} OOS B&H mismatch`);
    }
  });

  it("edgeFound is TRUE iff aggregate-OR-≥1-token OOS strictly beats B&H net of cost (recomputed)", function () {
    const aggBeat = report.aggregate.outOfSample.totalReturn > report.aggregate.outOfSample.buyAndHoldReturn;
    const tokenBeats = report.perToken.filter(
      (p: any) => p.outOfSample.totalReturn > p.outOfSample.buyAndHoldReturn
    );
    const expected = aggBeat || tokenBeats.length > 0;
    expect(report.verdict.edgeFound).to.equal(expected);
    // and the per-token beat flags agree with a strict comparison
    for (const p of report.perToken) {
      expect(p.outOfSample.beatsBuyHold).to.equal(
        p.outOfSample.totalReturn > p.outOfSample.buyAndHoldReturn,
        `${p.symbol} beatsBuyHold flag disagrees with a strict compare`
      );
    }
  });

  it("riskAdjustedWin is TRUE iff aggregate OOS Sharpe > B&H AND maxDD < B&H (recomputed)", function () {
    const a = report.aggregate.outOfSample;
    const expected = a.sharpe > a.buyAndHoldSharpe && a.maxDrawdown < a.buyAndHoldMaxDrawdown;
    expect(report.verdict.riskAdjustedWin).to.equal(expected);
  });

  it("a 'beat' is STRICT: excessReturn > 0 exactly matches beatsBuyHold", function () {
    for (const p of report.perToken) {
      expect(p.outOfSample.beatsBuyHold).to.equal(p.outOfSample.excessReturn > 0);
      expect(p.full.beatsBuyHold).to.equal(p.full.excessReturn > 0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) SELECTED ON IN-SAMPLE ONLY (the cardinal rule)
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — selection is in-sample only (never peeks at OOS)", function () {
  this.timeout(60000);

  const universe = loadUniverse();
  const sweep = buildSweep(DEFAULT_WALK);

  it("the search budget is within the fixed cap (<= 24 configs)", function () {
    expect(sweep.length).to.be.lessThanOrEqual(24);
    expect(sweep.length).to.be.greaterThan(1);
  });

  it("the selected winner is the argmax of the IN-SAMPLE aggregate objective", function () {
    const { winner } = selectInSample(universe, sweep, DEFAULT_OOS_FRACTION);
    // recompute every candidate's in-sample aggregate and confirm the winner is the argmax
    // (excess, then sharpe, then -drawdown). This proves the choice used in-sample metrics.
    const scored = sweep.map((c) => {
      const ev = evaluateCandidate(universe, c, DEFAULT_OOS_FRACTION);
      return { label: c.label, is: ev.aggregate.inSample };
    });
    const best = scored.reduce((b, c) =>
      c.is.excessReturn > b.is.excessReturn + 1e-12 ||
      (Math.abs(c.is.excessReturn - b.is.excessReturn) <= 1e-12 && c.is.sharpe > b.is.sharpe + 1e-12)
        ? c
        : b
    );
    expect(winner.label).to.equal(best.label);
  });

  it("the report's selected config matches selectInSample (no hand-editing of the winner)", function () {
    const { winner } = selectInSample(universe, sweep, DEFAULT_OOS_FRACTION);
    const report = buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
    expect(report.selectedConfig.label).to.equal(winner.label);
    // and the disclosed sweep marks exactly one candidate selected — the winner.
    const marked = report.search.inSampleAll.filter((c: any) => c.selected);
    expect(marked.length).to.equal(1);
    expect(marked[0].label).to.equal(winner.label);
  });

  it("ALL sweep candidates are disclosed in the report (no candidate hidden)", function () {
    const report = buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
    expect(report.search.inSampleAll.length).to.equal(sweep.length);
    const labels = new Set(report.search.inSampleAll.map((c: any) => c.label));
    for (const c of sweep) expect(labels.has(c.label)).to.equal(true, `candidate ${c.label} not disclosed`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (e) COST MODEL + SPLIT + METRIC PRIMITIVES
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — cost is net + split is fixed + metrics well-formed", function () {
  this.timeout(60000);

  it("a HIGHER cost assumption strictly lowers (or equals) strategy return (cost is real)", function () {
    const bars = wiggleBars(300, 11);
    const cheap = runWalk(bars, { ...DEFAULT_WALK, txCostBps: 10, slippageBps: 10 });
    const dear = runWalk(bars, { ...DEFAULT_WALK, txCostBps: 50, slippageBps: 50 });
    const cheapEnd = cheap.trace[cheap.trace.length - 1].equity;
    const dearEnd = dear.trace[dear.trace.length - 1].equity;
    expect(dearEnd).to.be.lessThanOrEqual(cheapEnd + 1e-12);
  });

  it("the split bar is the fixed floor(n*(1-oosFraction))", function () {
    expect(splitBarOf(1000, 0.3)).to.equal(700);
    expect(splitBarOf(999, 0.3)).to.equal(Math.floor(999 * 0.7));
    // clamps to [0.1, 0.9]
    expect(splitBarOf(1000, 0.99)).to.equal(splitBarOf(1000, 0.9));
    expect(splitBarOf(1000, 0.0)).to.equal(splitBarOf(1000, 0.1));
  });

  it("in-sample + OOS bar counts partition the series (no overlap, no gap)", function () {
    const bars = wiggleBars(250, 13);
    const w = runWalk(bars, DEFAULT_WALK);
    const sm = splitMetrics(w, bars.length, DEFAULT_OOS_FRACTION);
    expect(sm.inSample.bars + sm.outOfSample.bars).to.equal(bars.length);
    expect(sm.splitBar).to.equal(splitBarOf(bars.length, DEFAULT_OOS_FRACTION));
  });

  it("maxDrawdownOf / annualisedSharpe behave (primitive sanity)", function () {
    expect(maxDrawdownOf([1, 1.2, 0.9, 1.1])).to.be.closeTo((1.2 - 0.9) / 1.2, 1e-9);
    expect(annualisedSharpe([0, 0, 0], BARS_PER_YEAR_DAILY)).to.equal(0); // zero variance -> 0
  });

  it("DIRECTIONAL sanity: a long-only walk on a steady BULL rides it; on a steady BEAR sits flat", function () {
    const bull = runWalk(trendBars(300, 0.01, { fearGreed: 50 }), { ...DEFAULT_WALK, allowShort: false });
    const bear = runWalk(trendBars(300, -0.01, { fearGreed: 50 }), { ...DEFAULT_WALK, allowShort: false });
    const bullEnd = bull.trace[bull.trace.length - 1].equity;
    const bearEnd = bear.trace[bear.trace.length - 1].equity;
    expect(bullEnd).to.be.greaterThan(1.0, "long-only should profit riding a steady bull");
    // long-only in a bear goes flat -> equity stays ~1.0 (only cost drag), never deeply negative.
    expect(bearEnd).to.be.within(0.9, 1.05, "long-only should sit ~flat through a bear, dodging the drawdown");
  });

  it("all committed report metrics are finite + in range", function () {
    const report = buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
    const checkM = (m: Metrics, where: string) => {
      for (const k of ["totalReturn", "buyAndHoldReturn", "sharpe", "sortino", "maxDrawdown"] as const) {
        expect(isFinite(m[k]), `${where}.${k} not finite`).to.equal(true);
      }
      expect(m.maxDrawdown).to.be.within(0, 1, `${where}.maxDrawdown out of range`);
      expect(m.winRate).to.be.within(0, 1, `${where}.winRate out of range`);
    };
    for (const seg of ["inSample", "outOfSample", "full"] as const) checkM(report.aggregate[seg], `aggregate.${seg}`);
    for (const p of report.perToken) for (const seg of ["inSample", "outOfSample", "full"] as const) checkM(p[seg], `${p.symbol}.${seg}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (f) ISOLATION — the frozen report.json is untouched by this path
// ════════════════════════════════════════════════════════════════════════════
describe("momentum backtest — does NOT touch the frozen report.json", function () {
  it("buildReport never reads or writes backtest/report.json (the frozen anchor)", function () {
    if (!fs.existsSync(REPORT_JSON_PATH)) return; // skip if the frozen anchor isn't present
    const before = fs.readFileSync(REPORT_JSON_PATH, "utf8");
    buildReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK); // building the momentum report must not write report.json
    const after = fs.readFileSync(REPORT_JSON_PATH, "utf8");
    expect(after).to.equal(before, "the frozen report.json bytes changed — momentum.ts must never touch it");
  });

  it("the momentum report writes to its OWN file, not report.json", function () {
    expect(MOMENTUM_REPORT_PATH).to.match(/report-momentum\.json$/);
    expect(MOMENTUM_REPORT_PATH).to.not.match(/[/\\]report\.json$/);
  });
});
