/**
 * Stoic — CoinMarketCap Agent Hub (MCP) data adapter.  [M1]
 *
 * A typed client for the CMC MCP tools the signal engine uses, with TWO transports:
 *
 *   (a) LIVE   — HTTP POST (JSON-RPC `tools/call`) to https://mcp.coinmarketcap.com/mcp
 *                with header `X-CMC-MCP-API-KEY: <process.env.CMC_MCP_API_KEY>`.
 *                A free key (10k credits/mo) is at pro.coinmarketcap.com.
 *   (b) FIXTURE — DEFAULT when no key. Reads fixtures/cmc/<tool>.json (the M-1 pinned
 *                samples) so the whole pipeline + tests run offline and reproducibly.
 *
 * HONESTY / PROVENANCE (see D:\BNB\BNB_BUILD_PLAN.md sections 2, 4 — R3):
 *   - Live JSON field paths are VERIFIED for only 2 tools (quotes_latest,
 *     technical_analysis, pinned in M-1). Everything else is coded against DOCUMENTED
 *     shapes but UNVERIFIED, so EVERY parser is DEFENSIVE / multi-path (same technique
 *     as Stoic's allora.ts / elfa.ts) and returns a normalized `{ value, available }`.
 *   - When a value is unavailable (no key, network error, surprise shape, NaN) the
 *     adapter degrades to `available:false` and the bounded-advisory mapper emits the
 *     strict no-op `{ adjustment:0, confidence:0 }` that core.blendScore treats as a
 *     pass-through — keeping the deterministic engine + backtest byte-reproducible.
 *   - Fixtures are labelled "SAMPLE — replace with live ... responses"; we never
 *     fabricate a live response and present it as real.
 *
 * The signal engine (M2) consumes the normalized fields directly AND, where a leg is
 * advisory, folds the mapped `{adjustment,confidence}` through core.blendScore.
 */

import * as fs from "fs";
import * as path from "path";

// ── config ──────────────────────────────────────────────────────────────────
export const CMC_MCP_URL = "https://mcp.coinmarketcap.com/mcp";
const FIXTURE_DIR = path.resolve(__dirname, "../../fixtures/cmc");

// ── normalized result types ───────────────────────────────────────────────────
/** Every metric is surfaced as a normalized cell: a number + whether it was found. */
export interface Metric {
  value: number;
  available: boolean;
}

/** Bounded advisory consumed by core.blendScore. `{0,0}` = strict no-op (pass-through). */
export interface Advisory {
  adjustment: number; // integer, -50..50
  confidence: number; // 0..1
}

export const NO_METRIC: Metric = { value: 0, available: false };
export const NO_ADVICE: Advisory = { adjustment: 0, confidence: 0 };

// Normalized per-tool payloads. Each field is a Metric so a partial/surprise response
// degrades field-by-field rather than all-or-nothing.
export interface SearchResult {
  id: number | null;
  symbol: string;
  available: boolean;
}
export interface Quotes {
  price: Metric;
  volume24h: Metric;
  percentChange1h: Metric;
  percentChange24h: Metric;
  percentChange7d: Metric;
  marketCap: Metric;
}
export interface TechnicalAnalysis {
  rsi: Metric;       // 0..100
  macdHist: Metric;  // MACD histogram (signed)
  ema50: Metric;
  ema200: Metric;
  atr: Metric;
}
export interface GlobalMetrics {
  fearGreed: Metric;     // 0..100 (regime)
  btcDominance: Metric;  // %
  altSeasonIndex: Metric;
}
export interface Derivatives {
  fundingRate: Metric;        // fraction per interval (positioning/crowd leg)
  openInterest: Metric;       // USD
  openInterestChange24h: Metric; // %
  liquidations24h: Metric;    // USD
  longShortRatio: Metric;
}
export interface TrendingNarrative {
  name: string;
  avgPriceChange24h: number;
}
export interface Narratives {
  narratives: TrendingNarrative[];
  available: boolean;
}
export interface HolderMetrics {
  holderCount: Metric;
  whalesPct: Metric;        // % held by whales (concentration)
  whaleTxns24h: Metric;
  holderChange24h: Metric;
}

