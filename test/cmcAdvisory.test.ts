/**
 * Stoic — KEYED CMC advisory wiring tests.  [gap 2 — CMC in the evaluated loop]
 *
 * The independent eval's gap #2: CoinMarketCap never touched the EVALUATED product — the
 * backtester never set RunOpts.advisoryProvider, so every committed metric was 100% Binance.
 * src/signal/cmcAdvisory.ts builds a real KEYED advisory provider (Fear&Greed -> fearGreed-
 * Advisory, RSI -> rsiAdvisory, folded through core.blendScore) and engine.ts forwards it
 * into runDivergence. These tests pin the binding guarantees:
 *
 *   (a) UNKEYED DEFAULT = STRICT {0,0} NO-OP. With no key, buildCmcSnapshot returns the
 *       EMPTY snapshot and the provider returns the strict no-op on every bar, so the
 *       conviction is BYTE-IDENTICAL to the no-provider path (report.json + tests unchanged).
 *   (b) KEYED, NON-NEUTRAL SNAPSHOT MOVES THE PRODUCT. A real CMC read (extreme greed / fear)
 *       demonstrably shifts the conviction the backtester walks — the gap-2 claim.
 *   (c) LOOK-AHEAD SAFE. The provider reads NO bar data, so it is truncation-invariant:
 *       truncating the series at bar k leaves every conviction < k byte-identical.
 *   (d) SIGN-FLIP WITH REGIME. Extreme fear tilts contrarian-bullish (+), extreme greed
 *       contrarian-bearish (-), neutral ~zero — the tilt tracks the CMC field, not a constant.
 *   (e) BYTE-REPRODUCIBLE comparison report (backtest/report-cmc-compare.json).
 *
 * Offline + pure: no network, no key. The provider's IO (buildCmcSnapshot) is exercised only
 * for its keyless no-op contract; the live HTTP branch is covered by the recorded-cassette
 * test (test/cmcLive.test.ts) when a key/cassette is present.
 */
import { expect } from "chai";
import * as fs from "fs";

// Ensure keyless (FIXTURE/no-op) transport regardless of ambient env.
delete process.env.CMC_MCP_API_KEY;

import { Bar } from "../src/data/binance";
import { loadBarsFixture, SYMBOLS } from "../src/data/fetchHistory";
import { runDivergence } from "../src/signal/signalEngine";
import { runBacktest, DEFAULT_PARAMS, BacktestParams } from "../backtest/engine";
import {
  cmcAdvisoryProvider,
  buildCmcSnapshot,
  baseSymbol,
  EMPTY_CMC_SNAPSHOT,
  CmcSnapshot,
} from "../src/signal/cmcAdvisory";
import {
  buildCmcCompareReport,
  serializeCmcCompareReport,
  COMPARE_SNAPSHOT,
  CMC_COMPARE_OOS_FRACTION,
  CMC_COMPARE_REPORT_PATH,
} from "../backtest/cmc-compare";
import { hasLiveKey, NO_ADVICE } from "../src/data/cmc";

