/**
 * Stoic — the DRY-RUN Capsule CONSUMER must validate the example, emit a dry-run
 * order, and NEVER sign / NEVER write on-chain.  [Aux: handoff proof]
 *
 * tools/consume-capsule.ts is the machine-checkable demonstration that a
 * Trust-Wallet / BSC agent CAN consume the Strategy Capsule this Skill emits. This
 * test pins the three things that make that demonstration HONEST:
 *
 *   1. It VALIDATES the committed capsule.example.json against the committed
 *      capsule.schema.json (the same draft-07 subset validator the integration
 *      tests use) — and the validator is proven NON-vacuous (a broken capsule is
 *      rejected, and a broken capsule yields a null order).
 *   2. It EMITS a dry-run order (side, sizeBps, regime label, invalidation,
 *      allowlist check) derived from the capsule's OWN fields, and runs the
 *      guardrails.json allowlist check.
 *   3. It NEVER signs and NEVER writes on-chain: the invariants are asserted, the
 *      printed transcript is screamingly labelled DRY-RUN, no positive alpha claim
 *      leaks in, and the x402 path is labelled as an unfunded/unsettled code path.
 *
 * Pure + offline: reads the committed example + schema + guardrails. No network,
 * no key, no LLM, no chain.
 */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import {
  consumeCapsule,
  runFromFiles,
  validate,
  twakPolicyMapping,
  x402DryRunRoute,
} from "../tools/consume-capsule";

const SKILL_DIR = path.resolve(__dirname, "../skills/sentiment-divergence-regime");
const SCHEMA_PATH = path.join(SKILL_DIR, "capsule.schema.json");
const EXAMPLE_PATH = path.join(SKILL_DIR, "capsule.example.json");
const GUARDRAILS_PATH = path.resolve(__dirname, "../guardrails.json");

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, "utf8"));
const guardrails = JSON.parse(fs.readFileSync(GUARDRAILS_PATH, "utf8"));

