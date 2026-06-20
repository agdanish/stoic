/**
 * Stoic — backtest engine (the look-ahead-safe walk-forward core).  [M5]
 *
 * This is the PURE simulation library the `run.ts` CLI and `test/backtest.test.ts`
 * both call. It walks a REAL bar series ONE BAR AT A TIME, decides long/short/flat from
 * the deterministic conviction engine (src/signal/signalEngine.runDivergence, which is
 * itself look-ahead-safe), holds the decided position into the NEXT bar, realises the
 * close-to-close return on that next bar, and books a conservative transaction cost +
 * slippage on every change of position.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY (the property test/backtest.test.ts pins)
 * ════════════════════════════════════════════════════════════════════════════
 *  - The conviction/side DECIDED for bar i uses only bars <= i (runDivergence is
 *    look-ahead-safe; decideTrade is a pure per-bar branch).
 *  - The position decided at bar i is HELD INTO bar i+1; the PnL booked is the
 *    close[i+1]/close[i]-1 move — i.e. we never trade on information from the bar whose
 *    return we earn. The decision strictly precedes the move it is paid on.
 *  - Therefore truncating the series at bar k leaves every trade/return at bars < k
 *    byte-identical: a dedicated test asserts this.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  COST MODEL — a CONFIGURABLE ASSUMPTION, not an organizer-confirmed number
 * ════════════════════════════════════════════════════════════════════════════
 *  Default 10 bps transaction cost + 10 bps slippage, charged on the |Δ signed
 *  notional| each time the target position changes (open / close / flip / resize).
 *  The exact organizer cost/slippage model is UNCONFIRMED (see BNB_BUILD_PLAN.md Q2);
 *  the report records the params it used and labels them an assumption.
 *
 * Pure: no Date / no random / no IO here. Deterministic given (bars, params) so the
 * emitted report is byte-reproducible.
 */

import { Bar } from "../src/data/binance";
import { runDivergence, RunOpts } from "../src/signal/signalEngine";
import { decideTrade, Side } from "../src/agent/decide";
import { ENTRY_THRESHOLD } from "../src/signal/core";
import { Advisory } from "../src/data/cmc";
import { DivergenceBar } from "../src/signal/divergence";

// ── parameters (single object so the report can echo exactly what it ran) ──────
export interface BacktestParams {
  /** Transaction cost in basis points charged on traded notional (per side of a trade). */
  txCostBps: number;
  /** Slippage in basis points charged on traded notional (per side of a trade). */
  slippageBps: number;
  /** Entry threshold |conviction-500| must exceed to take a trade (decideTrade). */
  entryThreshold: number;
  /** Whether shorts are allowed (false -> short signals collapse to flat). */
  allowShort: boolean;
  /**
   * Maximum fraction of capital deployed at full conviction (1.0 = 100%). The
   * engine's sizeBps (0..10000) scales linearly within this cap. Keeping this <=1
   * means returns are unlevered (conservative).
   */
  maxLeverage: number;
  /** z-score window forwarded to the divergence engine (defaults to engine default). */
  window?: number;
  /** min past observations forwarded to the divergence engine. */
  minObs?: number;
  /**
   * OPTIONAL per-bar CMC/LLM advisory provider, forwarded verbatim to runDivergence's
   * RunOpts.advisoryProvider (signalEngine.ts:186-194), which folds each returned advisory
   * through core.blendScore. This is the hook that wires a KEYED CoinMarketCap read
   * (Fear&Greed / RSI -> bounded advisory) into the EVALUATED backtest. OMITTED (the
   * default + every committed report) -> deterministic engine only, byte-reproducible.
   * The provider MUST itself be look-ahead-safe (use only info at-or-before the bar);
   * src/signal/cmcAdvisory.ts's provider satisfies this (it reads no bar data at all).
   */
  advisoryProvider?: (bar: Bar, div: DivergenceBar, i: number) => Advisory[];
}

export const DEFAULT_PARAMS: BacktestParams = {
  txCostBps: 10,
  slippageBps: 10,
  entryThreshold: ENTRY_THRESHOLD,
  allowShort: true,
  maxLeverage: 1.0,
};

