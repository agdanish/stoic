/**
 * Stoic — CMC LIVE HTTP-branch test (recorded cassettes).  [gap 7 — live path untested]
 *
 * The committed report + the offline contract tests run in FIXTURE mode (no key), so the
 * LIVE transport branch of callTool (src/data/cmc.ts:182-202) — the actual `fetch` POST of a
 * JSON-RPC `tools/call` to https://mcp.coinmarketcap.com/mcp with the X-CMC-MCP-API-KEY
 * header — was never exercised by a test. This test closes that, per WIRED tool, WITHOUT a
 * real key or network:
 *
 *   - sets a DUMMY CMC_MCP_API_KEY so hasLiveKey() is true and callTool takes the live branch;
 *   - stubs globalThis.fetch to RECORD the request (url / headers / body) and return the
 *     recorded cassette envelope (fixtures/cmc/cassettes/<tool>.json — the JSON-RPC result
 *     shape await res.json() yields on the wire);
 *   - drives the REAL adapter end-to-end (callTool -> live fetch -> unwrapMcp -> defensive
 *     parser) and asserts (1) the request hit the right URL with the key header + the right
 *     tool name in the JSON-RPC body, and (2) the parsed normalized shape is available + sane.
 *
 * HONESTY: the cassettes are SHAPE fixtures (documented MCP envelope, SAMPLE values) — NOT a
 * real captured live response. A real captured envelope belongs in fixtures/cmc/live/ and is
 * committed by the user's one keyed round-trip. This test proves
 * the live HTTP CODE PATH + parser work; it does not claim the values are live.
 *
 * The dummy key + fetch stub are installed/removed around each case so no other test (which
 * all assume keyless FIXTURE mode) is affected.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  searchCryptos,
  getQuotes,
  getTechnicalAnalysis,
  getGlobalMetrics,
  getDerivatives,
  getTrendingNarratives,
  getMetrics,
  hasLiveKey,
  CMC_MCP_URL,
} from "../src/data/cmc";

const CASSETTE_DIR = path.resolve(__dirname, "../fixtures/cmc/cassettes");

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

let lastRequest: RecordedRequest | null = null;
let savedFetch: any;
let savedKey: string | undefined;

/** Load a recorded cassette envelope (the wire-shape JSON-RPC result for a tool). */
function cassette(tool: string): any {
  return JSON.parse(fs.readFileSync(path.join(CASSETTE_DIR, `${tool}.json`), "utf8"));
}

/**
 * Install a fetch stub that records the outgoing request and replies with `tool`'s cassette.
 * Mirrors the minimal Response surface callTool uses: { ok, json() }.
 */
function installStub(tool: string): void {
  savedKey = process.env.CMC_MCP_API_KEY;
  process.env.CMC_MCP_API_KEY = "dummy-test-key"; // -> hasLiveKey() true -> live branch
  savedFetch = (globalThis as any).fetch;
  lastRequest = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    lastRequest = {
      url: String(url),
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : undefined,
    };
    return {
      ok: true,
      json: async () => cassette(tool),
    } as any;
  };
}

function restoreStub(): void {
  (globalThis as any).fetch = savedFetch;
  if (savedKey === undefined) delete process.env.CMC_MCP_API_KEY;
  else process.env.CMC_MCP_API_KEY = savedKey;
}

/** Assert the recorded request is a well-formed live tools/call for `tool`. */
function assertLiveCall(tool: string): void {
  expect(lastRequest, "no live fetch was made (live branch not taken?)").to.not.equal(null);
  const r = lastRequest as RecordedRequest;
  expect(r.url).to.equal(CMC_MCP_URL);
  expect(r.headers["X-CMC-MCP-API-KEY"]).to.equal("dummy-test-key");
  expect(r.body?.method).to.equal("tools/call");
  expect(r.body?.params?.name).to.equal(tool);
}