describe("consume-capsule — DRY-RUN Capsule consumer (honest BSC agent handoff)", () => {
  it("VALIDATES the committed capsule.example.json against capsule.schema.json", () => {
    const errs = validate(example, schema);
    expect(errs, errs.join("\n")).to.deep.equal([]);

    const result = consumeCapsule(example, schema, guardrails);
    expect(result.validationErrors, result.validationErrors.join("\n")).to.deep.equal([]);
    expect(result.order, "an order must be produced for a valid capsule").to.not.equal(null);
  });

  it("the validator is NOT vacuous — a broken capsule is rejected and yields a null order", () => {
    const broken = JSON.parse(JSON.stringify(example));
    broken.strategyId = "not-the-skill"; // const violation
    expect(validate(broken, schema).length).to.be.greaterThan(0);

    const result = consumeCapsule(broken, schema, guardrails);
    expect(result.validationErrors.length).to.be.greaterThan(0);
    expect(result.order, "no order for an invalid capsule").to.equal(null);
    // It must refuse loudly, in DRY-RUN, before any order construction.
    expect(result.lines.some((l) => /FAILED schema validation/.test(l))).to.equal(true);
  });

  it("EMITS a dry-run order: pair, side, sizeBps, regime label, invalidation, allowlist", () => {
    const { order } = consumeCapsule(example, schema, guardrails);
    expect(order).to.not.equal(null);
    const o = order!;

    // pair derived from universe.symbols[0] + pairConvention "<SYMBOL>USDT"
    expect(o.pair).to.equal(`${example.universe.symbols[0].symbol}USDT`);
    expect(o.pair).to.equal("BTCUSDT");

    // side ∈ {LONG, SHORT, FLAT}; sizeBps is a finite, non-negative number
    expect(["LONG", "SHORT", "FLAT"]).to.include(o.side);
    expect(o.sizeBps).to.be.a("number");
    expect(o.sizeBps).to.be.at.least(0);

    // regime label + favoredSide ride along from the capsule's live read
    expect(o.regimeLabel).to.equal(example.regime.label);
    expect(o.favoredSide).to.equal(example.regime.favoredSide);

    // invalidation conditions are copied straight from the capsule (not invented)
    expect(o.invalidation).to.deep.equal(example.invalidation.conditions);
    expect(o.invalidation.length).to.be.greaterThan(0);
  });

  it("the shipped BTC example is FLAT / 0 bps (conviction is at flat / warming) — no fabricated long", () => {
    // RADICAL HONESTY: conviction == CONVICTION_FLAT (500, warming) in the example,
    // so the honest proposed order is FLAT / 0 bps even though the regime is
    // long-favored. We must NOT manufacture a position the conviction can't support.
    expect(example.signal.conviction).to.equal(example.engineConstants.CONVICTION_FLAT);
    const { order } = consumeCapsule(example, schema, guardrails);
    expect(order!.side).to.equal("FLAT");
    expect(order!.sizeBps).to.equal(0);
    // ...but the long-favored regime LABEL still rides along for the operator.
    expect(order!.favoredSide).to.equal(1);
    expect(order!.regimeLabel).to.equal("extreme-fear");
  });

  it("runs the guardrails.json allowlist check (BTCUSDT is allowed; an off-list pair is refused)", () => {
    const allowlist: string[] =
      guardrails.guardrails["3_universeAllowlistAndCompliance"].universeAllowlist;
    expect(allowlist).to.include("BTCUSDT");

    const { order } = consumeCapsule(example, schema, guardrails);
    expect(order!.allowlisted).to.equal(true);

    // An off-allowlist symbol must be flagged not-allowlisted and refused in the transcript.
    const offList = JSON.parse(JSON.stringify(example));
    offList.universe.symbols = [{ symbol: "DOGE", cmcId: 74, resolved: true }];
    const res = consumeCapsule(offList, schema, guardrails);
    expect(res.order!.pair).to.equal("DOGEUSDT");
    expect(res.order!.allowlisted).to.equal(false);
    expect(res.lines.some((l) => /REFUSED/.test(l))).to.equal(true);
  });

  it("NEVER signs and NEVER writes on-chain — invariants + order flags are hard false", () => {
    const result = consumeCapsule(example, schema, guardrails);
    expect(result.invariants.signed).to.equal(false);
    expect(result.invariants.onChainWrite).to.equal(false);
    expect(result.invariants.twakKeyLoaded).to.equal(false);
    expect(result.invariants.x402Settled).to.equal(false);

    expect(result.order!.signed).to.equal(false);
    expect(result.order!.onChainWrite).to.equal(false);
    expect(result.order!.action).to.equal("PROPOSE_VIA_WALLETCONNECT_DRY_RUN");
  });

  it("every printed line is loudly labelled DRY-RUN (no unlabelled execution line)", () => {
    const { lines } = consumeCapsule(example, schema, guardrails);
    // The transcript must SAY 'DRY-RUN' prominently and never imply a live write.
    const blob = lines.join("\n");
    expect(/DRY-RUN: no signing, no Trust Wallet Agent Kit key, no on-chain write\./.test(blob)).to.equal(true);
    expect(blob).to.contain("DRY-RUN: ORDER IT *WOULD* CONSTRUCT");

    // No content line may claim a live/broadcast/signed action. (Divider lines of
    // ═ and blank lines are allowed; everything with letters carries DRY-RUN.)
    const forbidden = [
      /\bbroadcast(ed|ing)?\b/i,
      /\bsigned the (tx|transaction)\b/i,
      // a COMPLETED settlement claim is forbidden; "NOT a funded/settled call" is fine.
      /\bsettlement (?:complete|done|succeeded|confirmed)\b/i,
      /\bon-?chain write (?:complete|done|succeeded)\b/i,
    ];
    for (const re of forbidden) {
      expect(re.test(blob), `transcript must not assert ${re}`).to.equal(false);
    }
  });

  it("x402 is labelled a DRY-RUN, NOT a funded/settled USDC call (no completed-tx claim)", () => {
    const route = x402DryRunRoute();
    expect(route).to.match(/x402 keyless route/i);
    expect(route).to.match(/DRY-RUN/);
    expect(route).to.match(/NOT a funded\/settled USDC call/);
    // The disqualifying claim — a completed paid x402 tx — must never appear.
    expect(/x402 (?:payment|tx|transaction) (?:complete|settled|succeeded)/i.test(route)).to.equal(false);
  });

  it("prints the field-by-field TWAK autonomous-mode policy mapping (safety rows present)", () => {
    const rows = twakPolicyMapping();
    const blob = rows.map((r) => `${r.source} ${r.policy}`).join("\n");

    // drawdown scaler -> spend cap
    expect(/drawdown scaler/i.test(blob) && /SPEND CAP/i.test(blob)).to.equal(true);
    // regime risk-off -> halt / tighten allowlist
    expect(/risk-off/i.test(blob) && /(HALT|TIGHTEN ALLOWLIST)/i.test(blob)).to.equal(true);
    // signal -> WalletConnect propose-and-approve, NOT autonomous signing
    expect(/WALLETCONNECT PROPOSE-AND-APPROVE/i.test(blob)).to.equal(true);
    expect(/NOT autonomous signing/i.test(blob)).to.equal(true);
    // kill switch at the 30% disqualify line
    expect(/KILL SWITCH/i.test(blob) && /30%/.test(blob)).to.equal(true);

    // the mapping must also be emitted in the printed transcript
    const { lines } = consumeCapsule(example, schema, guardrails);
    expect(lines.some((l) => /autonomous-mode policy/i.test(l))).to.equal(true);
    expect(lines.some((l) => /WALLETCONNECT PROPOSE-AND-APPROVE/i.test(l))).to.equal(true);
  });

  it("self-discloses the honest gaps (NOT alpha, 2-of-7, no TWAK key, no on-chain write)", () => {
    const { lines } = consumeCapsule(example, schema, guardrails);
    const blob = lines.join("\n");
    expect(blob).to.contain("NOT alpha");
    expect(blob).to.contain("-0.32%");
    expect(blob).to.contain("58.3%");
    expect(blob).to.contain("17.7%");
    expect(/2-of-7/.test(blob)).to.equal(true);
    expect(/NO Trust Wallet Agent Kit key/i.test(blob)).to.equal(true);
    expect(/NO BNB AI Agent SDK call/i.test(blob)).to.equal(true);

    // Never a POSITIVE alpha/edge claim anywhere in the transcript.
    const forbiddenPositive = [
      /\bbeats buy-?and-?hold\b/i,
      /\bgenerates? alpha\b/i,
      /\bhas (?:an? )?edge\b/i,
    ];
    for (const re of forbiddenPositive) {
      expect(re.test(blob), `transcript must not assert ${re}`).to.equal(false);
    }
  });

  it("runFromFiles() reads the committed artifacts and validates green end to end", () => {
    const result = runFromFiles();
    expect(result.validationErrors).to.deep.equal([]);
    expect(result.order).to.not.equal(null);
    expect(result.order!.signed).to.equal(false);
    expect(result.order!.onChainWrite).to.equal(false);
  });

  it("tools/consume-capsule.ts imports NO signer/RPC/wallet/http client (no-sign by construction)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../tools/consume-capsule.ts"),
      "utf8"
    );
    // There is nothing to sign WITH: no ethers/web3/wallet/RPC/fetch import exists.
    const bannedImports = [
      /from ["']ethers["']/,
      /from ["']web3["']/,
      /require\(["']ethers["']\)/,
      /from ["']@trustwallet\//,
      /from ["']node-fetch["']/,
      /\bnew ethers\./,
      /\.sendTransaction\(/,
      /\.signTransaction\(/,
      /\.broadcast\(/,
    ];
    for (const re of bannedImports) {
      expect(re.test(src), `consume-capsule.ts must not contain ${re}`).to.equal(false);
    }
  });
});
