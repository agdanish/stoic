/**
 * Stoic — LAYER-ATTRIBUTION ABLATION tests.  [ABL]
 *
 * Pins the honesty + correctness guarantees of backtest/ablation.ts (the per-layer
 * attribution over the DAILY harness) WITHOUT touching the frozen backtest/report.json
 * OR backtest/report-momentum.json:
 *
 *   (a) FAITHFUL — the FULL arm (A3 = trend core + F&G gate + risk filter) reproduces the
 *       production runStrategy / momentum.runWalk walk BYTE-FOR-BYTE on every committed
 *       fixture, AND its aggregate/per-token OOS metrics equal the committed
 *       report-momentum.json to the digit. So the ablation is a faithful decomposition of
 *       the headline, not a parallel re-implementation that could disagree.
 *   (b) NESTED LAYERS — A1 ⊂ A2 ⊂ A3: each arm adds exactly one overlay; with both overlays
 *       OFF (A1) the conviction is the raw directional bias; turning a layer off can only
 *       remove its effect (the layer flags do what they say).
 *   (c) NO LOOK-AHEAD — truncating the series at bar k leaves every ablation conviction /
 *       equity at bars <= k byte-identical, for every arm (the load-bearing property).
 *   (d) BYTE-REPRODUCIBLE — buildAblationReport serialises to the EXACT committed bytes.
 *   (e) HONEST VERDICT — divergenceAddsValue / crossSectionalAddsValue match a freshly
 *       recomputed comparison; neither is asserted positive (reported as-is). The risk
 *       filter's near-inertness on the OOS is pinned (it does NOT silently swing the result).
 *   (f) ISOLATION — the frozen report.json AND report-momentum.json bytes are unchanged.
 *
 * Pure + offline: reads the committed fixtures + committed report files; NO network.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  buildAblationReport,
  serializeAblationReport,
  ablationConvictions,
  ablationWalk,
  evaluateArm,
  ABLATION_REPORT_PATH,
  AblationLayers,
} from "../backtest/ablation";
import {
  runWalk,
  buildSweep,
  selectInSample,
  loadUniverse,
  splitBarOf,
  round12,
  DEFAULT_WALK,
  DEFAULT_OOS_FRACTION,
} from "../backtest/momentum";
import { runStrategy } from "../src/signal/strategy";
import { DailyBar, DAY_MS, utcDateString } from "../src/data/history";

const MOMENTUM_REPORT_PATH = path.resolve(__dirname, "../backtest/report-momentum.json");
const REPORT_JSON_PATH = path.resolve(__dirname, "../backtest/report.json");
const DAY0 = Date.UTC(2024, 0, 1);

function serialize(report: unknown): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** A deterministic wiggly multi-regime daily series (no Math.random) for invariance tests. */
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

const LAYERS_FULL: AblationLayers = { fgGate: true, riskFilter: true };
const LAYERS_GATE: AblationLayers = { fgGate: true, riskFilter: false };
const LAYERS_CORE: AblationLayers = { fgGate: false, riskFilter: false };

