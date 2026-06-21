/**
 * Stoic — DRAWDOWN-BUCKET EXPOSURE SCALER tests.  [A5]
 *
 * Pins the two load-bearing properties of src/signal/drawdownState.ts and its wiring as the
 * A5 ablation arm in backtest/ablation.ts:
 *
 *   (a) MONOTONICITY — deeper underwater => a smaller-or-equal exposure multiplier. The bucket
 *       map and the running-state machine must never INCREASE exposure as drawdown deepens.
 *   (b) LOOK-AHEAD / TRUNCATION INVARIANCE — the multiplier emitted for a PAST bar depends only
 *       on the equity PREFIX through that bar; appending FUTURE equities (or future bars in the
 *       A5 walk) cannot change it. This is the property that makes A5 honest.
 *
 *   (c) ADDITIVITY — A5 is purely additive: with no drawdown the scaled walk reduces to the
 *       base ablationWalk byte-for-byte, and A1..A3 do not touch the scaled path. (The existing
 *       ablation.test.ts "A3 reproduces runStrategy byte-for-byte" guard is unaffected.)
 *
 * Pure + offline (synthetic + committed fixtures); NO network.
 */
import { expect } from "chai";
import {
  DrawdownState,
  DRAWDOWN_BUCKETS,
  multiplierForDrawdown,
  multipliersForEquitySeries,
  DD_EDGE_SHALLOW,
  DD_EDGE_MID,
  DD_EDGE_DEEP,
  DD_MULT_FULL,
  DD_MULT_MID,
  DD_MULT_DEEP,
  DD_MULT_FLOOR,
} from "../src/signal/drawdownState";
import {
  ablationConvictions,
  ablationWalk,
  ablationWalkDrawdownScaled,
  AblationLayers,
} from "../backtest/ablation";
import {
  buildSweep,
  selectInSample,
  loadUniverse,
  DEFAULT_WALK,
  DEFAULT_OOS_FRACTION,
} from "../backtest/momentum";
import { DailyBar, DAY_MS, utcDateString } from "../src/data/history";

const DAY0 = Date.UTC(2024, 0, 1);
const LAYERS_FULL: AblationLayers = { fgGate: true, riskFilter: true };

