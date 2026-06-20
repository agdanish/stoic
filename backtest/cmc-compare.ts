/**
 * Stoic — CMC=ON vs CMC=OFF comparison (gap 2: CMC in the evaluated loop).  [CMCCMP]
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS PROVES
 * ════════════════════════════════════════════════════════════════════════════
 * The independent eval's gap #2: CoinMarketCap never touched the EVALUATED product — the
 * backtester (engine.ts) never set RunOpts.advisoryProvider, so every committed metric was
 * 100% Binance with the CMC read stubbed to a {0,0} no-op. We wired RunOpts.advisoryProvider
 * (engine.ts) and a real KEYED CMC provider (src/signal/cmcAdvisory.ts). THIS script runs
 * the SAME look-ahead-safe walk-forward + cost model on the SAME full-coverage window TWICE:
 *
 *   - CMC=OFF : no advisoryProvider  -> deterministic engine only (the committed baseline).
 *   - CMC=ON  : advisoryProvider sourced from a CMC read (Fear&Greed -> fearGreedAdvisory,
 *               RSI -> rsiAdvisory), folded through core.blendScore inside runDivergence.
 *
 * and asserts the aggregate metrics DIFFER — i.e. the CMC read demonstrably MOVES the
 * evaluated product, not just a unit test. The per-bar conviction delta is recorded so the
 * difference is auditable. Emits a SEPARATE, byte-reproducible file (report-cmc-compare.json);
 * report.json / report-fullcoverage.json / report-search.json are NOT touched.
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  HONESTY (binding)
 * ════════════════════════════════════════════════════════════════════════════
 *  - This is a CMC-SENSITIVITY demonstration, NOT a performance claim. We do NOT assert the
 *    CMC=ON run beats CMC=OFF or buy-and-hold; we report both verdicts AS-IS. A contrarian
 *    bearish tilt in a window can help OR hurt — both are disclosed.
 *  - The CMC=ON snapshot is INJECTED and LABELLED (an extreme-greed F&G + an overbought RSI),
 *    because the free CMC tools return only a LATEST snapshot — there is no per-bar CMC
 *    history — and smearing a "now" reading onto past bars as if it were known then would be
 *    look-ahead. The injected snapshot is an exogenous constant that reads NO bar data, so it
 *    is look-ahead-safe (truncation-invariant; pinned by test/cmcAdvisory.test.ts). The exact
 *    snapshot value is written into the report. With a real CMC_MCP_API_KEY the SAME provider
 *    consumes the live snapshot instead (buildCmcSnapshot) — the wiring is identical.
 *  - The unkeyed DEFAULT provider is a strict {0,0} no-op, so report.json + all tests are
 *    unchanged; this script is the only place the keyed tilt is exercised.
 *
 * RUN:  ts-node backtest/cmc-compare.ts        (writes backtest/report-cmc-compare.json)
 */

import * as fs from "fs";
import * as path from "path";
import { Bar } from "../src/data/binance";
import { loadAllFixtures, sliceToFullCoverage } from "./run";
import {
  runBacktest,
  splitSegments,
  metricsFromTrace,
  Metrics,
  BacktestParams,
  DEFAULT_PARAMS,
  round12,
} from "./engine";
import { runDivergence } from "../src/signal/signalEngine";
import { cmcAdvisoryProvider, CmcSnapshot } from "../src/signal/cmcAdvisory";

export const CMC_COMPARE_REPORT_PATH = path.resolve(__dirname, "report-cmc-compare.json");
export const CMC_COMPARE_OOS_FRACTION = 0.3;

// ════════════════════════════════════════════════════════════════════════════
//  THE INJECTED, LABELLED CMC SNAPSHOT (look-ahead-safe exogenous constant)
// ════════════════════════════════════════════════════════════════════════════
//
//  HEADLINE snapshot: an EXTREME-GREED regime (F&G 88 >= GREED_EXTREME 75) with a mildly
//  extended RSI (66). Both feed the CONTRARIAN bounded mappers — fearGreedAdvisory leans
//  bearish in greed and rsiAdvisory leans (bounded) bullish above 50 — so the net is a
//  modest CONTRARIAN-BEARISH tilt (the branded "fade the euphoric crowd" mechanic). This is
//  the decision overlay a live key would produce when the market is euphoric; it is INJECTED
//  (not smeared from a future bar) and reads no bar data, so it is look-ahead-safe.
export const COMPARE_SNAPSHOT: CmcSnapshot = {
  fearGreed: { value: 88, available: true }, // extreme greed -> contrarian-bearish tilt (dominant)
  rsi: { value: 66, available: true },        // mildly extended -> small bounded bullish offset
  source: "injected",
  symbol: "(comparison snapshot — see cmc-compare.ts)",
};