// ── per-bar trace record (provenance; the report keeps a compact summary, tests
//    can walk the full trace to assert no look-ahead) ───────────────────────────
export interface BarTrace {
  bar: number;
  t: number;
  close: number;
  conviction: number;
  side: Side;            // side HELD INTO the next bar (decided from data <= this bar)
  targetWeight: number;  // signed fraction of capital (long +, short -, flat 0)
  barReturn: number;     // close-to-close return realised on THIS bar from the PRIOR side
  cost: number;          // transaction cost charged entering THIS bar's position (fraction)
  equity: number;        // strategy equity after this bar (starts at 1.0)
  buyHoldEquity: number; // buy-and-hold equity after this bar (starts at 1.0)
}

export interface CompletedTrade {
  entryBar: number;
  exitBar: number;
  side: Side;            // "long" | "short"
  entryPrice: number;
  exitPrice: number;
  /** Net return of the round-trip as a fraction of deployed notional, AFTER costs. */
  netReturn: number;
}

export interface Metrics {
  /** Total compounded strategy return over the window (fraction; 0.05 = +5%). */
  totalReturn: number;
  /** Fraction of completed round-trip trades that were net-profitable (0..1). */
  winRate: number;
  /** Maximum peak-to-trough drawdown of the equity curve (fraction, >=0). */
  maxDrawdown: number;
  /** Annualised Sharpe (per-bar mean/std of returns, scaled by sqrt(barsPerYear)). */
  sharpe: number;
  /** Annualised Sortino (downside-deviation variant of Sharpe). */
  sortino: number;
  /** Number of completed round-trip trades. */
  tradeCount: number;
  /** Number of bars in this segment that actually realised a return. */
  bars: number;
  /** Buy-and-hold total return over the same bars (fraction). */
  buyAndHoldReturn: number;
}

export interface SegmentResult extends Metrics {
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
}

export interface BacktestResult {
  trace: BarTrace[];
  trades: CompletedTrade[];
  full: Metrics;
}

// ── bars-per-year for annualisation (hourly bars) ──────────────────────────────
export const BARS_PER_YEAR_HOURLY = 24 * 365; // 8760

// ════════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD SIMULATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run the look-ahead-safe walk-forward backtest over a bar series.
 *
 * Mechanics (index-aligned to `bars`):
 *   1. runDivergence(bars) -> per-bar conviction (look-ahead-safe; bar i uses bars <= i).
 *   2. decideTrade(prevSide, conviction[i], sizeBps[i]) -> the side to HOLD INTO bar i+1.
 *   3. The signed target weight for that side = sign * (sizeBps/10000) * maxLeverage.
 *   4. At each bar i>=1 we realise close[i]/close[i-1]-1 against the weight we were
 *      HOLDING coming into bar i (i.e. decided at bar i-1) — never against a weight that
 *      used bar i's own data.
 *   5. A transaction cost is charged whenever the target weight changes, on |Δweight|.
 *
 * Returns the full per-bar trace, the completed round-trip trades, and the metrics over
 * the whole series. Pure + deterministic.
 */
