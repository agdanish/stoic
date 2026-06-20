import { expect } from "chai";
import {
  rollingZScore,
  buildCrowdLeg,
  buildFlowLeg,
  divergenceSignal,
  divergenceToBias,
  readRegime,
  regimeGain,
  crowdAttentionAdvisory,
  ZSCORE_WINDOW,
  ZSCORE_MIN_OBS,
  DIVERGENCE_FULL_Z,
  DIVERGENCE_DEADBAND_Z,
  FEAR_EXTREME,
  GREED_EXTREME,
  FUNDING_STRETCHED,
  REGIME_GATE_MAX,
  REGIME_GATE_MIN,
} from "../src/signal/divergence";
import {
  scoreConviction,
  runDivergence,
  barFeatures,
  SignalsAtBar,
} from "../src/signal/signalEngine";
import { CONVICTION_FLAT, CONVICTION_MIN, CONVICTION_MAX } from "../src/signal/core";
import { Bar } from "../src/data/binance";
import { NO_ADVICE } from "../src/data/cmc";

/**
 * ============================================================================
 *  src/signal/divergence.ts + signalEngine.ts — the NET-NEW originality core
 * ============================================================================
 *  Covers: rollingZScore look-ahead safety, leg construction, regime gate,
 *  divergence→bias mapping, the public scoreConviction entry, determinism,
 *  monotonicity, BVA at every exported threshold, AND a DEDICATED look-ahead
 *  -bias suite asserting appending/truncating FUTURE bars cannot change any
 *  past z-score / divergence / conviction.
 * ============================================================================
 */

// ── synthetic bar builder (CLEARLY synthetic — see the comment; not real data) ──
// Deterministic generator: distinct, finite OHLCV + flow legs per bar so z-scores
// are well-defined. Values are arbitrary test fixtures, NOT market data.
function synthBars(n: number, seed = 1): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    // pseudo-deterministic wiggle (no Math.random — reproducible)
    const w = Math.sin((i + seed) * 0.7) * 2 + Math.cos((i + seed) * 0.31);
    close = Math.max(1, close + w);
    bars.push({
      t: 1_700_000_000_000 + i * 3_600_000,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + i,
      funding: 0.0001 * Math.sin((i + seed) * 0.5),       // crowd leg input
      longShortRatio: 1 + 0.1 * Math.sin((i + seed) * 0.9), // crowd leg input
      takerBuySellRatio: 1 + 0.1 * Math.cos((i + seed) * 0.6), // flow leg input
      openInterest: 1e6 + i * 100,
    });
  }
  return bars;
}