const greed: CmcSnapshot = { fearGreed: { value: 90, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" };
const fear: CmcSnapshot = { fearGreed: { value: 10, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" };
const neutral: CmcSnapshot = { fearGreed: { value: 50, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" };

function bars(symbol = "BTCUSDT"): Bar[] {
  return loadBarsFixture(symbol).bars;
}

// ════════════════════════════════════════════════════════════════════════════
//  (a) UNKEYED DEFAULT = STRICT {0,0} NO-OP  (report.json + tests unchanged)
// ════════════════════════════════════════════════════════════════════════════
describe("cmcAdvisory — unkeyed default is a strict {0,0} no-op", () => {
  it("hasLiveKey() is false in the test env (default keyless path)", () => {
    expect(hasLiveKey()).to.equal(false);
  });

  it("buildCmcSnapshot() returns the EMPTY snapshot with no key and does NO IO", async () => {
    const snap = await buildCmcSnapshot("BTCUSDT");
    expect(snap.fearGreed.available).to.equal(false);
    expect(snap.rsi.available).to.equal(false);
    expect(snap.source).to.equal("none");
  });

  it("the EMPTY-snapshot provider returns an empty advisory array on every bar", () => {
    const provider = cmcAdvisoryProvider(EMPTY_CMC_SNAPSHOT);
    const b = bars();
    for (let i = 0; i < Math.min(50, b.length); i++) {
      const adv = provider(b[i], { bar: i } as any, i);
      expect(adv).to.be.an("array").with.lengthOf(0);
    }
  });

  it("runDivergence WITH the empty-snapshot provider == WITHOUT any provider (byte-identical conviction)", () => {
    for (const s of SYMBOLS) {
      const b = bars(s);
      const off = runDivergence(b, {});
      const on = runDivergence(b, { advisoryProvider: cmcAdvisoryProvider(EMPTY_CMC_SNAPSHOT) });
      expect(on.length).to.equal(off.length);
      for (let i = 0; i < b.length; i++) {
        expect(on[i].conviction, `${s} bar ${i} conviction drifted`).to.equal(off[i].conviction);
        expect(on[i].sizeBps, `${s} bar ${i} size drifted`).to.equal(off[i].sizeBps);
      }
    }
  });

  it("runBacktest WITH an empty-snapshot provider == WITHOUT one (same trace, trades, metrics)", () => {
    const b = bars();
    const off = runBacktest(b, DEFAULT_PARAMS);
    const onParams: BacktestParams = { ...DEFAULT_PARAMS, advisoryProvider: cmcAdvisoryProvider(EMPTY_CMC_SNAPSHOT) };
    const on = runBacktest(b, onParams);
    expect(JSON.stringify(on.full)).to.equal(JSON.stringify(off.full));
    expect(on.trades.length).to.equal(off.trades.length);
    expect(JSON.stringify(on.trace)).to.equal(JSON.stringify(off.trace));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (b) KEYED, NON-NEUTRAL SNAPSHOT MEASURABLY MOVES THE PRODUCT
// ════════════════════════════════════════════════════════════════════════════
describe("cmcAdvisory — a keyed non-neutral CMC read moves the conviction", () => {
  it("extreme-greed snapshot changes the conviction on bars vs the offline run", () => {
    const b = bars();
    const off = runDivergence(b, {});
    const on = runDivergence(b, { advisoryProvider: cmcAdvisoryProvider(greed) });
    const changed = b.filter((_x, i) => on[i].conviction !== off[i].conviction).length;
    expect(changed, "expected the CMC read to move at least one bar's conviction").to.be.greaterThan(0);
  });

  it("the provider emits the F&G advisory (non-empty) for a greed snapshot", () => {
    const provider = cmcAdvisoryProvider(greed);
    const adv = provider(bars()[100], { bar: 100 } as any, 100);
    expect(adv.length).to.be.greaterThan(0);
    // extreme greed -> contrarian-bearish -> negative adjustment
    expect(adv[0].adjustment).to.be.lessThan(0);
  });

  it("runBacktest metrics differ between CMC=ON (greed) and CMC=OFF on the full series", () => {
    const b = bars();
    const off = runBacktest(b, DEFAULT_PARAMS);
    const on = runBacktest(b, { ...DEFAULT_PARAMS, advisoryProvider: cmcAdvisoryProvider(greed) });
    // SOMETHING must differ (return and/or trade count) — CMC is not a no-op here.
    const differs =
      off.full.totalReturn !== on.full.totalReturn || off.full.tradeCount !== on.full.tradeCount;
    expect(differs, "CMC=ON produced identical metrics to CMC=OFF (wiring is a no-op?)").to.equal(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (c) LOOK-AHEAD SAFE  (truncation invariance — provider reads no bar data)
// ════════════════════════════════════════════════════════════════════════════
describe("cmcAdvisory — look-ahead-safe (truncation invariant)", () => {
  it("truncating the series at bar k leaves every conviction < k byte-identical (CMC=ON)", () => {
    const b = bars();
    const provider = () => cmcAdvisoryProvider(greed); // fresh provider per run (frozen internally)
    const full = runDivergence(b, { advisoryProvider: provider() });
    for (const k of [50, 120, 300, b.length - 1]) {
      if (k <= 0 || k >= b.length) continue;
      const truncated = runDivergence(b.slice(0, k), { advisoryProvider: provider() });
      expect(truncated.length).to.equal(k);
      for (let i = 0; i < k; i++) {
        expect(truncated[i].conviction, `bar ${i} changed when truncating at ${k}`).to.equal(full[i].conviction);
      }
    }
  });

  it("the advisory for bar i is independent of i (a constant exogenous read — no bar leakage)", () => {
    const provider = cmcAdvisoryProvider(fear);
    const b = bars();
    const a0 = JSON.stringify(provider(b[0], { bar: 0 } as any, 0));
    for (let i = 1; i < Math.min(200, b.length); i++) {
      expect(JSON.stringify(provider(b[i], { bar: i } as any, i)), `advisory varied at bar ${i}`).to.equal(a0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (d) SIGN-FLIP WITH REGIME  (the tilt tracks the CMC field, not a constant)
// ════════════════════════════════════════════════════════════════════════════
describe("cmcAdvisory — the conviction tilt flips sign with the CMC regime read", () => {
  const meanDelta = (snap: CmcSnapshot): number => {
    const b = bars();
    const off = runDivergence(b, {});
    const on = runDivergence(b, { advisoryProvider: cmcAdvisoryProvider(snap) });
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += on[i].conviction - off[i].conviction;
    return sum / b.length;
  };

  it("extreme fear tilts the mean conviction BULLISH (> 0)", () => {
    expect(meanDelta(fear)).to.be.greaterThan(0);
  });
  it("extreme greed tilts the mean conviction BEARISH (< 0)", () => {
    expect(meanDelta(greed)).to.be.lessThan(0);
  });
  it("a neutral F&G (50) tilts ~nothing (mean delta == 0)", () => {
    expect(meanDelta(neutral)).to.equal(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (e) BYTE-REPRODUCIBLE comparison report + helpers
// ════════════════════════════════════════════════════════════════════════════
describe("cmc-compare report — byte-reproducible + asserts CMC moves the product", () => {
  it("baseSymbol strips the quote suffix (BTCUSDT -> BTC)", () => {
    expect(baseSymbol("BTCUSDT")).to.equal("BTC");
    expect(baseSymbol("ethusdt")).to.equal("ETH");
    expect(baseSymbol("BNB")).to.equal("BNB");
  });

  it("buildCmcCompareReport reports cmcMovesProduct=true (the keyed run differs from offline)", () => {
    const r = buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION);
    expect(r.cmcMovesProduct).to.equal(true);
    expect(r.aggregate.convictionBarsChanged).to.be.greaterThan(0);
    expect(r.perToken.every((p) => p.differs)).to.equal(true);
  });

  it("the sensitivity sweep shows the tilt FLIPS sign across regimes (fear+ vs greed-)", () => {
    const r = buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION);
    const byLabel = (sub: string) => r.sensitivitySweep.find((s) => s.label.includes(sub));
    const f = byLabel("extreme-fear");
    const g = byLabel("extreme-greed");
    const n = byLabel("neutral");
    expect(f, "missing extreme-fear scenario").to.not.equal(undefined);
    expect(g, "missing extreme-greed scenario").to.not.equal(undefined);
    expect(f!.convictionMeanDelta).to.be.greaterThan(0);
    expect(g!.convictionMeanDelta).to.be.lessThan(0);
    expect(n!.convictionMeanDelta).to.equal(0);
  });

  it("serializes deterministically (same input -> byte-identical)", () => {
    const a = serializeCmcCompareReport(buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION));
    const b = serializeCmcCompareReport(buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION));
    expect(a).to.equal(b);
  });

  it("matches the committed backtest/report-cmc-compare.json byte-for-byte (run `ts-node backtest/cmc-compare.ts` if this fails)", () => {
    const built = serializeCmcCompareReport(buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION));
    const committed = fs.readFileSync(CMC_COMPARE_REPORT_PATH, "utf8");
    expect(built).to.equal(committed);
  });

  it("carries NO wall-clock field (stays diff-stable)", () => {
    const built = serializeCmcCompareReport(buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION));
    expect(built).to.not.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no ISO timestamp
  });

  it("NO_ADVICE remains the documented strict no-op (the contract the no-op path relies on)", () => {
    expect(NO_ADVICE).to.deep.equal({ adjustment: 0, confidence: 0 });
  });
});
