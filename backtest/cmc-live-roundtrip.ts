/**
 * Stoic — ONE live CMC MCP round-trip recorder.  [gap 2 — live round-trip]
 *
 * Performs ONE real `tools/call` round-trip per WIRED tool against the CoinMarketCap MCP
 * endpoint (https://mcp.coinmarketcap.com/mcp) using the user's free CMC_MCP_API_KEY, and
 * commits the RAW response envelopes to fixtures/cmc/live/<tool>.json as LABELLED LIVE
 * captures (plus a manifest). It also prints the normalized parse of each so the user can
 * paste a transcript / screenshot into docs/DEMO.md.
 *
 * This is a USER-EXECUTED step: it needs a real key (free 10k credits/mo at
 * pro.coinmarketcap.com). With NO key it prints the exact command + exits 0 WITHOUT writing
 * anything (so it is safe to run in CI / offline). The live transport itself
 * (src/data/cmc.ts:182-202) is already correct; this script just exercises it for real and
 * persists the evidence.
 *
 * HONESTY: the captured envelopes are written under fixtures/cmc/live/ and clearly labelled
 * `_capture: "LIVE"` with a UTC timestamp. They are NEVER passed off as the SAMPLE fixtures
 * and are NOT consumed by any committed report (report.json stays byte-reproducible offline).
 * If a real field path differs from the defensive parser's expectations, the manifest records
 * `available:false` for that field so the discrepancy is visible (fix cmc.ts then re-run).
 *
 * RUN (user, with a key):
 *   CMC_MCP_API_KEY=xxxxxxxx ts-node backtest/cmc-live-roundtrip.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  CMC_MCP_URL,
  hasLiveKey,
  callTool,
  unwrapMcp,
  searchCryptos,
  getQuotes,
  getTechnicalAnalysis,
  getGlobalMetrics,
  getDerivatives,
  getTrendingNarratives,
  getMetrics,
} from "../src/data/cmc";

const LIVE_DIR = path.resolve(__dirname, "../fixtures/cmc/live");

/**
 * The 7 wired tools + the arguments to call each with (BTC = CMC id 1). Arguments match the
 * VERIFIED tool inputSchemas (additionalProperties:false): the id-keyed tools take a numeric
 * STRING `id`; the global tools take no args; search takes a `query`.
 */
const CALLS: { tool: string; args: Record<string, any> }[] = [
  { tool: "search_cryptos", args: { query: "BTC" } },
  { tool: "get_crypto_quotes_latest", args: { id: "1" } },
  { tool: "get_crypto_technical_analysis", args: { id: "1" } },
  { tool: "get_global_metrics_latest", args: {} },
  { tool: "get_global_crypto_derivatives_metrics", args: {} },
  { tool: "trending_crypto_narratives", args: {} },
  { tool: "get_crypto_metrics", args: { id: "1" } },
];

async function normalizedParse(): Promise<Record<string, any>> {
  // Drive the real exported adapters (each takes the live branch under a key) so the manifest
  // records what the DEFENSIVE PARSER extracted — surfacing any real-vs-expected field drift.
  const out: Record<string, any> = {};
  const s = await searchCryptos("BTC");
  out.search_cryptos = { id: s.id, available: s.available };
  const q = await getQuotes(s.id ?? 1, "BTC");
  out.get_crypto_quotes_latest = { price: q.price, percentChange24h: q.percentChange24h };
  const t = await getTechnicalAnalysis(s.id ?? 1, "BTC");
  out.get_crypto_technical_analysis = { rsi: t.rsi, macdHist: t.macdHist };
  const g = await getGlobalMetrics();
  out.get_global_metrics_latest = { fearGreed: g.fearGreed, btcDominance: g.btcDominance };
  const d = await getDerivatives("BTC");
  out.get_global_crypto_derivatives_metrics = { fundingRate: d.fundingRate, openInterest: d.openInterest };
  const n = await getTrendingNarratives();
  out.trending_crypto_narratives = { available: n.available, count: n.narratives.length };
  const m = await getMetrics(s.id ?? 1, "BTC");
  out.get_crypto_metrics = { holderCount: m.holderCount, whalesPct: m.whalesPct };
  return out;
}

export async function main(): Promise<void> {
  if (!hasLiveKey()) {
    console.log("[stoic] cmc-live-roundtrip: NO CMC_MCP_API_KEY set — nothing written.");
    console.log("  To perform the ONE live round-trip and commit the raw envelopes, run:");
    console.log("    CMC_MCP_API_KEY=<your-free-key> ts-node backtest/cmc-live-roundtrip.ts");
    console.log(`  Endpoint: ${CMC_MCP_URL}  (free key: pro.coinmarketcap.com)`);
    console.log("  See fixtures/cmc/live/README.md for details.");
    return;
  }

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const nowISO = new Date().toISOString();
  const manifest: any = { _capture: "LIVE", capturedAt: nowISO, endpoint: CMC_MCP_URL, tools: [] };

  for (const c of CALLS) {
    let raw: any = {};
    let ok = false;
    try {
      raw = await callTool(c.tool, c.args);
      ok = raw && Object.keys(raw).length > 0;
    } catch (e) {
      raw = { _error: String(e) };
    }
    const wrapped = {
      _capture: "LIVE",
      _note: `RAW live tools/call envelope for "${c.tool}" — captured ${nowISO}. NOT a SAMPLE fixture.`,
      capturedAt: nowISO,
      tool: c.tool,
      args: c.args,
      envelope: raw,
      unwrapped: unwrapMcp(raw),
    };
    fs.writeFileSync(path.join(LIVE_DIR, `${c.tool}.json`), JSON.stringify(wrapped, null, 2) + "\n", "utf8");
    manifest.tools.push({ tool: c.tool, ok });
    console.log(`  ${ok ? "OK " : "?? "} ${c.tool} -> fixtures/cmc/live/${c.tool}.json`);
  }

  const parsed = await normalizedParse();
  manifest.normalizedParse = parsed;
  fs.writeFileSync(path.join(LIVE_DIR, "_manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("\n[stoic] LIVE round-trip complete. Normalized parse (paste into docs/DEMO.md):");
  console.log(JSON.stringify(parsed, null, 2));
  console.log(`\n  Raw envelopes + manifest committed under fixtures/cmc/live/.`);
  console.log(`  If any field shows available:false, the real path differs from the defensive parser —`);
  console.log(`  fix src/data/cmc.ts to match the captured envelope, then re-run.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[stoic] cmc-live-roundtrip failed:", e);
    process.exit(1);
  });
}
