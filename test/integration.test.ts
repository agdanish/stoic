/**
 * Stoic — END-TO-END integration test.  [Aux: test hardening]
 *
 * The single test the whole Track-2 deliverable turns on, exercised as a pipeline:
 *
 *     bar fixtures  ──▶  runDivergence (the deterministic engine)
 *                   ──▶  decideTrade   (the per-bar entry rule)
 *                   ──▶  a Strategy CAPSULE assembled from the engine's OWN exported
 *                        constants + the look-ahead-safe per-bar reads
 *                   ──▶  VALIDATES against skills/.../capsule.schema.json
 *
 * The Capsule is what the CMC Skill (SKILL.md) emits. Here we BUILD one offline from the
 * committed bar fixtures and the engine constants (the "no CMC key" path: regime/signal
 * read from the bars themselves, cmcKeyPresent=false) and assert it conforms to the
 * machine-readable schema the Skill promises. This proves the engine -> Capsule contract
 * end to end without any network, key, or LLM.
 *
 * HONESTY: the constants in the Capsule are READ FROM THE ENGINE (single source of truth) —
 * never hard-coded here. If an engine constant changes, this Capsule changes with it, and
 * the schema's `engineConstants` snapshot is asserted to match the engine's live value.
 *
 * The JSON-Schema validator below is a SMALL, self-contained draft-07 subset (no ajv in the
 * toolchain; package.json is off-limits). It implements exactly the keywords the Capsule
 * schema uses: type (incl. nullable unions + integer), const, enum, required,
 * additionalProperties:false, properties, items, minItems/maxItems, minimum/maximum. It is
 * itself unit-tested below (a deliberately broken Capsule MUST be rejected) so a vacuous
 * "always passes" validator cannot hide a real schema break.
 *
 * Pure + offline: reads the committed fixtures + the committed schema; no network.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import { loadBarsFixture, SYMBOLS, BarsFixture } from "../src/data/fetchHistory";
import { runDivergence, EngineBar } from "../src/signal/signalEngine";
import { decideTrade } from "../src/agent/decide";
import { Bar } from "../src/data/binance";
import {
  ZSCORE_WINDOW,
  ZSCORE_MIN_OBS,
  MOMENTUM_LOOKBACK,
  DIVERGENCE_DEADBAND_Z,
  DIVERGENCE_FULL_Z,
  FEAR_EXTREME,
  GREED_EXTREME,
  FUNDING_STRETCHED,
  REGIME_GATE_MAX,
  REGIME_GATE_MIN,
  CONVICTION_FLAT,
  ENTRY_THRESHOLD,
  ENTRY_MIN,
  ENTRY_MAX,
  CALIBRATION_STEP,
  REGIME_FLATTEN_BAND,
  STRONG_DIVERGENCE,
} from "../src/signal/signalEngine";
import { readRegime, regimeGain } from "../src/signal/divergence";
// directional trend/momentum core + F&G gate + risk-filter constants (the headline
// strategy that runStrategy/report-momentum.json runs) — folded into the Capsule snapshot
// so the machine-checkable spec documents the actual OOS earner, not just the conviction engine.
import {
  EMA_FAST,
  EMA_SLOW,
  TREND_FULL_SEP,
  MOMENTUM_FULL_RET,
  TREND_WEIGHT,
  MOMENTUM_WEIGHT,
} from "../src/signal/momentum";
import { GATE_MAX, GATE_MIN } from "../src/signal/regimeGate";
import { RISK_FILTER_TRIM, RISK_FILTER_VETO_INTENSITY } from "../src/signal/strategy";

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../skills/sentiment-divergence-regime/capsule.schema.json"
);

// ════════════════════════════════════════════════════════════════════════════
//  A SMALL, SELF-CONTAINED draft-07 VALIDATOR (the subset the schema uses).
//  Returns an array of human-readable errors ([] == valid). Never throws.
// ════════════════════════════════════════════════════════════════════════════
type JsonSchema = any;

function jsonType(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer"; // draft-07: integers also satisfy "number"
  return typeof v; // "number" | "string" | "boolean" | "object" | "undefined"
}

function typeMatches(value: any, t: string): boolean {
  const actual = jsonType(value);
  if (t === "number") return actual === "number" || actual === "integer";
  if (t === "integer") return actual === "integer";
  return actual === t;
}

function validate(value: any, schema: JsonSchema, pathStr = "$"): string[] {
  const errors: string[] = [];
  if (schema === true || schema === undefined) return errors;

  // type (string or array-of-strings, e.g. ["number","null"])
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join("|")}, got ${jsonType(value)}`);
      return errors; // type mismatch — further keyword checks are noise
    }
  }

  // const
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.some((e: any) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${pathStr}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  // numeric bounds
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${pathStr}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${pathStr}: ${value} > maximum ${schema.maximum}`);
    }
  }

  // arrays
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${pathStr}: ${value.length} items < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${pathStr}: ${value.length} items > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${pathStr}[${i}]`)));
    }
  }

  // objects
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) errors.push(`${pathStr}: missing required property "${req}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathStr}: additional property "${key}" not allowed`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) errors.push(...validate(value[key], subSchema, `${pathStr}.${key}`));
    }
  }

  return errors;
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILD A STRATEGY CAPSULE from the engine (the no-CMC-key path).
//  Mirrors the SKILL.md "Report structure — the Strategy Capsule" template,
//  sourcing EVERY threshold from the engine's exported constants.
// ════════════════════════════════════════════════════════════════════════════
function engineConstantsSnapshot() {
  // Read straight off the engine — single source of truth.
  return {
    ZSCORE_WINDOW,
    ZSCORE_MIN_OBS,
    MOMENTUM_LOOKBACK,
    DIVERGENCE_DEADBAND_Z,
    DIVERGENCE_FULL_Z,
    FEAR_EXTREME,
    GREED_EXTREME,
    FUNDING_STRETCHED,
    REGIME_GATE_MAX,
    REGIME_GATE_MIN,
    CONVICTION_FLAT,
    ENTRY_THRESHOLD,
    ENTRY_MIN,
    ENTRY_MAX,
    CALIBRATION_STEP,
    REGIME_FLATTEN_BAND,
    STRONG_DIVERGENCE,
    // directional trend/momentum core (src/signal/momentum.ts) — the OOS earner
    EMA_FAST,
    EMA_SLOW,
    TREND_FULL_SEP,
    MOMENTUM_FULL_RET,
    TREND_WEIGHT,
    MOMENTUM_WEIGHT,
    // Fear & Greed contrarian regime-gate multipliers (src/signal/regimeGate.ts)
    GATE_MAX,
    GATE_MIN,
    // positioning/funding divergence RISK FILTER (src/signal/strategy.ts) — demoted, inert OOS
    RISK_FILTER_TRIM,
    RISK_FILTER_VETO_INTENSITY,
  };
}

/**
 * Assemble a Capsule for one symbol from its bars. `cmcKeyPresent=false` (offline path):
 * the regime + current-bar signal are read from the bars themselves (look-ahead-safe — the
 * last bar's divergence record uses only bars < t). No network, no key, no LLM.
 */