export function runBacktest(bars: Bar[], params: BacktestParams = DEFAULT_PARAMS): BacktestResult {
  const opts: RunOpts = {};
  if (params.window !== undefined) opts.window = params.window;
  if (params.minObs !== undefined) opts.minObs = params.minObs;
  // Wire the optional KEYED CMC advisory provider into the evaluated walk. Omitted
  // (the default + every committed report) -> deterministic engine only, so report.json
  // and all tests stay byte-identical; set -> the CMC read folds through blendScore.
  if (params.advisoryProvider !== undefined) opts.advisoryProvider = params.advisoryProvider;

  const engine = runDivergence(bars, opts);
  const costRate = (params.txCostBps + params.slippageBps) / 10000; // fraction per unit notional traded

  const trace: BarTrace[] = [];
  const trades: CompletedTrade[] = [];

  let equity = 1.0;
  let buyHold = 1.0;
  let prevWeight = 0; // signed fraction currently held coming INTO the bar
  let prevSide: Side | null = null;

  // open-trade tracker for round-trip accounting
  let openSide: Side | null = null;
  let openEntryBar = 0;
  let openEntryPrice = 0;
  let openCostAccrued = 0; // total cost fraction booked against the open position

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const eng = engine[i];

    // ── 1) realise the return on THIS bar from the weight we held coming in ──
    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r = isFinite(prevClose) && prevClose !== 0 && isFinite(b.close)
        ? b.close / prevClose - 1
        : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    // ── 2) decide the side to HOLD INTO the next bar (uses only bars <= i) ──
    let decision = decideTrade(prevSide, eng.conviction, eng.sizeBps, params.entryThreshold);
    let side: Side = decision.side;
    if (side === "short" && !params.allowShort) side = "flat";

    const magnitude = (eng.sizeBps / 10000) * params.maxLeverage; // 0..maxLeverage
    const targetWeight =
      side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    // ── 3) charge transaction cost on the change in signed notional ──
    const deltaNotional = Math.abs(targetWeight - prevWeight);
    const cost = deltaNotional * costRate;
    if (cost > 0) {
      equity *= 1 - cost;
    }

    // ── 4) round-trip trade accounting (on side change) ──
    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      // close any open directional trade
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross =
          openSide === "long"
            ? exitPrice / openEntryPrice - 1
            : openEntryPrice / exitPrice - 1; // short gains when price falls
        // cost booked against this round-trip (entry + the portion of this bar's cost)
        const tripCost = openCostAccrued + cost;
        trades.push({
          entryBar: openEntryBar,
          exitBar: i,
          side: openSide,
          entryPrice: openEntryPrice,
          exitPrice,
          netReturn: round12(gross - tripCost),
        });
        openSide = null;
        openCostAccrued = 0;
      }
      // open a new directional trade
      if (side === "long" || side === "short") {
        openSide = side;
        openEntryBar = i;
        openEntryPrice = b.close;
        openCostAccrued = cost; // entry leg cost
      }
    } else if (openSide === "long" || openSide === "short") {
      // same side continues — accrue any resize cost
      openCostAccrued += cost;
    }

    trace.push({
      bar: i,
      t: b.t,
      close: b.close,
      conviction: eng.conviction,
      side,
      targetWeight: round12(targetWeight),
      barReturn: round12(barReturn),
      cost: round12(cost),
      equity: round12(equity),
      buyHoldEquity: round12(buyHold),
    });

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side; // flat keeps the last directional memory for flip detection
  }

  // close any still-open trade at the final bar (mark-to-close)
  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross =
      openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
    trades.push({
      entryBar: openEntryBar,
      exitBar: bars.length - 1,
      side: openSide,
      entryPrice: openEntryPrice,
      exitPrice,
      netReturn: round12(gross - openCostAccrued),
    });
  }

  const full = metricsFromTrace(trace, trades, 0, trace.length);
  return { trace, trades, full };
}

// ════════════════════════════════════════════════════════════════════════════
//  METRICS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compute metrics over a [startBar, endBar) slice of an already-simulated trace.
 * Equity inside a slice is re-based to 1.0 at the slice start so totalReturn /
 * drawdown / Sharpe are local to the slice (correct for in-sample vs out-of-sample
 * reporting). Trades are attributed to the slice that contains their ENTRY bar.
 *
 * Returns are taken from `barReturn` (the per-bar strategy return AFTER position
 * weighting; transaction cost is folded into equity, so for Sharpe we use the
 * cost-inclusive equity-ratio returns to stay honest). Pure.
 */
