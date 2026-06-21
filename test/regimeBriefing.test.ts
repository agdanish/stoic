/**
 * Stoic — CMC regime briefing CLASSIFIER tests (pins the deterministic labels).
 *
 * backtest/cmc-regime-briefing.ts promotes the old flat `derivedStance` string-join into a
 * PURE deterministic classifier (`classifyRegime`) that maps the 7-tool reads to ONE label
 * from a fixed enum, deciding the label using ONLY the two decision-relevant legs
 * (Fear & Greed GATE primary, RSI advisory secondary) against the real engine constants
 * FEAR_EXTREME / GREED_EXTREME. The five context legs become `notes`, never the label.
 *
 * HONESTY: these tests pin the LABEL boundaries and prove the context legs do NOT move the
 * label — they do not claim the classifier is alpha or that it feeds the committed decision.
 * It is a regime DESCRIPTION; only the F&G gate + RSI feed the shipped backtest.
 */
import { expect } from "chai";
import { classifyRegime } from "../backtest/cmc-regime-briefing";
import { FEAR_EXTREME, GREED_EXTREME } from "../src/signal/regimeGate";

/** Minimal context-free inputs (only the two decision-relevant legs set). */
function inputs(fearGreed: number | null, rsi: number | null = null) {
  return {
    fearGreed,
    rsi,
    fundingStretched: false,
    dominance: null,
    narrativeLeader: null,
  };
}

describe("cmc regime briefing — deterministic classifier (classifyRegime)", () => {
  it("extreme fear (F&G <= FEAR_EXTREME) -> BEAR_CAPITULATION_FAVOUR_LONG", () => {
    const c = classifyRegime(inputs(FEAR_EXTREME)); // boundary: <= is inclusive
    expect(c.label).to.equal("BEAR_CAPITULATION_FAVOUR_LONG");
    expect(c.because).to.contain(`<= FEAR_EXTREME=${FEAR_EXTREME}`);
    const deep = classifyRegime(inputs(10));
    expect(deep.label).to.equal("BEAR_CAPITULATION_FAVOUR_LONG");
  });

  it("extreme greed without overbought RSI -> GREED_TRIM", () => {
    const c = classifyRegime(inputs(GREED_EXTREME, 55)); // boundary: >= inclusive, RSI < 70
    expect(c.label).to.equal("GREED_TRIM");
    expect(c.because).to.contain(`>= GREED_EXTREME=${GREED_EXTREME}`);
    // RSI null in extreme greed must still be a plain GREED_TRIM (no fabricated overbought).
    expect(classifyRegime(inputs(90, null)).label).to.equal("GREED_TRIM");
  });

  it("extreme greed AND RSI overbought (>=70) -> RISK_OFF_CROWDED_LONG", () => {
    const c = classifyRegime(inputs(85, 72));
    expect(c.label).to.equal("RISK_OFF_CROWDED_LONG");
    expect(c.because).to.contain("overbought");
  });

  it("neutral F&G -> NEUTRAL_PASS_THROUGH; missing F&G -> UNKNOWN_INSUFFICIENT_DATA", () => {
    expect(classifyRegime(inputs(50)).label).to.equal("NEUTRAL_PASS_THROUGH");
    // Just inside each band edge stays neutral (strict extremes are <=/>=).
    expect(classifyRegime(inputs(FEAR_EXTREME + 1)).label).to.equal("NEUTRAL_PASS_THROUGH");
    expect(classifyRegime(inputs(GREED_EXTREME - 1)).label).to.equal("NEUTRAL_PASS_THROUGH");
    expect(classifyRegime(inputs(null)).label).to.equal("UNKNOWN_INSUFFICIENT_DATA");
  });

  it("context legs (funding/dominance/narratives) become NOTES and never change the label", () => {
    const bare = classifyRegime(inputs(50));
    const loaded = classifyRegime({
      fearGreed: 50,
      rsi: 80, // RSI overbought is IGNORED when F&G is neutral (gate is primary)
      fundingStretched: true,
      dominance: 58.26,
      narrativeLeader: "Binance Ecosystem",
    });
    // Same decision label despite loaded context + overbought RSI:
    expect(loaded.label).to.equal(bare.label).and.to.equal("NEUTRAL_PASS_THROUGH");
    // ...but the context surfaced as honest notes:
    expect(loaded.notes.some((n) => n.includes("funding"))).to.equal(true);
    expect(loaded.notes.some((n) => n.includes("dominance"))).to.equal(true);
    expect(loaded.notes.some((n) => n.includes("Binance Ecosystem"))).to.equal(true);
    expect(bare.notes).to.have.length(0);
  });
});
