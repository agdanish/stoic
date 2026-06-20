/**
 * Stoic — DAILY regime-aware DIRECTIONAL backtest (the honest pivot).  [P1]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS  (READ HONEST_SEARCH_RULES.md FIRST)
 * ════════════════════════════════════════════════════════════════════════════
 * The original CONTRARIAN divergence strategy (backtest/report.json) loses to
 * buy-and-hold OOS net of cost on every segment — a contrarian signal cannot out-earn
 * B&H in a rising market. The honest fix is a DIFFERENT THESIS on BETTER (longer,
 * multi-regime) DAILY data:
 *
 *   a regime-aware DIRECTIONAL core (trend/momentum, src/signal/momentum.ts) that RIDES
 *   bull markets, with the Fear&Greed contrarian read as a regime GATE (regimeGate.ts)
 *   and the divergence/funding signal DEMOTED to a contrarian RISK FILTER (strategy.ts).
 *
 * THIS file is the look-ahead-safe walk-forward over the DAILY multi-regime fixtures
 * (fixtures/daily/<SYMBOL>.json, ~1000 daily bars ≈ 2.7yr each, REAL keyless data):
 *
 *   - IN-SAMPLE = leading 70% of bars; HELD-OUT OOS = trailing 30%. SET BEFORE ANY SEARCH.
 *   - The strategy knobs are searched on the IN-SAMPLE segment ONLY (≤24 configs, fixed
 *     budget), one axis at a time around the module defaults (HONEST_SEARCH_RULES §6).
 *   - The single best in-sample config (by in-sample aggregate net total return) is LOCKED;
 *     the held-out OOS is then run ONCE and reported AS-IS — win, loss, or break-even.
 *   - Net of a LABELLED 10 bps tx + 10 bps slippage cost, charged on |Δ signed notional|.
 *   - Reported per token + aggregate, AND broken out per distinct REGIME sub-window
 *     (bull / bear / chop, segmented by a look-ahead-safe trailing-trend label).
 *
 * Determines: edgeFound (strict absolute B&H beat OOS for ≥1 token OR aggregate),
 * riskAdjustedWin (higher Sharpe AND lower maxDrawdown than B&H OOS). If it loses, that
 * is reported honestly — NO fabrication, NO selecting on OOS, NO moving the split.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  LOOK-AHEAD SAFETY (the property test/momentum.test.ts pins)
 * ════════════════════════════════════════════════════════════════════════════
 *  - runStrategy decides bar i from closes[0..i] + bar i's own F&G/funding only.
 *  - The position decided at bar i is HELD INTO bar i+1; PnL is close[i+1]/close[i]-1.
 *    The decision strictly precedes the move it is paid on (no look-ahead).
 *  - The in-sample/OOS split + regime labels use ONLY past/at-bar info; truncating the
 *    series at bar k leaves every trade/return at bars < k byte-identical (tested).
 *  - The search reads ONLY in-sample metrics; OOS is never an input to any choice.
 *
 *  Output: backtest/report-momentum.json (byte-reproducible — no Date / no random at
 *  compute time; a test asserts `npm run` regenerates it byte-for-byte). The frozen
 *  backtest/report.json is NEVER touched by this file.
 *
 * RUN:  ts-node backtest/momentum.ts
 *       OOS_FRACTION=0.3 ts-node backtest/momentum.ts   (held-out tail fraction; default 0.3)
 *       TX_BPS=10 SLIP_BPS=10 ts-node backtest/momentum.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DailyBar, DAILY_SYMBOLS } from "../src/data/history";
import { loadDailyFixture, dailyFixturePath, DailyFixture } from "../src/data/fetchDailyHistory";
import {
  runStrategy,
  strategyDecision,
  StrategyOpts,
  StrategyBar,
  EMA_FAST,
  EMA_SLOW,
  MOMENTUM_LOOKBACK,
  TREND_FULL_SEP,
  MOMENTUM_FULL_RET,
  TREND_WEIGHT,
  MOMENTUM_WEIGHT,
  FEAR_EXTREME,
  GREED_EXTREME,
  GATE_MAX,
  GATE_MIN,
  FUNDING_STRETCHED,
  RISK_FILTER_TRIM,
  RISK_FILTER_VETO_INTENSITY,
} from "../src/signal/strategy";
import { Side } from "../src/agent/decide";
import { ENTRY_THRESHOLD, ENTRY_MIN, ENTRY_MAX } from "../src/signal/core";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG / PATHS
// ════════════════════════════════════════════════════════════════════════════

/** NEW report file — backtest/report.json is NEVER touched by this run (frozen anchor). */
export const MOMENTUM_REPORT_PATH = path.resolve(__dirname, "report-momentum.json");
export const DEFAULT_OOS_FRACTION = 0.3;
/** Daily bars/year for annualising Sharpe/Sortino (calendar days; the fixtures are 1d). */
export const BARS_PER_YEAR_DAILY = 365;

// ════════════════════════════════════════════════════════════════════════════
//  COST MODEL + WALK PARAMETERS (a LABELLED ASSUMPTION — never softened)
// ════════════════════════════════════════════════════════════════════════════

export interface WalkParams {
  /** Transaction cost in bps charged on |Δ signed notional| per position change. */
  txCostBps: number;
  /** Slippage in bps charged on |Δ signed notional| per position change. */
  slippageBps: number;
  /** Entry threshold |conviction-500| must exceed to take a trade (decideTrade). */
  entryThreshold: number;
  /** Whether shorts are allowed (false -> short signals collapse to flat / long-only). */
  allowShort: boolean;
  /** Max fraction of capital deployed at full conviction (<=1 keeps returns unlevered). */
  maxLeverage: number;
}

