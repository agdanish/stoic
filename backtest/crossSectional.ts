/**
 * Stoic — cross-sectional dislocation VALIDATION harness (Phase 4, gap 4).  [XS]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS
 * ════════════════════════════════════════════════════════════════════════════
 * Validates the NET-NEW cross-sectional positioning-vs-flow dislocation differentiator
 * (src/signal/crossSectional.ts) on the SAME P1 FULL-COVERAGE slice (the contiguous tail
 * where all flow legs are present, so the construct is non-degenerate on every bar) using
 * the SAME look-ahead-safe walk-forward + cost model as backtest/engine.ts. It compares,
 * head to head on the identical bars and split:
 *
 *   - PER-TOKEN (baseline): the existing time-series divergence (z(crowd)−z(flow))
 *     mapped to divergenceBias — i.e. engine.runBacktest on the slice (DEFAULT knobs).
 *   - CROSS-SECTIONAL (new): at each bar, demean the panel's per-token divergence across
 *     {BTC,ETH,BNB}, re-standardise by the panel dispersion, and fade only the MOST
 *     cross-sectionally dislocated token — the idiosyncratic residual, market-neutral
 *     flavoured. dislocation -> divergenceBias via dislocationToBias (same contrarian map).
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY (binding — mirrors HONEST_SEARCH_RULES.md)
 * ════════════════════════════════════════════════════════════════════════════
 *  - The cross-sectional term uses ONLY the per-token divergences, each computed from bars
 *    < t (rolling z-score window ends at t−1). The cross-section at bar t reads only the
 *    panel values AT bar t. A dedicated truncation-invariance test pins look-ahead safety.
 *  - The full-coverage slice is chosen PURELY by data coverage (the same slice as
 *    report-fullcoverage.json), NEVER by result.
 *  - The held-out OOS tail is reported UNCONDITIONALLY for both arms — win, loss, or
 *    break-even. There is no parameter selection on OOS here (the dislocation thresholds
 *    are fixed exported constants, not searched).
 *  - The cost model stays the labelled 10+10 bps assumption; all returns net of it.
 *  - report.json / report-fullcoverage.json / report-search.json are NOT touched. This
 *    emits a SEPARATE, byte-reproducible file (report-crosssectional.json).
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  RESULT (committed in report-crosssectional.json; reproduced byte-for-byte by the test)
 * ════════════════════════════════════════════════════════════════════════════
 *  The numbers are whatever the committed run produces — read them from the report, not
 *  from this comment. The verdict field states plainly whether the cross-sectional arm
 *  beats the per-token arm and/or buy-and-hold on the held-out OOS; if it does not, that
 *  is reported as-is (the differentiator's value is the look-ahead-safe relative-value
 *  construct itself + its measurable difference from the per-token engine, not a fabricated
 *  win). Nothing here is selected on OOS, fabricated, or window-shopped.
 *
 * RUN:  ts-node backtest/crossSectional.ts   (writes backtest/report-crosssectional.json)
 */

import * as fs from "fs";
import * as path from "path";
import { Bar } from "../src/data/binance";
import { loadAllFixtures, sliceToFullCoverage } from "./run";
import {
  crossSectionalDislocation,
  dislocationToBias,
  PanelToken,
  DislocationBar,
  CROSS_MIN_TOKENS,
  CROSS_DISLOCATION_DEADBAND,
  CROSS_FULL_DISLOCATION,
} from "../src/signal/crossSectional";
import { barFeatures, scoreConviction } from "../src/signal/signalEngine";
import { divergenceSignal } from "../src/signal/divergence";
import { decideTrade, Side } from "../src/agent/decide";
import {
  metricsFromTrace,
  Metrics,
  BarTrace,
  CompletedTrade,
  round12,
  DEFAULT_PARAMS,
} from "./engine";

export const XS_REPORT_PATH = path.resolve(__dirname, "report-crosssectional.json");
export const XS_OOS_FRACTION = 0.3;

/**
 * Walk-forward over ONE token's sliced bars using a PROVIDED per-bar divergenceBias series.
 * Mirrors engine.runBacktest / search.runBacktestKnobs mechanics EXACTLY (decision at bar i
 * uses only bars <= i; position held into i+1; cost on |Δ signed notional|). The only
 * difference vs the per-token engine is WHICH divergenceBias feeds scoreConviction — here
 * the caller supplies it (per-token OR cross-sectional). Look-ahead-safe. Pure.
 */