describe("cmc LIVE HTTP branch (recorded cassettes) — per wired tool", () => {
  afterEach(() => restoreStub());

  it("with a key set, hasLiveKey() is true (the live branch is taken)", () => {
    installStub("search_cryptos");
    expect(hasLiveKey()).to.equal(true);
    // (restored in afterEach)
  });

  it("search_cryptos: live POST -> id resolved from the cassette envelope", async () => {
    installStub("search_cryptos");
    const r = await searchCryptos("BTC");
    assertLiveCall("search_cryptos");
    expect(r.available).to.equal(true);
    expect(r.id).to.equal(1);
  });

  it("get_crypto_quotes_latest: live POST -> price parsed from the cassette", async () => {
    installStub("get_crypto_quotes_latest");
    const q = await getQuotes(1, "BTC");
    assertLiveCall("get_crypto_quotes_latest");
    expect(q.price.available).to.equal(true);
    expect(q.price.value).to.be.greaterThan(0);
  });

  it("get_crypto_quotes_latest: SYMBOL-keyed data ({\"BTC\":{...}}) also parses (verified CMC convention)", async () => {
    // CMC keys quotes/latest by whichever query param was sent: id -> data["1"],
    // symbol -> data["BTC"]. The id-keyed cassette covers the former; this pins the
    // symbol-keyed shape (verified against CMC standards-and-conventions doc, 2026-06)
    // so the defensive parser handles BOTH on the wire. Shape fixture, sample value.
    savedKey = process.env.CMC_MCP_API_KEY;
    process.env.CMC_MCP_API_KEY = "dummy-test-key";
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  data: {
                    BTC: {
                      id: 1,
                      symbol: "BTC",
                      quote: { USD: { price: 67250.42, percent_change_24h: -1.84 } },
                    },
                  },
                }),
              },
            ],
            isError: false,
          },
        }),
      } as any);
    const q = await getQuotes(1, "BTC");
    expect(q.price.available).to.equal(true);
    expect(q.price.value).to.equal(67250.42);
    expect(q.percentChange24h.available).to.equal(true);
    restoreStub();
  });

  it("get_crypto_technical_analysis: live POST -> RSI parsed from the cassette", async () => {
    installStub("get_crypto_technical_analysis");
    const t = await getTechnicalAnalysis(1, "BTC");
    assertLiveCall("get_crypto_technical_analysis");
    expect(t.rsi.available).to.equal(true);
    expect(t.rsi.value).to.be.within(0, 100);
  });

  it("get_global_metrics_latest: live POST -> Fear&Greed parsed from the cassette", async () => {
    installStub("get_global_metrics_latest");
    const g = await getGlobalMetrics();
    assertLiveCall("get_global_metrics_latest");
    expect(g.fearGreed.available).to.equal(true);
    expect(g.fearGreed.value).to.be.within(0, 100);
  });

  it("get_global_crypto_derivatives_metrics: live POST -> funding parsed from the cassette", async () => {
    installStub("get_global_crypto_derivatives_metrics");
    const d = await getDerivatives("BTC");
    assertLiveCall("get_global_crypto_derivatives_metrics");
    expect(d.fundingRate.available).to.equal(true);
  });

  it("trending_crypto_narratives: live POST -> narratives parsed from the cassette", async () => {
    installStub("trending_crypto_narratives");
    const n = await getTrendingNarratives();
    assertLiveCall("trending_crypto_narratives");
    expect(n.available).to.equal(true);
    expect(n.narratives.length).to.be.greaterThan(0);
  });

  it("get_crypto_metrics: live POST -> holder/whale parsed from the cassette", async () => {
    installStub("get_crypto_metrics");
    const m = await getMetrics(1, "BTC");
    assertLiveCall("get_crypto_metrics");
    expect(m.holderCount.available).to.equal(true);
  });

  it("a non-OK live response degrades to {} (graceful no-op, never throws)", async () => {
    savedKey = process.env.CMC_MCP_API_KEY;
    process.env.CMC_MCP_API_KEY = "dummy-test-key";
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) } as any);
    const g = await getGlobalMetrics(); // must not throw; every metric unavailable
    expect(g.fearGreed.available).to.equal(false);
    restoreStub();
  });

  it("a fetch that throws degrades to {} (network failure -> no-op, never throws)", async () => {
    savedKey = process.env.CMC_MCP_API_KEY;
    process.env.CMC_MCP_API_KEY = "dummy-test-key";
    savedFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => {
      throw new Error("simulated network failure");
    };
    const d = await getDerivatives("BTC"); // must not throw
    expect(d.fundingRate.available).to.equal(false);
    restoreStub();
  });
});
