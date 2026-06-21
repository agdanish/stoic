/**
 * Stoic — CMC x402 KEYLESS route — CODE PATH, DRY-RUN, NOT a funded/settled USDC call.
 *
 * CoinMarketCap exposes the same MCP tools behind an x402-paywalled endpoint
 * (https://mcp.coinmarketcap.com/x402/mcp) that takes per-call USDC micropayments on Base
 * (chain id 8453, ~$0.01/call) INSTEAD of an API key. This test exercises the ADDITIVE keyless
 * transport branch wired in src/data/cmc.ts WITHOUT paying anything:
 *
 *   - buildX402Request() constructs the UN-PAID JSON-RPC `tools/call` request shape: it targets
 *     the x402 URL, carries NO X-CMC-MCP-API-KEY and NO X-PAYMENT header, and exposes dry-run
 *     settlement metadata (Base / 8453 / USDC / $0.01). No wallet, no signature, no transfer.
 *   - useX402Keyless() is the opt-in gate (CMC_X402=1 AND no key); the keyed branch stays default.
 *   - callToolX402() defaults to NO network at all (pure shape construction -> {} no-op). With
 *     CMC_X402_FETCH=1 it issues the ONE un-paid request and treats the expected 402 (or any
 *     non-OK / thrown fetch) as the documented degrade-to-{} no-op.
 *
 * HONESTY / RED LINE: this proves the keyless x402 CODE PATH is wired and the request shape is
 * correct. It performs NO funded/settled USDC transaction and claims none. A real paid x402 call
 * (sign the 402 `accepts` challenge, retry with X-PAYMENT) is NOT implemented and NOT asserted.
 *
 * The keyed branch (X-CMC-MCP-API-KEY, gated on hasLiveKey) MUST remain the default and is
 * re-asserted here to be unaffected. Env + fetch stubs are installed/removed around each case so
 * no other test (which all assume keyless FIXTURE mode) is affected.
 */
import { expect } from "chai";
import {
  callTool,
  callToolX402,
  buildX402Request,
  useX402Keyless,
  hasLiveKey,
  CMC_MCP_X402_URL,
  CMC_MCP_URL,
  X402_NETWORK,
} from "../src/data/cmc";

let savedKey: string | undefined;
let savedX402: string | undefined;
let savedX402Fetch: string | undefined;
let savedFetch: any;

function saveEnv(): void {
  savedKey = process.env.CMC_MCP_API_KEY;
  savedX402 = process.env.CMC_X402;
  savedX402Fetch = process.env.CMC_X402_FETCH;
  savedFetch = (globalThis as any).fetch;
}

