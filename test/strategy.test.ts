/**
 * ============================================================================
 *  src/signal/momentum.ts + regimeGate.ts + strategy.ts — the regime-aware
 *  DIRECTIONAL strategy (the honest pivot).
 * ============================================================================
 *  Covers, per the Phase-1 brief:
 *   - DETERMINISM: identical input -> identical output (byte-reproducible backtest).
 *   - MONOTONICITY: stronger up-trend -> higher directional bias / conviction; the F&G
 *     gate monotonically trims a long into greed and dampens a short into fear; the risk
 *     filter monotonically reduces size (pass >= trim >= veto).
 *   - LOOK-AHEAD INVARIANCE: appending OR truncating FUTURE bars cannot change any PAST
 *     decision (the core property — momentum EMAs + gate + filter are all bounded to
 *     info at-or-before each bar).
 *   - EXPORTED-THRESHOLD BVA: the single-sourced knob constants are as documented and the
 *     extreme-fear / extreme-greed / dead-band edges behave at the boundary.
 *   - DIRECTIONAL SIGN: the core RIDES the trend (up-trend -> long), the OPPOSITE of the
 *     old contrarian engine — the whole point of the pivot.
 *
 *  Pure + offline (synthetic series + committed daily fixtures); NO network.
 */
import { expect } from "chai";
import {
  ema,
  momentumSignal,
  trendToBias,
  momentumToBias,
  EMA_FAST,
  EMA_SLOW,
  MOMENTUM_LOOKBACK,
  TREND_FULL_SEP,
  MOMENTUM_FULL_RET,
  TREND_WEIGHT,
  MOMENTUM_WEIGHT,
  MIN_OBS,
} from "../src/signal/momentum";
import {
  readRegimeGate,
  regimeGateGain,
  applyRegimeGate,
  FEAR_EXTREME,
  GREED_EXTREME,
  GATE_MAX,
  GATE_MIN,
} from "../src/signal/regimeGate";
import {
  runStrategy,
  scoreStrategyBar,
  strategyDecision,
  riskFilter,
  StrategyBar,
  StrategyBarInput,
  FUNDING_STRETCHED,
  RISK_FILTER_TRIM,
  RISK_FILTER_VETO_INTENSITY,
} from "../src/signal/strategy";
import { CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX, ENTRY_THRESHOLD } from "../src/signal/core";
import { NO_ADVICE } from "../src/data/cmc";
import { DailyBar, DAY_MS, utcDateString } from "../src/data/history";
import { loadDailyFixture, type DailyFixture } from "../src/data/fetchDailyHistory";
import { dailyFixturePath } from "../src/data/fetchDailyHistory";
import { DAILY_SYMBOLS } from "../src/data/history";
import * as fs from "fs";

const DAY0 = Date.UTC(2024, 0, 1);

// ── synthetic DAILY bar builders (CLEARLY synthetic — arbitrary fixtures, not market data) ──

/** A deterministic series with a controllable daily drift (so we can build bull/bear/chop). */
function trendBars(n: number, dailyDrift: number, opts: { fearGreed?: number; funding?: number; start?: number; base?: number } = {}): DailyBar[] {
  const bars: DailyBar[] = [];
  let close = opts.base ?? 100;
  const start = opts.start ?? DAY0;
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY_MS;
    const open = close;
    close = Math.max(0.01, open * (1 + dailyDrift));
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const bar: DailyBar = {
      date: utcDateString(t),
      t,
      open: Math.round(open * 1e4) / 1e4,
      high: Math.round(high * 1e4) / 1e4,
      low: Math.round(low * 1e4) / 1e4,
      close: Math.round(close * 1e4) / 1e4,
      volume: 1000 + i,
    };
    if (opts.fearGreed !== undefined) {
      bar.fearGreed = opts.fearGreed;
    }
    if (opts.funding !== undefined) bar.funding = opts.funding;
    bars.push(bar);
  }
  return bars;
}

