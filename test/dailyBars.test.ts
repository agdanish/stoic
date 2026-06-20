/**
 * Stoic — DAILY multi-regime fixture + history-alignment tests.  [P0]
 *
 * Guarantees for the regime-aware DIRECTIONAL pivot (HONEST_SEARCH_RULES.md):
 *   1. SCHEMA + MONOTONICITY — every committed fixtures/daily/<SYMBOL>.json parses to the
 *      DailyFixture contract, has strictly-ascending unique timestamps on the UTC-midnight
 *      grid, `date` consistent with `t`, and OHLCV that is finite + internally consistent
 *      (low <= open/close <= high). This is the look-ahead-safety precondition for the
 *      daily backtest (ordered, non-duplicated, contiguous bars).
 *   2. F&G RANGE — every present fearGreed value is in 0..100; absent days stay undefined
 *      (no fabrication). 0..100 is asserted both on the pure path and on the committed data.
 *   3. ALIGNMENT CORRECTNESS — buildDailyBars joins F&G by UTC date and forward-fills 8h
 *      funding to a daily level without leaking a future settle backward (look-ahead-safe).
 *   4. COVERAGE REPORT — a printed per-symbol coverage + regime-window summary so a reader
 *      sees exactly which legs are present and over what multi-regime span.
 *
 * Pure + offline (reads committed fixtures + in-memory fixtures); NO network.
 */
import { expect } from "chai";
import * as fs from "fs";
import {
  DailyBar,
  DailyKline,
  DAY_MS,
  FUNDING_MS,
  DAILY_SYMBOLS,
  buildDailyBars,
  validateDailyBars,
  parseDailyKlines,
  parseFearGreed,
  parseFunding,
  utcDateString,
  floorToUtcDay,
} from "../src/data/history";
import {
  dailyFixturePath,
  loadDailyFixture,
  synthDailySeries,
  makeDailyFixture,
  type DailyFixture,
} from "../src/data/fetchDailyHistory";

const DAY0 = Date.UTC(2024, 0, 1); // 2024-01-01 00:00 UTC