export function metricsFromTrace(
  trace: BarTrace[],
  trades: CompletedTrade[],
  startBar: number,
  endBar: number
): Metrics {
  const slice = trace.filter((r) => r.bar >= startBar && r.bar < endBar);
  if (slice.length === 0) {
    return {
      totalReturn: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, sortino: 0,
      tradeCount: 0, bars: 0, buyAndHoldReturn: 0,
    };
  }

  // Cost-inclusive per-bar strategy returns: derive from successive equity values so the
  // transaction-cost drag (folded into equity, not into barReturn) is captured honestly.
  const eqReturns: number[] = [];
  for (let k = 1; k < slice.length; k++) {
    const prev = slice[k - 1].equity;
    const cur = slice[k].equity;
    eqReturns.push(prev !== 0 ? cur / prev - 1 : 0);
  }
  // first bar of the slice also moved equity vs the bar before the slice (if any)
  const beforeIdx = startBar - 1;
  if (beforeIdx >= 0) {
    const before = trace.find((r) => r.bar === beforeIdx);
    if (before && before.equity !== 0) {
      eqReturns.unshift(slice[0].equity / before.equity - 1);
    }
  }

  // total strategy return over the slice (re-based to the bar before the slice)
  const baseEq = beforeIdx >= 0
    ? (trace.find((r) => r.bar === beforeIdx)?.equity ?? slice[0].equity)
    : 1.0; // slice starts at bar 0 -> base is the initial 1.0 (bar 0 realises nothing)
  const endEq = slice[slice.length - 1].equity;
  const totalReturn = baseEq !== 0 ? endEq / baseEq - 1 : 0;

  // buy-and-hold over the same slice
  const baseBH = beforeIdx >= 0
    ? (trace.find((r) => r.bar === beforeIdx)?.buyHoldEquity ?? slice[0].buyHoldEquity)
    : 1.0;
  const endBH = slice[slice.length - 1].buyHoldEquity;
  const buyAndHoldReturn = baseBH !== 0 ? endBH / baseBH - 1 : 0;

  // max drawdown of the (re-based) equity curve over the slice
  const maxDrawdown = maxDrawdownOf([baseEq, ...slice.map((r) => r.equity)]);

  // Sharpe / Sortino (annualised). Zero-variance -> 0 (no spurious infinity).
  const sharpe = annualisedSharpe(eqReturns, BARS_PER_YEAR_HOURLY);
  const sortino = annualisedSortino(eqReturns, BARS_PER_YEAR_HOURLY);

  // trades whose ENTRY bar falls in this slice
  const sliceTrades = trades.filter((t) => t.entryBar >= startBar && t.entryBar < endBar);
  const wins = sliceTrades.filter((t) => t.netReturn > 0).length;
  const tradeCount = sliceTrades.length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;

  return {
    totalReturn: round12(totalReturn),
    winRate: round12(winRate),
    maxDrawdown: round12(maxDrawdown),
    sharpe: round12(sharpe),
    sortino: round12(sortino),
    tradeCount,
    bars: slice.length,
    buyAndHoldReturn: round12(buyAndHoldReturn),
  };
}

/** Build an in-sample / out-of-sample segment pair at a fractional split point. */
export function splitSegments(
  result: BacktestResult,
  bars: Bar[],
  oosFraction: number
): { inSample: SegmentResult; outOfSample: SegmentResult; splitBar: number } {
  const n = bars.length;
  const frac = Math.min(0.9, Math.max(0.1, oosFraction));
  const splitBar = Math.floor(n * (1 - frac));

  const isMetrics = metricsFromTrace(result.trace, result.trades, 0, splitBar);
  const oosMetrics = metricsFromTrace(result.trace, result.trades, splitBar, n);

  const at = (bar: number) => bars[Math.min(Math.max(bar, 0), n - 1)]?.t ?? 0;

  return {
    splitBar,
    inSample: {
      ...isMetrics,
      startBar: 0,
      endBar: splitBar,
      startTime: at(0),
      endTime: at(splitBar - 1),
    },
    outOfSample: {
      ...oosMetrics,
      startBar: splitBar,
      endBar: n,
      startTime: at(splitBar),
      endTime: at(n - 1),
    },
  };
}

// ── metric primitives (pure) ───────────────────────────────────────────────────

/** Max peak-to-trough drawdown of an equity curve (fraction in [0,1]). */
export function maxDrawdownOf(equity: number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equity) {
    if (!isFinite(e)) continue;
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/** Annualised Sharpe from per-bar returns. Zero-variance -> 0. */
export function annualisedSharpe(returns: number[], barsPerYear: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, c) => a + c, 0) / returns.length;
  const variance = returns.reduce((a, c) => a + (c - mean) * (c - mean), 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std <= 1e-15) return 0;
  return (mean / std) * Math.sqrt(barsPerYear);
}

/** Annualised Sortino from per-bar returns (downside deviation; target 0). Zero-downside -> 0. */
export function annualisedSortino(returns: number[], barsPerYear: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, c) => a + c, 0) / returns.length;
  let downSse = 0;
  let downN = 0;
  for (const r of returns) {
    if (r < 0) {
      downSse += r * r;
      downN++;
    }
  }
  if (downN === 0) return 0; // no downside variance observed -> undefined; report 0 honestly
  const downStd = Math.sqrt(downSse / returns.length);
  if (downStd <= 1e-15) return 0;
  return (mean / downStd) * Math.sqrt(barsPerYear);
}

/**
 * Round to 12 significant decimal places to kill float-noise in the LAST bits so the
 * JSON report is byte-stable across runs/platforms WITHOUT distorting any real value
 * (12 dp is far finer than any reported metric needs). Pure.
 */
export function round12(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 1e12) / 1e12;
}