/** A wiggly multi-regime series (deterministic, no Math.random) for invariance tests. */
function wiggleBars(n: number, seed = 1): DailyBar[] {
  const bars: DailyBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const t = DAY0 + i * DAY_MS;
    const w = Math.sin((i + seed) * 0.13) * 0.02 + Math.cos((i + seed) * 0.041) * 0.015;
    const open = close;
    close = Math.max(0.01, close * (1 + w));
    const high = Math.max(open, close) * 1.01;
    const low = Math.min(open, close) * 0.99;
    // F&G + funding oscillate so the gate + filter are actually exercised.
    const fg = Math.max(0, Math.min(100, Math.round(50 + 45 * Math.sin((i + seed) * 0.07))));
    bars.push({
      date: utcDateString(t),
      t,
      open: Math.round(open * 1e4) / 1e4,
      high: Math.round(high * 1e4) / 1e4,
      low: Math.round(low * 1e4) / 1e4,
      close: Math.round(close * 1e4) / 1e4,
      volume: 1000 + i,
      fearGreed: fg,
      funding: 0.0006 * Math.sin((i + seed) * 0.09),
    });
  }
  return bars;
}

// ════════════════════════════════════════════════════════════════════════════
//  momentum.ts — EMA + directional core
// ════════════════════════════════════════════════════════════════════════════
describe("momentum.ema — look-ahead-safe forward recurrence", function () {
  it("seeds on the first finite close and is a forward recurrence", function () {
    const e = ema([10, 10, 10, 10], 3);
    expect(e[0]).to.equal(10);
    e.forEach((v) => expect(v).to.equal(10)); // constant input -> constant EMA
  });

  it("rising series -> rising EMA, EMA lags below the latest close", function () {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8];
    const e = ema(closes, 3);
    for (let i = 1; i < e.length; i++) expect(e[i]).to.be.greaterThan(e[i - 1]);
    expect(e[e.length - 1]).to.be.lessThan(closes[closes.length - 1]); // lags
  });

  it("carries the last finite EMA across a non-finite close (no NaN poisoning)", function () {
    const e = ema([10, 20, NaN, 30], 3);
    e.forEach((v) => expect(isFinite(v)).to.equal(true));
  });

  it("PREFIX EQUALITY: ema[0..k] is identical whether or not closes > k exist", function () {
    const full = wiggleBars(120).map((b) => b.close);
    const eFull = ema(full, EMA_SLOW);
    for (const k of [20, 60, 100]) {
      const ePrefix = ema(full.slice(0, k + 1), EMA_SLOW);
      for (let i = 0; i <= k; i++) {
        expect(ePrefix[i]).to.equal(eFull[i], `ema[${i}] changed when closes > ${k} were truncated`);
      }
    }
  });
});

