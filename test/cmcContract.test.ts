/**
 * Stoic — CMC Agent Hub adapter contract tests.  [M1]
 *
 * Two guarantees per tool:
 *   1. HAPPY PATH  — the pinned SAMPLE fixture parses into the documented normalized
 *      shape with `available:true` and sane values (multi-path defensive parse works).
 *   2. GRACEFUL NO-OP — a malformed / surprise payload degrades to `available:false`
 *      (and the bounded-advisory mappers emit the strict {0,0} no-op that
 *      core.blendScore treats as a pass-through). Parsers NEVER throw.
 *
 * Runs in FIXTURE mode (no CMC_MCP_API_KEY) so it is offline + reproducible. We force
 * fixture mode explicitly in case the runner's env carries a key.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// Ensure FIXTURE transport regardless of ambient env.
delete process.env.CMC_MCP_API_KEY;

import {
  searchCryptos,
  getQuotes,
  getTechnicalAnalysis,
  getGlobalMetrics,
  getDerivatives,
  getTrendingNarratives,
  getMetrics,
  unwrapMcp,
  hasLiveKey,
  rsiAdvisory,
  fundingAdvisory,
  fearGreedAdvisory,
  narrativeAdvisory,
  NO_METRIC,
  NO_ADVICE,
  type Metric,
} from "../src/data/cmc";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/cmc");
const malformed = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "_malformed.json"), "utf8")
);

describe("cmc — transport mode", () => {
  it("defaults to FIXTURE mode when no CMC_MCP_API_KEY is set", () => {
    expect(hasLiveKey()).to.equal(false);
  });
});

describe("cmc.unwrapMcp — defensive envelope unwrap (never throws)", () => {
  it("unwraps a double-encoded content[].text JSON string", () => {
    const out = unwrapMcp({
      content: [{ type: "text", text: '{"data":{"x":1}}' }],
    });
    expect(out?.data?.x).to.equal(1);
  });
  it("unwraps a JSON-RPC result wrapper with structuredContent", () => {
    const out = unwrapMcp({ result: { structuredContent: { data: { y: 2 } } } });
    expect(out?.data?.y).to.equal(2);
  });
  it("returns {} (no throw) on null / garbage / non-JSON text", () => {
    expect(unwrapMcp(null)).to.deep.equal({});
    expect(unwrapMcp(undefined)).to.deep.equal({});
    expect(unwrapMcp({ content: [{ text: "not json <<<" }] })).to.be.an("object");
  });
});

describe("cmc.searchCryptos — symbol -> numeric id", () => {
  it("resolves BTC to its numeric id from the SAMPLE fixture", async () => {
    const r = await searchCryptos("BTC");
    expect(r.available).to.equal(true);
    expect(r.id).to.equal(1);
    expect(r.symbol).to.equal("BTC");
  });
  it("is case-insensitive on the requested symbol", async () => {
    const r = await searchCryptos("btc");
    expect(r.available).to.equal(true);
    expect(r.id).to.equal(1);
  });
});

describe("cmc.getQuotes — latest price quote", () => {
  it("parses price / volume / changes / market cap from the SAMPLE fixture", async () => {
    const q = await getQuotes(1, "BTC");
    expect(q.price.available).to.equal(true);
    expect(q.price.value).to.be.closeTo(67250.42, 1e-6);
    expect(q.volume24h.available).to.equal(true);
    expect(q.percentChange24h.available).to.equal(true);
    expect(q.percentChange24h.value).to.be.closeTo(-1.84, 1e-6);
    expect(q.marketCap.available).to.equal(true);
  });
});

describe("cmc.getTechnicalAnalysis — RSI/MACD/EMA (real shapes; values are comma-strings)", () => {
  it("parses indicators from the SAMPLE fixture (rsi.rsi14, macd.histogram, EMA strings)", async () => {
    const t = await getTechnicalAnalysis(1, "BTC");
    // RSI = rsi.rsi14, parsed from the string "58.40".
    expect(t.rsi.available).to.equal(true);
    expect(t.rsi.value).to.be.closeTo(58.4, 1e-6);
    // MACD histogram = macd.histogram, parsed from the string "22.30".
    expect(t.macdHist.available).to.equal(true);
    expect(t.macdHist.value).to.be.closeTo(22.3, 1e-6);
    // No 50-day EMA in the live payload -> the 30-day EMA ("65,800.10") is used; comma-parsed.
    expect(t.ema50.available).to.equal(true);
    expect(t.ema50.value).to.be.closeTo(65800.1, 1e-6);
    expect(t.ema200.available).to.equal(true);
    expect(t.ema200.value).to.be.closeTo(61200.7, 1e-6);
    // ATR is NOT part of the live technical-analysis payload -> honestly unavailable.
    expect(t.atr.available).to.equal(false);
  });
});

describe("cmc.getGlobalMetrics — regime (Fear&Greed / dominance)", () => {
  it("parses Fear&Greed, BTC dominance, altseason from the SAMPLE fixture", async () => {
    const g = await getGlobalMetrics();
    expect(g.fearGreed.available).to.equal(true);
    expect(g.fearGreed.value).to.equal(72);
    expect(g.btcDominance.available).to.equal(true);
    expect(g.btcDominance.value).to.be.closeTo(54.7, 1e-6);
    expect(g.altSeasonIndex.available).to.equal(true);
  });
});

describe("cmc.getDerivatives — positioning (funding/OI/liquidations; real unit strings)", () => {
  it("parses funding / OI (unit string) / liquidations from the SAMPLE fixture", async () => {
    const d = await getDerivatives("BTC");
    // fundingRate.current "0.00012" -> 0.00012 (a fraction).
    expect(d.fundingRate.available).to.equal(true);
    expect(d.fundingRate.value).to.be.closeTo(0.00012, 1e-9);
    // totalOpenInterest.current "18.9 B" -> 18.9e9 (unit-suffix parsed).
    expect(d.openInterest.available).to.equal(true);
    expect(d.openInterest.value).to.be.closeTo(18.9e9, 1);
    // btc_liquidations.total_usd_24h.total "142 M" -> 142e6.
    expect(d.liquidations24h.available).to.equal(true);
    expect(d.liquidations24h.value).to.be.closeTo(142e6, 1);
    // OI 24h change "+3.4%" -> 3.4 (percent number).
    expect(d.openInterestChange24h.available).to.equal(true);
    expect(d.openInterestChange24h.value).to.be.closeTo(3.4, 1e-6);
    // The global derivatives payload exposes no long/short ratio -> honestly unavailable.
    expect(d.longShortRatio.available).to.equal(false);
  });
});

describe("cmc.getTrendingNarratives — attention/narrative momentum", () => {
  it("parses the narrative list from the SAMPLE fixture", async () => {
    const n = await getTrendingNarratives();
    expect(n.available).to.equal(true);
    expect(n.narratives.length).to.be.greaterThan(0);
    const ai = n.narratives.find((x) => x.name.toLowerCase().includes("ai"));
    expect(ai).to.not.equal(undefined);
    expect(ai!.avgPriceChange24h).to.be.closeTo(6.8, 1e-6);
  });
});

describe("cmc.getMetrics — holder / whale distribution (real addressesByHoldingValue shape)", () => {
  it("parses holder count (summed buckets) + whale concentration from the SAMPLE fixture", async () => {
    const m = await getMetrics(1, "BTC");
    // holderCount = sum of the addressesByHoldingValue bucket counts.
    expect(m.holderCount.available).to.equal(true);
    expect(m.holderCount.value).to.equal(42737795 + 11972160 + 1121507);
    // Whale proxy = usd100kPlus.percentOfAddresses (2.01% of addresses hold >= $100k).
    expect(m.whalesPct.available).to.equal(true);
    expect(m.whalesPct.value).to.be.closeTo(2.01, 1e-6);
  });
});

// ── graceful no-op: malformed payload must degrade, not throw ──────────────────
// We exercise the FULL adapter path (readFixture -> unwrapMcp -> defensive parse) by
// temporarily overwriting each tool's fixture file with the malformed payload, driving
// the real adapter, then restoring the original SAMPLE fixture. Every metric must come
// back `available:false` (which maps to the {0,0} blendScore no-op) and nothing throws.
describe("cmc — malformed payloads degrade to a graceful no-op (never throw)", () => {
  const tools = [
    "search_cryptos",
    "get_crypto_quotes_latest",
    "get_crypto_technical_analysis",
    "get_global_metrics_latest",
    "get_global_crypto_derivatives_metrics",
    "trending_crypto_narratives",
    "get_crypto_metrics",
  ];
  const saved: Record<string, string> = {};

  beforeEach(() => {
    for (const t of tools) {
      const f = path.join(FIXTURE_DIR, `${t}.json`);
      saved[t] = fs.readFileSync(f, "utf8");
      fs.writeFileSync(f, JSON.stringify(malformed), "utf8");
    }
  });
  afterEach(() => {
    for (const t of tools) {
      fs.writeFileSync(path.join(FIXTURE_DIR, `${t}.json`), saved[t], "utf8");
    }
  });

  it("unwrapMcp on the malformed fixture yields an object with no usable data", () => {
    const j = unwrapMcp(malformed);
    expect(j).to.be.an("object");
    expect(j?.data ?? null).to.satisfy((x: any) => x === null || typeof x === "object");
  });

  it("searchCryptos -> { id:null, available:false }", async () => {
    const r = await searchCryptos("BTC");
    expect(r.available).to.equal(false);
    expect(r.id).to.equal(null);
  });
  it("getQuotes -> every Metric unavailable", async () => {
    const q = await getQuotes(1, "BTC");
    for (const m of Object.values(q)) expect((m as Metric).available).to.equal(false);
  });
  it("getTechnicalAnalysis -> every Metric unavailable", async () => {
    const t = await getTechnicalAnalysis(1, "BTC");
    for (const m of Object.values(t)) expect((m as Metric).available).to.equal(false);
  });
  it("getGlobalMetrics -> every Metric unavailable", async () => {
    const g = await getGlobalMetrics();
    for (const m of Object.values(g)) expect((m as Metric).available).to.equal(false);
  });
  it("getDerivatives -> every Metric unavailable", async () => {
    const d = await getDerivatives("BTC");
    for (const m of Object.values(d)) expect((m as Metric).available).to.equal(false);
  });
  it("getTrendingNarratives -> empty + unavailable", async () => {
    const n = await getTrendingNarratives();
    expect(n.available).to.equal(false);
    expect(n.narratives).to.deep.equal([]);
  });
  it("getMetrics -> every Metric unavailable", async () => {
    const m = await getMetrics(1, "BTC");
    for (const c of Object.values(m)) expect((c as Metric).available).to.equal(false);
  });

  it("the NO_* sentinels match the documented blendScore no-op contract", () => {
    expect(NO_METRIC).to.deep.equal({ value: 0, available: false });
    expect(NO_ADVICE).to.deep.equal({ adjustment: 0, confidence: 0 });
  });
});

// ── bounded-advisory mappers: available -> nudge; unavailable -> strict {0,0} ──
describe("cmc advisory mappers — bounded {adjustment,confidence} for blendScore", () => {
  const unavail: Metric = { ...NO_METRIC };

  it("rsiAdvisory: unavailable -> strict no-op {0,0}", () => {
    expect(rsiAdvisory(unavail)).to.deep.equal(NO_ADVICE);
  });
  it("rsiAdvisory: bullish RSI (70) -> positive bounded adjustment", () => {
    const a = rsiAdvisory({ value: 70, available: true });
    expect(a.adjustment).to.be.greaterThan(0);
    expect(a.adjustment).to.be.at.most(50);
    expect(a.confidence).to.be.within(0, 1);
  });
  it("rsiAdvisory: bearish RSI (30) -> negative bounded adjustment", () => {
    const a = rsiAdvisory({ value: 30, available: true });
    expect(a.adjustment).to.be.lessThan(0);
    expect(a.adjustment).to.be.at.least(-50);
  });

  it("fundingAdvisory: unavailable -> strict no-op {0,0}", () => {
    expect(fundingAdvisory(unavail)).to.deep.equal(NO_ADVICE);
  });
  it("fundingAdvisory: crowded longs (positive funding) -> contrarian-bearish (negative)", () => {
    const a = fundingAdvisory({ value: 0.001, available: true });
    expect(a.adjustment).to.be.lessThan(0);
    expect(a.adjustment).to.be.at.least(-50);
  });

  it("fearGreedAdvisory: unavailable -> strict no-op {0,0}", () => {
    expect(fearGreedAdvisory(unavail)).to.deep.equal(NO_ADVICE);
  });
  it("fearGreedAdvisory: extreme greed (90) -> contrarian-bearish (negative)", () => {
    const a = fearGreedAdvisory({ value: 90, available: true });
    expect(a.adjustment).to.be.lessThan(0);
  });
  it("fearGreedAdvisory: extreme fear (10) -> contrarian-bullish (positive)", () => {
    const a = fearGreedAdvisory({ value: 10, available: true });
    expect(a.adjustment).to.be.greaterThan(0);
  });

  it("narrativeAdvisory: no narratives -> strict no-op {0,0}", () => {
    expect(
      narrativeAdvisory({ narratives: [], available: false }, "AI Agents")
    ).to.deep.equal(NO_ADVICE);
  });
  it("narrativeAdvisory: matched narrative -> bounded nudge from 24h performance", () => {
    const n = {
      narratives: [{ name: "AI Agents", avgPriceChange24h: 6.8 }],
      available: true,
    };
    const a = narrativeAdvisory(n, "ai");
    expect(a.adjustment).to.be.greaterThan(0);
    expect(a.adjustment).to.be.at.most(25);
    expect(a.confidence).to.be.within(0, 1);
  });
});
