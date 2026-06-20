/**
 * Stoic — bar fixture + Binance-adapter tests.  [M1d]
 *
 * Guarantees:
 *   1. SCHEMA + MONOTONICITY — every committed fixtures/bars/<SYMBOL>.json parses to the
 *      BarsFixture contract, has strictly-ascending unique hourly timestamps, and OHLCV
 *      that is finite + internally consistent (low <= open/close <= high). This is the
 *      look-ahead-safety precondition for the M5 backtest (ordered, non-duplicated bars).
 *   2. JOIN CORRECTNESS — joinBars aligns flow series onto OHLCV by timestamp, forward-
 *      fills 8h funding, leaves uncovered fields undefined (no fabrication), and tags the
 *      settle bar. validateBars catches a non-ascending series.
 *
 * Pure + offline (reads committed fixtures + in-memory fixtures); no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import {
  Bar,
  Kline,
  HOUR_MS,
  joinBars,
  validateBars,
} from "../src/data/binance";
import {
  SYMBOLS,
  fixturePath,
  loadBarsFixture,
  synthSeries,
  type BarsFixture,
} from "../src/data/fetchHistory";

describe("binance.validateBars — schema + monotonicity (pure)", () => {
  const good: Bar[] = [
    { t: 1000, open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { t: 1000 + HOUR_MS, open: 11, high: 13, low: 10, close: 12, volume: 6 },
  ];

  it("accepts a finite, ordered, strictly-ascending series", () => {
    const v = validateBars(good);
    expect(v.ok).to.equal(true);
    expect(v.count).to.equal(2);
    expect(v.errors).to.deep.equal([]);
  });

  it("rejects an empty series", () => {
    const v = validateBars([]);
    expect(v.ok).to.equal(false);
    expect(v.count).to.equal(0);
  });

  it("rejects non-strictly-ascending timestamps (look-ahead hazard)", () => {
    const dup: Bar[] = [
      { t: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { t: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    expect(validateBars(dup).ok).to.equal(false);
    const desc: Bar[] = [
      { t: 3000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { t: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    expect(validateBars(desc).ok).to.equal(false);
  });

  it("rejects high < low and high < max(open,close)", () => {
    const bad: Bar[] = [{ t: 1, open: 10, high: 8, low: 9, close: 11, volume: 1 }];
    expect(validateBars(bad).ok).to.equal(false);
  });

  it("reports per-field coverage of optional flow legs", () => {
    const mixed: Bar[] = [
      { t: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, funding: 0.0001 },
      { t: 1 + HOUR_MS, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    const v = validateBars(mixed);
    expect(v.coverage.funding).to.equal(0.5);
    expect(v.coverage.longShortRatio).to.equal(0);
  });
});

describe("binance.joinBars — align flow series onto OHLCV by timestamp (pure)", () => {
  const klines: Kline[] = [
    { t: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, closeTime: HOUR_MS - 1 },
    { t: HOUR_MS, open: 1.5, high: 2.5, low: 1, close: 2, volume: 1, closeTime: 2 * HOUR_MS - 1 },
    { t: 2 * HOUR_MS, open: 2, high: 3, low: 1.5, close: 2.5, volume: 1, closeTime: 3 * HOUR_MS - 1 },
  ];

  it("matches hourly-grid series (longShort/taker/OI) on exact timestamp; leaves gaps undefined", () => {
    const bars = joinBars(klines, {
      longShort: [{ t: HOUR_MS, longShortRatio: 1.5 }],
      taker: [{ t: 2 * HOUR_MS, takerBuySellRatio: 1.1 }],
      openInterest: [{ t: 0, openInterest: 1000 }],
    });
    expect(bars).to.have.length(3);
    expect(bars[0].openInterest).to.equal(1000);
    expect(bars[0].longShortRatio).to.equal(undefined); // no fabrication
    expect(bars[1].longShortRatio).to.equal(1.5);
    expect(bars[2].takerBuySellRatio).to.equal(1.1);
  });

  it("forward-fills 8h funding and tags only the settle bar; no look-ahead", () => {
    // a single settle at t=0 should carry forward to t=1h and t=2h
    const bars = joinBars(klines, { funding: [{ t: 0, funding: 0.0002 }] });
    expect(bars[0].funding).to.equal(0.0002);
    expect(bars[0].fundingSettled).to.equal(true);
    expect(bars[1].funding).to.equal(0.0002);
    expect(bars[1].fundingSettled).to.equal(undefined);
    expect(bars[2].funding).to.equal(0.0002);
  });

  it("does not leak a future funding settle backward (look-ahead-safe)", () => {
    // settle lands at t=2h: bars at t=0 and t=1h must NOT see it.
    const bars = joinBars(klines, { funding: [{ t: 2 * HOUR_MS, funding: 0.0009 }] });
    expect(bars[0].funding).to.equal(undefined);
    expect(bars[1].funding).to.equal(undefined);
    expect(bars[2].funding).to.equal(0.0009);
    expect(bars[2].fundingSettled).to.equal(true);
  });

  it("produces a strictly-ascending joined series even from unsorted klines", () => {
    const shuffled = [klines[2], klines[0], klines[1]];
    const bars = joinBars(shuffled, {});
    expect(validateBars(bars).ok).to.equal(true);
  });
});

describe("fetchHistory.synthSeries — deterministic labelled fallback (pure)", () => {
  it("is byte-reproducible for a fixed (symbol, start, count) and passes validation", () => {
    const a = synthSeries("BTCUSDT", 0, 50);
    const b = synthSeries("BTCUSDT", 0, 50);
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
    expect(validateBars(a).ok).to.equal(true);
    expect(a).to.have.length(50);
  });
});

describe("committed bar fixtures — schema + monotonicity (REAL or SYNTHETIC)", () => {
  for (const symbol of SYMBOLS) {
    describe(symbol, () => {
      const file = fixturePath(symbol);
      const exists = fs.existsSync(file);

      it("fixture file exists (run `npm run fetch-data` if missing)", () => {
        expect(exists, `missing ${file}`).to.equal(true);
      });

      if (!exists) return;

      const fx: BarsFixture = loadBarsFixture(symbol);

      it("declares the BarsFixture contract fields", () => {
        expect(fx).to.have.property("_synthetic");
        expect(typeof fx._synthetic).to.equal("boolean");
        expect(fx).to.have.property("_source");
        expect(fx.interval).to.equal("1h");
        expect(fx.symbol).to.equal(symbol);
        expect(Array.isArray(fx.bars)).to.equal(true);
        expect(fx.count).to.equal(fx.bars.length);
      });

      it("has a non-trivial multi-bar series", () => {
        expect(fx.bars.length).to.be.greaterThan(100);
      });

      it("has strictly-ascending unique timestamps + consistent OHLCV", () => {
        const v = validateBars(fx.bars);
        expect(v.ok, v.errors.slice(0, 3).join("; ")).to.equal(true);
      });

      it("timestamps sit on the hourly grid", () => {
        for (const b of fx.bars) {
          expect(b.t % HOUR_MS).to.equal(0);
        }
      });

      it("startTime/endTime match the first/last bar", () => {
        expect(fx.startTime).to.equal(fx.bars[0].t);
        expect(fx.endTime).to.equal(fx.bars[fx.bars.length - 1].t);
      });
    });
  }
});