describe("momentum.trendToBias / momentumToBias — DIRECTIONAL sign (rides the trend)", function () {
  it("exported momentum knobs are as documented (single-sourced)", function () {
    expect(EMA_FAST).to.equal(20);
    expect(EMA_SLOW).to.equal(50);
    expect(MOMENTUM_LOOKBACK).to.equal(20);
    expect(TREND_FULL_SEP).to.equal(0.06);
    expect(MOMENTUM_FULL_RET).to.equal(0.15);
    expect(TREND_WEIGHT + MOMENTUM_WEIGHT).to.equal(1.0);
    expect(MIN_OBS).to.equal(EMA_SLOW);
  });

  it("fast EMA ABOVE slow -> bias ABOVE 500 (LONG / trend-following, NOT contrarian)", function () {
    expect(trendToBias(110, 100)).to.be.greaterThan(CONVICTION_FLAT);
  });
  it("fast EMA BELOW slow -> bias BELOW 500 (SHORT/flat)", function () {
    expect(trendToBias(90, 100)).to.be.lessThan(CONVICTION_FLAT);
  });
  it("equal EMAs -> exactly 500 (no trend edge)", function () {
    expect(trendToBias(100, 100)).to.equal(CONVICTION_FLAT);
  });
  it("saturates at +/- TREND_FULL_SEP", function () {
    expect(trendToBias(100 * (1 + TREND_FULL_SEP + 0.05), 100)).to.equal(CONVICTION_MAX);
    expect(trendToBias(100 * (1 - TREND_FULL_SEP - 0.05), 100)).to.equal(CONVICTION_MIN);
  });
  it("momentumToBias: positive return -> long (>500), negative -> short (<500), saturates", function () {
    expect(momentumToBias(0.05)).to.be.greaterThan(CONVICTION_FLAT);
    expect(momentumToBias(-0.05)).to.be.lessThan(CONVICTION_FLAT);
    expect(momentumToBias(MOMENTUM_FULL_RET + 0.1)).to.equal(CONVICTION_MAX);
    expect(momentumToBias(-(MOMENTUM_FULL_RET + 0.1))).to.equal(CONVICTION_MIN);
  });
  it("trendToBias is monotonic in separation", function () {
    const a = trendToBias(102, 100) - CONVICTION_FLAT;
    const b = trendToBias(105, 100) - CONVICTION_FLAT;
    expect(b).to.be.greaterThan(a);
  });
  it("non-finite / zero-slow inputs -> neutral 500 (defensive)", function () {
    expect(trendToBias(NaN, 100)).to.equal(CONVICTION_FLAT);
    expect(trendToBias(100, 0)).to.equal(CONVICTION_FLAT);
    expect(momentumToBias(NaN)).to.equal(CONVICTION_FLAT);
  });
});

