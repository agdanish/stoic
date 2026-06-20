/**
 * Stoic — HONESTY invariants.  [Aux: test hardening]
 *
 * Honesty is an explicit judging axis (the prior project lost by being off-domain /
 * over-claimed). These tests pin three promises the README, SKILL.md, and the demo make,
 * so a regression that quietly breaks one of them fails CI instead of the judges:
 *
 *   (1) NO KEYS -> FULLY DETERMINISTIC. With NO CMC key and NO LLM key (the default
 *       everywhere) the signal output is byte-reproducible run-to-run, and the optional
 *       advisory layers degrade to the strict {0,0} no-op that cannot move the number.
 *
 *   (2) SYNTHETIC IS SURFACED, NEVER SILENTLY REAL. A bar fixture marked `_synthetic:true`
 *       must be loudly labelled (in the fixture AND in any backtest report built on it) —
 *       never folded into a "REAL" claim. The committed fixtures' own `_synthetic` flag is
 *       threaded through honestly.
 *
 *   (3) THE SKILL CANNOT PROMISE A TOOL THE ADAPTER DOES NOT CALL. Every `allowed-tools`
 *       entry in SKILL.md must be backed by a real `callTool("<tool>", ...)` in
 *       src/data/cmc.ts AND an exported adapter method — so the Skill never advertises a
 *       CMC capability the code does not actually exercise.
 *
 * Pure + offline: reads committed fixtures, the SKILL.md, and the cmc.ts SOURCE; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { loadBarsFixture, SYMBOLS, synthSeries, makeFixture } from "../src/data/fetchHistory";
import { buildReport, serializeReport, loadAllFixtures, DEFAULT_OOS_FRACTION } from "../backtest/run";
import { runDivergence } from "../src/signal/signalEngine";
import { runBacktest, DEFAULT_PARAMS } from "../backtest/engine";
import * as cmc from "../src/data/cmc";

const SKILL_PATH = path.resolve(__dirname, "../skills/sentiment-divergence-regime/SKILL.md");
const CMC_SRC_PATH = path.resolve(__dirname, "../src/data/cmc.ts");

// Force the offline (keyless) transport for the whole file regardless of ambient env.
delete process.env.CMC_MCP_API_KEY;
delete process.env.ZAI_API_KEY;

// ════════════════════════════════════════════════════════════════════════════
//  (1) NO CMC/LLM KEYS -> the signal output is fully deterministic / reproducible
// ════════════════════════════════════════════════════════════════════════════
describe("honesty (1) — no CMC/LLM keys => deterministic, reproducible signal output", () => {
  it("no keys are set (offline path is the default the backtest + demo run on)", () => {
    expect(cmc.hasLiveKey(), "CMC key must be absent for the deterministic guarantee").to.equal(false);
    expect(!!(process.env.ZAI_API_KEY && process.env.ZAI_API_KEY.trim()), "LLM key absent").to.equal(false);
  });

  it("runDivergence over a real fixture is byte-identical run-to-run (no Date/random/IO)", () => {
    const bars = loadBarsFixture(SYMBOLS[0]).bars;
    const a = runDivergence(bars);
    const b = runDivergence(bars);
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
  });

  it("the full backtest over a real fixture is deterministic (trace + trades + metrics)", () => {
    const bars = loadBarsFixture(SYMBOLS[0]).bars;
    const a = runBacktest(bars, DEFAULT_PARAMS);
    const b = runBacktest(bars, DEFAULT_PARAMS);
    expect(a).to.deep.equal(b);
  });

  it("buildReport over the committed fixtures serializes to identical bytes twice (one lucky run cannot be disguised)", () => {
    const fx = loadAllFixtures();
    const s1 = serializeReport(buildReport(fx, DEFAULT_PARAMS, DEFAULT_OOS_FRACTION));
    const s2 = serializeReport(buildReport(fx, DEFAULT_PARAMS, DEFAULT_OOS_FRACTION));
    expect(s1).to.equal(s2);
  });

  it("an absent CMC advisory is the strict {0,0} no-op (cannot move the conviction)", () => {
    // every adapter mapper returns {0,0} when its metric is unavailable; blendScore({0,0}) is a pass-through.
    const unavail = { ...cmc.NO_METRIC };
    expect(cmc.rsiAdvisory(unavail)).to.deep.equal(cmc.NO_ADVICE);
    expect(cmc.fundingAdvisory(unavail)).to.deep.equal(cmc.NO_ADVICE);
    expect(cmc.fearGreedAdvisory(unavail)).to.deep.equal(cmc.NO_ADVICE);
    expect(cmc.NO_ADVICE).to.deep.equal({ adjustment: 0, confidence: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (2) a fixture marked `_synthetic` is SURFACED, never silently treated as REAL
// ════════════════════════════════════════════════════════════════════════════
describe("honesty (2) — `_synthetic` data is surfaced, never silently passed off as real", () => {
  it("the committed bar fixtures honestly declare their `_synthetic` flag (boolean) + a provenance note", () => {
    for (const symbol of SYMBOLS) {
      const fx = loadBarsFixture(symbol);
      expect(typeof fx._synthetic, `${symbol}._synthetic`).to.equal("boolean");
      expect(fx._note, `${symbol}._note`).to.be.a("string").with.length.greaterThan(0);
      // the note must match the flag: a synthetic fixture LOUDLY says so; a real one says REAL.
      if (fx._synthetic) {
        expect(fx._note.toUpperCase()).to.contain("SYNTHETIC");
        expect(fx._note).to.match(/NOT real|not real market data/i);
      } else {
        expect(fx._note.toUpperCase()).to.contain("REAL");
      }
    }
  });

  it("a SYNTHETIC fixture forces the whole backtest report to kind=SYNTHETIC with a loud note (not REAL)", () => {
    // Build a labelled synthetic fixture in memory and run the REAL report builder over it.
    const startTime = 1_700_000_000_000;
    const synthFix = makeFixture("BTCUSDT", synthSeries("BTCUSDT", startTime, 300), true);
    expect(synthFix._synthetic, "the synthetic fixture must carry _synthetic:true").to.equal(true);

    const report = buildReport([synthFix], DEFAULT_PARAMS, DEFAULT_OOS_FRACTION);
    expect(report.dataSource.kind, "a synthetic fixture must NOT be reported as REAL").to.equal("SYNTHETIC");
    expect(report.dataSource.note.toUpperCase()).to.contain("SYNTHETIC");
    expect(report.dataSource.note).to.match(/NOT real market data/i);
    expect(report.perToken[0].synthetic, "perToken honesty flag").to.equal(true);
  });

  it("a SINGLE synthetic fixture among real ones still flips the report to SYNTHETIC (no silent dilution)", () => {
    const realFix = loadBarsFixture(SYMBOLS[0]);
    expect(realFix._synthetic).to.equal(false);
    const startTime = realFix.startTime;
    const synthFix = makeFixture("ETHUSDT", synthSeries("ETHUSDT", startTime, 300), true);

    const mixed = buildReport([realFix, synthFix], DEFAULT_PARAMS, DEFAULT_OOS_FRACTION);
    expect(mixed.dataSource.kind, "any synthetic fixture must label the WHOLE report SYNTHETIC").to.equal("SYNTHETIC");
    // the per-token flags stay honest: the real one is false, the synthetic one is true
    const flags = mixed.perToken.map((p) => p.synthetic);
    expect(flags).to.include(true);
    expect(flags).to.include(false);
  });

  it("an all-REAL fixture set is honestly reported as REAL (the flag is not hard-wired)", () => {
    const report = buildReport(loadAllFixtures(), DEFAULT_PARAMS, DEFAULT_OOS_FRACTION);
    // committed fixtures are all _synthetic:false, so the report MUST say REAL — proving the
    // SYNTHETIC label above is data-driven, not a constant.
    const allReal = SYMBOLS.every((s) => loadBarsFixture(s)._synthetic === false);
    expect(allReal).to.equal(true);
    expect(report.dataSource.kind).to.equal("REAL");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  (3) every allowed-tool in SKILL.md is backed by a real call + method in cmc.ts
// ════════════════════════════════════════════════════════════════════════════
describe("honesty (3) — every SKILL.md allowed-tool is backed by src/data/cmc.ts", () => {
  // Parse the YAML frontmatter's allowed-tools WITHOUT a yaml dependency (simple list lines).
  function parseAllowedTools(skillMd: string): string[] {
    const fm = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fm, "SKILL.md must have a YAML frontmatter block").to.not.equal(null);
    const lines = fm![1].split(/\r?\n/);
    const start = lines.findIndex((l) => /^allowed-tools:\s*$/.test(l));
    expect(start, "frontmatter must declare an allowed-tools list").to.be.greaterThan(-1);
    const tools: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const item = lines[i].match(/^\s*-\s*(\S+)\s*$/);
      if (item) {
        tools.push(item[1]);
      } else if (/^[A-Za-z]/.test(lines[i])) {
        break; // reached the next top-level key
      }
    }
    return tools;
  }

  // Bare MCP tool name -> exported adapter method that wraps it (documented mapping; the
  // method names are camelCased/abbreviated so they are NOT identical to the tool strings).
  const TOOL_TO_METHOD: Record<string, keyof typeof cmc> = {
    search_cryptos: "searchCryptos",
    get_crypto_quotes_latest: "getQuotes",
    get_crypto_technical_analysis: "getTechnicalAnalysis",
    get_global_metrics_latest: "getGlobalMetrics",
    get_global_crypto_derivatives_metrics: "getDerivatives",
    trending_crypto_narratives: "getTrendingNarratives",
    get_crypto_metrics: "getMetrics",
  };

  const skillMd = fs.readFileSync(SKILL_PATH, "utf8");
  const cmcSrc = fs.readFileSync(CMC_SRC_PATH, "utf8");
  const allowedTools = parseAllowedTools(skillMd);

  // Every callTool("<tool>", ...) literal actually invoked in the adapter source.
  const calledTools = Array.from(cmcSrc.matchAll(/callTool\(\s*["']([a-z_]+)["']/g)).map((m) => m[1]);

  it("SKILL.md declares a non-empty allowed-tools list (all mcp__cmc-mcp__ prefixed)", () => {
    expect(allowedTools.length).to.be.greaterThan(0);
    for (const t of allowedTools) {
      expect(t, `${t} must be an mcp cmc-mcp tool`).to.match(/^mcp__cmc-mcp__[a-z_]+$/);
    }
  });

  it("EVERY allowed-tool is actually CALLED via callTool(...) in src/data/cmc.ts (no advertised-but-unused tool)", () => {
    for (const t of allowedTools) {
      const bare = t.replace(/^mcp__cmc-mcp__/, "");
      expect(
        calledTools.includes(bare),
        `SKILL.md advertises "${t}" but src/data/cmc.ts never calls callTool("${bare}", ...)`
      ).to.equal(true);
    }
  });

  it("EVERY allowed-tool maps to an EXPORTED adapter method in src/data/cmc.ts", () => {
    for (const t of allowedTools) {
      const bare = t.replace(/^mcp__cmc-mcp__/, "");
      const method = TOOL_TO_METHOD[bare];
      expect(method, `no adapter method mapped for tool "${bare}"`).to.not.equal(undefined);
      expect(typeof (cmc as any)[method], `cmc.${String(method)} is not an exported function`).to.equal("function");
    }
  });

  it("the documented tool->method mapping is exhaustive over the allowed-tools (no drift)", () => {
    const bareAllowed = allowedTools.map((t) => t.replace(/^mcp__cmc-mcp__/, "")).sort();
    const mapped = Object.keys(TOOL_TO_METHOD).sort();
    expect(mapped, "TOOL_TO_METHOD must cover exactly the SKILL.md allowed-tools").to.deep.equal(bareAllowed);
  });
});