export const DEFAULT_WALK: WalkParams = {
  txCostBps: 10,
  slippageBps: 10,
  entryThreshold: ENTRY_THRESHOLD,
  allowShort: true,
  maxLeverage: 1.0,
};

// ════════════════════════════════════════════════════════════════════════════
//  PURE NUMERIC HELPERS (mirrors backtest/engine.ts so the two reports agree)
// ════════════════════════════════════════════════════════════════════════════

/** Round to 12 sig-dp to kill float-noise so the JSON is byte-stable; pure. */
export function round12(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.round(x * 1e12) / 1e12;
}

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

/** Annualised Sharpe from per-bar returns. Zero-variance -> 0 (no spurious infinity). */
export function annualisedSharpe(returns: number[], barsPerYear: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, c) => a + c, 0) / returns.length;
  const variance = returns.reduce((a, c) => a + (c - mean) * (c - mean), 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std <= 1e-15) return 0;
  return (mean / std) * Math.sqrt(barsPerYear);
}

/** Annualised Sortino from per-bar returns (downside deviation; target 0). */
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
  if (downN === 0) return 0;
  const downStd = Math.sqrt(downSse / returns.length);
  if (downStd <= 1e-15) return 0;
  return (mean / downStd) * Math.sqrt(barsPerYear);
}

// ════════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD — produce a per-bar equity + buy&hold curve (look-ahead-safe)
// ════════════════════════════════════════════════════════════════════════════

/** One per-bar trace record (provenance; tests walk this to assert no look-ahead). */
export interface WalkBar {
  bar: number;
  t: number;
  close: number;
  conviction: number;
  side: Side;            // side HELD INTO the next bar (decided from data <= this bar)
  targetWeight: number;  // signed fraction of capital (long +, short -, flat 0)
  barReturn: number;     // strategy return realised on THIS bar from the PRIOR weight
  cost: number;          // tx+slippage cost charged entering THIS bar's position (fraction)
  equity: number;        // strategy equity after this bar (starts at 1.0)
  buyHoldEquity: number; // buy-and-hold equity after this bar (starts at 1.0)
}

export interface CompletedTrade {
  entryBar: number;
  exitBar: number;
  side: Side; // "long" | "short"
  netReturn: number; // round-trip net of cost, fraction of deployed notional
}

export interface WalkResult {
  trace: WalkBar[];
  trades: CompletedTrade[];
  strategyBars: StrategyBar[];
}

/**
 * Walk a DAILY bar series through the regime-aware directional strategy, ONE BAR AT A TIME.
 *
 *   1. runStrategy(bars, opts) -> per-bar conviction (look-ahead-safe; bar i uses bars <=i).
 *   2. strategyDecision(prevSide, sb[i], entryThreshold) -> side to HOLD INTO bar i+1.
 *   3. signed target weight = sign * (sizeBps/10000) * maxLeverage.
 *   4. At bar i>=1 realise close[i]/close[i-1]-1 against the weight held COMING INTO bar i
 *      (decided at bar i-1) — never against a weight that used bar i's own data.
 *   5. Charge tx+slippage on |Δweight| whenever the target weight changes.
 *
 * Pure + deterministic given (bars, opts, walk). Returns the full trace + round-trips.
 */
export function runWalk(
  bars: DailyBar[],
  walk: WalkParams = DEFAULT_WALK,
  opts: StrategyOpts = {}
): WalkResult {
  const strategyBars = runStrategy(bars, opts);
  const costRate = (walk.txCostBps + walk.slippageBps) / 10000;

  const trace: WalkBar[] = [];
  const trades: CompletedTrade[] = [];

  let equity = 1.0;
  let buyHold = 1.0;
  let prevWeight = 0;
  let prevSide: Side | null = null;

  let openSide: Side | null = null;
  let openEntryBar = 0;
  let openEntryPrice = 0;
  let openCostAccrued = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const sb = strategyBars[i];

    // 1) realise the return on THIS bar from the weight held coming in.
    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r =
        isFinite(prevClose) && prevClose !== 0 && isFinite(b.close) ? b.close / prevClose - 1 : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    // 2) decide the side to HOLD INTO the next bar (uses only bars <= i).
    const decision = strategyDecision(prevSide, sb, walk.entryThreshold);
    let side: Side = decision.side;
    if (side === "short" && !walk.allowShort) side = "flat";

    const magnitude = (sb.sizeBps / 10000) * walk.maxLeverage;
    const targetWeight = side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    // 3) charge tx+slippage on the change in signed notional.
    const deltaNotional = Math.abs(targetWeight - prevWeight);
    const cost = deltaNotional * costRate;
    if (cost > 0) equity *= 1 - cost;

    // 4) round-trip trade accounting (on side change).
    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross =
          openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
        trades.push({
          entryBar: openEntryBar,
          exitBar: i,
          side: openSide,
          netReturn: round12(gross - (openCostAccrued + cost)),
        });
        openSide = null;
        openCostAccrued = 0;
      }
      if (side === "long" || side === "short") {
        openSide = side;
        openEntryBar = i;
        openEntryPrice = b.close;
        openCostAccrued = cost;
      }
    } else if (openSide === "long" || openSide === "short") {
      openCostAccrued += cost;
    }

    trace.push({
      bar: i,
      t: b.t,
      close: b.close,
      conviction: sb.conviction,
      side,
      targetWeight: round12(targetWeight),
      barReturn: round12(barReturn),
      cost: round12(cost),
      equity: round12(equity),
      buyHoldEquity: round12(buyHold),
    });

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side; // flat keeps last directional memory for flip
  }

  // mark-to-close any still-open trade at the final bar.
  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const gross =
      openSide === "long" ? last.close / openEntryPrice - 1 : openEntryPrice / last.close - 1;
    trades.push({
      entryBar: openEntryBar,
      exitBar: bars.length - 1,
      side: openSide,
      netReturn: round12(gross - openCostAccrued),
    });
  }

  return { trace, trades, strategyBars };
}

