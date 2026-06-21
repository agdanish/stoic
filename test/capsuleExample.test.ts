/**
 * Stoic — the SHIPPED example Capsule must be schema-valid.  [Aux: deliverable proof]
 *
 * skills/sentiment-divergence-regime/capsule.example.json is a real, filled-in Strategy
 * Capsule for BTC — the concrete artifact the CMC Skill (SKILL.md) promises to emit. It is
 * a COMMITTED file (unlike integration.test.ts, which BUILDS a Capsule offline from the bar
 * fixtures), so this test pins that the committed example:
 *
 *   1. VALIDATES against the committed capsule.schema.json (the same draft-07 subset
 *      validator integration.test.ts uses — re-implemented here, self-contained, so this
 *      file stands alone and a vacuous validator cannot hide a real schema break).
 *   2. carries the FULL engineConstants set the CURRENT schema requires (all 27 names),
 *      every value numeric.
 *   3. tells the HONEST headline story: the OOS aggregate is a small LOSS (-0.32%), the
 *      strategy HALVES max drawdown vs buy-and-hold (17.7% vs 58.3%) — a drawdown overlay,
 *      never alpha. Those numbers are asserted to TIE to the committed
 *      backtest/report-momentum.json (no copied-then-drifted constants).
 *
 * Pure + offline: reads the committed example + the committed schema + the committed report;
 * no network, no key, no LLM.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const SKILL_DIR = path.resolve(__dirname, "../skills/sentiment-divergence-regime");
const SCHEMA_PATH = path.join(SKILL_DIR, "capsule.schema.json");
const EXAMPLE_PATH = path.join(SKILL_DIR, "capsule.example.json");
const REPORT_PATH = path.resolve(__dirname, "../backtest/report-momentum.json");

// ════════════════════════════════════════════════════════════════════════════
//  A SMALL, SELF-CONTAINED draft-07 VALIDATOR (the subset the schema uses).
//  Same subset as test/integration.test.ts: type (incl. nullable unions + integer),
//  const, enum, required, additionalProperties:false, properties, items,
//  minItems/maxItems, minimum/maximum. Returns [] when valid; never throws.
// ════════════════════════════════════════════════════════════════════════════
type JsonSchema = any;

function jsonType(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer"; // draft-07: integers also satisfy "number"
  return typeof v;
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

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join("|")}, got ${jsonType(value)}`);
      return errors;
    }
  }

  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e: any) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${pathStr}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${pathStr}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${pathStr}: ${value} > maximum ${schema.maximum}`);
    }
  }

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

describe("capsule.example.json — the shipped BTC example Capsule", () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, "utf8"));

  it("the validator is NOT vacuous (a deliberately broken copy is rejected)", () => {
    const broken = JSON.parse(JSON.stringify(example));
    broken.strategyId = "not-the-skill"; // const violation
    expect(validate(broken, schema).length).to.be.greaterThan(0);
  });

  it("VALIDATES against the committed capsule.schema.json", () => {
    const errs = validate(example, schema);
    expect(errs, errs.join("\n")).to.deep.equal([]);
  });

  it("carries the FULL engineConstants set the schema requires (all 27, every value numeric)", () => {
    const required: string[] = schema.properties.engineConstants.required;
    expect(required.length, "schema must require 27 engineConstants").to.equal(27);
    for (const k of required) {
      expect(example.engineConstants, `missing ${k}`).to.have.property(k);
      expect(typeof example.engineConstants[k], `${k} not numeric`).to.equal("number");
    }
    // no EXTRA constants beyond what the schema names (additionalProperties:false would
    // already reject this in validate(), but pin it explicitly as a contract).
    expect(Object.keys(example.engineConstants).sort()).to.deep.equal([...required].sort());
  });

  it("cites the trend/momentum core + F&G gate constants by NAME in the entry rule (no copied numbers)", () => {
    expect(example.entryRule.thresholdConstant).to.equal("ENTRY_THRESHOLD");
    for (const name of ["EMA_FAST", "EMA_SLOW", "TREND_WEIGHT", "MOMENTUM_WEIGHT", "GATE_MAX", "GATE_MIN"]) {
      expect(example.entryRule.referencesConstants, `entryRule should cite ${name}`).to.include(name);
    }
  });

  it("the regime mirrors the committed live capture (F&G=23 extreme-fear, stretched funding, long-favored)", () => {
    expect(example.regime.fearGreed).to.equal(23);
    expect(example.regime.funding).to.equal(0.0006212);
    expect(example.regime.label).to.equal("extreme-fear");
    expect(example.regime.favoredSide).to.equal(1);
    expect(example.regime.stretchedFunding).to.equal(true);
    // funding above FUNDING_STRETCHED is what makes stretchedFunding true — tie it to the constant.
    expect(Math.abs(example.regime.funding)).to.be.greaterThan(example.engineConstants.FUNDING_STRETCHED);
    // F&G at/below FEAR_EXTREME is what makes the label extreme-fear.
    expect(example.regime.fearGreed).to.be.at.most(example.engineConstants.FEAR_EXTREME);
  });

  it("tells the HONEST headline OOS story (drawdown overlay, NOT alpha) and ties it to report-momentum.json", () => {
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
    const oos = report.aggregate.outOfSample;

    // Ground truth from the committed report: a small LOSS, drawdown roughly halved vs B&H.
    expect(oos.totalReturn).to.be.lessThan(0); // -0.32% — a LOSS, never alpha
    expect(Math.round(oos.totalReturn * 10000) / 100).to.be.closeTo(-0.32, 0.01); // -0.32%
    expect(Math.round(oos.maxDrawdown * 1000) / 10).to.equal(17.7); // 17.7%
    expect(Math.round(oos.buyAndHoldMaxDrawdown * 1000) / 10).to.equal(58.3); // 58.3%
    expect(oos.maxDrawdown).to.be.lessThan(oos.buyAndHoldMaxDrawdown); // overlay HALVES drawdown

    // The example's notes must surface those exact figures and must NOT claim alpha/edge.
    const notesBlob = (example.notes as string[]).join("\n");
    expect(notesBlob).to.contain("-0.32%");
    expect(notesBlob).to.contain("17.7%");
    expect(notesBlob).to.contain("58.3%");
    // RADICAL HONESTY: the notes may NEGATE alpha/edge ("NOT alpha", "not an edge", "not
    // claimed as drivers"), but must never make a POSITIVE alpha claim. Pin the forbidden
    // positive phrasings explicitly (negations are allowed; bare boasts are not).
    const forbiddenPositiveClaims = [
      /\bbeats buy-?and-?hold\b/i,
      /\bout-?earns? buy-?and-?hold\b/i,
      /\bgenerates? alpha\b/i,
      /\bhas (?:an? )?edge\b/i,
      /\bis (?:an? )?(?:driver|edge)\b/i,
    ];
    for (const re of forbiddenPositiveClaims) {
      expect(re.test(notesBlob), `notes must not assert "${re}"`).to.equal(false);
    }
  });
});