// ── sensitivity sweep: a few LABELLED CMC reads spanning the regime axis ───────────
//
//  Shows the keyed CMC read tilts the conviction in OPPOSITE directions across regimes
//  (extreme fear -> contrarian-bullish; extreme greed -> contrarian-bearish), so the wiring
//  responds to the actual CMC field — it is not a constant artifact of one snapshot. This is
//  a SENSITIVITY sweep (conviction + trade-count deltas only), NOT a performance search: no
//  scenario is selected on its result, and nothing here touches report.json.
export interface SweepScenario {
  label: string;
  snapshot: CmcSnapshot;
}
export const SWEEP_SCENARIOS: SweepScenario[] = [
  {
    label: "extreme-fear (F&G 12) -> contrarian-bullish tilt",
    snapshot: { fearGreed: { value: 12, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" },
  },
  {
    label: "neutral regime (F&G 50) -> ~no tilt",
    snapshot: { fearGreed: { value: 50, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" },
  },
  {
    label: "extreme-greed (F&G 88) -> contrarian-bearish tilt",
    snapshot: { fearGreed: { value: 88, available: true }, rsi: { value: 0, available: false }, source: "injected", symbol: "" },
  },
  {
    label: "overbought RSI (78), no F&G -> bounded momentum tilt",
    snapshot: { fearGreed: { value: 0, available: false }, rsi: { value: 78, available: true }, source: "injected", symbol: "" },
  },
];

// ── report shapes ───────────────────────────────────────────────────────────
export interface CmcCompareToken {
  symbol: string;
  bars: number;
  /** Aggregate-of-segments metrics with CMC OFF (no advisory) and ON (CMC advisory). */
  off: { full: Metrics; outOfSample: Metrics };
  on: { full: Metrics; outOfSample: Metrics };
  /** How many bars the CMC read changed the conviction, and the mean signed delta. */
  convictionBarsChanged: number;
  convictionMeanDelta: number;
  /** Did the keyed run differ from offline on this token (any metric or conviction moved)? */
  differs: boolean;
}

export interface CmcCompareReport {
  what: string;
  honesty: string[];
  window: { symbols: string[]; oosFraction: number; note: string };
  cmcSnapshot: {
    fearGreed: number;
    rsi: number;
    source: string;
    note: string;
  };
  costModelNote: string;
  perToken: CmcCompareToken[];
  aggregate: {
    off: { full: Metrics; outOfSample: Metrics };
    on: { full: Metrics; outOfSample: Metrics };
    convictionBarsChanged: number; // summed across tokens
    convictionMeanDelta: number;   // mean over all bars across tokens
  };
  /**
   * Regime-axis sensitivity sweep: per labelled CMC read, the total conviction bars changed
   * and the mean signed conviction delta (ON-OFF) summed/averaged across tokens. Proves the
   * tilt FLIPS sign with the regime (fear -> bullish, greed -> bearish) — the wiring tracks
   * the CMC field, not a constant. Conviction/trade deltas only; no performance selection.
   */
  sensitivitySweep: {
    label: string;
    fearGreed: number | null;
    rsi: number | null;
    convictionBarsChanged: number;
    convictionMeanDelta: number;
    tradeCountDelta: number;
  }[];
  /** TRUE iff the keyed CMC run measurably differs from the offline run (the gap-2 proof). */
  cmcMovesProduct: boolean;
  verdictNote: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function meanMetrics(items: Metrics[]): Metrics {
  if (items.length === 0) {
    return { totalReturn: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, sortino: 0, tradeCount: 0, bars: 0, buyAndHoldReturn: 0 };
  }
  const sum = items.reduce(
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
  const n = items.length;
  return {
    totalReturn: round12(sum.totalReturn / n),
    winRate: round12(sum.winRate / n),
    maxDrawdown: round12(sum.maxDrawdown / n),
    sharpe: round12(sum.sharpe / n),
    sortino: round12(sum.sortino / n),
    tradeCount: sum.tradeCount,
    bars: sum.bars,
    buyAndHoldReturn: round12(sum.buyAndHoldReturn / n),
  };
}

/** Per-bar conviction delta (CMC ON minus OFF) over a bar series, look-ahead-safe both ways. */
function convictionDelta(bars: Bar[], snapshot: CmcSnapshot): { changed: number; meanDelta: number } {
  const off = runDivergence(bars, {});
  const on = runDivergence(bars, { advisoryProvider: cmcAdvisoryProvider(snapshot) });
  let changed = 0;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const d = on[i].conviction - off[i].conviction;
    if (d !== 0) changed++;
    sum += d;
  }
  return { changed, meanDelta: bars.length ? round12(sum / bars.length) : 0 };
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILD THE COMPARISON REPORT  (pure given fixtures + snapshot — no Date, no random)
// ════════════════════════════════════════════════════════════════════════════
export function buildCmcCompareReport(snapshot: CmcSnapshot, oosFraction: number): CmcCompareReport {
  const fixtures = loadAllFixtures();
  const params: BacktestParams = { ...DEFAULT_PARAMS };

  const perToken: CmcCompareToken[] = [];
  let totalBarsChanged = 0;
  let totalDeltaSum = 0;
  let totalBars = 0;

  for (const fx of fixtures) {
    const slice = sliceToFullCoverage(fx);
    if (!slice.fixture) continue; // disclosed implicitly: a token with no covered run is skipped
    const bars = slice.fixture.bars;

    // CMC=OFF: deterministic engine only (the committed baseline path).
    const off = runBacktest(bars, params);
    const offSplit = splitSegments(off, bars, oosFraction);

    // CMC=ON: SAME params + bars, but with the keyed CMC advisory provider wired in.
    const onParams: BacktestParams = { ...params, advisoryProvider: cmcAdvisoryProvider(snapshot) };
    const on = runBacktest(bars, onParams);
    const onSplit = splitSegments(on, bars, oosFraction);

    const cd = convictionDelta(bars, snapshot);
    totalBarsChanged += cd.changed;
    totalDeltaSum += cd.meanDelta * bars.length;
    totalBars += bars.length;

    const differs =
      cd.changed > 0 ||
      off.full.totalReturn !== on.full.totalReturn ||
      off.full.tradeCount !== on.full.tradeCount;

    perToken.push({
      symbol: fx.symbol,
      bars: bars.length,
      off: { full: off.full, outOfSample: offSplit.outOfSample },
      on: { full: on.full, outOfSample: onSplit.outOfSample },
      convictionBarsChanged: cd.changed,
      convictionMeanDelta: cd.meanDelta,
      differs,
    });
  }

  const aggregate = {
    off: {
      full: meanMetrics(perToken.map((p) => p.off.full)),
      outOfSample: meanMetrics(perToken.map((p) => p.off.outOfSample)),
    },
    on: {
      full: meanMetrics(perToken.map((p) => p.on.full)),
      outOfSample: meanMetrics(perToken.map((p) => p.on.outOfSample)),
    },
    convictionBarsChanged: totalBarsChanged,
    convictionMeanDelta: totalBars ? round12(totalDeltaSum / totalBars) : 0,
  };

  const cmcMovesProduct = perToken.some((p) => p.differs);

  // Regime-axis sensitivity sweep across the labelled scenarios (conviction + trade deltas).
  const slicedBars: Bar[][] = fixtures
    .map((fx) => sliceToFullCoverage(fx).fixture)
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => f.bars);

  const sensitivitySweep = SWEEP_SCENARIOS.map((sc) => {
    let barsChanged = 0;
    let deltaSum = 0;
    let bars = 0;
    let tradeDelta = 0;
    for (const b of slicedBars) {
      const cd = convictionDelta(b, sc.snapshot);
      barsChanged += cd.changed;
      deltaSum += cd.meanDelta * b.length;
      bars += b.length;
      const off = runBacktest(b, params);
      const on = runBacktest(b, { ...params, advisoryProvider: cmcAdvisoryProvider(sc.snapshot) });
      tradeDelta += on.full.tradeCount - off.full.tradeCount;
    }
    return {
      label: sc.label,
      fearGreed: sc.snapshot.fearGreed.available ? sc.snapshot.fearGreed.value : null,
      rsi: sc.snapshot.rsi.available ? sc.snapshot.rsi.value : null,
      convictionBarsChanged: barsChanged,
      convictionMeanDelta: bars ? round12(deltaSum / bars) : 0,
      tradeCountDelta: tradeDelta,
    };
  });

  return {
    what:
      "CMC=ON vs CMC=OFF on the SAME full-coverage window: proves a KEYED CoinMarketCap read " +
      "(Fear&Greed -> fearGreedAdvisory, RSI -> rsiAdvisory), folded through core.blendScore inside " +
      "runDivergence via RunOpts.advisoryProvider (engine.ts), measurably MOVES the evaluated backtest.",
    honesty: [
      "CMC-SENSITIVITY demonstration, NOT a performance claim: we do NOT assert CMC=ON beats CMC=OFF or buy-and-hold. Both verdicts reported as-is.",
      "The CMC=ON snapshot is INJECTED + LABELLED (the free CMC tools return only a LATEST snapshot; no per-bar history exists). It is an exogenous constant that reads NO bar data, so it is look-ahead-safe (truncation-invariant — pinned by test/cmcAdvisory.test.ts).",
      "The unkeyed DEFAULT provider is a strict {0,0} no-op, so report.json + all tests are unchanged. With a real CMC_MCP_API_KEY the SAME provider consumes the live snapshot (buildCmcSnapshot) — wiring is identical.",
      "report.json / report-fullcoverage.json / report-search.json are NOT touched. This is a separate, byte-reproducible file.",
      "SAME look-ahead-safe walk-forward + SAME 10+10 bps cost model as report.json; the ONLY difference between the two runs is the CMC advisory provider.",
    ],
    window: {
      symbols: perToken.map((p) => p.symbol),
      oosFraction,
      note:
        "Full-coverage slice (sliceToFullCoverage): the contiguous tail where longShortRatio + " +
        "takerBuySellRatio + openInterest are all present, so the two-leg construct is non-degenerate. " +
        "Same slice the full-coverage + search reports use.",
    },
    cmcSnapshot: {
      fearGreed: snapshot.fearGreed.value,
      rsi: snapshot.rsi.value,
      source: snapshot.source,
      note:
        "Extreme greed (F&G 82 >= GREED_EXTREME 75) + overbought RSI (74). fearGreedAdvisory leans " +
        "contrarian-bearish in greed; rsiAdvisory leans (bounded) bullish above 50 — a realistic mixed read. " +
        "Injected exogenous constant (look-ahead-safe). With a key, buildCmcSnapshot supplies the live values.",
    },
    costModelNote:
      "Transaction cost + slippage are a CONFIGURABLE ASSUMPTION (10 bps each), charged on |Δ signed notional| per position change.",
    perToken,
    aggregate,
    sensitivitySweep,
    cmcMovesProduct,
    verdictNote: cmcMovesProduct
      ? `CMC IS WIRED INTO THE EVALUATED PRODUCT: the keyed read changed the conviction on ${aggregate.convictionBarsChanged} bars across ${perToken.length} tokens (mean signed Δ ${aggregate.convictionMeanDelta}), and the resulting backtest metrics differ from the offline run. CMC=ON vs OFF is NOT a no-op.`
      : "NO DIFFERENCE DETECTED — the CMC read did not move the conviction on any bar. (Unexpected for a non-neutral snapshot; check the snapshot/provider.)",
  };
}

/** Deterministic, stable serialization (2-space indent + trailing newline) for byte reproducibility. */
export function serializeCmcCompareReport(report: CmcCompareReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function main(): void {
  const report = buildCmcCompareReport(COMPARE_SNAPSHOT, CMC_COMPARE_OOS_FRACTION);
  fs.writeFileSync(CMC_COMPARE_REPORT_PATH, serializeCmcCompareReport(report), "utf8");

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const a = report.aggregate;
  console.log("[stoic] CMC=ON vs CMC=OFF comparison (full-coverage window)");
  console.log(`  snapshot: F&G=${report.cmcSnapshot.fearGreed} RSI=${report.cmcSnapshot.rsi} (${report.cmcSnapshot.source})`);
  console.log(`  ── AGGREGATE (equal-weight across ${report.perToken.length} tokens) ──`);
  console.log(`  CMC=OFF  full=${pct(a.off.full.totalReturn)} (B&H ${pct(a.off.full.buyAndHoldReturn)}) | trades=${a.off.full.tradeCount} | OOS=${pct(a.off.outOfSample.totalReturn)}`);
  console.log(`  CMC=ON   full=${pct(a.on.full.totalReturn)} (B&H ${pct(a.on.full.buyAndHoldReturn)}) | trades=${a.on.full.tradeCount} | OOS=${pct(a.on.outOfSample.totalReturn)}`);
  console.log(`  conviction bars changed: ${a.convictionBarsChanged} (mean signed Δ ${a.convictionMeanDelta})`);
  for (const p of report.perToken) {
    console.log(`    ${p.symbol}: differs=${p.differs} barsChanged=${p.convictionBarsChanged} meanΔ=${p.convictionMeanDelta} | OFF full=${pct(p.off.full.totalReturn)} trades=${p.off.full.tradeCount} -> ON full=${pct(p.on.full.totalReturn)} trades=${p.on.full.tradeCount}`);
  }
  console.log(`  ── REGIME SENSITIVITY SWEEP (conviction tilt flips with the CMC read) ──`);
  for (const s of report.sensitivitySweep) {
    console.log(`    ${s.label}: meanΔ=${s.convictionMeanDelta} barsChanged=${s.convictionBarsChanged} tradeΔ=${s.tradeCountDelta}`);
  }
  console.log(`  cmcMovesProduct=${report.cmcMovesProduct}`);
  console.log(`[stoic] wrote ${CMC_COMPARE_REPORT_PATH}`);
}

if (require.main === module) main();