function restoreEnv(): void {
  (globalThis as any).fetch = savedFetch;
  for (const [k, v] of [
    ["CMC_MCP_API_KEY", savedKey],
    ["CMC_X402", savedX402],
    ["CMC_X402_FETCH", savedX402Fetch],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("cmc x402 KEYLESS route — code path, dry-run, NOT a funded/settled call", () => {
  beforeEach(() => saveEnv());
  afterEach(() => restoreEnv());

  it("buildX402Request targets the x402 URL with NO key and NO payment header (un-paid shape)", () => {
    const req = buildX402Request("search_cryptos", { query: "BTC" });
    expect(req.url).to.equal(CMC_MCP_X402_URL);
    expect(req.url).to.not.equal(CMC_MCP_URL); // distinct from the keyed endpoint
    expect(req.method).to.equal("POST");
    // RED LINE: the dry-run request carries no API key and, crucially, no payment authorization.
    expect(req.headers["X-CMC-MCP-API-KEY"]).to.equal(undefined);
    expect(req.headers["X-PAYMENT"]).to.equal(undefined);
    expect(req.headers["Content-Type"]).to.equal("application/json");
  });

  it("buildX402Request body is a well-formed JSON-RPC tools/call carrying the tool + args", () => {
    const req = buildX402Request("get_crypto_quotes_latest", { id: "1" });
    const body = JSON.parse(req.body);
    expect(body.jsonrpc).to.equal("2.0");
    expect(body.method).to.equal("tools/call");
    expect(body.params.name).to.equal("get_crypto_quotes_latest");
    expect(body.params.arguments).to.deep.equal({ id: "1" });
  });

  it("settlement metadata is dry-run only (Base / 8453 / USDC / $0.01) — describes, does not pay", () => {
    const req = buildX402Request("get_global_metrics_latest");
    expect(req.settlement).to.deep.equal(X402_NETWORK);
    expect(req.settlement.chainId).to.equal(8453);
    expect(req.settlement.asset).to.equal("USDC");
    expect(req.settlement.name).to.equal("base");
  });

  it("useX402Keyless() requires the opt-in flag AND no key; keyed branch always wins", () => {
    process.env.CMC_X402 = "1";
    delete process.env.CMC_MCP_API_KEY;
    expect(useX402Keyless()).to.equal(true);
    // A key present -> keyed branch is default, keyless is suppressed.
    process.env.CMC_MCP_API_KEY = "dummy-test-key";
    expect(hasLiveKey()).to.equal(true);
    expect(useX402Keyless()).to.equal(false);
    // Flag absent -> keyless off (fixture fallback path instead).
    delete process.env.CMC_MCP_API_KEY;
    delete process.env.CMC_X402;
    expect(useX402Keyless()).to.equal(false);
  });

  it("callToolX402 default dry-run does NO network and degrades to {} (never throws)", async () => {
    delete process.env.CMC_X402_FETCH;
    let fetched = false;
    (globalThis as any).fetch = async () => {
      fetched = true;
      return { ok: true, json: async () => ({}) } as any;
    };
    const out = await callToolX402("search_cryptos", { query: "BTC" });
    expect(out).to.deep.equal({});
    expect(fetched, "default dry-run must not touch the network").to.equal(false);
  });

  it("with CMC_X402=1 and no key, callTool routes through the keyless branch (records the un-paid request)", async () => {
    delete process.env.CMC_MCP_API_KEY;
    process.env.CMC_X402 = "1";
    process.env.CMC_X402_FETCH = "1"; // enable the single un-paid request for recording
    let rec: any = null;
    (globalThis as any).fetch = async (url: string, init: any) => {
      rec = { url: String(url), headers: (init && init.headers) || {}, body: init && JSON.parse(init.body) };
      // Mirror the real endpoint: the un-paid request comes back 402 Payment Required.
      return { ok: false, status: 402, json: async () => ({}) } as any;
    };
    const out = await callTool("search_cryptos", { query: "BTC" });
    expect(rec, "keyless branch did not issue the request").to.not.equal(null);
    expect(rec.url).to.equal(CMC_MCP_X402_URL); // hit the x402 endpoint, not the keyed one
    expect(rec.headers["X-CMC-MCP-API-KEY"]).to.equal(undefined);
    expect(rec.headers["X-PAYMENT"]).to.equal(undefined);
    expect(rec.body.params.name).to.equal("search_cryptos");
    // 402 is expected on the un-paid call -> documented degrade-to-{} no-op (no payment retried).
    expect(out).to.deep.equal({});
  });

  it("keyless branch: a thrown fetch degrades to {} (never throws)", async () => {
    delete process.env.CMC_MCP_API_KEY;
    process.env.CMC_X402 = "1";
    process.env.CMC_X402_FETCH = "1";
    (globalThis as any).fetch = async () => {
      throw new Error("simulated network failure");
    };
    const out = await callTool("get_global_metrics_latest");
    expect(out).to.deep.equal({});
  });

  it("the KEYED branch remains the default: a set key still POSTs to the keyed URL with the key header", async () => {
    process.env.CMC_MCP_API_KEY = "dummy-test-key";
    process.env.CMC_X402 = "1"; // even with the keyless flag on, the key wins
    let rec: any = null;
    (globalThis as any).fetch = async (url: string, init: any) => {
      rec = { url: String(url), headers: (init && init.headers) || {} };
      return { ok: true, json: async () => ({ result: { content: [] } }) } as any;
    };
    await callTool("search_cryptos", { query: "BTC" });
    expect(rec.url).to.equal(CMC_MCP_URL); // keyed endpoint, NOT the x402 one
    expect(rec.headers["X-CMC-MCP-API-KEY"]).to.equal("dummy-test-key");
  });

  it("with neither key nor flag, callTool stays on the FIXTURE branch (no network)", async () => {
    delete process.env.CMC_MCP_API_KEY;
    delete process.env.CMC_X402;
    let fetched = false;
    (globalThis as any).fetch = async () => {
      fetched = true;
      return { ok: true, json: async () => ({}) } as any;
    };
    const out = await callTool("search_cryptos", { query: "BTC" });
    expect(fetched, "default keyless+flagless mode must read a fixture, not fetch").to.equal(false);
    // search_cryptos has a pinned fixture, so the fixture branch returns a non-empty envelope.
    expect(out).to.be.an("object");
  });
});
