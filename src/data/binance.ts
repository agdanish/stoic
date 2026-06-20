/**
 * Stoic — FREE Binance public REST adapter (NO API KEY).  [M1d]
 *
 * Typed, defensive fetchers for the historical + flow series that feed the backtest
 * (the REAL, NON-cosmetic input — see D:\BNB\BNB_BUILD_PLAN.md R5/M1d). All endpoints
 * are public and keyless:
 *
 *   klines        GET https://api.binance.com/api/v3/klines
 *                     ?symbol=BTCUSDT&interval=1h&limit=1000[&startTime&endTime]
 *   funding       GET https://fapi.binance.com/fapi/v1/fundingRate
 *                     ?symbol=BTCUSDT[&startTime&endTime&limit]      (settles every 8h)
 *   long/short    GET https://fapi.binance.com/futures/data/globalLongShortAccountRatio
 *                     ?symbol=BTCUSDT&period=1h[&startTime&endTime&limit]
 *   taker vol     GET https://fapi.binance.com/futures/data/takerlongshortRatio
 *                     ?symbol=BTCUSDT&period=1h[&startTime&endTime&limit]
 *   open interest GET https://fapi.binance.com/futures/data/openInterestHist
 *                     ?symbol=BTCUSDT&period=1h[&startTime&endTime&limit]
 *
 * PROVENANCE / HONESTY (mirrors the discipline in src/data/cmc.ts):
 *   - Klines are SPOT OHLCV; funding/longShortRatio/taker/OI are USDT-M FUTURES series.
 *     They share the same <SYMBOL>USDT pair convention used across the project.
 *   - The `futures/data/*` endpoints (longShortRatio, takerBuySellRatio, openInterest)
 *     retain only ~30 days of history on the public API. klines + funding go back years.
 *     The JOIN is therefore TOLERANT: a Bar always has OHLCV; the flow fields are
 *     OPTIONAL and simply absent on bars older than the futures-data retention window.
 *     Nothing is fabricated to fill the gap — absent means absent.
 *   - funding settles on an 8h cadence; we forward-fill the most recent funding settle
 *     onto each hourly bar (a funding rate is a standing level until the next settle),
 *     and tag the bar where the settle actually occurred. This is documented, not hidden.
 *
 * Pure transport + parse only; no fixture IO and no synthetic data here — that policy
 * lives in fetchHistory.ts (the orchestrator/writer). Every fetcher is defensive and
 * never returns a half-parsed row: a malformed element is skipped, not coerced to NaN.
 */

// ── endpoint config ───────────────────────────────────────────────────────────
export const SPOT_BASE = "https://api.binance.com";
export const FAPI_BASE = "https://fapi.binance.com";

/** Public-API hard cap on rows per klines request. */
export const KLINES_MAX_LIMIT = 1000;
/** Public-API hard cap on rows per futures/data request. */
export const FUTURES_DATA_MAX_LIMIT = 500;
/** Milliseconds in one hour (the project's bar interval). */
export const HOUR_MS = 3_600_000;
/**
 * Public-API retention for the futures/data/* endpoints (longShort / taker / OI).
 * A `startTime` older than ~30 days returns error -1130 ("parameter 'startTime' is
 * invalid"), so a range pull MUST clamp its start cursor to within this window —
 * older bars then legitimately lack these legs (we never fabricate to fill the gap).
 * Set to 29 days to stay safely inside the boundary.
 */
export const FUTURES_DATA_RETENTION_MS = 29 * 24 * HOUR_MS;

// ── unified bar type (the contract every downstream module loads) ──────────────
/**
 * One hourly bar. OHLCV is ALWAYS present (from spot klines). The flow fields are
 * OPTIONAL — present only when the corresponding futures series covers that timestamp.
 *   t                  open time of the bar, ms since epoch (the join key).
 *   open/high/low/close spot OHLC in USDT.
 *   volume             base-asset volume over the bar.
 *   funding            funding rate in effect at this bar (fraction, e.g. 0.0001 = 1bp);
 *                      forward-filled from the most recent 8h settle.
 *   fundingSettled     true on the bar where a funding settle actually occurred.
 *   longShortRatio     global long/short ACCOUNT ratio (positioning/crowd leg input).
 *   takerBuySellRatio  taker buy/sell volume ratio (flow leg input).
 *   openInterest       sum open interest (base units) at this bar.
 */
export interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  funding?: number;
  fundingSettled?: boolean;
  longShortRatio?: number;
  takerBuySellRatio?: number;
  openInterest?: number;
}

// ── raw per-endpoint typed rows (post-parse, pre-join) ─────────────────────────
export interface Kline {
  t: number; // open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}
export interface FundingPoint {
  t: number; // fundingTime
  funding: number;
}
export interface LongShortPoint {
  t: number;
  longShortRatio: number;
}
export interface TakerPoint {
  t: number;
  takerBuySellRatio: number;
}
export interface OpenInterestPoint {
  t: number;
  openInterest: number;
}

// ── numeric / parse helpers (pure, defensive — mirror cmc.ts) ──────────────────
/** First finite number among candidates, else null. Tolerates strings + nullish. */
function firstNum(...cands: any[]): number | null {
  for (const c of cands) {
    if (c === null || c === undefined || c === "") continue;
    const n = typeof c === "number" ? c : Number(c);
    if (isFinite(n)) return n;
  }
  return null;
}

/** Build a query string from a param record, skipping nullish values. */
function qs(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * GET + parse JSON from a Binance endpoint. Returns `[]`-or-`null` semantics: an array
 * payload comes back as-is; a non-2xx / network / parse failure returns `null` so the
 * caller can distinguish "empty window" from "request failed". NEVER throws.
 */
async function getJson(url: string): Promise<any> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res || !(res as any).ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── per-endpoint typed fetchers ────────────────────────────────────────────────

/**
 * Spot klines (OHLCV). Binance returns an array of arrays:
 *   [ openTime, open, high, low, close, volume, closeTime, quoteVol, trades,
 *     takerBuyBase, takerBuyQuote, ignore ]
 * Malformed rows are skipped. `null` on request failure (vs `[]` for an empty window).
 */
export async function fetchKlines(
  symbol: string,
  interval = "1h",
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<Kline[] | null> {
  const limit = Math.min(opts.limit ?? KLINES_MAX_LIMIT, KLINES_MAX_LIMIT);
  const url =
    `${SPOT_BASE}/api/v3/klines` +
    qs({ symbol, interval, limit, startTime: opts.startTime, endTime: opts.endTime });
  const j = await getJson(url);
  if (!Array.isArray(j)) return null;
  const out: Kline[] = [];
  for (const row of j) {
    if (!Array.isArray(row)) continue;
    const t = firstNum(row[0]);
    const open = firstNum(row[1]);
    const high = firstNum(row[2]);
    const low = firstNum(row[3]);
    const close = firstNum(row[4]);
    const volume = firstNum(row[5]);
    const closeTime = firstNum(row[6]);
    if (t === null || open === null || high === null || low === null || close === null || volume === null) {
      continue; // skip a malformed row rather than coerce to NaN
    }
    out.push({ t, open, high, low, close, volume, closeTime: closeTime ?? t + HOUR_MS - 1 });
  }
  return out;
}

/**
 * USDT-M futures funding rate history. Rows: { symbol, fundingTime, fundingRate, markPrice }.
 * Settles every 8h, so this is sparse relative to hourly bars (the join forward-fills it).
 */
export async function fetchFunding(
  symbol: string,
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<FundingPoint[] | null> {
  const url =
    `${FAPI_BASE}/fapi/v1/fundingRate` +
    qs({ symbol, limit: opts.limit, startTime: opts.startTime, endTime: opts.endTime });
  const j = await getJson(url);
  if (!Array.isArray(j)) return null;
  const out: FundingPoint[] = [];
  for (const r of j) {
    const t = firstNum(r?.fundingTime, r?.time, r?.timestamp);
    const funding = firstNum(r?.fundingRate, r?.funding_rate);
    if (t === null || funding === null) continue;
    out.push({ t, funding });
  }
  return out;
}

/**
 * Global long/short ACCOUNT ratio. Rows: { longAccount, shortAccount, longShortRatio,
 * timestamp }. Public-API retention ~30 days; absent for older bars (left optional).
 */
export async function fetchLongShortRatio(
  symbol: string,
  period = "1h",
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<LongShortPoint[] | null> {
  const limit = Math.min(opts.limit ?? FUTURES_DATA_MAX_LIMIT, FUTURES_DATA_MAX_LIMIT);
  const url =
    `${FAPI_BASE}/futures/data/globalLongShortAccountRatio` +
    qs({ symbol, period, limit, startTime: opts.startTime, endTime: opts.endTime });
  const j = await getJson(url);
  if (!Array.isArray(j)) return null;
  const out: LongShortPoint[] = [];
  for (const r of j) {
    const t = firstNum(r?.timestamp, r?.time);
    const longShortRatio = firstNum(r?.longShortRatio, r?.ls_ratio);
    if (t === null || longShortRatio === null) continue;
    out.push({ t, longShortRatio });
  }
  return out;
}

/**
 * Taker buy/sell volume ratio. Rows: { buySellRatio, buyVol, sellVol, timestamp }.
 * Public-API retention ~30 days; absent for older bars (left optional).
 */
export async function fetchTakerRatio(
  symbol: string,
  period = "1h",
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<TakerPoint[] | null> {
  const limit = Math.min(opts.limit ?? FUTURES_DATA_MAX_LIMIT, FUTURES_DATA_MAX_LIMIT);
  const url =
    `${FAPI_BASE}/futures/data/takerlongshortRatio` +
    qs({ symbol, period, limit, startTime: opts.startTime, endTime: opts.endTime });
  const j = await getJson(url);
  if (!Array.isArray(j)) return null;
  const out: TakerPoint[] = [];
  for (const r of j) {
    const t = firstNum(r?.timestamp, r?.time);
    const takerBuySellRatio = firstNum(r?.buySellRatio, r?.takerBuySellRatio);
    if (t === null || takerBuySellRatio === null) continue;
    out.push({ t, takerBuySellRatio });
  }
  return out;
}

/**
 * Open interest history. Rows: { sumOpenInterest, sumOpenInterestValue, timestamp }.
 * Public-API retention ~30 days; absent for older bars (left optional).
 */
export async function fetchOpenInterest(
  symbol: string,
  period = "1h",
  opts: { limit?: number; startTime?: number; endTime?: number } = {}
): Promise<OpenInterestPoint[] | null> {
  const limit = Math.min(opts.limit ?? FUTURES_DATA_MAX_LIMIT, FUTURES_DATA_MAX_LIMIT);
  const url =
    `${FAPI_BASE}/futures/data/openInterestHist` +
    qs({ symbol, period, limit, startTime: opts.startTime, endTime: opts.endTime });
  const j = await getJson(url);
  if (!Array.isArray(j)) return null;
  const out: OpenInterestPoint[] = [];
  for (const r of j) {
    const t = firstNum(r?.timestamp, r?.time);
    const openInterest = firstNum(r?.sumOpenInterest, r?.openInterest);
    if (t === null || openInterest === null) continue;
    out.push({ t, openInterest });
  }
  return out;
}

// ── paged klines (walk past the 1000-row cap to cover a multi-month window) ────
/**
 * Fetch hourly klines from `startTime` to `endTime` (ms), paging forward past the
 * 1000-row cap. De-duplicates on open time and returns ascending, unique `t`.
 * Returns whatever it successfully pulled; a failed page stops paging (no throw).
 */
export async function fetchKlinesRange(
  symbol: string,
  startTime: number,
  endTime: number,
  interval = "1h",
  intervalMs = HOUR_MS
): Promise<Kline[]> {
  const all: Kline[] = [];
  const seen = new Set<number>();
  let cursor = startTime;
  // Hard page ceiling so a misbehaving cursor can never loop forever.
  const maxPages = Math.ceil((endTime - startTime) / (KLINES_MAX_LIMIT * intervalMs)) + 4;
  for (let page = 0; page < maxPages && cursor < endTime; page++) {
    const batch = await fetchKlines(symbol, interval, {
      limit: KLINES_MAX_LIMIT,
      startTime: cursor,
      endTime,
    });
    if (!batch || batch.length === 0) break;
    let advanced = false;
    for (const k of batch) {
      if (k.t > endTime) continue;
      if (!seen.has(k.t)) {
        seen.add(k.t);
        all.push(k);
        advanced = true;
      }
    }
    const last = batch[batch.length - 1].t;
    const next = last + intervalMs;
    if (!advanced || next <= cursor) break; // no forward progress -> stop
    cursor = next;
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

/**
 * Page a futures/data endpoint (long-short / taker / OI) forward across `startTime`..
 * `endTime`. These cap at 500 rows AND only retain ~30 days, so the effective window is
 * `max(startTime, now-~30d)`..`endTime`. Generic over the point type via the fetcher.
 */
async function fetchFuturesRange<T extends { t: number }>(
  fetcher: (
    symbol: string,
    period: string,
    opts: { limit?: number; startTime?: number; endTime?: number }
  ) => Promise<T[] | null>,
  symbol: string,
  startTime: number,
  endTime: number,
  period = "1h",
  intervalMs = HOUR_MS
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<number>();
  // futures/data only retains ~30 days: a startTime older than that errors (-1130) and
  // would abort paging on the first request. Clamp forward so we still capture the
  // available recent window; older bars stay unpopulated (honest gap, no fabrication).
  const minStart = Date.now() - FUTURES_DATA_RETENTION_MS;
  let cursor = Math.max(startTime, minStart);
  const maxPages = Math.ceil((endTime - cursor) / (FUTURES_DATA_MAX_LIMIT * intervalMs)) + 4;
  for (let page = 0; page < maxPages && cursor < endTime; page++) {
    const batch = await fetcher(symbol, period, {
      limit: FUTURES_DATA_MAX_LIMIT,
      startTime: cursor,
      endTime,
    });
    if (!batch || batch.length === 0) break;
    let advanced = false;
    let last = cursor;
    for (const p of batch) {
      if (p.t > endTime) continue;
      if (p.t > last) last = p.t;
      if (!seen.has(p.t)) {
        seen.add(p.t);
        all.push(p);
        advanced = true;
      }
    }
    const next = last + intervalMs;
    if (!advanced || next <= cursor) break;
    cursor = next;
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

export const fetchLongShortRange = (
  symbol: string,
  startTime: number,
  endTime: number,
  period = "1h"
) => fetchFuturesRange(fetchLongShortRatio, symbol, startTime, endTime, period);

export const fetchTakerRange = (
  symbol: string,
  startTime: number,
  endTime: number,
  period = "1h"
) => fetchFuturesRange(fetchTakerRatio, symbol, startTime, endTime, period);

export const fetchOpenInterestRange = (
  symbol: string,
  startTime: number,
  endTime: number,
  period = "1h"
) => fetchFuturesRange(fetchOpenInterest, symbol, startTime, endTime, period);

/**
 * Funding range (8h cadence, deep history). Pages by `limit` since fundingRate has no
 * `period`. 1000-row cap on this endpoint.
 */
export async function fetchFundingRange(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<FundingPoint[]> {
  const all: FundingPoint[] = [];
  const seen = new Set<number>();
  let cursor = startTime;
  const FUNDING_MS = 8 * HOUR_MS;
  const maxPages = Math.ceil((endTime - startTime) / (1000 * FUNDING_MS)) + 4;
  for (let page = 0; page < maxPages && cursor < endTime; page++) {
    const batch = await fetchFunding(symbol, { limit: 1000, startTime: cursor, endTime });
    if (!batch || batch.length === 0) break;
    let advanced = false;
    let last = cursor;
    for (const p of batch) {
      if (p.t > endTime) continue;
      if (p.t > last) last = p.t;
      if (!seen.has(p.t)) {
        seen.add(p.t);
        all.push(p);
        advanced = true;
      }
    }
    const next = last + FUNDING_MS;
    if (!advanced || next <= cursor) break;
    cursor = next;
  }
  all.sort((a, b) => a.t - b.t);
  return all;
}

// ── the JOIN: align flow series onto the hourly klines by timestamp ────────────
/**
 * Align funding / longShort / taker / OI series onto the hourly OHLCV bars BY TIMESTAMP.
 *
 *   - OHLCV bars are the spine; their `t` (open time) is the join key.
 *   - longShort / taker / OI are point-in-time series on the SAME hourly grid -> exact
 *     timestamp match. (Binance stamps these at the bar's open time.)
 *   - funding settles every 8h -> FORWARD-FILL: each bar carries the most recent funding
 *     settle at-or-before its open time; the bar where a settle landed is tagged
 *     `fundingSettled:true`. A funding level is a standing value until the next settle,
 *     so forward-fill is the correct, look-ahead-safe interpretation (uses only past info).
 *
 * No fabrication: a flow field is left `undefined` when no series point covers the bar.
 */
export function joinBars(
  klines: Kline[],
  series: {
    funding?: FundingPoint[];
    longShort?: LongShortPoint[];
    taker?: TakerPoint[];
    openInterest?: OpenInterestPoint[];
  } = {}
): Bar[] {
  const sorted = [...klines].sort((a, b) => a.t - b.t);

  // exact-timestamp maps for the hourly-grid series
  const lsMap = new Map<number, number>();
  for (const p of series.longShort ?? []) lsMap.set(p.t, p.longShortRatio);
  const takerMap = new Map<number, number>();
  for (const p of series.taker ?? []) takerMap.set(p.t, p.takerBuySellRatio);
  const oiMap = new Map<number, number>();
  for (const p of series.openInterest ?? []) oiMap.set(p.t, p.openInterest);

  // funding: sorted ascending for a forward-fill walk
  const funding = [...(series.funding ?? [])].sort((a, b) => a.t - b.t);
  const settleSet = new Set(funding.map((f) => f.t));

  const bars: Bar[] = [];
  let fi = 0; // funding pointer (monotone with ascending bars)
  let lastFunding: number | undefined = undefined;

  for (const k of sorted) {
    // advance funding pointer to the latest settle at-or-before this bar's open time
    while (fi < funding.length && funding[fi].t <= k.t) {
      lastFunding = funding[fi].funding;
      fi++;
    }
    const bar: Bar = {
      t: k.t,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    };
    if (lastFunding !== undefined) bar.funding = lastFunding;
    // tag the bar whose open time is exactly a settle time
    if (settleSet.has(k.t)) bar.fundingSettled = true;
    const ls = lsMap.get(k.t);
    if (ls !== undefined) bar.longShortRatio = ls;
    const tk = takerMap.get(k.t);
    if (tk !== undefined) bar.takerBuySellRatio = tk;
    const oi = oiMap.get(k.t);
    if (oi !== undefined) bar.openInterest = oi;
    bars.push(bar);
  }
  return bars;
}

// ── validation (used by fetchHistory before it writes a fixture, and by the test) ──
export interface BarValidation {
  ok: boolean;
  count: number;
  errors: string[];
  /** Per-field coverage = fraction of bars that carry the optional flow field. */
  coverage: {
    funding: number;
    longShortRatio: number;
    takerBuySellRatio: number;
    openInterest: number;
  };
}

/**
 * Validate a bar series: non-empty, OHLCV finite + ordered (low<=open/close<=high),
 * strictly ascending unique timestamps. Reports optional-field coverage. Pure; no throw.
 */
export function validateBars(bars: Bar[]): BarValidation {
  const errors: string[] = [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      ok: false,
      count: 0,
      errors: ["empty bar series"],
      coverage: { funding: 0, longShortRatio: 0, takerBuySellRatio: 0, openInterest: 0 },
    };
  }
  let cF = 0, cL = 0, cT = 0, cO = 0;
  let prev = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const finite = [b.t, b.open, b.high, b.low, b.close, b.volume].every((x) => isFinite(x));
    if (!finite) errors.push(`bar[${i}] has non-finite OHLCV`);
    if (finite) {
      if (b.high < b.low) errors.push(`bar[${i}] high<low`);
      const hi = Math.max(b.open, b.close);
      const lo = Math.min(b.open, b.close);
      if (b.high < hi - 1e-9) errors.push(`bar[${i}] high<max(open,close)`);
      if (b.low > lo + 1e-9) errors.push(`bar[${i}] low>min(open,close)`);
      if (b.volume < 0) errors.push(`bar[${i}] negative volume`);
    }
    if (!(b.t > prev)) errors.push(`bar[${i}] timestamp not strictly ascending (t=${b.t}, prev=${prev})`);
    prev = b.t;
    if (b.funding !== undefined) cF++;
    if (b.longShortRatio !== undefined) cL++;
    if (b.takerBuySellRatio !== undefined) cT++;
    if (b.openInterest !== undefined) cO++;
  }
  const n = bars.length;
  return {
    ok: errors.length === 0,
    count: n,
    errors,
    coverage: {
      funding: cF / n,
      longShortRatio: cL / n,
      takerBuySellRatio: cT / n,
      openInterest: cO / n,
    },
  };
}