// ════════════════════════════════════════════════════════════════════════════
//  (a) FAITHFUL — the FULL arm reproduces runStrategy / runWalk byte-for-byte
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — FULL arm (A3) is faithful to the production pipeline", function () {
  this.timeout(60000);

  const universe = loadUniverse();
  const sweep = buildSweep(DEFAULT_WALK);
  const { winner } = selectInSample(universe, sweep, DEFAULT_OOS_FRACTION);

  it("the LOCKED ablation config is the SAME in-sample winner as report-momentum.json", function () {
    expect(winner.label).to.equal("long-only+ema30/80");
  });

  it("A3 conviction series equals runStrategy's conviction series on every fixture", function () {
    for (const tok of universe) {
      const sb = runStrategy(tok.bars, winner.strategy);
      const convs = ablationConvictions(tok.bars, winner.strategy, LAYERS_FULL);
      for (let i = 0; i < tok.bars.length; i++) {
        expect(convs[i].conviction).to.equal(sb[i].conviction, `${tok.symbol} conviction[${i}]`);
        expect(convs[i].sizeBps).to.equal(sb[i].sizeBps, `${tok.symbol} sizeBps[${i}]`);
        expect(convs[i].riskAction).to.equal(sb[i].riskAction, `${tok.symbol} riskAction[${i}]`);
      }
    }
  });

  it("A3 walk reproduces momentum.runWalk BYTE-FOR-BYTE (trace + trades)", function () {
    for (const tok of universe) {
      const ref = runWalk(tok.bars, winner.walk, winner.strategy);
      const convs = ablationConvictions(tok.bars, winner.strategy, LAYERS_FULL);
      const abl = ablationWalk(tok.bars, convs, winner.walk);
      expect(abl.trace, `${tok.symbol} trace`).to.deep.equal(ref.trace);
      expect(abl.trades, `${tok.symbol} trades`).to.deep.equal(ref.trades);
    }
  });

  it("A3 aggregate + per-token OOS metrics equal the committed report-momentum.json", function () {
    const ablation = buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
    const momentum = JSON.parse(fs.readFileSync(MOMENTUM_REPORT_PATH, "utf8"));
    const a3 = ablation.arms.find((a: any) => a.id === "A3");
    // aggregate OOS
    for (const k of ["totalReturn", "buyAndHoldReturn", "sharpe", "maxDrawdown", "tradeCount"] as const) {
      expect(a3.aggregate.outOfSample[k], `agg OOS ${k}`).to.equal(momentum.aggregate.outOfSample[k]);
    }
    // per-token OOS
    for (const p of a3.perToken) {
      const mp = momentum.perToken.find((z: any) => z.symbol === p.symbol).outOfSample;
      for (const k of ["totalReturn", "buyAndHoldReturn", "sharpe", "maxDrawdown", "tradeCount"] as const) {
        expect(p.outOfSample[k], `${p.symbol} OOS ${k}`).to.equal(mp[k]);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) NESTED LAYERS — each flag adds exactly one overlay
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — layers are nested (A1 ⊂ A2 ⊂ A3) and flags do what they say", function () {
  it("with BOTH overlays OFF (A1), conviction is the raw directional bias (no gate, no trim)", function () {
    const bars = wiggleBars(260, 3);
    const winner = selectInSample(loadUniverse(), buildSweep(DEFAULT_WALK), DEFAULT_OOS_FRACTION).winner;
    const core = ablationConvictions(bars, winner.strategy, LAYERS_CORE);
    // independent: the directional bias rounded (gate=1, filter=pass) IS the conviction.
    const { momentumSignal } = require("../src/signal/momentum");
    const moms = momentumSignal(bars.map((b) => b.close), winner.strategy);
    for (let i = 0; i < bars.length; i++) {
      const expected = Math.round(Math.max(0, Math.min(1000, moms[i].directional)));
      expect(core[i].conviction).to.equal(expected, `core conviction[${i}] is not the raw directional bias`);
      expect(core[i].riskAction).to.equal("pass", `core riskAction[${i}] should be pass (filter OFF)`);
    }
  });

  it("turning the risk filter OFF never CHANGES a conviction the filter would not have touched", function () {
    // A2 (gate on, filter off) and A3 (gate on, filter on) must AGREE on every bar where the
    // filter is a pass; they may differ ONLY where the filter trimmed/vetoed.
    for (const tok of loadUniverse()) {
      const winner = selectInSample(loadUniverse(), buildSweep(DEFAULT_WALK), DEFAULT_OOS_FRACTION).winner;
      const a2 = ablationConvictions(tok.bars, winner.strategy, LAYERS_GATE);
      const a3 = ablationConvictions(tok.bars, winner.strategy, LAYERS_FULL);
      for (let i = 0; i < tok.bars.length; i++) {
        if (a3[i].riskAction === "pass") {
          expect(a2[i].conviction).to.equal(a3[i].conviction, `${tok.symbol} bar ${i}: filter passed but A2≠A3`);
        }
      }
    }
  });

  it("the risk filter only ever REDUCES |edge| (trim/veto), never increases it", function () {
    for (const tok of loadUniverse()) {
      const winner = selectInSample(loadUniverse(), buildSweep(DEFAULT_WALK), DEFAULT_OOS_FRACTION).winner;
      const a2 = ablationConvictions(tok.bars, winner.strategy, LAYERS_GATE);
      const a3 = ablationConvictions(tok.bars, winner.strategy, LAYERS_FULL);
      for (let i = 0; i < tok.bars.length; i++) {
        const e2 = Math.abs(a2[i].conviction - 500);
        const e3 = Math.abs(a3[i].conviction - 500);
        expect(e3).to.be.at.most(e2 + 1e-9, `${tok.symbol} bar ${i}: filter INCREASED the edge`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) NO LOOK-AHEAD — truncation invariance, every arm
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — look-ahead safety (truncation invariance, every arm)", function () {
  for (const [name, layers] of [
    ["trendOnly", LAYERS_CORE],
    ["+fgGate", LAYERS_GATE],
    ["+riskFilter", LAYERS_FULL],
  ] as Array<[string, AblationLayers]>) {
    it(`${name}: conviction + walk equity for bars 0..k identical on a truncated series`, function () {
      const full = wiggleBars(220, 7);
      const convFull = ablationConvictions(full, {}, layers);
      const wFull = ablationWalk(full, convFull, DEFAULT_WALK);
      for (const k of [40, 110, 190]) {
        const sub = full.slice(0, k + 1);
        const convTrunc = ablationConvictions(sub, {}, layers);
        const wTrunc = ablationWalk(sub, convTrunc, DEFAULT_WALK);
        for (let i = 0; i <= k; i++) {
          expect(convTrunc[i].conviction).to.equal(convFull[i].conviction, `${name} conviction[${i}] changed`);
          expect(wTrunc.trace[i].equity).to.equal(wFull.trace[i].equity, `${name} equity[${i}] changed`);
          expect(wTrunc.trace[i].side).to.equal(wFull.trace[i].side, `${name} side[${i}] changed`);
        }
      }
    });
  }

  it("mutating a FUTURE bar leaves all PAST ablation equity untouched (full arm)", function () {
    const bars = wiggleBars(150, 8);
    const before = ablationWalk(bars, ablationConvictions(bars, {}, LAYERS_FULL), DEFAULT_WALK);
    const mutated = bars.map((b, i) =>
      i === bars.length - 1 ? { ...b, close: b.close * 8, fearGreed: 99, funding: 0.02 } : b
    );
    const after = ablationWalk(mutated, ablationConvictions(mutated, {}, LAYERS_FULL), DEFAULT_WALK);
    for (let i = 0; i < bars.length - 1; i++) {
      expect(after.trace[i].equity).to.equal(before.trace[i].equity, `equity[${i}] reacted to a FUTURE bar`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) BYTE-REPRODUCIBILITY of the committed report
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — byte-reproducible report-ablation.json", function () {
  this.timeout(60000);

  it("buildAblationReport serialises to the EXACT committed bytes (no Date / no random)", function () {
    if (!fs.existsSync(ABLATION_REPORT_PATH)) {
      throw new Error(`missing ${ABLATION_REPORT_PATH} — run \`ts-node backtest/ablation.ts\``);
    }
    const committed = fs.readFileSync(ABLATION_REPORT_PATH, "utf8");
    const fresh = serializeAblationReport(buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    expect(fresh).to.equal(committed, "report-ablation.json is not byte-reproducible — re-run the harness");
  });

  it("buildAblationReport is deterministic across two invocations", function () {
    const a = serialize(buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    const b = serialize(buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK));
    expect(a).to.equal(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (e) HONEST VERDICT — computed, not hand-set; risk filter near-inert on OOS
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — verdict is computed from the metrics (brutally honest)", function () {
  this.timeout(60000);

  const report = buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
  const a1 = report.arms.find((a: any) => a.id === "A1");
  const a2 = report.arms.find((a: any) => a.id === "A2");
  const a3 = report.arms.find((a: any) => a.id === "A3");

  it("the trend core ALONE (A1) already carries essentially the entire OOS result", function () {
    // A1 OOS return must be within a hair of the full pipeline (A3) — the overlays are marginal.
    const diff = Math.abs(a1.aggregate.outOfSample.totalReturn - a3.aggregate.outOfSample.totalReturn);
    expect(diff).to.be.lessThan(0.01, "the overlays move the OOS return by >1% — they are NOT marginal");
    // and A1 already beats B&H OOS on absolute return (the bear-dodge is the core's, not the overlays')
    expect(a1.aggregate.outOfSample.totalReturn).to.be.greaterThan(a1.aggregate.outOfSample.buyAndHoldReturn);
  });

  it("divergenceAddsValue matches a fresh recompute of the A2→A3 marginal OOS delta", function () {
    const dRet = round12(a3.aggregate.outOfSample.totalReturn - a2.aggregate.outOfSample.totalReturn);
    const dSharpe = round12(a3.aggregate.outOfSample.sharpe - a2.aggregate.outOfSample.sharpe);
    const dMaxDD = round12(a3.aggregate.outOfSample.maxDrawdown - a2.aggregate.outOfSample.maxDrawdown);
    const changed =
      a3.aggregate.outOfSample.totalReturn !== a2.aggregate.outOfSample.totalReturn ||
      a3.aggregate.outOfSample.sharpe !== a2.aggregate.outOfSample.sharpe ||
      a3.aggregate.outOfSample.maxDrawdown !== a2.aggregate.outOfSample.maxDrawdown;
    const expected = changed && (dSharpe > 0 || dMaxDD < 0) && dRet >= -1e-12;
    expect(report.verdict.divergenceAddsValue).to.equal(expected);
  });

  it("the risk filter is near-INERT on the held-out OOS (it does NOT swing the result)", function () {
    // The 2026-drawdown OOS is a FEAR regime; the filter only bites on LONG-into-extreme-GREED,
    // so it must barely move the OOS aggregate. Pin |ΔOOS return| < 5 bps so a future change that
    // silently makes the filter load-bearing on the OOS trips this honesty guard.
    const dRet = Math.abs(a3.aggregate.outOfSample.totalReturn - a2.aggregate.outOfSample.totalReturn);
    expect(dRet).to.be.lessThan(0.0005, "the risk filter moved the OOS return by >=5bps — re-examine the 'non-earning veto' claim");
  });

  it("crossSectionalAddsValue matches the committed cross-sectional report (or is false if absent)", function () {
    const xsPath = path.resolve(__dirname, "../backtest/report-crosssectional.json");
    if (!fs.existsSync(xsPath)) {
      expect(report.verdict.crossSectionalAddsValue).to.equal(false);
      return;
    }
    const xsr = JSON.parse(fs.readFileSync(xsPath, "utf8"));
    const ptOOS = xsr.aggregate.perToken.outOfSample;
    const xsOOS = xsr.aggregate.crossSectional.outOfSample;
    const expected =
      !!xsr.verdict.crossSectionalDiffersFromPerToken &&
      (xsOOS.totalReturn > ptOOS.totalReturn || xsOOS.maxDrawdown < ptOOS.maxDrawdown);
    expect(report.verdict.crossSectionalAddsValue).to.equal(expected);
    // and it must NOT claim a B&H beat on its own OOS tail (reported as-is).
    expect(report.crossSectional.beatsBuyHoldOOS).to.equal(false);
  });

  it("evaluateArm counts risk actions only when the filter layer is ON", function () {
    const universe = loadUniverse();
    const winner = selectInSample(universe, buildSweep(DEFAULT_WALK), DEFAULT_OOS_FRACTION).winner;
    const off = evaluateArm(universe, winner, LAYERS_GATE, DEFAULT_OOS_FRACTION);
    const on = evaluateArm(universe, winner, LAYERS_FULL, DEFAULT_OOS_FRACTION);
    expect(off.riskActions.trim + off.riskActions.veto).to.equal(0, "filter OFF must record 0 risk actions");
    expect(on.riskActions.trim + on.riskActions.veto).to.be.greaterThan(0, "filter ON must record some risk actions on the real series");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (f) ISOLATION — the frozen reports are untouched by this path
// ════════════════════════════════════════════════════════════════════════════
describe("ablation — does NOT touch the frozen report.json OR report-momentum.json", function () {
  this.timeout(60000);

  it("buildAblationReport never mutates report.json or report-momentum.json", function () {
    const frozenBefore = fs.existsSync(REPORT_JSON_PATH) ? fs.readFileSync(REPORT_JSON_PATH, "utf8") : null;
    const momentumBefore = fs.existsSync(MOMENTUM_REPORT_PATH) ? fs.readFileSync(MOMENTUM_REPORT_PATH, "utf8") : null;
    buildAblationReport(DEFAULT_OOS_FRACTION, DEFAULT_WALK);
    if (frozenBefore !== null) {
      expect(fs.readFileSync(REPORT_JSON_PATH, "utf8")).to.equal(frozenBefore, "frozen report.json bytes changed");
    }
    if (momentumBefore !== null) {
      expect(fs.readFileSync(MOMENTUM_REPORT_PATH, "utf8")).to.equal(momentumBefore, "report-momentum.json bytes changed");
    }
  });

  it("the ablation report writes to its OWN file, not report.json / report-momentum.json", function () {
    expect(ABLATION_REPORT_PATH).to.match(/report-ablation\.json$/);
    expect(ABLATION_REPORT_PATH).to.not.match(/[/\\]report\.json$/);
    expect(ABLATION_REPORT_PATH).to.not.match(/report-momentum\.json$/);
  });
});