// ── numeric / parse helpers (pure, defensive) ─────────────────────────────────
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** First finite number among the candidates, else null. Tolerates strings + nullish. */
function firstNum(...cands: any[]): number | null {
  for (const c of cands) {
    if (c === null || c === undefined || c === "") continue;
    const n = typeof c === "number" ? c : Number(c);
    if (isFinite(n)) return n;
  }
  return null;
}

/**
 * Parse a numeric STRING that may carry thousands separators ("64,367.92" -> 64367.92) or a
 * leading sign ("+58.29%" handled by stripping non-numerics below). Returns null on failure.
 * Plain numbers pass through. Tolerates nullish.
 */
function numStr(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * Parse a CMC unit-suffixed value string into its raw magnitude:
 *   "409.62 B" -> 409.62e9, "2.24 T" -> 2.24e12, "351.26 M" -> 351.26e6, "76.15 K" -> 76150,
 *   "+58.29%" / "-0.70207%" -> the fraction (-> /100), "0.00090222" -> 0.00090222.
 * Strips a leading +/-, thousands separators, and a trailing unit token. Null on failure.
 */
function unitNum(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "") return null;
  const isPct = s.includes("%");
  // Unit multiplier (case-insensitive, optional). Match the FIRST T/B/M/K token.
  const unit = s.match(/([TBMK])\b/i);
  let mult = 1;
  if (!isPct && unit) {
    switch (unit[1].toUpperCase()) {
      case "T": mult = 1e12; break;
      case "B": mult = 1e9; break;
      case "M": mult = 1e6; break;
      case "K": mult = 1e3; break;
    }
  }
  // Keep digits, sign, decimal point only.
  const cleaned = s.replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  const base = Number(cleaned);
  if (!isFinite(base)) return null;
  if (isPct) return base / 100; // percent string -> fraction
  return base * mult;
}

/** Wrap a candidate chain into a normalized Metric (available iff a finite number found). */
function metric(...cands: any[]): Metric {
  const n = firstNum(...cands);
  return n === null ? { ...NO_METRIC } : { value: n, available: true };
}

/** Like `metric` but each candidate is run through `numStr` (comma-separated number strings). */
function metricStr(...cands: any[]): Metric {
  for (const c of cands) {
    const n = numStr(c);
    if (n !== null) return { value: n, available: true };
  }
  return { ...NO_METRIC };
}

/** Like `metric` but each candidate is run through `unitNum` (unit-suffixed / percent strings). */
function metricUnit(...cands: any[]): Metric {
  for (const c of cands) {
    const n = unitNum(c);
    if (n !== null) return { value: n, available: true };
  }
  return { ...NO_METRIC };
}

/**
 * Unwrap an MCP `tools/call` envelope into the underlying JSON payload, DEFENSIVELY.
 *
 * The CMC MCP server returns `{ jsonrpc, id, result:{ content:[{ type:"text",
 * text:"<ESCAPED JSON STRING>" }] } }` — the tool payload is DOUBLE-ENCODED: `result.
 * content[0].text` is itself a JSON string that must be `JSON.parse`d AGAIN to get the real
 * payload (which may be an ARRAY or an OBJECT). A JSON-RPC error response carries `{error}`
 * (and no usable `result`) -> we degrade to `{}`. Some servers also mirror a structured
 * object under `structuredContent`. We try, in order: content[].text double-decode,
 * structuredContent, the raw object. Never throws — returns `{}` on total failure.
 */
export function unwrapMcp(raw: any): any {
  if (raw === null || raw === undefined) return {};
  try {
    // 0) JSON-RPC error response: { error:{ code, message } } -> no usable payload.
    if (raw?.error && raw?.result === undefined) return {};
    // 1) JSON-RPC result wrapper: { result: { content/structuredContent ... } }
    const root = raw?.result ?? raw;
    // 2) content[].text double-encoded JSON (array OR object payloads both valid)
    const content = root?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const text = block?.text;
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object") return parsed; // arrays included
          } catch {
            /* not JSON — fall through to other shapes */
          }
        }
      }
    }
    // 3) structuredContent / data already objects
    if (root?.structuredContent && typeof root.structuredContent === "object") {
      return root.structuredContent;
    }
    // 4) the root itself already carries `data`
    if (root && typeof root === "object") return root;
  } catch {
    /* swallow */
  }
  return {};
}