/** Deterministic wiggly multi-regime daily series (no Math.random) — drives real drawdowns. */
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
//  EXPORTED CONSTANTS — single-sourced bucket ladder is as documented
// ════════════════════════════════════════════════════════════════════════════
describe("drawdownState — exported bucket constants (single-sourced)", function () {
  it("edges + multipliers are exactly the documented de-risking ladder", function () {
    expect(DD_EDGE_SHALLOW).to.equal(0.05);
    expect(DD_EDGE_MID).to.equal(0.15);
    expect(DD_EDGE_DEEP).to.equal(0.25);
    expect(DD_MULT_FULL).to.equal(1.0);
    expect(DD_MULT_MID).to.equal(0.66);
    expect(DD_MULT_DEEP).to.equal(0.4);
    expect(DD_MULT_FLOOR).to.equal(0.2);
  });

  it("DRAWDOWN_BUCKETS is shallow->deep with edges matching the constants", function () {
    expect(DRAWDOWN_BUCKETS.map((b) => b.minDrawdown)).to.deep.equal([0, DD_EDGE_SHALLOW, DD_EDGE_MID, DD_EDGE_DEEP]);
    expect(DRAWDOWN_BUCKETS.map((b) => b.multiplier)).to.deep.equal([DD_MULT_FULL, DD_MULT_MID, DD_MULT_DEEP, DD_MULT_FLOOR]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (a) MONOTONICITY — deeper underwater => smaller-or-equal multiplier
// ════════════════════════════════════════════════════════════════════════════
describe("drawdownState — MONOTONICITY (deeper underwater => smaller exposure)", function () {
  it("multiplierForDrawdown is monotone NON-INCREASING in dd across the whole [0,1] sweep", function () {
    let prev = Infinity;
    for (let dd = 0; dd <= 1.0001; dd += 0.005) {
      const m = multiplierForDrawdown(dd);
      expect(m).to.be.at.most(prev + 1e-12, `multiplier INCREASED going deeper underwater at dd=${dd.toFixed(3)}`);
      prev = m;
    }
  });

  it("each band maps to its documented multiplier (incl. boundary edges)", function () {
    expect(multiplierForDrawdown(0)).to.equal(DD_MULT_FULL);
    expect(multiplierForDrawdown(0.049)).to.equal(DD_MULT_FULL);
    expect(multiplierForDrawdown(DD_EDGE_SHALLOW)).to.equal(DD_MULT_MID); // edge is inclusive lower
    expect(multiplierForDrawdown(0.10)).to.equal(DD_MULT_MID);
    expect(multiplierForDrawdown(DD_EDGE_MID)).to.equal(DD_MULT_DEEP);
    expect(multiplierForDrawdown(0.20)).to.equal(DD_MULT_DEEP);
    expect(multiplierForDrawdown(DD_EDGE_DEEP)).to.equal(DD_MULT_FLOOR);
    expect(multiplierForDrawdown(0.5)).to.equal(DD_MULT_FLOOR);
    expect(multiplierForDrawdown(1.0)).to.equal(DD_MULT_FLOOR);
  });

  it("a strictly DEEPER drawdown never yields a LARGER multiplier (pairwise)", function () {
    const ddPairs: Array<[number, number]> = [
      [0.0, 0.06], [0.06, 0.16], [0.16, 0.26], [0.10, 0.30], [0.04, 0.99],
    ];
    for (const [shallow, deep] of ddPairs) {
      expect(multiplierForDrawdown(deep)).to.be.at.most(multiplierForDrawdown(shallow), `dd ${deep} > dd ${shallow} but multiplier larger`);
    }
  });

  it("the DrawdownState multiplier shrinks (never grows) as the account sinks below its peak", function () {
    const st = new DrawdownState(1.0);
    expect(st.multiplier()).to.equal(DD_MULT_FULL); // at peak
    const sinking = [1.0, 0.97, 0.92, 0.80, 0.74, 0.70]; // monotonically deeper underwater
    let prev = Infinity;
    for (const e of sinking) {
      st.update(e);
      const m = st.multiplier();
      expect(m).to.be.at.most(prev + 1e-12, `multiplier grew while sinking to equity ${e}`);
      prev = m;
    }
    // deepest point (~30% underwater) sits at the floor.
    expect(st.multiplier()).to.equal(DD_MULT_FLOOR);
  });

  it("defensive: non-finite / negative dd -> full exposure (no drawdown)", function () {
    expect(multiplierForDrawdown(NaN)).to.equal(DD_MULT_FULL);
    expect(multiplierForDrawdown(-0.2)).to.equal(DD_MULT_FULL);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) LOOK-AHEAD / TRUNCATION INVARIANCE — appending FUTURE data can't change the PAST
// ════════════════════════════════════════════════════════════════════════════
describe("drawdownState — LOOK-AHEAD / truncation invariance", function () {
  it("multipliersForEquitySeries: a multiplier for bar i depends ONLY on equity[0..i]", function () {
    const equity = [1.0, 1.05, 1.10, 1.02, 0.95, 0.88, 0.80, 0.90, 1.00, 1.20];
    const full = multipliersForEquitySeries(equity);
    for (const k of [0, 3, 5, 8]) {
      const prefix = multipliersForEquitySeries(equity.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(prefix[i]).to.equal(full[i], `multiplier[${i}] changed when equities > ${k} were truncated`);
      }
    }
  });

  it("appending FUTURE equities (incl. a new all-time high) cannot change a PAST multiplier", function () {
    const past = [1.0, 1.1, 0.9, 0.8, 0.85];
    const before = multipliersForEquitySeries(past);
    for (const future of [[3.0], [0.01], [3.0, 0.01, 5.0]]) {
      const after = multipliersForEquitySeries([...past, ...future]);
      for (let i = 0; i < past.length; i++) {
        expect(after[i]).to.equal(before[i], `appending future equities changed past multiplier[${i}]`);
      }
    }
  });

  it("A5 walk: conviction/size + equity for bars 0..k identical on a TRUNCATED bar series", function () {
    const full = wiggleBars(220, 7);
    const convFull = ablationConvictions(full, {}, LAYERS_FULL);
    const wFull = ablationWalkDrawdownScaled(full, convFull, DEFAULT_WALK);
    for (const k of [40, 110, 190]) {
      const sub = full.slice(0, k + 1);
      const convTrunc = ablationConvictions(sub, {}, LAYERS_FULL);
      const wTrunc = ablationWalkDrawdownScaled(sub, convTrunc, DEFAULT_WALK);
      for (let i = 0; i <= k; i++) {
        expect(wTrunc.trace[i].equity).to.equal(wFull.trace[i].equity, `A5 equity[${i}] changed on truncation`);
        expect(wTrunc.trace[i].side).to.equal(wFull.trace[i].side, `A5 side[${i}] changed on truncation`);
        expect(wTrunc.trace[i].targetWeight).to.equal(wFull.trace[i].targetWeight, `A5 targetWeight[${i}] changed on truncation`);
      }
    }
  });

  it("A5 walk: mutating a FUTURE bar leaves ALL past A5 equity/weights untouched", function () {
    const bars = wiggleBars(150, 8);
    const before = ablationWalkDrawdownScaled(bars, ablationConvictions(bars, {}, LAYERS_FULL), DEFAULT_WALK);
    const mutated = bars.map((b, i) =>
      i === bars.length - 1 ? { ...b, close: b.close * 8, fearGreed: 99, funding: 0.02 } : b
    );
    const after = ablationWalkDrawdownScaled(mutated, ablationConvictions(mutated, {}, LAYERS_FULL), DEFAULT_WALK);
    for (let i = 0; i < bars.length - 1; i++) {
      expect(after.trace[i].equity).to.equal(before.trace[i].equity, `A5 equity[${i}] reacted to a FUTURE bar`);
      expect(after.trace[i].targetWeight).to.equal(before.trace[i].targetWeight, `A5 targetWeight[${i}] reacted to a FUTURE bar`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) ADDITIVITY — A5 reduces to the base walk when no drawdown ever de-risks
// ════════════════════════════════════════════════════════════════════════════
describe("drawdownState — A5 is PURELY ADDITIVE (no de-risk => base walk byte-for-byte)", function () {
  it("a strictly RISING bar series never de-risks: A5 walk == base ablationWalk byte-for-byte", function () {
    // A monotonically rising series can only ever set new equity peaks (dd stays 0 -> mult 1.0),
    // so the drawdown-scaled walk must equal the unscaled walk exactly.
    const rising: DailyBar[] = [];
    let close = 100;
    for (let i = 0; i < 200; i++) {
      const t = DAY0 + i * DAY_MS;
      const open = close;
      close = close * 1.01; // steady +1%/day up-trend, long-only -> equity only rises
      rising.push({
        date: utcDateString(t), t,
        open: Math.round(open * 1e4) / 1e4,
        high: Math.round(close * 1.005 * 1e4) / 1e4,
        low: Math.round(open * 0.995 * 1e4) / 1e4,
        close: Math.round(close * 1e4) / 1e4,
        volume: 1000 + i, fearGreed: 50, funding: 0,
      });
    }
    const convs = ablationConvictions(rising, {}, LAYERS_FULL);
    const base = ablationWalk(rising, convs, DEFAULT_WALK);
    const scaled = ablationWalkDrawdownScaled(rising, convs, DEFAULT_WALK);
    // every multiplier must have been 1.0 (no drawdown), so traces + trades match exactly.
    expect(multipliersForEquitySeries(base.trace.map((r) => r.equity)).every((m) => m === 1.0)).to.equal(true);
    expect(scaled.trace).to.deep.equal(base.trace);
    expect(scaled.trades).to.deep.equal(base.trades);
  });

  it("on a real drawdown series the A5 walk DOES de-risk (shaves the trough) — sanity", function () {
    const universe = loadUniverse();
    const winner = selectInSample(universe, buildSweep(DEFAULT_WALK), DEFAULT_OOS_FRACTION).winner;
    let anyScaled = false;
    for (const tok of universe) {
      const convs = ablationConvictions(tok.bars, winner.strategy, LAYERS_FULL);
      const base = ablationWalk(tok.bars, convs, winner.walk);
      const scaled = ablationWalkDrawdownScaled(tok.bars, convs, winner.walk);
      for (let i = 0; i < base.trace.length; i++) {
        if (Math.abs(base.trace[i].targetWeight) - Math.abs(scaled.trace[i].targetWeight) > 1e-9) {
          anyScaled = true; // scaled weight is strictly smaller somewhere => the scaler bit
        }
        // the scaler only ever REDUCES |exposure|, never increases it.
        expect(Math.abs(scaled.trace[i].targetWeight)).to.be.at.most(
          Math.abs(base.trace[i].targetWeight) + 1e-9,
          `${tok.symbol} bar ${i}: A5 INCREASED exposure vs base`
        );
      }
    }
    expect(anyScaled).to.equal(true, "the drawdown scaler never reduced exposure on the real universe — expected some de-risking");
  });
});