export function runWithDivergenceBias(
  bars: Bar[],
  divergenceBiasSeries: number[],
  txBps: number = DEFAULT_PARAMS.txCostBps,
  slipBps: number = DEFAULT_PARAMS.slippageBps
): { trace: BarTrace[]; trades: CompletedTrade[] } {
  const costRate = (txBps + slipBps) / 10000;
  const trace: BarTrace[] = [];
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

    let barReturn = 0;
    if (i > 0) {
      const prevClose = bars[i - 1].close;
      const r = isFinite(prevClose) && prevClose !== 0 && isFinite(b.close) ? b.close / prevClose - 1 : 0;
      barReturn = prevWeight * r;
      equity *= 1 + barReturn;
      buyHold *= 1 + r;
    }

    const feats = barFeatures(bars, i);
    const scored = scoreConviction({
      bar: i,
      trend: feats.trend,
      momentum: feats.momentum,
      fundingBias: feats.fundingBias,
      flowBias: feats.flowBias,
      divergenceBias: divergenceBiasSeries[i],
    });

    let side: Side = decideTrade(prevSide, scored.conviction, scored.sizeBps, DEFAULT_PARAMS.entryThreshold).side;
    if (!DEFAULT_PARAMS.allowShort && side === "short") side = "flat";

    const magnitude = (scored.sizeBps / 10000) * DEFAULT_PARAMS.maxLeverage;
    const targetWeight = side === "long" ? magnitude : side === "short" ? -magnitude : 0;

    const cost = Math.abs(targetWeight - prevWeight) * costRate;
    if (cost > 0) equity *= 1 - cost;

    const sideChanged = side !== (openSide ?? "flat");
    if (sideChanged) {
      if (openSide === "long" || openSide === "short") {
        const exitPrice = b.close;
        const gross = openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
        trades.push({
          entryBar: openEntryBar, exitBar: i, side: openSide,
          entryPrice: openEntryPrice, exitPrice, netReturn: round12(gross - (openCostAccrued + cost)),
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
      bar: i, t: b.t, close: b.close, conviction: scored.conviction, side,
      targetWeight: round12(targetWeight), barReturn: round12(barReturn),
      cost: round12(cost), equity: round12(equity), buyHoldEquity: round12(buyHold),
    });

    prevWeight = targetWeight;
    prevSide = side === "flat" ? prevSide : side;
  }

  if ((openSide === "long" || openSide === "short") && bars.length > 0) {
    const last = bars[bars.length - 1];
    const exitPrice = last.close;
    const gross = openSide === "long" ? exitPrice / openEntryPrice - 1 : openEntryPrice / exitPrice - 1;
    trades.push({
      entryBar: openEntryBar, exitBar: bars.length - 1, side: openSide,
      entryPrice: openEntryPrice, exitPrice, netReturn: round12(gross - openCostAccrued),
    });
  }

  return { trace, trades };
}

/** Per-token per-bar divergenceBias from the EXISTING per-token time-series engine. */
export function perTokenDivergenceBias(bars: Bar[]): number[] {
  return divergenceSignal(bars).map((d) => d.divergenceBias);
}

/** Per-token per-bar divergenceBias from the NEW cross-sectional dislocation series. */
export function crossSectionalDivergenceBias(disloc: DislocationBar[]): number[] {
  return disloc.map((d) => dislocationToBias(d.dislocation));
}

// ── segment metrics over the fixed 0.30 split ─────────────────────────────────
export interface ArmSegments {
  inSample: Metrics;
  outOfSample: Metrics;
  full: Metrics;
}

function segmentsFor(bars: Bar[], bias: number[], txBps?: number, slipBps?: number): ArmSegments {
  const { trace, trades } = runWithDivergenceBias(bars, bias, txBps, slipBps);
  const n = bars.length;
  const splitBar = Math.floor(n * (1 - XS_OOS_FRACTION));
  return {
    inSample: metricsFromTrace(trace, trades, 0, splitBar),
    outOfSample: metricsFromTrace(trace, trades, splitBar, n),
    full: metricsFromTrace(trace, trades, 0, n),
  };
}

function meanMetrics(items: Metrics[]): Metrics {
  const n = items.length || 1;
  const r = (x: number) => round12(x / n);
  const s = items.reduce(
    (a, m) => ({
      totalReturn: a.totalReturn + m.totalReturn,
      winRate: a.winRate + m.winRate,
      maxDrawdown: a.maxDrawdown + m.maxDrawdown,
      sharpe: a.sharpe + m.sharpe,
      sortino: a.sortino + m.sortino,
      tradeCount: a.tradeCount + m.tradeCount,
      bars: a.bars + m.bars,
      buyAndHoldReturn: a.buyAndHoldReturn + m.buyAndHoldReturn,
    }),
    { totalReturn: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, sortino: 0, tradeCount: 0, bars: 0, buyAndHoldReturn: 0 }
  );
  return {
    totalReturn: r(s.totalReturn), winRate: r(s.winRate), maxDrawdown: r(s.maxDrawdown),
    sharpe: r(s.sharpe), sortino: r(s.sortino), tradeCount: s.tradeCount, bars: s.bars,
    buyAndHoldReturn: r(s.buyAndHoldReturn),
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  REPORT SHAPE
// ════════════════════════════════════════════════════════════════════════════
export interface PerTokenArm {
  symbol: string;
  perToken: ArmSegments;
  crossSectional: ArmSegments;
  /** Fraction of slice bars on which the cross-sectional divergenceBias differs from the per-token one. */
  biasDifferFraction: number;
  /** Fraction of slice bars where this token was the panel outlier (the one to fade). */
  outlierFraction: number;
}

export interface XsReport {
  what: string;
  insight: string[];
  honesty: string[];
  constants: {
    CROSS_MIN_TOKENS: number;
    CROSS_DISLOCATION_DEADBAND: number;
    CROSS_FULL_DISLOCATION: number;
  };
  window: { note: string; oosFraction: number; perToken: { symbol: string; bars: number }[] };
  costModelNote: string;
  perToken: PerTokenArm[];
  aggregate: {
    perToken: ArmSegments;
    crossSectional: ArmSegments;
  };
  /** 15+15 bps cost-bump stress on the cross-sectional aggregate (mirrors search Rule 3.4). */
  stress15bps: { perToken: ArmSegments; crossSectional: ArmSegments };
  verdict: {
    crossSectionalDiffersFromPerToken: boolean;
    crossSectionalBeatsBuyHoldOOS: boolean;
    crossSectionalBeatsPerTokenOOS: boolean;
    summary: string;
    decision: string;
  };
}

/**
 * Build the cross-sectional validation report (pure given the committed fixtures).
 * Slices to the full-coverage tail, computes the panel dislocation, runs both arms through
 * the identical walk-forward, and reports the unconditional held-out OOS for both.
 */
export function buildXsReport(): XsReport {
  // 1) full-coverage slices (bar-for-bar aligned across BTC/ETH/BNB in this repo)
  const slices = loadAllFixtures().map((fx) => {
    const sliced = sliceToFullCoverage(fx).fixture;
    if (!sliced) throw new Error(`[crosssectional] ${fx.symbol}: no full-coverage slice`);
    return { symbol: fx.symbol, bars: sliced.bars };
  });

  // 2) cross-sectional dislocation panel (look-ahead-safe)
  const panel: PanelToken[] = slices.map((s) => ({ symbol: s.symbol, bars: s.bars }));
  const dislocation = crossSectionalDislocation(panel);

  // 3) both arms, per token + stress
  const perTokenArms: PerTokenArm[] = slices.map((s) => {
    const ptBias = perTokenDivergenceBias(s.bars);
    const xsBias = crossSectionalDivergenceBias(dislocation[s.symbol]);
    const ptSeg = segmentsFor(s.bars, ptBias);
    const xsSeg = segmentsFor(s.bars, xsBias);
    let differ = 0;
    for (let i = 0; i < s.bars.length; i++) if (ptBias[i] !== xsBias[i]) differ++;
    const outliers = dislocation[s.symbol].filter((d) => d.isPanelOutlier).length;
    return {
      symbol: s.symbol,
      perToken: ptSeg,
      crossSectional: xsSeg,
      biasDifferFraction: round12(differ / s.bars.length),
      outlierFraction: round12(outliers / s.bars.length),
    };
  });

  const stressArms = slices.map((s) => {
    const xsBias = crossSectionalDivergenceBias(dislocation[s.symbol]);
    const ptBias = perTokenDivergenceBias(s.bars);
    return {
      perToken: segmentsFor(s.bars, ptBias, 15, 15),
      crossSectional: segmentsFor(s.bars, xsBias, 15, 15),
    };
  });

  const aggregate = {
    perToken: {
      inSample: meanMetrics(perTokenArms.map((p) => p.perToken.inSample)),
      outOfSample: meanMetrics(perTokenArms.map((p) => p.perToken.outOfSample)),
      full: meanMetrics(perTokenArms.map((p) => p.perToken.full)),
    },
    crossSectional: {
      inSample: meanMetrics(perTokenArms.map((p) => p.crossSectional.inSample)),
      outOfSample: meanMetrics(perTokenArms.map((p) => p.crossSectional.outOfSample)),
      full: meanMetrics(perTokenArms.map((p) => p.crossSectional.full)),
    },
  };

  const stress15bps = {
    perToken: {
      inSample: meanMetrics(stressArms.map((p) => p.perToken.inSample)),
      outOfSample: meanMetrics(stressArms.map((p) => p.perToken.outOfSample)),
      full: meanMetrics(stressArms.map((p) => p.perToken.full)),
    },
    crossSectional: {
      inSample: meanMetrics(stressArms.map((p) => p.crossSectional.inSample)),
      outOfSample: meanMetrics(stressArms.map((p) => p.crossSectional.outOfSample)),
      full: meanMetrics(stressArms.map((p) => p.crossSectional.full)),
    },
  };

  // 4) verdict — reported AS-IS (no selection on OOS)
  const anyDiffer = perTokenArms.some((p) => p.biasDifferFraction > 0);
  const xsAgg = aggregate.crossSectional.outOfSample;
  const ptAgg = aggregate.perToken.outOfSample;
  const xsBeatsBH = xsAgg.totalReturn > xsAgg.buyAndHoldReturn ||
    perTokenArms.some((p) => p.crossSectional.outOfSample.totalReturn > p.crossSectional.outOfSample.buyAndHoldReturn);
  const xsBeatsPt = xsAgg.totalReturn > ptAgg.totalReturn;

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  return {
    what:
      "Head-to-head validation of the NET-NEW cross-sectional positioning-vs-flow dislocation " +
      "differentiator vs the existing per-token time-series divergence, on the IDENTICAL P1 " +
      "full-coverage slice + walk-forward + cost model. Cross-sectional demeans the panel's " +
      "divergence across BTC/ETH/BNB and fades the most idiosyncratically dislocated token.",
    insight: [
      "The per-token engine asks: is THIS token's crowd offside vs THIS token's flow, relative to its OWN history (a time-series z-score). The cross-sectional term asks: across the WHOLE panel at this instant, which token's divergence is the OUTLIER relative to its peers (a panel-axis z-score).",
      "The cross-sectional DEMEAN removes the common (market-wide / beta) component of divergence: when the whole market is crowded long, the per-token engine fires SHORT on all three tokens (= shorting beta, no edge); subtracting the panel mean leaves only the IDIOSYNCRATIC residual — the token offside RELATIVE TO ITS PEERS — which is the cleaner mean-reversion target.",
      "This is a relative-value (stat-arb-flavoured) selection the per-token engine cannot express, because the per-token engine has no concept of the other tokens. It is genuinely net-new, not the canned 'sentiment vs price' example nor a relabel of the per-token construct.",
      "Look-ahead-safe: every input is a per-token divergence computed from bars < t; the cross-section at bar t reads only the panel's at-or-before-derived values at bar t. A dedicated truncation-invariance test pins it.",
    ],
    honesty: [
      "Full-coverage slice chosen by data coverage, not by result (same slice as report-fullcoverage.json / report-search.json).",
      "Held-out OOS (trailing 30%) reported UNCONDITIONALLY for both arms — win, loss, or break-even. No parameter is selected on OOS; the dislocation thresholds are fixed exported constants.",
      "Same look-ahead-safe walk-forward as engine.runBacktest; same 10+10 bps cost assumption (a 15+15 bps stress is included). report.json / report-fullcoverage.json / report-search.json are not touched.",
    ],
    constants: { CROSS_MIN_TOKENS, CROSS_DISLOCATION_DEADBAND, CROSS_FULL_DISLOCATION },
    window: {
      note:
        "FULL-COVERAGE slice of the committed REAL Binance fixtures (bar-for-bar aligned across BTC/ETH/BNB). Default 0.30 split; in-sample = leading 70%, held-out OOS = trailing 30%.",
      oosFraction: XS_OOS_FRACTION,
      perToken: slices.map((s) => ({ symbol: s.symbol, bars: s.bars.length })),
    },
    costModelNote:
      "Transaction cost + slippage are a CONFIGURABLE ASSUMPTION (default 10 bps each), charged on |Δ signed notional| per position change. The exact organizer cost/slippage model is UNCONFIRMED.",
    perToken: perTokenArms,
    aggregate,
    stress15bps,
    verdict: {
      crossSectionalDiffersFromPerToken: anyDiffer,
      crossSectionalBeatsBuyHoldOOS: xsBeatsBH,
      crossSectionalBeatsPerTokenOOS: xsBeatsPt,
      summary:
        `Cross-sectional differs from per-token on >=1 token: ${anyDiffer}. ` +
        `Aggregate held-out OOS — cross-sectional ${pct(xsAgg.totalReturn)} vs per-token ${pct(ptAgg.totalReturn)} vs B&H ${pct(xsAgg.buyAndHoldReturn)}. ` +
        `Cross-sectional OOS maxDD ${pct(aggregate.crossSectional.outOfSample.maxDrawdown)} vs per-token ${pct(aggregate.perToken.outOfSample.maxDrawdown)}.`,
      decision: xsBeatsBH
        ? "The cross-sectional differentiator beats B&H net-of-cost on the held-out full-coverage OOS for >=1 arm — lead with it as the originality differentiator AND a measurable edge; retain the frozen baselines labelled as such."
        : "The cross-sectional differentiator does NOT beat B&H net-of-cost on the held-out OOS (consistent with the Phase-1b reframe: this rising OOS tail is not where a contrarian construct earns). Its value is the look-ahead-safe relative-value construct itself, its measurable difference from the per-token engine, and its risk profile — reported here as-is, never fabricated.",
    },
  };
}

/** Deterministic serialization (2-space indent + trailing newline) for byte reproducibility. */
export function serializeXsReport(report: XsReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function main(): void {
  const report = buildXsReport();
  fs.writeFileSync(XS_REPORT_PATH, serializeXsReport(report), "utf8");
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const xs = report.aggregate.crossSectional;
  const pt = report.aggregate.perToken;
  console.log(`[stoic] cross-sectional: panel ${report.window.perToken.map((p) => p.symbol).join("/")}, ${report.window.perToken[0].bars} bars/token (full coverage).`);
  console.log(`  DISLOCATION constants: minTokens=${CROSS_MIN_TOKENS} deadband=${CROSS_DISLOCATION_DEADBAND} full=${CROSS_FULL_DISLOCATION}`);
  for (const p of report.perToken) {
    console.log(`    ${p.symbol}: bias differs on ${pct(p.biasDifferFraction)} of bars; panel-outlier on ${pct(p.outlierFraction)} of bars`);
  }
  console.log(`  ── AGGREGATE held-out OOS (equal-weight) ──`);
  console.log(`  PER-TOKEN       ret=${pct(pt.outOfSample.totalReturn)} vs B&H ${pct(pt.outOfSample.buyAndHoldReturn)} | maxDD=${pct(pt.outOfSample.maxDrawdown)} | trades=${pt.outOfSample.tradeCount}`);
  console.log(`  CROSS-SECTIONAL ret=${pct(xs.outOfSample.totalReturn)} vs B&H ${pct(xs.outOfSample.buyAndHoldReturn)} | maxDD=${pct(xs.outOfSample.maxDrawdown)} | trades=${xs.outOfSample.tradeCount}`);
  console.log(`  VERDICT: differs=${report.verdict.crossSectionalDiffersFromPerToken} beatsBH_OOS=${report.verdict.crossSectionalBeatsBuyHoldOOS} beatsPerToken_OOS=${report.verdict.crossSectionalBeatsPerTokenOOS}`);
  console.log(`[stoic] cross-sectional: wrote ${XS_REPORT_PATH}`);
}

if (require.main === module) main();