// ════════════════════════════════════════════════════════════════════════════
//  METRICS over a [startBar, endBar) slice of an already-simulated trace
// ════════════════════════════════════════════════════════════════════════════

export interface Metrics {
  totalReturn: number;       // compounded strategy return over the slice (net of cost)
  buyAndHoldReturn: number;  // buy-and-hold return over the same bars
  excessReturn: number;      // totalReturn - buyAndHoldReturn (the headline edge vs B&H)
  beatsBuyHold: boolean;     // strictly greater net total return than B&H on these bars
  winRate: number;
  maxDrawdown: number;
  buyAndHoldMaxDrawdown: number;
  sharpe: number;
  buyAndHoldSharpe: number;
  sortino: number;
  tradeCount: number;
  bars: number;
}

/**
 * Metrics over a [startBar, endBar) slice, re-based to 1.0 at the slice start so
 * totalReturn / drawdown / Sharpe are LOCAL to the slice (correct for in-sample vs OOS).
 * The strategy returns are cost-inclusive (derived from the equity curve into which cost
 * is folded). B&H Sharpe/drawdown are computed on the SAME bars for a like-for-like compare.
 */
export function metricsFromTrace(
  trace: WalkBar[],
  trades: CompletedTrade[],
  startBar: number,
  endBar: number,
  barsPerYear: number = BARS_PER_YEAR_DAILY
): Metrics {
  const slice = trace.filter((r) => r.bar >= startBar && r.bar < endBar);
  if (slice.length === 0) {
    return {
      totalReturn: 0, buyAndHoldReturn: 0, excessReturn: 0, beatsBuyHold: false,
      winRate: 0, maxDrawdown: 0, buyAndHoldMaxDrawdown: 0, sharpe: 0,
      buyAndHoldSharpe: 0, sortino: 0, tradeCount: 0, bars: 0,
    };
  }

  const before = startBar - 1 >= 0 ? trace.find((r) => r.bar === startBar - 1) : undefined;

  // cost-inclusive per-bar strategy + B&H returns from successive equity values.
  const eqReturns: number[] = [];
  const bhReturns: number[] = [];
  for (let k = 1; k < slice.length; k++) {
    const pe = slice[k - 1].equity;
    const ce = slice[k].equity;
    eqReturns.push(pe !== 0 ? ce / pe - 1 : 0);
    const pb = slice[k - 1].buyHoldEquity;
    const cb = slice[k].buyHoldEquity;
    bhReturns.push(pb !== 0 ? cb / pb - 1 : 0);
  }
  if (before && before.equity !== 0 && before.buyHoldEquity !== 0) {
    eqReturns.unshift(slice[0].equity / before.equity - 1);
    bhReturns.unshift(slice[0].buyHoldEquity / before.buyHoldEquity - 1);
  }

  const baseEq = before ? before.equity : 1.0;
  const endEq = slice[slice.length - 1].equity;
  const totalReturn = baseEq !== 0 ? endEq / baseEq - 1 : 0;

  const baseBH = before ? before.buyHoldEquity : 1.0;
  const endBH = slice[slice.length - 1].buyHoldEquity;
  const buyAndHoldReturn = baseBH !== 0 ? endBH / baseBH - 1 : 0;

  const maxDrawdown = maxDrawdownOf([baseEq, ...slice.map((r) => r.equity)]);
  const buyAndHoldMaxDrawdown = maxDrawdownOf([baseBH, ...slice.map((r) => r.buyHoldEquity)]);

  const sharpe = annualisedSharpe(eqReturns, barsPerYear);
  const buyAndHoldSharpe = annualisedSharpe(bhReturns, barsPerYear);
  const sortino = annualisedSortino(eqReturns, barsPerYear);

  const sliceTrades = trades.filter((t) => t.entryBar >= startBar && t.entryBar < endBar);
  const wins = sliceTrades.filter((t) => t.netReturn > 0).length;
  const tradeCount = sliceTrades.length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;

  const excess = totalReturn - buyAndHoldReturn;
  return {
    totalReturn: round12(totalReturn),
    buyAndHoldReturn: round12(buyAndHoldReturn),
    excessReturn: round12(excess),
    beatsBuyHold: excess > 0,
    winRate: round12(winRate),
    maxDrawdown: round12(maxDrawdown),
    buyAndHoldMaxDrawdown: round12(buyAndHoldMaxDrawdown),
    sharpe: round12(sharpe),
    buyAndHoldSharpe: round12(buyAndHoldSharpe),
    sortino: round12(sortino),
    tradeCount,
    bars: slice.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  IN-SAMPLE / OOS SPLIT (fixed BEFORE any search — HONEST_SEARCH_RULES §1.2)
// ════════════════════════════════════════════════════════════════════════════

/** The split bar = floor(n * (1 - oosFraction)). In-sample [0,split); OOS [split, n). */
export function splitBarOf(n: number, oosFraction: number): number {
  const frac = Math.min(0.9, Math.max(0.1, oosFraction));
  return Math.floor(n * (1 - frac));
}

export interface SplitMetrics {
  splitBar: number;
  full: Metrics;
  inSample: Metrics;
  outOfSample: Metrics;
}

export function splitMetrics(
  result: WalkResult,
  n: number,
  oosFraction: number,
  barsPerYear: number = BARS_PER_YEAR_DAILY
): SplitMetrics {
  const splitBar = splitBarOf(n, oosFraction);
  return {
    splitBar,
    full: metricsFromTrace(result.trace, result.trades, 0, n, barsPerYear),
    inSample: metricsFromTrace(result.trace, result.trades, 0, splitBar, barsPerYear),
    outOfSample: metricsFromTrace(result.trace, result.trades, splitBar, n, barsPerYear),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  REGIME SEGMENTATION (look-ahead-safe; disclosed; NOT used for selection)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Label each bar's REGIME from a LOOK-AHEAD-SAFE trailing trend: the slow-vs-fast
 * realised return over the prior `lookback` closes (closes[i-lookback..i], all <= i).
 *
 *   trailing return >= +bullThresh  -> "bull"
 *   trailing return <= -bearThresh  -> "bear"
 *   else                            -> "chop"
 *
 * This is a TRANSPARENT disclosure proxy so the reader sees how the strategy behaves in
 * each regime; it is NOT an input to parameter selection (HONEST_SEARCH_RULES §1.1). It
 * reads only past/at-bar closes, so it cannot leak the future. Pure.
 */
export type Regime = "bull" | "bear" | "chop";

export const REGIME_LOOKBACK = 60; // ~2 months trailing window for the regime label
export const REGIME_BULL_THRESH = 0.15; // +15% trailing -> bull
export const REGIME_BEAR_THRESH = 0.15; // -15% trailing -> bear

export function regimeLabels(
  closes: number[],
  lookback: number = REGIME_LOOKBACK,
  bullThresh: number = REGIME_BULL_THRESH,
  bearThresh: number = REGIME_BEAR_THRESH
): Regime[] {
  return closes.map((c, i) => {
    if (i < lookback) return "chop"; // warming -> treat as chop (neutral)
    const past = closes[i - lookback];
    if (!isFinite(past) || past === 0 || !isFinite(c)) return "chop";
    const ret = c / past - 1;
    if (ret >= bullThresh) return "bull";
    if (ret <= -bearThresh) return "bear";
    return "chop";
  });
}

export interface RegimeMetrics {
  regime: Regime;
  bars: number;
  /** Strategy net return over the bars labelled this regime (compounded over barReturn). */
  strategyReturn: number;
  /** Buy-and-hold return over the same regime-labelled bars. */
  buyAndHoldReturn: number;
  excessReturn: number;
  beatsBuyHold: boolean;
}

/**
 * Compute per-regime returns over a [startBar, endBar) slice. For each regime, compound the
 * strategy's per-bar `barReturn` (cost is in the equity curve; per-regime uses the gross
 * weighted return as a behaviour proxy) and the underlying close-to-close move (B&H), over
 * exactly the bars carrying that regime label. Disclosure-only; pure.
 *
 * NOTE on cost: per-regime returns use barReturn (position-weighted close-to-close) which is
 * BEFORE the tx/slippage drag (that drag is booked into equity, not barReturn). This is a
 * faithful BEHAVIOUR proxy — "did the directional core ride the bull / dodge the bear?" — and
 * is labelled as such. The HEADLINE win/loss verdict uses the cost-inclusive segment metrics
 * (metricsFromTrace), never these.
 */
export function regimeMetrics(
  trace: WalkBar[],
  regimes: Regime[],
  startBar: number,
  endBar: number
): RegimeMetrics[] {
  const out: RegimeMetrics[] = [];
  for (const regime of ["bull", "bear", "chop"] as Regime[]) {
    let stratEq = 1.0;
    let bhEq = 1.0;
    let count = 0;
    for (const r of trace) {
      if (r.bar < startBar || r.bar >= endBar) continue;
      if (regimes[r.bar] !== regime) continue;
      // close-to-close underlying move on this bar (i>0 only realises a move).
      const idx = r.bar;
      if (idx > 0) {
        const prev = trace.find((x) => x.bar === idx - 1);
        const underlying =
          prev && isFinite(prev.close) && prev.close !== 0 && isFinite(r.close)
            ? r.close / prev.close - 1
            : 0;
        bhEq *= 1 + underlying;
      }
      stratEq *= 1 + r.barReturn;
      count++;
    }
    const strategyReturn = round12(stratEq - 1);
    const buyAndHoldReturn = round12(bhEq - 1);
    out.push({
      regime,
      bars: count,
      strategyReturn,
      buyAndHoldReturn,
      excessReturn: round12(strategyReturn - buyAndHoldReturn),
      beatsBuyHold: strategyReturn - buyAndHoldReturn > 0,
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  THE IN-SAMPLE SEARCH (≤24 configs, fixed budget — HONEST_SEARCH_RULES §6)
// ════════════════════════════════════════════════════════════════════════════

/** A fully-specified candidate config: the strategy knobs + walk knobs swept together. */
export interface Candidate {
  label: string;
  strategy: StrategyOpts;
  walk: WalkParams;
}

/** The module defaults expressed as one Candidate (the centre of the coordinate sweep). */
export function defaultCandidate(walk: WalkParams): Candidate {
  return {
    label: "default(EMA20/50,L20,thr120,short)",
    strategy: {
      emaFast: EMA_FAST,
      emaSlow: EMA_SLOW,
      momentumLookback: MOMENTUM_LOOKBACK,
    },
    walk: { ...walk },
  };
}

/**
 * Build the bounded coordinate-style sweep AROUND the defaults (one axis at a time).
 * Budget: <= 24 configs total (HONEST_SEARCH_RULES §6). Axes swept:
 *   - EMA span pair (trend backbone): {10/30, 20/50, 30/80, 50/100}
 *   - momentum lookback:              {10, 20, 40}
 *   - entry threshold:                {60, 120, 200}
 *   - long/short vs long/flat:        {allowShort:true, allowShort:false}
 * Each non-default axis varies ONE knob off the default centre, so the count stays bounded
 * and the search is auditable (no full grid). The default is included exactly once.
 */
export function buildSweep(walk: WalkParams): Candidate[] {
  const cands: Candidate[] = [];
  const base = defaultCandidate(walk);
  cands.push(base);

  // axis 1: EMA span pair (3 non-default points).
  const emaPairs: Array<[number, number]> = [
    [10, 30],
    [30, 80],
    [50, 100],
  ];
  for (const [f, s] of emaPairs) {
    cands.push({
      label: `ema${f}/${s}`,
      strategy: { ...base.strategy, emaFast: f, emaSlow: s },
      walk: { ...walk },
    });
  }

  // axis 2: momentum lookback (2 non-default points: default is 20).
  for (const L of [10, 40]) {
    cands.push({
      label: `lookback${L}`,
      strategy: { ...base.strategy, momentumLookback: L },
      walk: { ...walk },
    });
  }

  // axis 3: entry threshold (2 non-default points: default is 120).
  for (const thr of [60, 200]) {
    cands.push({
      label: `entry${thr}`,
      strategy: { ...base.strategy },
      walk: { ...walk, entryThreshold: thr },
    });
  }

  // axis 4: long/flat (no shorts) vs the default long/short.
  cands.push({
    label: "long-only",
    strategy: { ...base.strategy },
    walk: { ...walk, allowShort: false },
  });

  // axis 5: regime-extreme aggressiveness — slower/wider trend so it rides longer (1 point),
  // and a tighter trend-full-separation so the trend term saturates sooner (1 point).
  cands.push({
    label: "trendFullSep0.04",
    strategy: { ...base.strategy, trendFullSep: 0.04 },
    walk: { ...walk },
  });
  cands.push({
    label: "momentumFullRet0.10",
    strategy: { ...base.strategy, momentumFullRet: 0.1 },
    walk: { ...walk },
  });

  // axis 6: trend-weight tilt (heavier trend backbone vs heavier momentum) — 2 points.
  cands.push({
    label: "trendWeight0.75",
    strategy: { ...base.strategy, trendWeight: 0.75, momentumWeight: 0.25 },
    walk: { ...walk },
  });
  cands.push({
    label: "trendWeight0.40",
    strategy: { ...base.strategy, trendWeight: 0.4, momentumWeight: 0.6 },
    walk: { ...walk },
  });

  // axis 7: long-only + slower trend (the "ride bull, sit out bear" archetype) — 2 points.
  cands.push({
    label: "long-only+ema30/80",
    strategy: { ...base.strategy, emaFast: 30, emaSlow: 80 },
    walk: { ...walk, allowShort: false },
  });
  cands.push({
    label: "long-only+entry60",
    strategy: { ...base.strategy },
    walk: { ...walk, allowShort: false, entryThreshold: 60 },
  });

  return cands; // 1 + 3 + 2 + 2 + 1 + 2 + 2 + 2 = 15 configs (<= 24 budget)
}

// ════════════════════════════════════════════════════════════════════════════
//  AGGREGATE (equal-weight over tokens) — mirrors run.ts's aggregate convention
// ════════════════════════════════════════════════════════════════════════════

/** Equal-weight mean of the segment metric across tokens (counts summed). */
export function aggregateMetrics(per: Metrics[]): Metrics {
  if (per.length === 0) {
    return {
      totalReturn: 0, buyAndHoldReturn: 0, excessReturn: 0, beatsBuyHold: false,
      winRate: 0, maxDrawdown: 0, buyAndHoldMaxDrawdown: 0, sharpe: 0,
      buyAndHoldSharpe: 0, sortino: 0, tradeCount: 0, bars: 0,
    };
  }
  const mean = (f: (m: Metrics) => number) => round12(per.reduce((a, m) => a + f(m), 0) / per.length);
  const totalReturn = mean((m) => m.totalReturn);
  const buyAndHoldReturn = mean((m) => m.buyAndHoldReturn);
  return {
    totalReturn,
    buyAndHoldReturn,
    excessReturn: round12(totalReturn - buyAndHoldReturn),
    beatsBuyHold: totalReturn - buyAndHoldReturn > 0,
    winRate: mean((m) => m.winRate),
    maxDrawdown: mean((m) => m.maxDrawdown),
    buyAndHoldMaxDrawdown: mean((m) => m.buyAndHoldMaxDrawdown),
    sharpe: mean((m) => m.sharpe),
    buyAndHoldSharpe: mean((m) => m.buyAndHoldSharpe),
    sortino: mean((m) => m.sortino),
    tradeCount: per.reduce((a, m) => a + m.tradeCount, 0),
    bars: per.reduce((a, m) => a + m.bars, 0),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  THE REPORT — assemble per-token + aggregate + per-regime, select + verdict
// ════════════════════════════════════════════════════════════════════════════

export interface TokenInput {
  symbol: string;
  synthetic: boolean;
  bars: DailyBar[];
}

/** Load the committed daily fixtures for the universe (REAL or labelled SYNTHETIC). */
export function loadUniverse(): TokenInput[] {
  const out: TokenInput[] = [];
  for (const symbol of DAILY_SYMBOLS) {
    if (!fs.existsSync(dailyFixturePath(symbol))) continue;
    const fx: DailyFixture = loadDailyFixture(symbol);
    out.push({ symbol, synthetic: fx._synthetic, bars: fx.bars });
  }
  return out;
}

/** Evaluate one candidate across the universe, returning per-token + aggregate split metrics. */
export function evaluateCandidate(
  universe: TokenInput[],
  cand: Candidate,
  oosFraction: number
): { perToken: Array<{ symbol: string; split: SplitMetrics }>; aggregate: { inSample: Metrics; outOfSample: Metrics; full: Metrics } } {
  const perToken = universe.map((tok) => {
    const result = runWalk(tok.bars, cand.walk, cand.strategy);
    const split = splitMetrics(result, tok.bars.length, oosFraction);
    return { symbol: tok.symbol, split };
  });
  return {
    perToken,
    aggregate: {
      inSample: aggregateMetrics(perToken.map((p) => p.split.inSample)),
      outOfSample: aggregateMetrics(perToken.map((p) => p.split.outOfSample)),
      full: aggregateMetrics(perToken.map((p) => p.split.full)),
    },
  };
}

/**
 * SELECT the best candidate on the IN-SAMPLE aggregate ONLY (HONEST_SEARCH_RULES §1).
 * Selection objective: maximise in-sample aggregate EXCESS return vs B&H (the honest
 * "edge", not raw return — a config that just rode a bull without beating B&H is not
 * preferred). Ties broken by higher in-sample aggregate Sharpe, then lower drawdown, then
 * the candidate's position in the (deterministic) sweep order. NEVER reads OOS.
 */
export function selectInSample(
  universe: TokenInput[],
  sweep: Candidate[],
  oosFraction: number
): { winner: Candidate; inSampleAll: Array<{ label: string; inSample: Metrics }> } {
  let best: { cand: Candidate; is: Metrics; idx: number } | null = null;
  const inSampleAll: Array<{ label: string; inSample: Metrics }> = [];

  sweep.forEach((cand, idx) => {
    const ev = evaluateCandidate(universe, cand, oosFraction);
    const is = ev.aggregate.inSample;
    inSampleAll.push({ label: cand.label, inSample: is });
    if (best === null) {
      best = { cand, is, idx };
      return;
    }
    const a = is;
    const b = best.is;
    const better =
      a.excessReturn > b.excessReturn + 1e-12 ||
      (Math.abs(a.excessReturn - b.excessReturn) <= 1e-12 && a.sharpe > b.sharpe + 1e-12) ||
      (Math.abs(a.excessReturn - b.excessReturn) <= 1e-12 &&
        Math.abs(a.sharpe - b.sharpe) <= 1e-12 &&
        a.maxDrawdown < b.maxDrawdown - 1e-12);
    if (better) best = { cand, is, idx };
  });

  return { winner: best!.cand, inSampleAll };
}

// ── pretty key for a candidate's resolved knobs (so the report echoes what it ran) ──
export function candidateConfig(cand: Candidate): Record<string, number | boolean | string> {
  const s = cand.strategy;
  return {
    emaFast: s.emaFast ?? EMA_FAST,
    emaSlow: s.emaSlow ?? EMA_SLOW,
    momentumLookback: s.momentumLookback ?? MOMENTUM_LOOKBACK,
    trendFullSep: s.trendFullSep ?? TREND_FULL_SEP,
    momentumFullRet: s.momentumFullRet ?? MOMENTUM_FULL_RET,
    trendWeight: s.trendWeight ?? TREND_WEIGHT,
    momentumWeight: s.momentumWeight ?? MOMENTUM_WEIGHT,
    entryThreshold: cand.walk.entryThreshold,
    allowShort: cand.walk.allowShort,
    maxLeverage: cand.walk.maxLeverage,
    label: cand.label,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILD THE FULL REPORT OBJECT (deterministic; no Date / no random)
// ════════════════════════════════════════════════════════════════════════════

export interface MomentumReport {
  strategy: string;
  dataSource: any;
  params: any;
  methodology: string[];
  search: any;
  selectedConfig: Record<string, number | boolean | string>;
  perToken: any[];
  aggregate: any;
  perRegime: any;
  verdict: any;
}

export function buildReport(oosFraction: number, walk: WalkParams): MomentumReport {
  const universe = loadUniverse();
  const allReal = universe.length > 0 && universe.every((t) => !t.synthetic);

  // 1) FIXED split + bounded sweep (defined before the search reads anything).
  const sweep = buildSweep(walk);

  // 2) SELECT on in-sample aggregate ONLY.
  const { winner, inSampleAll } = selectInSample(universe, sweep, oosFraction);

  // 3) Evaluate the WINNER fully (per-token splits + aggregate). OOS run ONCE, after select.
  const winEval = evaluateCandidate(universe, winner, oosFraction);

  // 4) Per-regime breakout (disclosure) on the FULL window per token + aggregate, using the
  //    winner's walk. Regime labels are look-ahead-safe trailing-trend labels.
  const perTokenRegime = universe.map((tok) => {
    const result = runWalk(tok.bars, winner.walk, winner.strategy);
    const regimes = regimeLabels(tok.bars.map((b) => b.close));
    const splitBar = splitBarOf(tok.bars.length, oosFraction);
    return {
      symbol: tok.symbol,
      full: regimeMetrics(result.trace, regimes, 0, tok.bars.length),
      outOfSample: regimeMetrics(result.trace, regimes, splitBar, tok.bars.length),
    };
  });

  // 5) VERDICT — computed from the COMMITTED metrics, never hand-set.
  //    edgeFound: strict absolute B&H beat on OOS for >=1 token OR the aggregate.
  const oosAgg = winEval.aggregate.outOfSample;
  const tokenBeats = winEval.perToken.filter((p) => p.split.outOfSample.beatsBuyHold);
  const edgeFound = oosAgg.beatsBuyHold || tokenBeats.length > 0;
  //    riskAdjustedWin: aggregate OOS higher Sharpe AND lower maxDD than B&H OOS.
  const riskAdjustedWin =
    oosAgg.sharpe > oosAgg.buyAndHoldSharpe && oosAgg.maxDrawdown < oosAgg.buyAndHoldMaxDrawdown;

  // span / provenance for dataSource (deterministic — from the fixtures, not Date.now()).
  const first = universe[0]?.bars[0];
  const last = universe[0]?.bars[universe[0].bars.length - 1];

  const report: MomentumReport = {
    strategy:
      "Stoic — MOMENTUM PIVOT: a regime-aware DIRECTIONAL core (trend/momentum, " +
      "src/signal/momentum.ts) that RIDES bull markets, with a Fear&Greed CONTRARIAN regime " +
      "gate (regimeGate.ts) and the divergence/funding signal DEMOTED to a contrarian RISK " +
      "FILTER (strategy.ts). Walk-forward over the DAILY multi-regime fixtures (~1000 daily " +
      "bars ≈ 2.7yr/token). Params selected on the IN-SAMPLE 70% ONLY; held-out OOS 30% run " +
      "once and reported as-is. The frozen backtest/report.json is UNTOUCHED.",
    dataSource: {
      kind: allReal ? "REAL" : "SYNTHETIC",
      provider:
        "Binance public REST (keyless) DAILY spot klines OHLCV + USDT-M funding (8h, forward-" +
        "filled to daily); Fear&Greed = alternative.me historical daily index (NOT CMC live " +
        "F&G — that is the live/demo path), joined by UTC date.",
      symbols: universe.map((t) => t.symbol),
      interval: "1d",
      startTime: first?.t ?? 0,
      endTime: last?.t ?? 0,
      startDate: first?.date ?? "",
      endDate: last?.date ?? "",
      note:
        "REAL multi-regime DAILY data spanning 2023-24 recovery/bull, 2025 cycle, and a " +
        "2026 YTD drawdown — exactly the multi-regime span the pivot needs. The Binance " +
        "long/short ACCOUNT ratio + taker buy/sell ratio legs have only ~30d history, so " +
        "they are NOT used in this multi-year backtest (they remain a recent/live refinement " +
        "via StrategyBarInput.positioning). This is stated, not hidden.",
    },
    params: {
      txCostBps: walk.txCostBps,
      slippageBps: walk.slippageBps,
      oosFraction,
      barsPerYear: BARS_PER_YEAR_DAILY,
      costModelNote:
        "Transaction cost + slippage are a CONFIGURABLE ASSUMPTION (default 10 bps each), " +
        "charged on |Δ signed notional| per position change, folded into the equity curve so " +
        "all returns + Sharpe/Sortino are NET OF COST. The exact organizer cost model is UNCONFIRMED.",
      moduleConstants: {
        EMA_FAST, EMA_SLOW, MOMENTUM_LOOKBACK, TREND_FULL_SEP, MOMENTUM_FULL_RET,
        TREND_WEIGHT, MOMENTUM_WEIGHT, FEAR_EXTREME, GREED_EXTREME, GATE_MAX, GATE_MIN,
        FUNDING_STRETCHED, RISK_FILTER_TRIM, RISK_FILTER_VETO_INTENSITY,
        ENTRY_THRESHOLD, ENTRY_MIN, ENTRY_MAX,
      },
      regimeProxy: { lookback: REGIME_LOOKBACK, bullThresh: REGIME_BULL_THRESH, bearThresh: REGIME_BEAR_THRESH },
    },
    methodology: [
      "Walk-forward, one DAILY bar at a time. The conviction/side for bar i uses only bars <= i (runStrategy is look-ahead-safe; EMAs are a forward recurrence; F&G/funding read the bar's own values).",
      "The position decided at bar i is HELD INTO bar i+1; PnL is the close[i+1]/close[i]-1 move. The decision strictly precedes the move it is paid on (no look-ahead).",
      "Transaction cost + slippage charged on |Δ signed notional| at every position change; folded into the equity curve (so Sharpe/Sortino + totalReturn are cost-inclusive).",
      "Sharpe/Sortino annualised from per-bar equity returns (×sqrt(365) for daily bars). Zero-variance segments report 0, never infinity. Buy-and-hold Sharpe/drawdown computed on the SAME bars.",
      "IN-SAMPLE = leading (1-oosFraction)=70% of bars; HELD-OUT OOS = trailing 30%. The split is fixed BEFORE the search. The search reads ONLY in-sample aggregate metrics; OOS is run ONCE on the locked winner and reported as-is.",
      "Selection objective: maximise the IN-SAMPLE aggregate EXCESS return vs B&H (ties: higher in-sample Sharpe, then lower drawdown, then sweep order). NEVER selected on OOS.",
      "Aggregate = equal-weight mean of per-token segment metrics (tradeCount/bars summed). Buy-and-hold computed on the same bars per token + aggregate.",
      "Per-regime breakout uses a LOOK-AHEAD-SAFE trailing-trend label (60d trailing return >= +15% -> bull, <= -15% -> bear, else chop). Disclosure-only; NOT an input to selection. Per-regime returns use position-weighted close-to-close (a behaviour proxy, BEFORE the cost drag which is booked into equity); the headline verdict uses the cost-inclusive segment metrics.",
    ],
    search: {
      budget: sweep.length,
      maxBudget: 24,
      note:
        "Bounded coordinate sweep AROUND the module defaults (one axis at a time): EMA span " +
        "pair, momentum lookback, entry threshold, long/short-vs-long/flat, trend-full-sep, " +
        "momentum-full-ret, trend/momentum weight tilt, and two long-only archetypes. All " +
        "candidates' IN-SAMPLE aggregate metrics are disclosed below (no candidate hidden).",
      inSampleAll: inSampleAll.map((c) => ({
        label: c.label,
        inSampleTotalReturn: c.inSample.totalReturn,
        inSampleBuyHold: c.inSample.buyAndHoldReturn,
        inSampleExcess: c.inSample.excessReturn,
        inSampleSharpe: c.inSample.sharpe,
        inSampleMaxDrawdown: c.inSample.maxDrawdown,
        selected: c.label === winner.label,
      })),
    },
    selectedConfig: candidateConfig(winner),
    perToken: winEval.perToken.map((p, i) => ({
      symbol: p.symbol,
      synthetic: universe[i].synthetic,
      bars: universe[i].bars.length,
      splitBar: p.split.splitBar,
      full: p.split.full,
      inSample: p.split.inSample,
      outOfSample: p.split.outOfSample,
    })),
    aggregate: {
      inSample: winEval.aggregate.inSample,
      outOfSample: winEval.aggregate.outOfSample,
      full: winEval.aggregate.full,
    },
    perRegime: {
      note:
        "Per-regime returns are a BEHAVIOUR proxy (position-weighted close-to-close, before the " +
        "cost drag booked into equity). They show whether the directional core rode the bull and " +
        "dodged the bear. NOT used for the win/loss verdict (that uses cost-inclusive OOS metrics).",
      perToken: perTokenRegime,
    },
    verdict: {
      edgeFound,
      edgeFoundBasis: oosAgg.beatsBuyHold
        ? "aggregate OOS strictly beats B&H net of cost"
        : tokenBeats.length > 0
        ? `OOS strictly beats B&H net of cost for ${tokenBeats.length} of ${winEval.perToken.length} token(s): ${tokenBeats.map((t) => t.symbol).join(", ")}`
        : "NO token and NOT the aggregate strictly beat B&H net of cost on the held-out OOS — reported honestly as a loss vs B&H on absolute return",
      tokensBeatingBuyHoldOOS: tokenBeats.map((t) => t.symbol),
      aggregateBeatsBuyHoldOOS: oosAgg.beatsBuyHold,
      riskAdjustedWin,
      riskAdjustedBasis: riskAdjustedWin
        ? "aggregate OOS has higher Sharpe AND lower maxDrawdown than buy-and-hold OOS"
        : `aggregate OOS Sharpe ${oosAgg.sharpe} vs B&H ${oosAgg.buyAndHoldSharpe}; OOS maxDD ${oosAgg.maxDrawdown} vs B&H ${oosAgg.buyAndHoldMaxDrawdown} — does NOT clear the higher-Sharpe-AND-lower-drawdown bar`,
      honesty:
        "Selected on in-sample only; OOS reported unconditionally; all tokens + all sweep " +
        "candidates disclosed; net of a labelled 10+10 bps cost. The frozen report.json is " +
        "untouched. If neither edgeFound nor riskAdjustedWin holds, this is stated plainly.",
    },
  };

  return report;
}

// ════════════════════════════════════════════════════════════════════════════
//  CLI ENTRY — write the byte-reproducible report
// ════════════════════════════════════════════════════════════════════════════

export function writeReport(report: MomentumReport): void {
  fs.writeFileSync(MOMENTUM_REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");
}

export function main(): void {
  const oosFraction = Number(process.env.OOS_FRACTION) || DEFAULT_OOS_FRACTION;
  const walk: WalkParams = {
    ...DEFAULT_WALK,
    txCostBps: Number(process.env.TX_BPS) || DEFAULT_WALK.txCostBps,
    slippageBps: Number(process.env.SLIP_BPS) || DEFAULT_WALK.slippageBps,
  };
  const report = buildReport(oosFraction, walk);
  writeReport(report);

  const a = report.aggregate;
  console.log(`[stoic] momentum backtest -> ${MOMENTUM_REPORT_PATH}`);
  console.log(`  selected: ${report.selectedConfig.label}`);
  console.log(
    `  IN-SAMPLE  agg: strat ${(a.inSample.totalReturn * 100).toFixed(2)}% vs B&H ${(a.inSample.buyAndHoldReturn * 100).toFixed(2)}% (excess ${(a.inSample.excessReturn * 100).toFixed(2)}%)`
  );
  console.log(
    `  HELD-OUT   agg: strat ${(a.outOfSample.totalReturn * 100).toFixed(2)}% vs B&H ${(a.outOfSample.buyAndHoldReturn * 100).toFixed(2)}% (excess ${(a.outOfSample.excessReturn * 100).toFixed(2)}%)`
  );
  console.log(
    `  verdict: edgeFound=${report.verdict.edgeFound} riskAdjustedWin=${report.verdict.riskAdjustedWin} | ${report.verdict.edgeFoundBasis}`
  );
  for (const p of report.perToken) {
    console.log(
      `    ${p.symbol}: OOS strat ${(p.outOfSample.totalReturn * 100).toFixed(2)}% vs B&H ${(p.outOfSample.buyAndHoldReturn * 100).toFixed(2)}% beat=${p.outOfSample.beatsBuyHold}`
    );
  }
}

if (require.main === module) {
  main();
}