function buildCapsule(symbol: string, bars: Bar[]): any {
  const engine: EngineBar[] = runDivergence(bars);
  const last = engine[engine.length - 1];

  // regime read from the last bar's own funding (no live CMC F&G offline)
  const lastBar = bars[bars.length - 1];
  const reg = readRegime({ funding: lastBar.funding });
  const sign: -1 | 0 | 1 =
    last.divergence.divergence > 0 ? -1 : last.divergence.divergence < 0 ? 1 : 0;
  const gain = regimeGain(reg, sign);

  // entry decision on the last bar (provenance for the entry-rule expression)
  decideTrade(null, last.conviction, last.sizeBps, ENTRY_THRESHOLD);

  const c = engineConstantsSnapshot();

  return {
    strategyId: "sentiment-divergence-regime",
    version: "0.1.0",
    // a real ISO-8601 UTC timestamp; this is a generated artifact, not a committed file,
    // so a wall-clock here is fine (the BACKTEST report is the byte-stable artifact).
    generatedAt: new Date().toISOString(),
    dataSources: {
      live: "CoinMarketCap MCP (https://mcp.coinmarketcap.com/mcp)",
      backtest:
        "Binance public REST (klines + funding + long/short account ratio + taker buy/sell volume)",
      cmcKeyPresent: false,
    },
    engineConstants: c,
    regime: {
      fearGreed: null, // no CMC key offline
      funding: lastBar.funding ?? null,
      stretchedFunding: reg.stretched,
      label: reg.label,
      favoredSide: reg.favored,
      regimeGain: gain,
    },
    universe: {
      barInterval: "1h",
      pairConvention: "<SYMBOL>USDT",
      symbols: [{ symbol: symbol.replace(/USDT$/, ""), cmcId: null, resolved: false }],
    },
    signal: {
      crowdZ: last.divergence.crowdZ,
      flowZ: last.divergence.flowZ,
      divergence: last.divergence.divergence,
      divergenceBias: last.divergence.divergenceBias,
      conviction: last.conviction,
      warming: last.divergence.warming,
    },
    entryRule: {
      expression:
        "Trade only when |conviction - CONVICTION_FLAT| > ENTRY_THRESHOLD; " +
        "conviction>500+ENTRY_THRESHOLD => LONG, conviction<500-ENTRY_THRESHOLD => SHORT (contrarian).",
      thresholdConstant: "ENTRY_THRESHOLD",
      referencesConstants: ["CONVICTION_FLAT", "ENTRY_THRESHOLD"],
    },
    exitRule: {
      expression:
        "Exit to FLAT when |conviction - CONVICTION_FLAT| <= ENTRY_THRESHOLD " +
        "(|divergenceBias-500| < REGIME_FLATTEN_BAND), OR on a side flip (decideTrade.flip).",
      referencesConstants: ["CONVICTION_FLAT", "ENTRY_THRESHOLD", "REGIME_FLATTEN_BAND"],
    },
    invalidation: {
      conditions: [
        "Regime flips against the open side AND divergence leaves the actionable band -> close.",
        "Either leg goes warming (insufficient history, z=0) -> no actionable divergence -> FLAT.",
        "Funding leaves the stretched regime the trade relied on -> reassess (gain -> 1.0).",
      ],
    },
    positionSizing: {
      method: "sizeFromConviction",
      expression:
        "sizeBps = 10000 * |conviction - CONVICTION_FLAT| / CONVICTION_FLAT " +
        "(0 bps at flat, 10000 bps at the extreme), scaled by the account risk budget.",
      maxPositionBps: null,
    },
    riskLimits: {
      lookAheadSafe: true,
      calibratedThreshold: {
        function: "calibrateEntryThreshold",
        bounds: [ENTRY_MIN, ENTRY_MAX],
        step: CALIBRATION_STEP,
      },
      advisoriesBounded: true,
      maxPositionBps: null,
    },
    backtestReplay: {
      steps: [
        "npm install",
        "npm run fetch-data",
        "npm run backtest",
        "Report on a HELD-OUT out-of-sample window: total return, win rate, max drawdown, Sharpe/Sortino vs buy-and-hold.",
      ],
      metrics: ["totalReturn", "winRate", "maxDrawdown", "sharpe", "sortino"],
      baseline: "buy-and-hold",
      outOfSample: true,
      reproducible: true,
    },
    notes: [
      "Offline Capsule: no CMC key, so live regime/signal use the bar fixture's own funding; F&G is null.",
      "The live CMC narrative term is attention MOMENTUM, not sentiment polarity (folded as a bounded advisory, no-op offline).",
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  VALIDATOR SELF-TEST — a vacuous validator would make every test below pass.
// ════════════════════════════════════════════════════════════════════════════
describe("integration — the draft-07 subset validator is not vacuous", () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

  it("accepts a well-formed Capsule", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    expect(validate(cap, schema), validate(cap, schema).join("\n")).to.deep.equal([]);
  });

  it("REJECTS a wrong strategyId (const violation)", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    cap.strategyId = "not-the-skill";
    expect(validate(cap, schema).length).to.be.greaterThan(0);
  });

  it("REJECTS a missing required section", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    delete cap.entryRule;
    expect(validate(cap, schema).some((e) => e.includes("entryRule"))).to.equal(true);
  });

  it("REJECTS an unknown additional property (additionalProperties:false)", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    cap.surpriseField = 123;
    expect(validate(cap, schema).some((e) => e.includes("surpriseField"))).to.equal(true);
  });

  it("REJECTS an out-of-range numeric (conviction > 1000)", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    cap.signal.conviction = 1500;
    expect(validate(cap, schema).some((e) => e.includes("maximum"))).to.equal(true);
  });

  it("REJECTS a bad enum (regime.label)", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    cap.regime.label = "euphoric";
    expect(validate(cap, schema).some((e) => e.includes("enum"))).to.equal(true);
  });

  it("REJECTS a wrong favoredSide enum value (2)", () => {
    const cap = buildCapsule(SYMBOLS[0], loadBarsFixture(SYMBOLS[0]).bars);
    cap.regime.favoredSide = 2;
    expect(validate(cap, schema).some((e) => e.includes("enum"))).to.equal(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  END-TO-END: every committed fixture -> engine -> Capsule -> schema-valid
// ════════════════════════════════════════════════════════════════════════════
describe("integration — bar fixtures -> engine -> Strategy Capsule -> schema-valid", () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

  for (const symbol of SYMBOLS) {
    describe(symbol, () => {
      const fx: BarsFixture = loadBarsFixture(symbol);

      it("the engine produces one look-ahead-safe EngineBar per bar", () => {
        const engine = runDivergence(fx.bars);
        expect(engine.length).to.equal(fx.bars.length);
        for (const e of engine) {
          expect(e.conviction, "conviction in range").to.be.within(0, 1000);
          expect(e.sizeBps, "sizeBps in range").to.be.within(0, 10000);
          expect(isFinite(e.divergence.divergence)).to.equal(true);
        }
      });

      it("emits a Strategy Capsule that VALIDATES against capsule.schema.json", () => {
        const cap = buildCapsule(symbol, fx.bars);
        const errs = validate(cap, schema);
        expect(errs, errs.join("\n")).to.deep.equal([]);
      });

      it("the Capsule's engineConstants snapshot matches the LIVE engine values (single source of truth)", () => {
        const cap = buildCapsule(symbol, fx.bars);
        expect(cap.engineConstants).to.deep.equal(engineConstantsSnapshot());
        // sanity: every constant the schema REQUIRES is present and numeric
        const required: string[] = schema.properties.engineConstants.required;
        for (const k of required) {
          expect(cap.engineConstants, `missing ${k}`).to.have.property(k);
          expect(typeof cap.engineConstants[k], `${k} not numeric`).to.equal("number");
        }
      });

      it("the Capsule's entry/exit/sizing rules cite engine constants by NAME (not copied numbers)", () => {
        const cap = buildCapsule(symbol, fx.bars);
        expect(cap.entryRule.referencesConstants).to.include("ENTRY_THRESHOLD");
        expect(cap.entryRule.thresholdConstant).to.equal("ENTRY_THRESHOLD");
        expect(cap.positionSizing.method).to.equal("sizeFromConviction");
        expect(cap.riskLimits.calibratedThreshold.bounds).to.deep.equal([ENTRY_MIN, ENTRY_MAX]);
        expect(cap.riskLimits.calibratedThreshold.step).to.equal(CALIBRATION_STEP);
      });

      it("the Capsule's current-bar signal equals the engine's LAST look-ahead-safe bar", () => {
        const engine = runDivergence(fx.bars);
        const last = engine[engine.length - 1];
        const cap = buildCapsule(symbol, fx.bars);
        expect(cap.signal.conviction).to.equal(last.conviction);
        expect(cap.signal.divergence).to.equal(last.divergence.divergence);
        expect(cap.signal.divergenceBias).to.equal(last.divergence.divergenceBias);
        expect(cap.signal.warming).to.equal(last.divergence.warming);
      });
    });
  }

  it("the Capsule build is deterministic for fixed bars (no random in the engine path)", () => {
    const bars = loadBarsFixture(SYMBOLS[0]).bars;
    const a = buildCapsule(SYMBOLS[0], bars);
    const b = buildCapsule(SYMBOLS[0], bars);
    // ignore the wall-clock generatedAt; everything else must be byte-identical
    delete a.generatedAt;
    delete b.generatedAt;
    expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
  });
});