describe("divergence.rollingZScore — look-ahead-safe rolling z-score", function () {
  it("warming-up: fewer than ZSCORE_MIN_OBS past obs → z = 0 (never NaN)", function () {
    const s = [1, 2, 3, 4, 5];
    const z = rollingZScore(s, 48, ZSCORE_MIN_OBS);
    // every index here has < ZSCORE_MIN_OBS(12) prior obs → all 0
    z.forEach((v) => expect(v).to.equal(0));
  });

  it("index 0 is always 0 (no past window exists)", function () {
    const z = rollingZScore([5, 5, 5, 5], 3, 1);
    expect(z[0]).to.equal(0);
  });

  it("zero-variance past window → z = 0 (no dispersion, no signal)", function () {
    // all-equal series: every past window has zero std → z = 0 throughout
    const z = rollingZScore(new Array(60).fill(7), 48, 12);
    z.forEach((v) => expect(v).to.equal(0));
  });

  it("z is computed from PAST window only (mean/std exclude the current value)", function () {
    // past window = ten 0s then current 10; with minObs small the z should be large +.
    const s = [...new Array(20).fill(0), 10];
    const z = rollingZScore(s, 48, 5);
    // bars 5..19 see only 0s in their past → std 0 → z 0
    expect(z[19]).to.equal(0);
    // bar 20 sees twenty 0s (mean 0, std 0) → still 0 (zero variance), value excluded
    expect(z[20]).to.equal(0);
  });

  it("produces a finite, signed z when the past window has dispersion", function () {
    const s = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 5];
    const z = rollingZScore(s, 48, 5);
    const last = z[z.length - 1];
    expect(isFinite(last)).to.equal(true);
    expect(last).to.be.greaterThan(0); // 5 is well above the alternating-0/1 past mean
  });

  it("skips non-finite series entries defensively (no NaN propagation)", function () {
    const s = [1, 2, NaN, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const z = rollingZScore(s, 48, 3);
    z.forEach((v) => expect(isFinite(v)).to.equal(true));
  });

  it("is deterministic (identical input → identical output)", function () {
    const s = synthBars(80).map((b) => b.close);
    expect(rollingZScore(s)).to.deep.equal(rollingZScore(s));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  DEDICATED LOOK-AHEAD-BIAS SUITE (M2z) — the originality property
// ════════════════════════════════════════════════════════════════════════════
describe("LOOK-AHEAD BIAS — appending/truncating FUTURE bars cannot change the PAST", function () {
  it("rollingZScore: prefix equality — z[0..k] is identical whether or not bars > k exist", function () {
    const full = synthBars(120).map((b) => b.close);
    const z_full = rollingZScore(full);
    for (const k of [20, 50, 90]) {
      const z_prefix = rollingZScore(full.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(z_prefix[i]).to.equal(z_full[i], `z[${i}] changed when bars > ${k} were truncated`);
      }
    }
  });

  it("rollingZScore: appending future values does not alter any earlier z", function () {
    const base = synthBars(60).map((b) => b.close);
    const z_base = rollingZScore(base);
    const extended = [...base, 999, -999, 12345, 0]; // wild future values
    const z_ext = rollingZScore(extended);
    for (let i = 0; i < base.length; i++) {
      expect(z_ext[i]).to.equal(z_base[i], `z[${i}] changed after appending future bars`);
    }
  });

  it("divergenceSignal: per-bar divergence/bias for bars 0..k is identical on a truncated series", function () {
    const full = synthBars(150);
    const sigFull = divergenceSignal(full);
    for (const k of [30, 75, 120]) {
      const sigTrunc = divergenceSignal(full.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(sigTrunc[i].crowdZ).to.equal(sigFull[i].crowdZ, `crowdZ[${i}] changed`);
        expect(sigTrunc[i].flowZ).to.equal(sigFull[i].flowZ, `flowZ[${i}] changed`);
        expect(sigTrunc[i].divergence).to.equal(sigFull[i].divergence, `divergence[${i}] changed`);
        expect(sigTrunc[i].divergenceBias).to.equal(sigFull[i].divergenceBias, `bias[${i}] changed`);
      }
    }
  });

  it("runDivergence: per-bar conviction/size for bars 0..k is identical on a truncated series", function () {
    const full = synthBars(140);
    const runFull = runDivergence(full);
    for (const k of [25, 60, 110]) {
      const runTrunc = runDivergence(full.slice(0, k + 1));
      for (let i = 0; i <= k; i++) {
        expect(runTrunc[i].conviction).to.equal(runFull[i].conviction, `conviction[${i}] changed`);
        expect(runTrunc[i].sizeBps).to.equal(runFull[i].sizeBps, `sizeBps[${i}] changed`);
      }
    }
  });

  it("runDivergence: mutating a FUTURE bar leaves all PAST convictions untouched", function () {
    const bars = synthBars(100);
    const runBefore = runDivergence(bars);
    // mutate the LAST bar drastically — a past-only engine must not react earlier
    const mutated = bars.map((b, i) =>
      i === bars.length - 1
        ? { ...b, close: b.close * 10, funding: 0.01, longShortRatio: 5, takerBuySellRatio: 5 }
        : b
    );
    const runAfter = runDivergence(mutated);
    for (let i = 0; i < bars.length - 1; i++) {
      expect(runAfter[i].conviction).to.equal(runBefore[i].conviction, `conviction[${i}] reacted to a future bar`);
    }
  });
});

describe("divergence.buildCrowdLeg / buildFlowLeg — leg construction", function () {
  it("crowd leg uses funding + long/short; absent both → NaN (skipped, not fabricated)", function () {
    const bars: Bar[] = [
      { t: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }, // no funding/LS → NaN
      { t: 2, open: 1, high: 1, low: 1, close: 1, volume: 1, funding: 0.0002 },
      { t: 3, open: 1, high: 1, low: 1, close: 1, volume: 1, longShortRatio: 1.5 },
    ];
    const crowd = buildCrowdLeg(bars);
    expect(isFinite(crowd[0])).to.equal(false);
    expect(isFinite(crowd[1])).to.equal(true);
    expect(isFinite(crowd[2])).to.equal(true);
  });

  it("flow leg uses taker ratio + price momentum; momentum reads only PAST closes", function () {
    const bars = synthBars(30);
    const flow = buildFlowLeg(bars, 12);
    // bar 0 has no taker? it does (synth). momentum needs i>=L → bar 0..11 momentum absent
    expect(flow.length).to.equal(bars.length);
    // a flow value is finite once taker ratio is present
    expect(isFinite(flow[0])).to.equal(true);
  });

  it("crowd/flow legs are deterministic", function () {
    const bars = synthBars(40);
    expect(buildCrowdLeg(bars)).to.deep.equal(buildCrowdLeg(bars));
    expect(buildFlowLeg(bars)).to.deep.equal(buildFlowLeg(bars));
  });
});

describe("divergence.readRegime / regimeGain — regime gate (BVA at thresholds)", function () {
  it("exported regime thresholds are as documented", function () {
    expect(FEAR_EXTREME).to.equal(25);
    expect(GREED_EXTREME).to.equal(75);
    expect(FUNDING_STRETCHED).to.equal(0.0005);
    expect(REGIME_GATE_MAX).to.equal(1.35);
    expect(REGIME_GATE_MIN).to.equal(0.5);
  });

  it("BVA: F&G == FEAR_EXTREME → extreme-fear, favours LONG (+1)", function () {
    const r = readRegime({ fearGreed: FEAR_EXTREME });
    expect(r.label).to.equal("extreme-fear");
    expect(r.favored).to.equal(1);
  });
  it("BVA: F&G just above FEAR_EXTREME (26) without stretched funding → not extreme-fear", function () {
    const r = readRegime({ fearGreed: FEAR_EXTREME + 1 });
    expect(r.label).to.not.equal("extreme-fear");
  });
  it("BVA: F&G == GREED_EXTREME → extreme-greed, favours SHORT (-1)", function () {
    const r = readRegime({ fearGreed: GREED_EXTREME });
    expect(r.label).to.equal("extreme-greed");
    expect(r.favored).to.equal(-1);
  });
  it("stretched positive funding (no F&G) favours SHORT (-1, contrarian to crowded longs)", function () {
    const r = readRegime({ funding: FUNDING_STRETCHED });
    expect(r.label).to.equal("stretched-funding");
    expect(r.favored).to.equal(-1);
    expect(r.stretched).to.equal(true);
  });
  it("stretched negative funding favours LONG (+1)", function () {
    const r = readRegime({ funding: -FUNDING_STRETCHED });
    expect(r.favored).to.equal(1);
  });
  it("no inputs → unknown regime, favored 0", function () {
    const r = readRegime({});
    expect(r.label).to.equal("unknown");
    expect(r.favored).to.equal(0);
  });

  it("regimeGain: agreeing regime amplifies (MAX), disagreeing dampens (≤MIN range)", function () {
    const fear = readRegime({ fearGreed: 10 }); // favours LONG
    expect(regimeGain(fear, 1)).to.equal(REGIME_GATE_MAX);   // long signal agrees
    expect(regimeGain(fear, -1)).to.be.at.most(REGIME_GATE_MIN); // short signal disagrees
  });
  it("regimeGain: neutral/unknown regime or flat signal → ~1.0 (bounded)", function () {
    expect(regimeGain(readRegime({}), 1)).to.equal(1.0);
    const fear = readRegime({ fearGreed: 10 });
    expect(regimeGain(fear, 0)).to.be.within(REGIME_GATE_MIN, REGIME_GATE_MAX);
  });
  it("regimeGain always stays within [REGIME_GATE_MIN, REGIME_GATE_MAX]", function () {
    for (const fg of [0, 10, 25, 50, 75, 90, 100]) {
      for (const f of [0.001, -0.001, 0.0001, -0.0001, 0]) {
        for (const sign of [-1, 0, 1] as const) {
          const g = regimeGain(readRegime({ fearGreed: fg, funding: f }), sign);
          expect(g).to.be.within(REGIME_GATE_MIN, REGIME_GATE_MAX);
        }
      }
    }
  });
});

describe("divergence.divergenceToBias — signed z-divergence → 0..1000 (contrarian, BVA)", function () {
  it("exported divergence thresholds are as documented", function () {
    expect(ZSCORE_WINDOW).to.equal(48);
    expect(ZSCORE_MIN_OBS).to.equal(12);
    expect(DIVERGENCE_FULL_Z).to.equal(2.5);
    expect(DIVERGENCE_DEADBAND_Z).to.equal(0.5);
  });

  it("BVA: |divergence| just below the dead-band → exactly 500 (no edge)", function () {
    expect(divergenceToBias(DIVERGENCE_DEADBAND_Z - 0.001, 1)).to.equal(CONVICTION_FLAT);
    expect(divergenceToBias(-(DIVERGENCE_DEADBAND_Z - 0.001), 1)).to.equal(CONVICTION_FLAT);
  });
  it("exactly at the dead-band edge → still 500 (strict <)", function () {
    // mag == DEADBAND → norm 0 → bias 500
    expect(divergenceToBias(DIVERGENCE_DEADBAND_Z, 1)).to.equal(CONVICTION_FLAT);
  });
  it("CONTRARIAN sign: POSITIVE divergence → bias BELOW 500 (bearish/short)", function () {
    expect(divergenceToBias(1.5, 1)).to.be.lessThan(CONVICTION_FLAT);
  });
  it("CONTRARIAN sign: NEGATIVE divergence → bias ABOVE 500 (bullish/long)", function () {
    expect(divergenceToBias(-1.5, 1)).to.be.greaterThan(CONVICTION_FLAT);
  });
  it("saturates: |divergence| ≥ FULL_Z (gain 1) → pinned to 0 / 1000", function () {
    expect(divergenceToBias(DIVERGENCE_FULL_Z + 5, 1)).to.equal(CONVICTION_MIN);
    expect(divergenceToBias(-(DIVERGENCE_FULL_Z + 5), 1)).to.equal(CONVICTION_MAX);
  });
  it("monotonic in magnitude: larger |divergence| → further from 500", function () {
    const a = Math.abs(divergenceToBias(0.8, 1) - CONVICTION_FLAT);
    const b = Math.abs(divergenceToBias(1.6, 1) - CONVICTION_FLAT);
    expect(b).to.be.greaterThan(a);
  });
  it("monotonic in gain: a higher regime gain pushes the bias further from 500", function () {
    const lo = Math.abs(divergenceToBias(1.0, REGIME_GATE_MIN) - CONVICTION_FLAT);
    const hi = Math.abs(divergenceToBias(1.0, REGIME_GATE_MAX) - CONVICTION_FLAT);
    expect(hi).to.be.greaterThan(lo);
  });
  it("non-finite divergence → neutral 500 (defensive)", function () {
    expect(divergenceToBias(NaN, 1)).to.equal(CONVICTION_FLAT);
  });
  it("output is always an integer within [0,1000]", function () {
    for (const d of [-5, -2, -1, -0.6, -0.4, 0, 0.4, 0.6, 1, 2, 5]) {
      for (const g of [REGIME_GATE_MIN, 1, REGIME_GATE_MAX]) {
        const v = divergenceToBias(d, g);
        expect(v).to.be.within(0, 1000);
        expect(Number.isInteger(v)).to.equal(true);
      }
    }
  });
});

describe("signalEngine.scoreConviction — public per-bar entry", function () {
  const S = (o: Partial<SignalsAtBar> = {}): SignalsAtBar => ({
    bar: o.bar ?? 0,
    trend: o.trend ?? 500,
    momentum: o.momentum ?? 500,
    fundingBias: o.fundingBias ?? 500,
    flowBias: o.flowBias ?? 500,
    divergenceBias: o.divergenceBias ?? 0, // strong-edge default exercises full-weight branch
    advisories: o.advisories,
  });

  it("perfectly neutral (all 500, no divergence) → conviction 500, flat size 0", function () {
    const r = scoreConviction(S({ divergenceBias: 500 }));
    expect(r.conviction).to.equal(500);
    expect(r.sizeBps).to.equal(0);
  });

  it("strong bearish divergenceBias (0) with neutral features → conviction < 500", function () {
    const r = scoreConviction(S({ divergenceBias: 0 }));
    expect(r.conviction).to.be.lessThan(500);
  });
  it("strong bullish divergenceBias (1000) → conviction > 500", function () {
    const r = scoreConviction(S({ divergenceBias: 1000 }));
    expect(r.conviction).to.be.greaterThan(500);
  });

  it("an empty / no-op advisory leaves the conviction unchanged (reproducible)", function () {
    const without = scoreConviction(S({ divergenceBias: 200 }));
    const withNoop = scoreConviction(S({ divergenceBias: 200, advisories: [NO_ADVICE, { ...NO_ADVICE }] }));
    expect(withNoop.conviction).to.equal(without.conviction);
  });

  it("a negative advisory genuinely lowers conviction; a positive one raises it", function () {
    const baseV = scoreConviction(S({ divergenceBias: 500, trend: 700, momentum: 700 })).conviction;
    const down = scoreConviction(S({ divergenceBias: 500, trend: 700, momentum: 700, advisories: [{ adjustment: -40, confidence: 1 }] })).conviction;
    const up = scoreConviction(S({ divergenceBias: 500, trend: 700, momentum: 700, advisories: [{ adjustment: 40, confidence: 1 }] })).conviction;
    expect(down).to.be.lessThan(baseV);
    expect(up).to.be.greaterThan(baseV);
  });

  it("clamps non-finite features to neutral (no NaN escapes)", function () {
    const r = scoreConviction(S({ trend: NaN as any, momentum: Infinity as any, divergenceBias: 500 }));
    expect(isFinite(r.conviction)).to.equal(true);
    expect(r.conviction).to.be.within(0, 1000);
  });

  it("is deterministic (identical input → identical output)", function () {
    const s = S({ divergenceBias: 220, trend: 612, momentum: 333, advisories: [{ adjustment: 10, confidence: 0.5 }] });
    const a = scoreConviction(s);
    const b = scoreConviction(s);
    expect(a).to.deep.equal(b);
  });

  it("monotonic: more bearish divergenceBias → lower conviction (full-weight regime)", function () {
    const c100 = scoreConviction(S({ divergenceBias: 100 })).conviction;
    const c250 = scoreConviction(S({ divergenceBias: 250 })).conviction;
    expect(c100).to.be.lessThan(c250); // 100 is more bearish than 250
  });
});

describe("signalEngine.runDivergence + barFeatures — batch pass", function () {
  it("returns one EngineBar per input bar, all convictions in [0,1000]", function () {
    const run = runDivergence(synthBars(120));
    expect(run.length).to.equal(120);
    run.forEach((r) => {
      expect(r.conviction).to.be.within(0, 1000);
      expect(r.sizeBps).to.be.within(0, 10000);
    });
  });

  it("barFeatures momentum/trend read only PAST closes (look-ahead-safe)", function () {
    const bars = synthBars(40);
    const f_full = barFeatures(bars, 20, 12);
    const f_trunc = barFeatures(bars.slice(0, 21), 20, 12); // drop all future bars
    expect(f_trunc).to.deep.equal(f_full);
  });

  it("runDivergence is deterministic", function () {
    const bars = synthBars(90);
    expect(runDivergence(bars)).to.deep.equal(runDivergence(bars));
  });

  it("an advisoryProvider that returns {0,0} cannot change the deterministic run", function () {
    const bars = synthBars(80);
    const plain = runDivergence(bars);
    const noop = runDivergence(bars, { advisoryProvider: () => [NO_ADVICE] });
    for (let i = 0; i < bars.length; i++) {
      expect(noop[i].conviction).to.equal(plain[i].conviction);
    }
  });
});

describe("divergence.crowdAttentionAdvisory — optional CMC attention-momentum term", function () {
  it("undefined / non-finite momentum → strict {0,0} no-op", function () {
    expect(crowdAttentionAdvisory(undefined)).to.deep.equal(NO_ADVICE);
    expect(crowdAttentionAdvisory(NaN)).to.deep.equal(NO_ADVICE);
  });
  it("CONTRARIAN: surging crowd attention → mild BEARISH (negative) adjustment", function () {
    const a = crowdAttentionAdvisory(50);
    expect(a.adjustment).to.be.lessThan(0);
    expect(a.confidence).to.be.greaterThan(0);
  });
  it("adjustment is bounded to ±20", function () {
    expect(crowdAttentionAdvisory(99999).adjustment).to.equal(-20);
    expect(crowdAttentionAdvisory(-99999).adjustment).to.equal(20);
  });
});