// ── transport ─────────────────────────────────────────────────────────────────
/** True when a live CMC MCP key is configured. Otherwise we run on pinned fixtures. */
export function hasLiveKey(): boolean {
  return !!(process.env.CMC_MCP_API_KEY && process.env.CMC_MCP_API_KEY.trim());
}

/**
 * Call one MCP tool. LIVE when `CMC_MCP_API_KEY` is set (HTTP POST JSON-RPC), else
 * FIXTURE mode reading fixtures/cmc/<tool>.json. Returns the RAW envelope (callers
 * pass it through `unwrapMcp` + a defensive parser). NEVER throws — returns `{}` on any
 * failure so the bounded-advisory layer degrades to a no-op.
 *
 * @param tool        MCP tool name, e.g. "get_crypto_quotes_latest".
 * @param args        tool arguments (e.g. { id: 1 }); ignored in fixture mode.
 * @param fixtureName override the fixture file basename (defaults to `tool`).
 */
export async function callTool(
  tool: string,
  args: Record<string, any> = {},
  fixtureName?: string
): Promise<any> {
  if (!hasLiveKey()) return readFixture(fixtureName ?? tool);

  try {
    const res = await fetch(CMC_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The CMC MCP server replies application/json normally, but the transport is also
        // SSE-capable; advertise both so a streaming reply is accepted.
        Accept: "application/json, text/event-stream",
        "X-CMC-MCP-API-KEY": process.env.CMC_MCP_API_KEY as string,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    if (!res || !(res as any).ok) return {};

    // Prefer a structured Content-Type read; fall back to text + sniff so we tolerate a
    // text/event-stream reply (join the `data:` lines and JSON.parse) as well as plain JSON.
    const ctype = (() => {
      try {
        return String((res as any).headers?.get?.("content-type") ?? "").toLowerCase();
      } catch {
        return "";
      }
    })();

    if (ctype.includes("text/event-stream")) {
      const body = await (res as any).text();
      return parseSse(body);
    }
    // Default: JSON. If json() is unavailable (older/stubbed Response) or the body is
    // actually SSE without a matching header, fall back to text + sniff.
    if (typeof (res as any).json === "function") {
      try {
        return await (res as any).json();
      } catch {
        /* fall through to text sniff */
      }
    }
    if (typeof (res as any).text === "function") {
      const body = await (res as any).text();
      if (/^\s*(data:|event:|id:)/m.test(body)) return parseSse(body);
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    }
    return {};
  } catch {
    return {}; // network / parse failure -> no-op upstream
  }
}

/**
 * Parse a `text/event-stream` body into the JSON-RPC envelope: join every `data:` line and
 * JSON.parse the result (the last complete data payload wins). Never throws -> `{}`.
 */
function parseSse(body: string): any {
  try {
    const dataLines = String(body)
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0 && l !== "[DONE]");
    if (dataLines.length === 0) return {};
    // Try the joined payload first (a single event split across lines), then the last line.
    for (const candidate of [dataLines.join(""), dataLines[dataLines.length - 1]]) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        /* try next */
      }
    }
    return {};
  } catch {
    return {};
  }
}