describe("momentum.momentumSignal — per-bar directional read", function () {
  it("warms up (neutral 500) until MIN_OBS past closes, then reads a trend", function () {
    const bars = trendBars(120, 0.01); // steady +1%/day up-trend
    const sig = momentumSignal(bars.map((b) => b.close));
    for (let i = 0; i < MIN_OBS; i++) {
      expect(sig[i].warming).to.equal(true);
      expect(sig[i].directional).to.equal(CONVICTION_FLAT);
      expect(sig[i].sign).to.equal(0);
    }
    // well past warm-up in a steady up-trend -> long bias.
    expect(sig[110].warming).to.equal(false);
    expect(sig[110].directional).to.be.greaterThan(CONVICTION_FLAT);
    expect(sig[110].sign).to.equal(1);
  });

  it("DIRECTIONAL: a sustained up-trend -> long bias; a down-trend -> short bias", function () {
    const up = momentumSignal(trendBars(120, 0.012).map((b) => b.close));
    const down = momentumSignal(trendBars(120, -0.012).map((b) => b.close));
    expect(up[110].sign).to.equal(1);
    expect(down[110].sign).to.equal(-1);
  });

  it("MONOTONIC: a steeper up-trend -> a higher directional bias", function () {
    const gentle = momentumSignal(trendBars(120, 0.004).map((b) => b.close));
    const steep = momentumSignal(trendBars(120, 0.02).map((b) => b.close));
    expect(steep[110].directional).to.be.greaterThan(gentle[110].directional);
  });

  it("is deterministic (identical input -> identical output)", function () {
    const closes = wiggleBars(90).map((b) => b.close);
    expect(momentumSignal(closes)).to.deep.equal(momentumSignal(closes));
  });

  it("LOOK-AHEAD: per-bar read for 0..k is identical on a truncated series", function () {
    const full = wiggleBars(150).map((b) => b.close);
    const sigFull = momentumSignal(full);
    for (const k of [40, 80, 130]) {
      const sigTrunc = momentumSignal(full.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(sigTrunc[i].directional).to.equal(sigFull[i].directional, `directional[${i}] changed`);
        expect(sigTrunc[i].trend).to.equal(sigFull[i].trend, `trend[${i}] changed`);
        expect(sigTrunc[i].momentum).to.equal(sigFull[i].momentum, `momentum[${i}] changed`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  regimeGate.ts — F&G contrarian gate
// ════════════════════════════════════════════════════════════════════════════
describe("regimeGate — Fear&Greed contrarian gate (BVA + monotonicity)", function () {
  it("exported gate thresholds are as documented (single-sourced)", function () {
    expect(FEAR_EXTREME).to.equal(25);
    expect(GREED_EXTREME).to.equal(75);
    expect(GATE_MAX).to.equal(1.25);
    expect(GATE_MIN).to.equal(0.4);
  });

  it("BVA: F&G == FEAR_EXTREME -> extreme-fear favours LONG (+1)", function () {
    const r = readRegimeGate(FEAR_EXTREME);
    expect(r.label).to.equal("extreme-fear");
    expect(r.favored).to.equal(1);
  });
  it("BVA: F&G just above FEAR_EXTREME (26) -> not extreme-fear (neutral)", function () {
    expect(readRegimeGate(FEAR_EXTREME + 1).label).to.equal("neutral");
  });
  it("BVA: F&G == GREED_EXTREME -> extreme-greed favours SHORT/TRIM (-1)", function () {
    const r = readRegimeGate(GREED_EXTREME);
    expect(r.label).to.equal("extreme-greed");
    expect(r.favored).to.equal(-1);
  });
  it("undefined / non-finite F&G -> unknown (gate is a pass-through)", function () {
    expect(readRegimeGate(undefined).label).to.equal("unknown");
    expect(readRegimeGate(NaN).favored).to.equal(0);
  });
  it("intensity ramps deeper into the extreme (0 at the band edge, 1 at the 0/100 end)", function () {
    expect(readRegimeGate(GREED_EXTREME).intensity).to.equal(0);
    expect(readRegimeGate(100).intensity).to.equal(1);
    expect(readRegimeGate(FEAR_EXTREME).intensity).to.equal(0);
    expect(readRegimeGate(0).intensity).to.equal(1);
  });

  it("CONFIRM: extreme fear + LONG signal -> gain > 1 (boost); extreme greed + SHORT -> > 1", function () {
    expect(regimeGateGain(readRegimeGate(0), 1)).to.be.greaterThan(1.0);
    expect(regimeGateGain(readRegimeGate(100), -1)).to.be.greaterThan(1.0);
  });
  it("CONTRADICT: extreme greed + LONG -> gain < 1 (TRIM the top); extreme fear + SHORT -> < 1", function () {
    expect(regimeGateGain(readRegimeGate(100), 1)).to.be.lessThan(1.0);
    expect(regimeGateGain(readRegimeGate(0), -1)).to.be.lessThan(1.0);
  });
  it("neutral regime or flat signal -> gain exactly 1.0 (pass-through)", function () {
    expect(regimeGateGain(readRegimeGate(50), 1)).to.equal(1.0);
    expect(regimeGateGain(readRegimeGate(100), 0)).to.equal(1.0);
  });
  it("gain stays within [GATE_MIN, GATE_MAX] across the whole F&G range", function () {
    for (const fg of [0, 10, 25, 26, 50, 74, 75, 90, 100]) {
      for (const sign of [-1, 0, 1] as const) {
        const g = regimeGateGain(readRegimeGate(fg), sign);
        expect(g).to.be.within(GATE_MIN, GATE_MAX);
      }
    }
  });

  it("applyRegimeGate: extreme greed TRIMS a long bias toward 500; extreme fear BOOSTS it", function () {
    const long = 800;
    const trimmed = applyRegimeGate(long, 100).gatedBias; // extreme greed
    const boosted = applyRegimeGate(long, 0).gatedBias;   // extreme fear
    expect(trimmed).to.be.lessThan(long);
    expect(trimmed).to.be.greaterThan(CONVICTION_FLAT); // trimmed, not flipped
    expect(boosted).to.be.greaterThan(long - 1); // boosted (or clamped at 1000)
  });
  it("applyRegimeGate: extreme fear DAMPENS a short bias toward 500 (don't press a washout)", function () {
    const short = 200;
    const damped = applyRegimeGate(short, 0).gatedBias; // extreme fear vs a short
    expect(damped).to.be.greaterThan(short);            // pulled toward flat
    expect(damped).to.be.lessThan(CONVICTION_FLAT);     // still short, not flipped
  });
  it("applyRegimeGate never flips the directional sign (gate trims/boosts, never reverses)", function () {
    for (const bias of [120, 300, 480, 520, 700, 880]) {
      for (const fg of [0, 25, 50, 75, 100, undefined]) {
        const out = applyRegimeGate(bias, fg).gatedBias;
        const before = Math.sign(bias - CONVICTION_FLAT);
        const after = Math.sign(out - CONVICTION_FLAT);
        if (before !== 0) expect(after === before || after === 0).to.equal(true, `sign flipped: ${bias}@${fg} -> ${out}`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  strategy.ts — risk filter + assembly
// ════════════════════════════════════════════════════════════════════════════
describe("strategy.riskFilter — divergence/funding-into-euphoria size reduction / veto", function () {
  it("exported risk-filter knobs are as documented (single-sourced)", function () {
    expect(FUNDING_STRETCHED).to.equal(0.0005);
    expect(RISK_FILTER_TRIM).to.equal(0.5);
    expect(RISK_FILTER_VETO_INTENSITY).to.equal(0.6);
  });

  it("PASS: a long in NEUTRAL regime (no euphoria) -> edge factor 1, no reduction", function () {
    const r = riskFilter(800, readRegimeGate(50), 0.001);
    expect(r.action).to.equal("pass");
    expect(r.edgeFactor).to.equal(1);
  });

  it("TRIM: long + EXTREME GREED (mild) + stretched-positive funding -> reduced edge", function () {
    // F&G 80 -> greed intensity = (80-75)/25 = 0.2 (< veto 0.6) -> trim.
    const r = riskFilter(800, readRegimeGate(80), FUNDING_STRETCHED + 0.0001);
    expect(r.action).to.equal("trim");
    expect(r.edgeFactor).to.equal(RISK_FILTER_TRIM);
  });

  it("VETO: long + DEEP greed (intensity >= veto) + stretched-positive funding -> edge 0 (flat)", function () {
    // F&G 95 -> intensity = (95-75)/25 = 0.8 (>= 0.6) -> veto.
    const r = riskFilter(800, readRegimeGate(95), FUNDING_STRETCHED + 0.0001);
    expect(r.action).to.equal("veto");
    expect(r.edgeFactor).to.equal(0);
  });

  it("no trim when funding is NOT stretched (euphoria needs crowded positioning)", function () {
    const r = riskFilter(800, readRegimeGate(95), 0.0001); // greed but funding calm
    expect(r.action).to.equal("pass");
  });

  it("SYMMETRIC: short + extreme fear + stretched-NEGATIVE funding -> trim/veto a capitulation short", function () {
    // F&G 20 -> fear intensity = (25-20)/25 = 0.2 (< veto 0.6) -> trim.
    const trim = riskFilter(200, readRegimeGate(20), -(FUNDING_STRETCHED + 0.0001));
    expect(trim.action).to.equal("trim");
    // F&G 2 -> fear intensity = (25-2)/25 = 0.92 (>= 0.6) -> veto.
    const veto = riskFilter(200, readRegimeGate(2), -(FUNDING_STRETCHED + 0.0001));
    expect(veto.action).to.equal("veto");
  });

  it("MONOTONIC size reduction: pass (1) >= trim (riskTrim) >= veto (0)", function () {
    expect(1).to.be.gte(RISK_FILTER_TRIM);
    expect(RISK_FILTER_TRIM).to.be.gte(0);
  });

  it("live positioning sharpener: crowded long unconfirmed by taker trims even without funding", function () {
    const r = riskFilter(800, readRegimeGate(80), undefined, {}, { longShortRatio: 1.5, takerBuySellRatio: 0.9 });
    expect(r.action).to.equal("trim");
  });
});

describe("strategy.scoreStrategyBar / runStrategy — full pipeline assembly", function () {
  const mk = (dir: number, fearGreed?: number, funding?: number): StrategyBarInput => ({
    bar: 0,
    momentum: { bar: 0, trend: dir, momentum: dir, directional: dir, sign: dir > 500 ? 1 : dir < 500 ? -1 : 0, warming: false },
    fearGreed,
    funding,
  });

  it("a flat directional read -> conviction 500, flat size 0", function () {
    const r = scoreStrategyBar(mk(CONVICTION_FLAT, 50));
    expect(r.conviction).to.equal(CONVICTION_FLAT);
    expect(r.sizeBps).to.equal(0);
  });

  it("a long directional read in a neutral regime passes through -> conviction == directional", function () {
    const r = scoreStrategyBar(mk(800, 50, 0.0001));
    expect(r.gateGain).to.equal(1.0);
    expect(r.riskAction).to.equal("pass");
    expect(r.conviction).to.equal(800);
  });

  it("extreme greed TRIMS a long conviction below the ungated value (contrarian gate)", function () {
    const gated = scoreStrategyBar(mk(800, 100, 0.0001)).conviction;
    const ungated = scoreStrategyBar(mk(800, 50, 0.0001)).conviction;
    expect(gated).to.be.lessThan(ungated);
  });

  it("the risk VETO collapses a euphoric long to flat (conviction 500, size 0)", function () {
    const r = scoreStrategyBar(mk(900, 98, FUNDING_STRETCHED + 0.0002));
    expect(r.riskAction).to.equal("veto");
    expect(r.conviction).to.equal(CONVICTION_FLAT);
    expect(r.sizeBps).to.equal(0);
  });

  it("a {0,0} advisory cannot change the conviction (reproducible)", function () {
    const without = scoreStrategyBar({ ...mk(700, 50, 0.0001) });
    const withNoop = scoreStrategyBar({ ...mk(700, 50, 0.0001), advisories: [NO_ADVICE, { ...NO_ADVICE }] });
    expect(withNoop.conviction).to.equal(without.conviction);
  });

  it("a non-zero advisory genuinely moves the conviction (CMC/LLM hook works)", function () {
    const base = scoreStrategyBar(mk(700, 50, 0.0001)).conviction;
    const up = scoreStrategyBar({ ...mk(700, 50, 0.0001), advisories: [{ adjustment: 40, confidence: 1 }] }).conviction;
    const down = scoreStrategyBar({ ...mk(700, 50, 0.0001), advisories: [{ adjustment: -40, confidence: 1 }] }).conviction;
    expect(up).to.be.greaterThan(base);
    expect(down).to.be.lessThan(base);
  });

  it("runStrategy returns one record per bar, all convictions/sizes in range", function () {
    const sb = runStrategy(wiggleBars(120));
    expect(sb.length).to.equal(120);
    sb.forEach((r) => {
      expect(r.conviction).to.be.within(CONVICTION_MIN, CONVICTION_MAX);
      expect(r.sizeBps).to.be.within(0, 10000);
    });
  });

  it("runStrategy is deterministic", function () {
    const bars = wiggleBars(100, 3);
    expect(runStrategy(bars)).to.deep.equal(runStrategy(bars));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  THE CORE PROPERTY — LOOK-AHEAD INVARIANCE over the assembled strategy
// ════════════════════════════════════════════════════════════════════════════
describe("LOOK-AHEAD INVARIANCE — appending/truncating FUTURE bars cannot change the PAST", function () {
  it("runStrategy: conviction/size for bars 0..k is identical on a truncated series", function () {
    const full = wiggleBars(180, 2);
    const sbFull = runStrategy(full);
    for (const k of [30, 90, 150]) {
      const sbTrunc = runStrategy(full.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(sbTrunc[i].conviction).to.equal(sbFull[i].conviction, `conviction[${i}] changed when bars > ${k} were truncated`);
        expect(sbTrunc[i].sizeBps).to.equal(sbFull[i].sizeBps, `sizeBps[${i}] changed`);
        expect(sbTrunc[i].gatedBias).to.equal(sbFull[i].gatedBias, `gatedBias[${i}] changed`);
        expect(sbTrunc[i].riskAction).to.equal(sbFull[i].riskAction, `riskAction[${i}] changed`);
      }
    }
  });

  it("runStrategy: mutating a FUTURE bar leaves all PAST convictions untouched", function () {
    const bars = wiggleBars(120, 5);
    const before = runStrategy(bars);
    // mutate the LAST bar drastically — a past-only strategy must not react earlier.
    const mutated = bars.map((b, i) =>
      i === bars.length - 1
        ? { ...b, close: b.close * 10, fearGreed: 99, funding: 0.02 }
        : b
    );
    const after = runStrategy(mutated);
    for (let i = 0; i < bars.length - 1; i++) {
      expect(after[i].conviction).to.equal(before[i].conviction, `conviction[${i}] reacted to a FUTURE bar`);
    }
  });

  it("strategyDecision: per-bar decisions for 0..k are identical on a truncated series (with prev-side walk)", function () {
    const full = wiggleBars(160, 7);
    const sbFull = runStrategy(full);
    const decideAll = (sb: StrategyBar[]) => {
      const out: string[] = [];
      let prev: any = null;
      for (const s of sb) {
        const d = strategyDecision(prev, s);
        out.push(`${d.side}:${d.sizeBps}`);
        prev = d.side === "flat" ? prev : d.side;
      }
      return out;
    };
    const decFull = decideAll(sbFull);
    for (const k of [40, 100, 140]) {
      const decTrunc = decideAll(runStrategy(full.slice(0, k + 1)));
      for (let i = 0; i <= k; i++) {
        expect(decTrunc[i]).to.equal(decFull[i], `decision[${i}] changed when bars > ${k} were truncated`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  END-TO-END on the committed REAL multi-year DAILY fixtures (informational + sanity)
// ════════════════════════════════════════════════════════════════════════════
describe("strategy on committed DAILY fixtures — sanity + directional behaviour", function () {
  for (const symbol of DAILY_SYMBOLS) {
    const file = dailyFixturePath(symbol);
    if (!fs.existsSync(file)) continue;
    it(`${symbol}: produces a finite, in-range, deterministic strategy over the real series`, function () {
      const fx: DailyFixture = loadDailyFixture(symbol);
      const a = runStrategy(fx.bars);
      const b = runStrategy(fx.bars);
      expect(JSON.stringify(a)).to.equal(JSON.stringify(b)); // byte-deterministic
      a.forEach((r) => {
        expect(r.conviction).to.be.within(CONVICTION_MIN, CONVICTION_MAX);
        expect(r.sizeBps).to.be.within(0, 10000);
      });
      // truncation invariance on real data (the load-bearing property).
      const k = Math.floor(fx.bars.length / 2);
      const trunc = runStrategy(fx.bars.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(trunc[i].conviction).to.equal(a[i].conviction, `conviction[${i}] changed on real-data truncation`);
      }
    });
  }

  it("prints per-symbol side mix + risk-action counts (disclosure, not a claim)", function () {
    for (const symbol of DAILY_SYMBOLS) {
      const file = dailyFixturePath(symbol);
      if (!fs.existsSync(file)) {
        console.log(`  [strategy] ${symbol}: NO FIXTURE`);
        continue;
      }
      const fx = loadDailyFixture(symbol);
      const sb = runStrategy(fx.bars);
      let long = 0, short = 0, flat = 0, trim = 0, veto = 0;
      let prev: any = null;
      for (const s of sb) {
        if (s.riskAction === "trim") trim++;
        if (s.riskAction === "veto") veto++;
        const d = strategyDecision(prev, s);
        if (d.side === "long") long++; else if (d.side === "short") short++; else flat++;
        prev = d.side === "flat" ? prev : d.side;
      }
      console.log(
        `  [strategy] ${symbol} [${fx._synthetic ? "SYNTHETIC" : "REAL"}] ${fx.startDate}..${fx.endDate} ` +
          `(${sb.length} bars) sides long=${long} short=${short} flat=${flat} | risk trim=${trim} veto=${veto}`
      );
      expect(sb.length).to.equal(fx.bars.length);
    }
  });
});