describe("history.validateDailyBars — schema + monotonicity + F&G range (pure)", () => {
  const good: DailyBar[] = [
    { date: utcDateString(DAY0), t: DAY0, open: 10, high: 12, low: 9, close: 11, volume: 5, fearGreed: 40, funding: 0.0001 },
    { date: utcDateString(DAY0 + DAY_MS), t: DAY0 + DAY_MS, open: 11, high: 13, low: 10, close: 12, volume: 6, fearGreed: 60 },
  ];

  it("accepts a finite, ordered, strictly-ascending UTC-day series", () => {
    const v = validateDailyBars(good);
    expect(v.ok, v.errors.join("; ")).to.equal(true);
    expect(v.count).to.equal(2);
    expect(v.firstDate).to.equal("2024-01-01");
    expect(v.lastDate).to.equal("2024-01-02");
  });

  it("rejects an empty series", () => {
    const v = validateDailyBars([]);
    expect(v.ok).to.equal(false);
    expect(v.count).to.equal(0);
  });

  it("rejects non-strictly-ascending timestamps (look-ahead hazard)", () => {
    const dup: DailyBar[] = [
      { date: utcDateString(DAY0), t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { date: utcDateString(DAY0), t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    expect(validateDailyBars(dup).ok).to.equal(false);
  });

  it("rejects a timestamp off the UTC-midnight grid", () => {
    const off: DailyBar[] = [
      { date: utcDateString(DAY0 + 123), t: DAY0 + 123, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    expect(validateDailyBars(off).ok).to.equal(false);
  });

  it("rejects a date string inconsistent with its timestamp", () => {
    const mism: DailyBar[] = [
      { date: "2099-12-31", t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    expect(validateDailyBars(mism).ok).to.equal(false);
  });

  it("rejects high<low and high<max(open,close)", () => {
    const bad: DailyBar[] = [
      { date: utcDateString(DAY0), t: DAY0, open: 10, high: 8, low: 9, close: 11, volume: 1 },
    ];
    expect(validateDailyBars(bad).ok).to.equal(false);
  });

  it("rejects a fearGreed value outside 0..100", () => {
    const bad: DailyBar[] = [
      { date: utcDateString(DAY0), t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, fearGreed: 137 },
    ];
    expect(validateDailyBars(bad).ok).to.equal(false);
    const neg: DailyBar[] = [
      { date: utcDateString(DAY0), t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, fearGreed: -1 },
    ];
    expect(validateDailyBars(neg).ok).to.equal(false);
  });

  it("reports per-leg coverage of optional F&G / funding legs (no fabrication)", () => {
    const mixed: DailyBar[] = [
      { date: utcDateString(DAY0), t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, fearGreed: 30, funding: 0.0001 },
      { date: utcDateString(DAY0 + DAY_MS), t: DAY0 + DAY_MS, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    ];
    const v = validateDailyBars(mixed);
    expect(v.coverage.fearGreed).to.equal(0.5);
    expect(v.coverage.funding).to.equal(0.5);
  });
});

describe("history source parsers (pure, defensive)", () => {
  it("parseDailyKlines skips malformed rows, never coerces to NaN", () => {
    const raw = [
      [DAY0, "10", "12", "9", "11", "5", DAY0 + DAY_MS - 1],
      "garbage",
      [DAY0 + DAY_MS, "x", "12", "9", "11", "5"], // bad open -> skipped
      [DAY0 + 2 * DAY_MS, "11", "13", "10", "12", "6"],
    ];
    const k = parseDailyKlines(raw);
    expect(k).to.have.length(2);
    expect(k[0].open).to.equal(10);
    expect(k[1].close).to.equal(12);
  });

  it("parseFearGreed converts unix-seconds to UTC-day ms and keeps 0..100 values", () => {
    const raw = {
      data: [
        { value: "23", value_classification: "Extreme Fear", timestamp: String(Math.floor(DAY0 / 1000)) },
        { value: "74", value_classification: "Greed", timestamp: String(Math.floor((DAY0 + DAY_MS) / 1000)) },
      ],
    };
    const fg = parseFearGreed(raw);
    expect(fg).to.have.length(2);
    expect(fg[0].t).to.equal(DAY0);
    expect(fg[0].value).to.equal(23);
    expect(fg[1].classification).to.equal("Greed");
  });

  it("parseFunding skips malformed rows and sorts ascending", () => {
    const raw = [
      { fundingTime: DAY0 + FUNDING_MS, fundingRate: "0.0002" },
      { fundingTime: DAY0, fundingRate: "0.0001" },
      { fundingTime: DAY0 + 2 * FUNDING_MS }, // no rate -> skipped
    ];
    const f = parseFunding(raw);
    expect(f).to.have.length(2);
    expect(f[0].t).to.equal(DAY0);
    expect(f[1].funding).to.equal(0.0002);
  });
});

describe("history.buildDailyBars — join F&G by date + forward-fill funding (look-ahead-safe)", () => {
  const klines: DailyKline[] = [
    { t: DAY0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, closeTime: DAY0 + DAY_MS - 1 },
    { t: DAY0 + DAY_MS, open: 1.5, high: 2.5, low: 1, close: 2, volume: 1, closeTime: DAY0 + 2 * DAY_MS - 1 },
    { t: DAY0 + 2 * DAY_MS, open: 2, high: 3, low: 1.5, close: 2.5, volume: 1, closeTime: DAY0 + 3 * DAY_MS - 1 },
  ];

  it("joins F&G on the matching UTC date; leaves uncovered days undefined", () => {
    const bars = buildDailyBars(klines, {
      fearGreed: [
        { t: DAY0, value: 30, classification: "Fear" },
        { t: DAY0 + 2 * DAY_MS, value: 80, classification: "Extreme Greed" },
      ],
    });
    expect(bars).to.have.length(3);
    expect(bars[0].fearGreed).to.equal(30);
    expect(bars[0].fearGreedClass).to.equal("Fear");
    expect(bars[1].fearGreed).to.equal(undefined); // no fabrication
    expect(bars[2].fearGreed).to.equal(80);
  });

  it("forward-fills funding across days from the last settle at-or-before each day", () => {
    // settle at start of day 0 carries to day 1 and day 2.
    const bars = buildDailyBars(klines, { funding: [{ t: DAY0, funding: 0.0003 }] });
    expect(bars[0].funding).to.equal(0.0003);
    expect(bars[1].funding).to.equal(0.0003);
    expect(bars[2].funding).to.equal(0.0003);
  });

  it("does NOT leak a future funding settle backward (look-ahead-safe)", () => {
    // settle lands on day 2: days 0 and 1 must NOT see it.
    const bars = buildDailyBars(klines, { funding: [{ t: DAY0 + 2 * DAY_MS, funding: 0.0009 }] });
    expect(bars[0].funding).to.equal(undefined);
    expect(bars[1].funding).to.equal(undefined);
    expect(bars[2].funding).to.equal(0.0009);
  });

  it("uses the latest intraday settle at-or-before the day open (8h settles within a day)", () => {
    // three settles inside day 0; day 0's 00:00 open sees only the 00:00 settle.
    const bars = buildDailyBars(klines, {
      funding: [
        { t: DAY0, funding: 0.0001 },
        { t: DAY0 + FUNDING_MS, funding: 0.0002 },
        { t: DAY0 + 2 * FUNDING_MS, funding: 0.0003 },
        { t: DAY0 + DAY_MS, funding: 0.0004 }, // 00:00 of day 1
      ],
    });
    expect(bars[0].funding).to.equal(0.0001); // only the 00:00 settle, not later same-day settles
    expect(bars[1].funding).to.equal(0.0004);
  });

  it("produces a strictly-ascending, contiguous daily series from unsorted klines", () => {
    const shuffled = [klines[2], klines[0], klines[1]];
    const bars = buildDailyBars(shuffled, {});
    const v = validateDailyBars(bars);
    expect(v.ok, v.errors.join("; ")).to.equal(true);
    expect(bars[1].t - bars[0].t).to.equal(DAY_MS);
  });
});

describe("fetchDailyHistory.synthDailySeries — deterministic labelled fallback (pure)", () => {
  it("is byte-reproducible for a fixed (symbol, start, count) and passes validation", () => {
    const a = synthDailySeries("BTCUSDT", DAY0, 60);
    const b = synthDailySeries("BTCUSDT", DAY0, 60);
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
    const v = validateDailyBars(a);
    expect(v.ok, v.errors.slice(0, 3).join("; ")).to.equal(true);
    expect(a).to.have.length(60);
  });

  it("makeDailyFixture threads the synthetic label + provenance honestly", () => {
    const bars = synthDailySeries("ETHUSDT", DAY0, 30);
    const fx = makeDailyFixture("ETHUSDT", bars, true);
    expect(fx._synthetic).to.equal(true);
    expect(fx.interval).to.equal("1d");
    expect(fx._note).to.match(/SYNTHETIC/);
    expect(fx.count).to.equal(30);
  });
});

describe("committed DAILY fixtures — schema, monotonicity, F&G range (REAL or SYNTHETIC)", () => {
  for (const symbol of DAILY_SYMBOLS) {
    describe(symbol, () => {
      const file = dailyFixturePath(symbol);
      const exists = fs.existsSync(file);

      it("fixture file exists (run `ts-node src/data/fetchDailyHistory.ts` if missing)", () => {
        expect(exists, `missing ${file}`).to.equal(true);
      });

      if (!exists) return;

      const fx: DailyFixture = loadDailyFixture(symbol);

      it("declares the DailyFixture contract fields", () => {
        expect(fx).to.have.property("_synthetic");
        expect(typeof fx._synthetic).to.equal("boolean");
        expect(fx).to.have.property("_source");
        expect(fx.interval).to.equal("1d");
        expect(fx.symbol).to.equal(symbol);
        expect(Array.isArray(fx.bars)).to.equal(true);
        expect(fx.count).to.equal(fx.bars.length);
      });

      it("has a non-trivial multi-year series (>= 800 daily bars)", () => {
        expect(fx.bars.length).to.be.greaterThan(800);
      });

      it("has strictly-ascending unique UTC-day timestamps + consistent OHLCV + F&G in 0..100", () => {
        const v = validateDailyBars(fx.bars);
        expect(v.ok, v.errors.slice(0, 3).join("; ")).to.equal(true);
      });

      it("timestamps sit on the UTC-midnight grid and are contiguous (no missing days)", () => {
        for (const b of fx.bars) expect(b.t % DAY_MS).to.equal(0);
        let gaps = 0;
        for (let i = 1; i < fx.bars.length; i++) {
          if (fx.bars[i].t - fx.bars[i - 1].t !== DAY_MS) gaps++;
        }
        expect(gaps, "non-1d steps in the daily series").to.equal(0);
      });

      it("startDate/endDate/startTime/endTime match the first/last bar", () => {
        expect(fx.startTime).to.equal(fx.bars[0].t);
        expect(fx.endTime).to.equal(fx.bars[fx.bars.length - 1].t);
        expect(fx.startDate).to.equal(fx.bars[0].date);
        expect(fx.endDate).to.equal(fx.bars[fx.bars.length - 1].date);
      });

      it("has high F&G coverage (>= 99%) — the historical-regime gate input", () => {
        const v = validateDailyBars(fx.bars);
        expect(v.coverage.fearGreed).to.be.greaterThan(0.99);
      });
    });
  }
});

describe("DAILY fixtures — coverage + multi-regime report (informational)", () => {
  it("prints per-symbol coverage, span, and bull/chop/bear sub-window returns", () => {
    for (const symbol of DAILY_SYMBOLS) {
      const file = dailyFixturePath(symbol);
      if (!fs.existsSync(file)) {
        console.log(`  [coverage] ${symbol}: NO FIXTURE (run fetchDailyHistory.ts)`);
        continue;
      }
      const fx = loadDailyFixture(symbol);
      const v = validateDailyBars(fx.bars);
      const b = fx.bars;
      const n = b.length;
      const bh = ((b[n - 1].close / b[0].open - 1) * 100).toFixed(1);
      // thirds as a transparent regime proxy (NOT used for selection — just disclosure).
      const seg = (lo: number, hi: number) => ((b[hi - 1].close / b[lo].open - 1) * 100).toFixed(1);
      const t1 = Math.floor(n / 3);
      const t2 = Math.floor((2 * n) / 3);
      console.log(
        `  [coverage] ${symbol} [${fx._synthetic ? "SYNTHETIC" : "REAL"}] ` +
          `${fx.startDate}..${fx.endDate} (${n} bars) ` +
          `F&G=${(v.coverage.fearGreed * 100).toFixed(1)}% funding=${(v.coverage.funding * 100).toFixed(1)}% ` +
          `| B&H=${bh}% thirds=[${seg(0, t1)}%, ${seg(t1, t2)}%, ${seg(t2, n)}%]`
      );
      expect(v.ok).to.equal(true);
    }
  });
});