/** Read a pinned fixture by tool name. Never throws. */
function readFixture(name: string): any {
  try {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// ── per-tool typed adapters (defensive multi-path parse on the unwrapped payload) ──

/**
 * Resolve a ticker symbol -> CMC numeric id. CALL THIS FIRST: every quote/TA/metrics
 * tool keys off the numeric id, not the symbol.
 */
export async function searchCryptos(symbol: string): Promise<SearchResult> {
  const raw = await callTool("search_cryptos", { query: symbol });
  const j = unwrapMcp(raw);
  const want = String(symbol).toUpperCase();
  try {
    // REAL shape: a bare ARRAY of { id:NUMBER, name, symbol, slug, rank }. Stay defensive in
    // case a server nests it under data / cryptoCurrencyList / cryptocurrencies.
    const rows: any[] =
      (Array.isArray(j) && j) ||
      (Array.isArray(j?.data) && j.data) ||
      (Array.isArray(j?.data?.cryptoCurrencyList) && j.data.cryptoCurrencyList) ||
      (Array.isArray(j?.cryptocurrencies) && j.cryptocurrencies) ||
      [];
    // Prefer an exact symbol match; else the highest-ranked row; else the first.
    const exact = rows.find((r) => String(r?.symbol).toUpperCase() === want);
    const pick =
      exact ??
      [...rows].sort(
        (a, b) => (Number(a?.rank) || 1e9) - (Number(b?.rank) || 1e9)
      )[0];
    const id = firstNum(pick?.id, pick?.cmc_id, pick?.cmcId);
    if (id === null) return { id: null, symbol: want, available: false };
    return { id, symbol: want, available: true };
  } catch {
    return { id: null, symbol: want, available: false };
  }
}

/** Latest price quote + 24h volume/changes/market cap for a CMC numeric id (id REQUIRED). */
export async function getQuotes(id: number, _symbol = ""): Promise<Quotes> {
  // `id` is a REQUIRED comma-separated numeric-string arg (per the tool inputSchema).
  const raw = await callTool("get_crypto_quotes_latest", { id: String(id) });
  const j = unwrapMcp(raw);
  // REAL shape: a bare ARRAY whose [0] carries FLAT numeric fields
  //   { id:"1", price, percent_change_1h/_24h/_7d, volume_24h, market_cap, ... }.
  // Stay defensive: also accept an id/symbol-keyed map or a quote.USD nesting.
  const sym = String(_symbol || "").toUpperCase();
  const node =
    (Array.isArray(j) ? j[0] : undefined) ??
    (Array.isArray(j?.data) ? j.data[0] : undefined) ??
    j?.data?.[String(id)] ??
    (sym ? j?.data?.[sym] : undefined) ??
    j?.data ??
    j ??
    {};
  const q = node?.quote?.USD ?? node?.quote ?? node ?? {};
  return {
    price: metric(node?.price, q?.price),
    volume24h: metric(node?.volume_24h, q?.volume_24h, q?.volume24h),
    percentChange1h: metric(node?.percent_change_1h, q?.percent_change_1h, q?.percentChange1h),
    percentChange24h: metric(node?.percent_change_24h, q?.percent_change_24h, q?.percentChange24h),
    percentChange7d: metric(node?.percent_change_7d, q?.percent_change_7d, q?.percentChange7d),
    marketCap: metric(node?.market_cap, q?.market_cap, q?.marketCap),
  };
}

/** Pre-computed technical indicators (RSI / MACD / EMA) for a numeric id (id REQUIRED). */
export async function getTechnicalAnalysis(
  id: number,
  _symbol = ""
): Promise<TechnicalAnalysis> {
  const raw = await callTool("get_crypto_technical_analysis", { id: String(id) });
  const j = unwrapMcp(raw);
  const sym = String(_symbol || "").toUpperCase();
  // REAL shape (flat object):
  //   { rsi:{rsi7,rsi14,rsi21}, macd:{macdLine,signalLine,histogram},
  //     moving_averages:{ exponential_moving_average_7/30/200_day, simple_... } }
  // Values are STRINGS WITH COMMAS ("41.85" / "620.87" / "64,367.92"). Parse via numStr.
  // Stay defensive: also accept id/symbol-keyed maps and an `indicators` nesting.
  const d =
    j?.data?.[String(id)] ??
    (sym ? j?.data?.[sym] : undefined) ??
    j?.data ??
    j ??
    {};
  const ind = d?.indicators ?? d;
  const rsi = ind?.rsi ?? d?.rsi ?? {};
  const macd = ind?.macd ?? d?.macd ?? {};
  const ma = ind?.moving_averages ?? d?.moving_averages ?? ind?.movingAverages ?? {};
  return {
    // RSI = rsi.rsi14 (string). Fall back to older flat spellings.
    rsi: metricStr(rsi?.rsi14, rsi?.rsi_14, ind?.rsi_14, ind?.rsi),
    // MACD histogram (signed, string).
    macdHist: metricStr(
      macd?.histogram,
      macd?.hist,
      macd?.macd_hist,
      ind?.macd_hist,
      ind?.macd_histogram
    ),
    // No 50-day EMA in the live payload; the 30-day EMA is the closest mid-term EMA.
    ema50: metricStr(
      ma?.exponential_moving_average_50_day,
      ma?.exponential_moving_average_30_day,
      ind?.ema_50,
      ind?.ema50
    ),
    ema200: metricStr(
      ma?.exponential_moving_average_200_day,
      ind?.ema_200,
      ind?.ema200
    ),
    // ATR is not part of the live technical-analysis payload -> remains unavailable.
    atr: metricStr(ind?.atr_14, ind?.atr, ind?.ATR, d?.atr_14, d?.atr),
  };
}

/** Global regime read: Fear&Greed (0..100), BTC dominance (%), altseason index. */
export async function getGlobalMetrics(): Promise<GlobalMetrics> {
  const raw = await callTool("get_global_metrics_latest", {});
  const j = unwrapMcp(raw);
  const d = j?.data ?? j ?? {};
  // REAL paths:
  //   Fear&Greed   = sentiment.fear_greed.current.index   (NUMBER 0..100)
  //   BTC dominance= dominance.btc.current = "+58.29%"     (percent string -> 58.29)
  //   Altseason    = rotation.altcoin_season.current.index (NUMBER)
  const fgCur = d?.sentiment?.fear_greed?.current;
  const fgLegacy = d?.fear_and_greed ?? d?.fearAndGreed ?? d?.fear_greed;
  // BTC dominance as a PERCENT number (strip +/- and %, keep magnitude scale): unitNum
  // would divide the % by 100; here the field is documented as a percent, so parse the bare
  // number from "+58.29%" -> 58.29.
  const domStr = d?.dominance?.btc?.current ?? d?.btc_dominance ?? d?.btcDominance;
  const domNum =
    typeof domStr === "string" ? numStr(domStr.replace(/[%+]/g, "")) : numStr(domStr);
  const altCur = d?.rotation?.altcoin_season?.current;
  return {
    fearGreed: metric(
      fgCur?.index,
      typeof fgLegacy === "object" ? fgLegacy?.value : fgLegacy,
      d?.fear_and_greed_value,
      d?.fearGreedIndex
    ),
    btcDominance: domNum === null ? { ...NO_METRIC } : { value: domNum, available: true },
    altSeasonIndex: metric(
      altCur?.index,
      d?.altcoin_season_index,
      d?.altcoinSeasonIndex,
      d?.altseason_index
    ),
  };
}

/** Derivatives positioning: funding rate, open interest, OI 24h change, liquidations. */
export async function getDerivatives(_symbol = ""): Promise<Derivatives> {
  const raw = await callTool("get_global_crypto_derivatives_metrics", {});
  const j = unwrapMcp(raw);
  // REAL paths (flat object — no symbol arg, this is a GLOBAL aggregate):
  //   fundingRate      = fundingRate.current               ("0.00090222" -> fraction)
  //   openInterest     = totalOpenInterest.current         ("409.62 B"   -> 409.62e9)
  //   OI 24h change    = totalOpenInterest.percentage_change_24h ("-3.47%" -> -3.47, percent)
  //   liquidations 24h = btc_liquidations.total_usd_24h.total    ("66.03 M" -> 66.03e6)
  //   (no global long/short ratio is exposed -> longShortRatio stays unavailable)
  const d = j?.data?.derivatives ?? j?.data ?? j ?? {};
  const fr = d?.fundingRate ?? d?.funding_rate ?? {};
  const oi = d?.totalOpenInterest ?? d?.open_interest ?? {};
  const liq24 = d?.btc_liquidations?.total_usd_24h ?? {};
  // OI 24h change as a percent number ("-3.47%" -> -3.47).
  const oiChgStr = oi?.percentage_change_24h ?? d?.open_interest_change_24h;
  const oiChg =
    typeof oiChgStr === "string" ? numStr(oiChgStr.replace(/[%+]/g, "")) : numStr(oiChgStr);
  return {
    // funding fraction: current funding string, or a legacy flat number.
    fundingRate: metricStr(
      fr?.current,
      typeof fr === "number" || typeof fr === "string" ? fr : undefined,
      d?.funding_rate_8h,
      d?.avg_funding_rate
    ),
    openInterest: metricUnit(oi?.current, d?.openInterest, d?.oi),
    openInterestChange24h:
      oiChg === null ? { ...NO_METRIC } : { value: oiChg, available: true },
    liquidations24h: metricUnit(
      liq24?.total,
      d?.liquidations_24h,
      d?.liquidations24h,
      d?.total_liquidations_24h
    ),
    longShortRatio: metric(d?.long_short_ratio, d?.longShortRatio, d?.ls_ratio),
  };
}

/** Trending narratives with 24h performance (optional attention-momentum input). */
export async function getTrendingNarratives(): Promise<Narratives> {
  const raw = await callTool("trending_crypto_narratives", {});
  const j = unwrapMcp(raw);
  try {
    // REAL shape: { categoryList:{ headers:[...], rows:[[...], ...] } }. Each row is an array
    // aligned to `headers`; map columns by header name. Name = categoryName,
    // 24h performance = marketCapChangePercentage24h ("-0.20934%" -> -0.20934, percent).
    const cl = j?.categoryList ?? j?.data?.categoryList;
    if (cl && Array.isArray(cl?.headers) && Array.isArray(cl?.rows)) {
      const headers: string[] = cl.headers.map((h: any) => String(h));
      const iName = headers.indexOf("categoryName");
      const iChg = headers.indexOf("marketCapChangePercentage24h");
      const narratives: TrendingNarrative[] = cl.rows
        .map((row: any[]) => {
          const name = String(iName >= 0 ? row?.[iName] ?? "" : "").trim();
          const chgRaw = iChg >= 0 ? row?.[iChg] : undefined;
          const chg =
            typeof chgRaw === "string"
              ? numStr(chgRaw.replace(/[%+]/g, ""))
              : numStr(chgRaw);
          return { name, avgPriceChange24h: chg ?? 0 };
        })
        .filter((n: TrendingNarrative) => n.name.length > 0);
      return { narratives, available: narratives.length > 0 };
    }

    // Fallback: a flat array / nested array of narrative objects.
    const rows: any[] =
      (Array.isArray(j?.data) && j.data) ||
      (Array.isArray(j?.data?.narratives) && j.data.narratives) ||
      (Array.isArray(j?.narratives) && j.narratives) ||
      (Array.isArray(j) && j) ||
      [];
    const narratives: TrendingNarrative[] = rows
      .map((r) => ({
        name: String(r?.name ?? r?.narrative ?? r?.category ?? r?.categoryName ?? "").trim(),
        avgPriceChange24h:
          (() => {
            const c =
              r?.avg_price_change_24h ??
              r?.avgPriceChange24h ??
              r?.price_change_24h ??
              r?.market_cap_change_24h ??
              r?.marketCapChangePercentage24h;
            return (typeof c === "string" ? numStr(c.replace(/[%+]/g, "")) : firstNum(c)) ?? 0;
          })(),
      }))
      .filter((n) => n.name.length > 0);
    return { narratives, available: narratives.length > 0 };
  } catch {
    return { narratives: [], available: false };
  }
}

/** Holder / whale distribution (optional on-chain-concentration term) — id REQUIRED. */
export async function getMetrics(id: number, _symbol = ""): Promise<HolderMetrics> {
  const raw = await callTool("get_crypto_metrics", { id: String(id) });
  const j = unwrapMcp(raw);
  const sym = String(_symbol || "").toUpperCase();
  // REAL shape (flat object):
  //   addressesByHoldingValue:{ usd0To1k, usd1kTo100k, usd100kPlus:{count,percentOfAddresses} }
  //   circulatingSupplyDistribution:{ whales:{volume,percentOfSupply}, others }
  //   addressesByHoldingTime:{ traders, cruisers, holders:{count,percentOfAddresses} }
  // Whale proxy = usd100kPlus.percentOfAddresses. holderCount = sum of the address buckets.
  const d =
    j?.data?.[String(id)] ??
    (sym ? j?.data?.[sym] : undefined) ??
    j?.data ??
    j ??
    {};
  const abhv = d?.addressesByHoldingValue ?? {};
  const whales100k = abhv?.usd100kPlus ?? {};
  // Total holder/address count: sum the holding-value buckets when present.
  const bucketCounts = [abhv?.usd0To1k?.count, abhv?.usd1kTo100k?.count, abhv?.usd100kPlus?.count]
    .map((c) => firstNum(c))
    .filter((n): n is number => n !== null);
  const holderTotal =
    bucketCounts.length > 0
      ? bucketCounts.reduce((a, b) => a + b, 0)
      : firstNum(d?.holder_count, d?.holderCount, d?.holders);
  // Legacy flat distribution fallback (old SAMPLE shape).
  const dist = d?.holder_distribution ?? d?.holderDistribution;
  return {
    holderCount: holderTotal === null ? { ...NO_METRIC } : { value: holderTotal, available: true },
    whalesPct: metric(
      whales100k?.percentOfAddresses,
      d?.circulatingSupplyDistribution?.whales?.percentOfSupply,
      dist?.whales_pct,
      dist?.whalesPct,
      dist?.whale_pct,
      dist?.top_10_pct
    ),
    whaleTxns24h: metric(
      d?.whale_transactions_24h,
      d?.whaleTransactions24h,
      d?.whale_txns_24h
    ),
    holderChange24h: metric(d?.holder_change_24h, d?.holderChange24h),
  };
}

// ── bounded-advisory mappers (Metric -> {adjustment,confidence} for blendScore) ──
//
// Each mapper turns a normalized metric into the bounded advisory core.blendScore
// consumes. Unavailable -> strict no-op {0,0}. These are MODEST nudges (small adj,
// modest confidence) so a single live leg never dominates the deterministic core;
// the divergence engine (M2) does the heavy lifting. Scalings are intentionally
// conservative and documented; tune in M2 when the engine is wired end-to-end.

/**
 * RSI -> bounded advisory. Centered at 50 (neutral); >50 bullish, <50 bearish.
 * Maps the |distance from 50| to a small adjustment; confidence rises with distance.
 */
export function rsiAdvisory(rsi: Metric): Advisory {
  if (!rsi.available) return { ...NO_ADVICE };
  const dist = clamp(rsi.value, 0, 100) - 50; // -50..50
  return {
    adjustment: clamp(Math.round(dist * 0.6), -50, 50),
    confidence: clamp(Math.abs(dist) / 50, 0, 1) * 0.5, // up to 0.5 at extremes
  };
}

/**
 * Funding rate -> bounded advisory for the POSITIONING/CROWD leg. POSITIVE funding =
 * crowded longs (contrarian-bearish pressure) -> negative adjustment; negative funding
 * (crowded shorts) -> positive. Funding is a small fraction (e.g. 0.0001 = 1bp/interval).
 */
export function fundingAdvisory(funding: Metric): Advisory {
  if (!funding.available) return { ...NO_ADVICE };
  // 0.01% (0.0001) ~ a mild crowd lean; scale so a typical +/-0.05% maps to a modest nudge.
  const bps = funding.value * 10000; // funding in basis points
  return {
    adjustment: clamp(Math.round(-bps * 30), -50, 50), // contrarian: crowded longs -> bearish
    confidence: clamp(Math.abs(bps) / 5, 0, 1) * 0.4,
  };
}

/**
 * Fear & Greed -> bounded advisory (regime tilt). Extreme GREED (>=75) leans
 * contrarian-bearish, extreme FEAR (<=25) contrarian-bullish; the mid band is a near
 * no-op. This is the regime nudge; the hard regime GATE lives in the M2 engine.
 */
export function fearGreedAdvisory(fg: Metric): Advisory {
  if (!fg.available) return { ...NO_ADVICE };
  const v = clamp(fg.value, 0, 100);
  const dist = v - 50; // >0 greed, <0 fear
  return {
    adjustment: clamp(Math.round(-dist * 0.4), -50, 50), // contrarian regime tilt
    confidence: clamp(Math.abs(dist) / 50, 0, 1) * 0.3,
  };
}

/**
 * Trending narratives -> bounded attention-momentum advisory. Looks up `name` (case-
 * insensitive substring) among the trending narratives and maps its 24h performance to
 * a small nudge. HONEST LABEL: this is attention/narrative MOMENTUM, not sentiment
 * polarity (same caveat as Stoic's elfa.ts). No match -> no-op.
 */
export function narrativeAdvisory(n: Narratives, name: string): Advisory {
  if (!n.available || !name) return { ...NO_ADVICE };
  const want = name.toLowerCase();
  const hit = n.narratives.find((x) => x.name.toLowerCase().includes(want));
  if (!hit) return { ...NO_ADVICE };
  return {
    adjustment: clamp(Math.round(hit.avgPriceChange24h * 0.8), -25, 25),
    confidence: 0.3,
  };
}
