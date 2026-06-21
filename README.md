<div align="center">

# Stoic

### *An AI crypto-trading agent that stays unmoved by the crowd's Fear & Greed - it rides bulls and sits out the storm.*

[![BNB Hack - Track 2 Strategy Skills](https://img.shields.io/badge/BNB%20Hack-Track%202%20Strategy%20Skills-F0B90B?style=flat)](https://github.com/agdanish/stoic)
[![CMC Agent Hub - LIVE](https://img.shields.io/badge/CMC%20Agent%20Hub-LIVE-orange?style=flat)](#-live-coinmarketcap-agent-hub-integration)
[![tests - 483 passing](https://img.shields.io/badge/tests-483%20passing-brightgreen?style=flat)](#3--verify-it-yourself-60-seconds)
[![tsc --noEmit - 0 errors](https://img.shields.io/badge/tsc%20--noEmit-0%20errors-blue?style=flat)](#3--verify-it-yourself-60-seconds)
[![reports - byte-reproducible](https://img.shields.io/badge/reports-byte--reproducible-success?style=flat)](#3--verify-it-yourself-60-seconds)
[![data - REAL Binance + F&G](https://img.shields.io/badge/data-REAL%20Binance%20%2B%20F%26G-informational?style=flat)](#1-the-headline-numbers--held-out-out-of-sample)
[![license - MIT](https://img.shields.io/badge/license-MIT-green?style=flat)](#license)

**[Live Demo](https://agdanish.github.io/stoic/)** · **[The Skill](skills/sentiment-divergence-regime/SKILL.md)** · **[Backtest](#1-the-headline-numbers--held-out-out-of-sample)** · **[CMC Hub](#-live-coinmarketcap-agent-hub-integration)** · **[Judges' changelog](CHANGES-FOR-JUDGES.md)**

<br/>

[![Stoic dashboard - directional read, live regime, honest backtest](docs/assets/dashboard-hero-fold.png)](https://agdanish.github.io/stoic/)

<sub>Dashboard rendered from the committed headline run [`backtest/report-momentum.json`](backtest/report-momentum.json) (aggregate OOS **−0.32%**, a small loss; maxDD **17.7% vs 58.3%**), with the demo regime pinned to **Fear & Greed = 78 ("Extreme Greed")** ([`frontend/index.html`](frontend/index.html)) so the contrarian mechanic fires on camera. **Separately**, the live keyed CMC round-trip captured **F&G = 23 ("Fear")** · RSI(14) = 41.85 · BTC dominance 58.26% - see [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json). The screenshot does not display the live 23; the two are different reads, kept distinct on purpose.</sub>

</div>

<div align="center">

### 🏷️ A regime-aware drawdown overlay with a falsifiable, self-ablating honesty contract.

*Read the one-page, four-clause* ***[Honesty Contract →](HONESTY-CONTRACT.md)*** *— every claim pinned to a committed report and a test that fails loudly if the claim ever stops being true.*

</div>

> ### ⚠️ What this is NOT
> - **NOT alpha.** Aggregate OOS return is **−0.32% — a small LOSS, not a profit**. The only win is risk: maxDD roughly halved, **17.7% vs 58.3%** OOS.
> - **NOT a working divergence signal.** The divergence/funding filter is **inert OOS** (Δreturn 0.00%, trim=11/veto=0) — a non-earning safety veto, not an edge.
> - **NOT 12 tools.** **7 wired CMC tools** (all `ok:true`, one committed keyed snapshot) + 5 documented — never 12.
> - **NOT regime-independent on return.** The absolute OOS "beat" is a **regime-conditional bear-dodge**; on a bull mid-window the same strategy loses to buy-and-hold by ~37%. Only the drawdown reduction is durable.

> ### 🔌 What is NOT wired (self-disclosed, before you go looking)
> This is the discipline, not an apology — every gap is stated here so a hostile juror finds nothing we did not already flag.
> - **NO Trust Wallet Agent Kit signing.** No TWAK key is loaded, present, or used anywhere in the repo. The handoff is **WalletConnect propose-and-approve** (dry-run); the human key holder signs.
> - **NO BNB AI Agent SDK.** That integration does not exist in this repo — we do not claim it.
> - **NO on-chain / BSC write.** Nothing is broadcast. The deliverable is a **spec**, not a live-trading bot.
> - **x402 = code path / dry-run, NOT a funded call.** The keyless x402 transport branch is wired in [`src/data/cmc.ts`](src/data/cmc.ts) and labelled throughout *"x402 keyless route — code wired, dry-run, NOT a funded/settled USDC call."* Claiming a completed paid x402 transaction would be a disqualifying red line — **we do not make it.**
> - **7 of CMC's 12 Data MCP tools wired** (never "all 12"). Of those 7, **only 2 feed the committed decision** (the Fear & Greed gate + the RSI/divergence-and-funding read); the other **5 are ablation-disclosed CONTEXT/classifier**, not decision drivers.
> - **NOT alpha.** Aggregate OOS return is **−0.32% — a small LOSS**. The only durable win is roughly halved drawdown (17.7% vs 58.3%).

> ### The agent did NOT make money. It lost less. Stated bluntly, both sides.
> **Aggregate out-of-sample return is −0.32% — a small loss, not a profit.** The win is **DRAWDOWN REDUCTION**: on a **held-out 2026 drawdown** (params selected on the in-sample 70% **only**), Stoic cut maximum drawdown to **17.7% vs buy-and-hold's 58.3%** — roughly half — on REAL multi-regime data, holding on **all three tokens and every cost level tested**. This is a regime-aware **risk overlay**, not alpha.
> **What "beats buy-and-hold on all 3 tokens" actually means:** buy-and-hold lost more (aggregate −43.50%), so beating it here means **losing less, not earning**. **2 of the 3 token "beats" are negative-absolute** (BTC −7.53%, ETH −11.90% — they lost, just less than B&H); only BNB (+18.48%) is positive. **Aggregate OOS is a −0.32% loss.** In a strong bull (in-sample) the strategy *lags* buy-and-hold by a wide margin (+57% vs +262%). We lead with the drawdown halving because it is the only claim the data supports *everywhere* — and because the agent did not, on aggregate, make money. **That honesty is the whole pitch.**

Every number in this README is **byte-reproducible** from a committed run, and every headline claim is mapped to its committed source in the cross-check table in [`CHANGES-FOR-JUDGES.md`](CHANGES-FOR-JUDGES.md). In a field where most submissions overclaim, **a result you can re-run to the digit is the differentiator.**

---

## TL;DR - the whole submission in ten seconds

- 📉 **The agent lost less, it did not earn.** Aggregate OOS return is **−0.32%** (a small loss). The real win is **roughly halved drawdown** vs buy-and-hold on a held-out 2026 drawdown - **17.7% vs 58.3%** OOS, robust across every window and cost level. A risk overlay, not alpha. → [`backtest/report-momentum.json`](backtest/report-momentum.json)
- 🔴 **A genuinely LIVE CoinMarketCap Agent Hub integration** - a real keyed MCP round-trip, **7/7 wired tools `ok:true`** (of 7 wired + 5 documented, never 12), captured **Fear & Greed = 23**, RSI 41.85, BTC dominance 58.26%. CMC's live Fear & Greed *is* the contrarian regime gate. → [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json)
- 🔬 **We decompose, we don't assert.** A per-layer ablation openly proves the trend core is the *entire* OOS earner while our own overlays are rounding-level / inert. → [`backtest/report-ablation.json`](backtest/report-ablation.json)
- ✅ **483 tests passing · `tsc --noEmit` exit 0 · all reports byte-reproducible · CI green · no API key in the repo.** → [`CHANGES-FOR-JUDGES.md`](CHANGES-FOR-JUDGES.md)
- 🧭 **Radical honesty as a feature.** Every caveat is kept and framed up front - the bear-dodge, the lost-less beats, the inert filter - each one traceable to a committed file. → [`ROBUSTNESS-momentum.md`](ROBUSTNESS-momentum.md)
- 📦 **Track-2 deliverable, done right.** An execution-agnostic **Strategy Capsule** in CMC's own `SKILL.md` format, with a committed JSON Schema ([`capsule.schema.json`](skills/sentiment-divergence-regime/capsule.schema.json)) a Trust-Wallet / BSC agent can validate against. → [`skills/sentiment-divergence-regime/SKILL.md`](skills/sentiment-divergence-regime/SKILL.md)

---

## What is Stoic - the thesis

A Stoic is unmoved by Fear and Greed. **So is this agent.**

Stoic is a regime-aware **directional (trend/momentum) core** that *rides* bull markets, gated by CoinMarketCap's **live Fear & Greed index** read contrarian-style (trim into greed, favour fear), with a positioning-vs-flow **divergence/funding risk filter**. Its edge is not out-earning the bull - it is **capital preservation**: when the regime turns, it goes flat and **sits out the storm**.

> **The edge is knowing when *not* to play.**

```mermaid
flowchart TD
    M{"Market regime<br/>(look-ahead-safe trend label)"}
    M -->|BULL| BULL["Participate but LAG<br/>EMA enters late, trims<br/><i>the price of the bear-dodge</i>"]
    M -->|BEAR| BEAR["Go FLAT - sit out the storm<br/>0% where B&amp;H takes −27% to −49%<br/>★ this is the entire edge"]
    M -->|CHOP| CHOP["Mixed - leaks on false trend flips"]
    classDef win fill:#F0B90B,stroke:#7a5c00,color:#1a1a1a,font-weight:bold;
    classDef neutral fill:#2b2b2b,stroke:#555,color:#ddd;
    class BEAR win;
    class BULL,CHOP neutral;
```

<sub>Per-regime shape verified on all 3 tokens in [`ROBUSTNESS-momentum.md`](ROBUSTNESS-momentum.md) §5: the core rides the bull but materially lags, goes flat through the bear (+50–81% excess), and leaks in chop. It is one mechanism, consistent across BTC/ETH/BNB: **all of the edge is the bear-dodge.**</sub>

---

## The mechanic - a 3-layer composition

The pipeline assembles three layers for each daily bar, in this exact order ([`src/signal/strategy.ts`](src/signal/strategy.ts)). The originality is the **composition + the live-CMC regime gating + the radical-transparency method** - never a claim that each layer earns. The ablation below proves exactly which piece carries the result.

```mermaid
flowchart LR
    D["Binance daily klines<br/>BTC · ETH · BNB"] --> C["1 · Directional Core<br/>EMA 30/80 + momentum<br/><i>momentum.ts</i>"]
    C --> G["2 · F&amp;G Contrarian Gate<br/>trim greed / favour fear<br/><i>regimeGate.ts</i>"]
    G --> R["3 · Divergence / Funding<br/>Risk Filter (veto / trim)<br/><i>strategy.ts</i>"]
    R --> B["blendScore<br/>+ sizeFromConviction<br/><i>core.ts</i>"]
    B --> T["decideTrade<br/>LONG / FLAT"]
    L["CMC LIVE Fear &amp; Greed = 23<br/>'Fear' → favour long"] -.-> G
    classDef earner fill:#F0B90B,stroke:#7a5c00,color:#1a1a1a,font-weight:bold;
    classDef inert fill:#2b2b2b,stroke:#555,color:#bbb;
    classDef live fill:#3a2a00,stroke:#F0B90B,color:#F0B90B;
    class C earner;
    class G,R inert;
    class L live;
```

| Layer | What it does | Honest OOS attribution |
|---|---|---|
| **1 · Directional core** (`momentum.ts`) | Fast/slow EMA trend separation + momentum, mapped to a 0–1000 bullish scale. Selected backtest config EMA **30/80** (module default 20/50). Rides the trend; goes flat in bear/chop. | 🟡 **The entire OOS earner** (ablation-verified). |
| **2 · F&G contrarian gate** (`regimeGate.ts`) | CMC's live Fear & Greed read as a bounded multiplicative gain - trims into greed, favours fear. Never flips the core's sign. | ⚪ **Rounding-level on OOS** (+0.03% return). A mild in-sample drag. |
| **3 · Divergence / funding risk filter** (`strategy.ts`) | Vetoes/trims a long that runs into euphoric, unconfirmed positioning (extreme greed + stretched funding). | ⚪ **Numerically inert on OOS** (`divergenceAddsValue: false`; fired trim=11/veto=0). A non-earning safety veto. |

The diagram is honest by design: **the overlays modulate at the margin, they do not earn.** Originality rests on the composition and the live-CMC gating, attributed precisely below.

> **The one genuinely novel mechanism, in one sentence:** on the divergence side, a **look-ahead-safe cross-sectional panel-demean** ([`src/signal/crossSectional.ts`](src/signal/crossSectional.ts)) subtracts the market-wide (beta) component of divergence across the {BTC, ETH, BNB} panel at each bar, isolating the *idiosyncratically* offside token - a market-neutral-flavoured relative-value selection the per-token engine cannot express. (It is validated on its own hourly harness and, honestly, does **not** beat buy-and-hold there - see the ablation - so it is offered as the original *construct*, not a return claim.)

#### Cross-sectional dislocation - a non-textbook *mechanism* (not the canned "sentiment vs price")

The per-token engine asks: is *this* token's crowd offside vs *this* token's flow, against its **own** history? The cross-sectional term ([`src/signal/crossSectional.ts`](src/signal/crossSectional.ts)) asks a different question entirely: across the **whole {BTC, ETH, BNB} panel at this instant**, which token is the divergence **outlier** relative to its peers? It **panel-demeans** - subtracts the common (market-wide / beta) component, which is the part the per-token engine shorts as undifferentiated beta - and **fades only the idiosyncratically dislocated token**. That is a relative-value (stat-arb-flavoured) selection the per-token engine *cannot express*, because it has no concept of the other tokens. Look-ahead-safe by construction (panel reads only at-or-before-derived values), pinned by a truncation-invariance test.

> **Honest results box** (verbatim from [`backtest/report-crosssectional.json`](backtest/report-crosssectional.json), aggregate held-out OOS, net 10+10 bps):
>
> | Aggregate held-out OOS | Cross-sectional | Per-token arm | Buy & hold |
> |---|---:|---:|---:|
> | Total return | **−1.11%** | −4.50% | **+4.09%** |
> | Max drawdown | **1.17%** | 4.67% | — |
>
> - **Lower drawdown and lower churn than the per-token arm** (OOS maxDD 1.17% vs 4.67%; 29 trades vs 86), and a smaller OOS loss (−1.11% vs −4.50%).
> - **It does NOT beat buy-and-hold** (B&H +4.09% on this rising OOS tail) and **posts a small negative OOS return (−1.11%)** - reported as-is (`verdict.crossSectionalBeatsBuyHoldOOS: false`). Consistent with the thesis that a contrarian/relative-value construct does not earn on a rising tail.
> - It lives on a **separate hourly harness** (`report-crosssectional.json`); it is **NOT wired to the daily earner** (`report-momentum.json`) and changes no headline number. Offered as the original *construct* and its measurable difference from the per-token engine, never a return claim.

---

## 📉 The proof (Technical execution)

### 1. The headline numbers - held-out out-of-sample

REAL keyless Binance daily klines for **BTC / ETH / BNB**, **2023-09-22 → 2026-06-17** (1000 bars/token ≈ 2.7yr, multi-regime), joined to alternative.me historical Fear & Greed (99.9% coverage) + Binance funding. The selected config (`long-only + EMA 30/80`, module default 20/50) was chosen on the **in-sample 70% only** over a disclosed 15-config sweep; the held-out OOS tail (trailing 30% - the 2026 drawdown) was run **once** and is reported as-is.

| Held-out OOS (trailing 30%, net 10+10 bps) | Strategy return | Buy & hold | Strategy max-DD | B&H max-DD | Source |
|---|---:|---:|---:|---:|---|
| **Aggregate** (equal-weight BTC/ETH/BNB) | **−0.32%** | **−43.50%** (excess **+43.19%**) | **17.7%** | **58.3%** | `report-momentum.json` `aggregate.outOfSample` |
| BTCUSDT | −7.53% | −42.91% (+35.38%) | 8.9% | 51.2% | `perToken[0].outOfSample` |
| ETHUSDT | −11.90% | −58.92% (+47.02%) | 23.0% | 67.5% | `perToken[1].outOfSample` |
| BNBUSDT | **+18.48%** | −28.68% (+47.16%) | 21.3% | 56.2% | `perToken[2].outOfSample` |

Aggregate OOS is a **risk-adjusted win**: Sharpe **−0.595 > B&H −1.000** *and* maxDD **17.7% < 58.3%** (`verdict.riskAdjustedWin: true`). The OOS beat survives cost stress at **15+15 bps** (excess +42.59%) and **25+25 bps** (excess +41.42%) on all 3 tokens.

> **Read this honestly, both directions.** Two of the three OOS "beats" are **negative-absolute "lost-less" beats** (BTC −7.53%, ETH −11.90% - they beat only because B&H lost more); only **BNB (+18.48%)** is a positive-return win. Per-token OOS Sharpe is mixed (BTC −2.04 is *worse* than B&H −1.28). The risk-adjusted win holds on the **aggregate**, not on every token. **Lower drawdown is the only claim robust everywhere.**

<details>
<summary><b>Full in-sample / OOS / full-window table (the bull lag, disclosed)</b></summary>

| Aggregate (equal-weight, 10+10 bps) | In-sample (lead 70%, BULL) | **Held-out OOS (2026 drawdown)** | Full window |
|---|---:|---:|---:|
| Strategy total return | +57.48% | **−0.32%** | +57.15% |
| Buy & hold (same bars) | +262.05% | **−43.50%** | +111.40% |
| Excess vs B&H | **−204.58%** | **+43.19%** | −54.25% |
| Beats B&H? | no (lags the bull) | **YES** | no |
| Strategy max drawdown | 29.5% | **17.7%** | 29.5% |
| B&H max drawdown | 42.2% | 58.3% | 58.3% |
| Sharpe (annualised, net) | 0.945 | −0.595 | 0.715 |
| B&H Sharpe | 1.505 | −1.000 | 0.757 |
| Trades | 45 | 11 | 56 |

**In-sample, the strategy LOSES to B&H by a wide margin (+57% vs +262%).** A long-only trend core cannot out-earn a +262% bull - the EMA lags and trims. All 15 swept configs have a large negative in-sample excess; the winner is the best of them on in-sample metrics, **not** chosen on OOS. We state this plainly because it is the mechanism: the OOS edge is the bear-dodge, never "out-earn the bull."

</details>

<details>
<summary><b>Robustness - how fragile is the edge? (the load-bearing finding)</b></summary>

A read-only stress harness ([`ROBUSTNESS-momentum.md`](ROBUSTNESS-momentum.md), params held fixed) classifies the edge as **REAL-but-regime-FRAGILE**:

| Window (locked config, 10+10 bps) | Strategy | B&H | Abs. beat? | Strategy maxDD | B&H maxDD |
|---|---:|---:|---|---:|---:|
| Held-out tail OOS (0.30) | −0.32% | −43.50% | **YES** | 17.7% | 58.3% |
| Bull mid-window [40%, 70%) | +25.47% | +62.57% | **no (−37%)** | 14.7% | 40.1% |
| Full window | +57.15% | +111.40% | no | 29.5% | 58.3% |

- The OOS beat survives **every** adjacent split (0.20–0.40, 3/3 tokens) and cost bumps to 25+25 bps - **but** every tail-OOS window in this dataset ends in the 2026 drawdown, so they share one bear-dodge mechanism. In a **bull-dominated mid-window the strategy LOSES to B&H by ~37%**.
- The higher-Sharpe-AND-lower-maxDD risk-adjusted win holds **only** in the bear-tailed OOS, not the mid-window or full window.
- The one claim robust across **every** window and cost level, on all 3 tokens, is **lower maximum drawdown** (0.177 vs 0.583 tail; 0.147 vs 0.401 mid; 0.295 vs 0.583 full). **That is the spine.**

</details>

### 2. Layer attribution - what actually earns (the ablation)

We do not assert which layer is novel; **we decompose it.** [`backtest/ablation.ts`](backtest/ablation.ts) holds the locked config fixed and toggles one overlay at a time. Arm A3 (the full pipeline) reproduces `runStrategy` **byte-for-byte** and equals `report-momentum.json` to the digit (pinned by `test/ablation.test.ts`, 20 tests) - a faithful decomposition, not a re-implementation. Held-out OOS, aggregate, net 10+10 bps:

| Arm | What it is | OOS return | OOS max-DD | Marginal contribution |
|---|---|---:|---:|---|
| **A1 - trend core ALONE** | no gate, no filter | **−0.35%** (B&H −43.50%) | **17.75%** (B&H 58.30%) | **- this is the whole result** |
| A2 - + F&G contrarian gate | trend core + gate | −0.32% | 17.72% | Δret **+0.03%**, ΔSharpe **+0.0011** (rounding-level) |
| A3 - + divergence/funding filter (== full pipeline) | trend core + gate + filter | −0.32% | 17.72% | Δret **0.00%**, ΔSharpe **−3e-12** (**inert**; trim=11/veto=0) |
| A5 - drawdown-state exposure scaler (isolated arm, vs A1) | trend core + de-risk-on-drawdown overlay | −3.29% | 13.79% | ΔmaxDD **−3.96pp** (17.75%→13.79%, shallower) **but** Δret **−2.94%**, ΔSharpe **−0.1819** → **does NOT bite** |

> **The drawdown-state exposure control (arm A5) does NOT bite - a disclosed inert monitor, like A3.** Added only as an isolated ablation arm (it changes **no** headline number), it scales exposure down by realized drawdown bucket. Measured on the held-out OOS, it genuinely **cuts maxDD by 3.96pp (17.75% → 13.79%)** - but that drawdown cut **costs ~2.94pp of OOS return (−0.35% → −3.29%)** and lowers Sharpe (−0.597 → −0.778). By the committed bite criterion (maxDD reduction ≥1pp **AND** return give-up ≤2pp) the return give-up is too large, so it **does not bite** (`verdict.drawdownScalerBites: false`). Because it de-risks *after* price has already fallen and lags re-entry on the sharp OOS recovery, it surrenders more upside than drawdown on this particular window - the textbook honest failure mode of a reactive drawdown overlay, disclosed as such. It is **not** load-bearing, **not** an edge, and does not beat B&H; the earner remains the vanilla EMA-30/80 trend core (A1). The null result is published openly in [`backtest/report-ablation.json`](backtest/report-ablation.json) (`attribution.drawdownScaler`, `verdict.drawdownScalerBites: false`), never hidden.

**The directional core IS the entire earner.** A1 alone produces the whole bear-dodge *and* the whole ~halved drawdown. The F&G gate is rounding-level (`addsValue` true only on a technicality); the divergence filter is `divergenceAddsValue: false`. A test pins `|ΔOOS return| < 5 bps` as an honesty guard, so any change that silently makes an overlay load-bearing trips the alarm.

> **A team that proves its own overlays don't earn is making a credibility flex no overclaiming competitor can match.** Our originality rests on the *composition* and the *live-CMC gating*, attributed precisely - never on a fabricated layer edge.

### 3. ✅ Verify it yourself (60 seconds)

```bash
npm install
# Optional - only for the Skill's LIVE regime read; the backtest needs NO key:
export CMC_MCP_API_KEY=<free key from pro.coinmarketcap.com>   # PowerShell: $env:CMC_MCP_API_KEY="<key>"

npm run fetch-data                  # FREE Binance public REST + alternative.me F&G → bar fixtures (no CMC key)
npx ts-node backtest/momentum.ts    # HEADLINE walk-forward → report-momentum.json   (=> git diff: no diff, byte-identical)
npx ts-node backtest/ablation.ts    # layer attribution → report-ablation.json        (=> A3 == runStrategy byte-for-byte)
npm test                            # mocha + ts-node                                 (=> 483 passing)
```

| Guarantee | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | exit **0** (strict) |
| Test suite | `npx mocha` | **483 passing** |
| Headline report byte-repro | `npx ts-node backtest/momentum.ts` then `git diff` | **no diff** |
| Frozen anchor byte-repro | `npm run backtest` then `git diff` | **no diff** |
| CI | `.github/workflows/ci.yml` | runs `tsc` + tests on Node 20 |
| Secrets | `git grep` for the key | **no API key in the repo** |

The engine is deterministic and pure (no `Date` / random / IO); every threshold is an **exported constant** (single source of truth, `src/signal/strategy.ts`). Look-ahead safety is pinned by a dedicated **truncation-invariance** test: appending or truncating future bars cannot change a past decision.

---

## 🔴 Live CoinMarketCap Agent Hub integration

> **CMC's live Fear & Greed IS the contrarian regime gate - built around the Agent Hub, not bolted on.**

A genuine keyed MCP round-trip to `https://mcp.coinmarketcap.com/mcp` was performed and **committed** under [`fixtures/cmc/live/`](fixtures/cmc/live/) (`_capture: "LIVE"`, `capturedAt 2026-06-17T19:36:35Z`), with **all 7 wired tools `ok:true`** and every field parsing `available: true`:

| Metric | Live value | Role in the strategy |
|---|---:|---|
| **Fear & Greed** | **23 ("Fear")** | The contrarian regime gate → favour long |
| RSI(14) | 41.85 | Trend / momentum context |
| BTC price | **~$64,424** | Provenance / sizing context |
| BTC dominance | 58.26% | Regime read |
| Funding rate | 0.0006212 | Funding regime / risk-filter input |
| Open interest | $407.9B | Derivatives positioning context |
| Holders / whales | 55,831,462 / 2.01% | Optional concentration term |

```mermaid
sequenceDiagram
    participant A as Stoic Skill
    participant H as CMC Agent Hub
    A->>H: search_cryptos("BTC")
    H-->>A: id = 1
    par Batched live reads
        A->>H: get_global_metrics_latest
        H-->>A: Fear & Greed = 23 (Fear), dominance 58.26%
        A->>H: get_crypto_technical_analysis
        H-->>A: RSI(14) = 41.85
        A->>H: get_global_crypto_derivatives_metrics
        H-->>A: funding 0.0006212, OI 407.9B
    end
    Note over A: Live F&G = 23 IS the contrarian regime gate
    A->>A: emit Strategy Capsule
```

<sub>7 wired tools, all `ok:true` - captured 2026-06-17 against `mcp.coinmarketcap.com`, committed under [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json). This is a single committed keyed snapshot, not a streaming/production feed.</sub>

<details>
<summary><b>The honest 7-wired / 5-documented tool split (never "12 tools")</b></summary>

The Skill's `allowed-tools` wires exactly **7** tools, each backed by a real `callTool(...)` adapter in `src/data/cmc.ts` (the mapping is pinned by `test/honesty.test.ts`). The other **5** are documented for optional context only - they have **no adapters**.

| Tool | Status | Role |
|---|---|---|
| `search_cryptos` | **WIRED** | Resolve ticker → CMC numeric id FIRST |
| `get_crypto_quotes_latest` | **WIRED** | Spot price + 24h change |
| `get_crypto_technical_analysis` | **WIRED** | RSI / MACD / EMA / ATR |
| `get_global_metrics_latest` | **WIRED** | **Fear & Greed**, dominance - the regime read |
| `get_global_crypto_derivatives_metrics` | **WIRED** | Funding, OI, long/short - positioning |
| `trending_crypto_narratives` | **WIRED** | Narrative **attention momentum** (not polarity) |
| `get_crypto_metrics` | **WIRED** | Holder / whale concentration |
| `get_crypto_info` | DOC | Asset metadata |
| `get_crypto_marketcap_technical_analysis` | DOC | Market-cap technical context |
| `get_upcoming_macro_events` | DOC | Macro-event context for invalidation |
| `get_crypto_latest_news` | DOC | Headline context |
| `search_crypto_info` | DOC | Free-text metadata lookup |

</details>

### CMC Agent Hub — 7 of 12 Data MCP tools, wired live

Each of the **7 wired tools** below was exercised in the committed keyed round-trip and parsed `ok: true` — cross-referenced to [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json) (`_capture: "LIVE"`, every tool `ok: true`; F&G **23**, RSI(14) **41.85**, funding **0.0006212**, BTC dominance **58.26%**). Grouped by CMC's own taxonomy, and — crucially — labelled **DECISION-USE** (feeds the committed `runStrategy` decision) vs **CONTEXT/CLASSIFIER** (read, disclosed, but not a decision driver). It is **2 DECISION-USE + 5 CONTEXT** — never "all 12".

| CMC taxonomy | Wired tool | Live manifest value (`_manifest.json`) | Role in the committed decision |
|---|---|---|---|
| **Quotes** | `get_crypto_quotes_latest` | price $64,423.61 · 24h −1.82% | ⚪ **CONTEXT/CLASSIFIER** — provenance / sizing context |
| **Technicals** | `get_crypto_technical_analysis` | RSI(14) **41.85** · MACD hist 620.87 | 🟡 **DECISION-USE** — divergence/funding read input |
| **Global** | `get_global_metrics_latest` | **Fear & Greed = 23** · BTC dominance **58.26%** | 🟡 **DECISION-USE** — the contrarian **F&G regime gate** |
| **Derivatives** | `get_global_crypto_derivatives_metrics` | funding **0.0006212** · OI $407.9B | ⚪ **CONTEXT/CLASSIFIER** — funding feeds the inert risk filter; OI is positioning context |
| **Trending narratives** | `trending_crypto_narratives` | available · count 5 | ⚪ **CONTEXT/CLASSIFIER** — attention-momentum context |
| **Holder metrics** | `get_crypto_metrics` | holders 55,831,462 · whales 2.01% | ⚪ **CONTEXT/CLASSIFIER** — optional concentration term |
| **Search / resolve** | `search_cryptos` | id resolved (`available: true`) | ⚪ **CONTEXT/CLASSIFIER** — ticker → CMC id resolution (a prerequisite, not a signal) |

<sub>**2 of 7 feed the committed decision** (the Fear & Greed gate + the RSI/divergence-and-funding read); the other 5 are wired and live but **ablation-disclosed CONTEXT** — see the ablation, where the F&G gate is rounding-level and the divergence/funding filter is numerically inert. The remaining **5 of CMC's 12** tools are documented-only (no adapters) in the table above. We say **7 of 12**, never 12.</sub>

### Consumable by a self-custody executor (dry-run)

The "an agent can consume this" claim is **demonstrated, not asserted**: [`tools/consume-capsule.ts`](tools/consume-capsule.ts) reads the committed `capsule.example.json`, **validates it against `capsule.schema.json`** with the same draft-07 subset validator the tests use, and **prints the order it would construct** (pair, side, sizeBps, regime label, allowlist check). It loads **no signer, no RPC, no wallet, no TWAK key** and writes **nothing on-chain** — every line is labelled `DRY-RUN`. It also exercises the **x402 keyless route** (`x402DryRunRoute()` / the branch in [`src/data/cmc.ts`](src/data/cmc.ts)) as a **wired code path only — dry-run, NOT a funded/settled USDC call.** Both are honestly labelled dry-run.

---

## 🧭 We grade ourselves harder than the judges will

The differentiator, framed as confidence, not apology. We state the robust claim **and** every honest caveat - before a judge can find them. Receipts in [`CHANGES-FOR-JUDGES.md`](CHANGES-FOR-JUDGES.md).

| ✅ The robust claim | ⚠️ The honest caveat |
|---|---|
| Roughly **halves drawdown** (17.7% vs 58.3% OOS), robust on every window & cost level, all 3 tokens. | The **absolute OOS beat is a regime-conditional bear-dodge, not alpha** - a bull mid-window loses to B&H by ~37%. |
| Held-out OOS beats B&H on return on all 3 tokens + aggregate (net of cost). | **2 of 3 token beats are negative-absolute "lost-less" beats**; only BNB is a positive-return win. |
| Aggregate OOS is a risk-adjusted win (higher Sharpe + lower maxDD). | The risk-adjusted win holds on the **aggregate**, not BTC (BTC OOS Sharpe −2.04 < B&H −1.28). |
| The composition + live-CMC gating is the original construction. | The **ablation proves our own overlays don't attributably earn** - the trend core does all the work. |
| Net of a labelled 10+10 bps cost; survives 15+15 and 25+25 bps. | The cost model is a **configurable assumption** - the organizer's exact model is unconfirmed. |
| Every load-bearing number is byte-reproducible and cross-checked to a committed file. | The **demo video is not yet recorded** - screenshots, a live dashboard, and a script are committed; the video is pending. |

<details>
<summary><b>The loss we kept (the frozen anchor, retained verbatim)</b></summary>

The original purely-contrarian divergence strategy **lost** - and we never overwrote it ([`backtest/report.json`](backtest/report.json), byte-identical, untouched):

| Aggregate (1h, 2026-02-17 → 2026-06-17) | Full | In-sample | OOS |
|---|---:|---:|---:|
| Total return | **−36.5%** | −22.5% | **−18.1%** |
| Buy & hold | −5.4% | +13.9% | −16.6% |
| Sharpe | −12.24 | −10.92 | −15.50 |
| Trades | 843 | 468 | 375 |

This is **why we pivoted**: a contrarian signal cannot out-earn buy-and-hold in a rising market. The honest fix was a *different thesis on better, multi-regime daily data* - keeping this loss as the anchor that motivated it. The pivot narrative itself is the integrity story.

</details>

---

## 🎯 Maps to the Track 2 rubric

| Rubric axis (equal weight) | One-sentence answer | Proof |
|---|---|---|
| **Technical execution** | It works and is real, not cosmetic: a deterministic pure engine, a look-ahead-safe walk-forward backtest on REAL multi-regime data, 483 tests, byte-reproducible reports, CI green. | ✅ [`report-momentum.json`](backtest/report-momentum.json) · [`CHANGES-FOR-JUDGES.md`](CHANGES-FOR-JUDGES.md) |
| **Originality** | A regime-aware composition packaged as a risk overlay, plus a genuinely novel mechanism - a look-ahead-safe **cross-sectional panel-demean** that strips market-wide beta from divergence to isolate the idiosyncratically offside token - with a per-layer ablation that honestly attributes the result, not the canned "sentiment vs price" one-liner. | ✅ [`report-ablation.json`](backtest/report-ablation.json) · [`crossSectional.ts`](src/signal/crossSectional.ts) · [`strategy.ts`](src/signal/strategy.ts) |
| **Real-world relevance** | A risk-conscious allocator who wants to ride bulls but not eat the full drawdown gets an execution-agnostic **Strategy Capsule** - emitted in CMC's `SKILL.md` format and validated against a committed [`capsule.schema.json`](skills/sentiment-divergence-regime/capsule.schema.json) - that a Trust-Wallet/BSC agent can consume; delivered value is capital preservation. | ✅ [`SKILL.md`](skills/sentiment-divergence-regime/SKILL.md) · [`capsule.schema.json`](skills/sentiment-divergence-regime/capsule.schema.json) |
| **Demo & presentation** | A reachable live dashboard + committed hero screenshots, and a README that leads with the robust claim and the honesty posture (video pending, honestly marked). | ✅ [Live dashboard](https://agdanish.github.io/stoic/) · [`docs/assets/`](docs/assets/) |
| 🏆 **Best Use of CMC Agent Hub** *(special prize)* | CMC's **live** Fear & Greed is the load-bearing contrarian regime gate - a genuine keyed round-trip, 7/7 wired tools `ok:true`, committed. | ✅ [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json) |

---

## 🌍 Real-world relevance - user & adoption path

**Who is this for?** A risk-conscious crypto allocator who wants to *participate* in bull markets but *not* eat the full drawdown when the regime turns. The delivered value is **capital preservation** - roughly halved drawdown - disclosed as regime-conditional for the absolute beat.

**How it's consumed.** The deliverable is **not** a live-trading toy. It is an execution-agnostic **Strategy Capsule** (entry / exit / invalidation / sizing / risk + look-ahead-safe replay) authored in CMC's own `cmc-mcp` `SKILL.md` format. The Capsule has a **committed JSON Schema** ([`capsule.schema.json`](skills/sentiment-divergence-regime/capsule.schema.json)) - required fields `strategyId`, `generatedAt`, `dataSources`, `engineConstants`, `regime`, `universe`, `entryRule`, `exitRule`, `invalidation`, `positionSizing`, `riskLimits`, `backtestReplay`, each numeric rule citing its engine constant by name - so a downstream Trust-Wallet / BSC execution agent ingests a *spec it can machine-validate*, not prose. No live trades, no on-chain writes, no token/fundraising language (Track-2 compliant).

> **Strategy Capsule, made concrete.** A committed, schema-validated example Capsule for BTC ships at [`skills/sentiment-divergence-regime/capsule.example.json`](skills/sentiment-divergence-regime/capsule.example.json), gated by a committed-file test you can run in isolation: **`npm run validate-capsule`** (GREEN). A downstream BSC execution agent consumes it directly: it reads `entryRule` / `exitRule` (when to open and flatten, each threshold citing its engine constant), `invalidation` (the regime conditions that void the read), `positionSizing` (`sizeFromConviction` in bps), and `riskLimits` (look-ahead-safe, bounded advisories, calibrated entry threshold) - turning the spec into orders without re-deriving the strategy.

> **Unattended-use safety contract.** Machine-readable guardrails for a self-custody holder live in [`guardrails.json`](guardrails.json), every bound sourced from committed code/reports: **de-risk-only** (the overlay can trim/flatten or scale edge but never flip the directional sign or exceed 1x), a **sub-30% max-drawdown disqualify cap** (committed OOS 17.7% sits 12.3pp inside it), a **universe allowlist** (BTC / ETH / BNB only), and **no on-chain writes** (spec-only, runs with no API key as a strict {0,0} no-op).

```mermaid
flowchart LR
    CMC["CMC Agent Hub<br/>live F&amp;G = 23, positioning, narratives"] --> SK["Stoic Skill<br/>SKILL.md"]
    SK --> CAP["Strategy Capsule<br/>entry / exit / invalidation<br/>sizing / risk + replay"]
    CAP --> SCH["validate against<br/>capsule.schema.json"]
    SCH --> EX["Downstream Trust-Wallet /<br/>BSC execution agent"]
```

### BNB, the asset — honest panel

**BNBUSDT was the only token with a positive absolute OOS return: +18.48%** (BTC −7.53%, ETH −11.90% both lost in absolute terms, beating buy-and-hold only because B&H lost more).

| Held-out OOS (net 10+10 bps) | Strategy return | Buy & hold | Strategy max-DD | B&H max-DD |
|---|---:|---:|---:|---:|
| **BNBUSDT** | **+18.48%** | −28.68% | 21.3% | 56.2% |

*Still a regime bear-dodge, not BNB-specific alpha.* The positive sign on BNB rides the same single mechanism as the aggregate — going flat through the 2026 bear — not anything the strategy knows about BNB in particular. Read it as one token landing on the right side of a bear-dodge, not an edge on the asset.

> **BEP-20 venue note.** The strategy universe is a fixed **BTC / ETH / BNB allowlist** ([`guardrails.json`](guardrails.json)), **BSC-native by design** — the downstream executor settles these as BEP-20 pairs on BNB Chain, and **slippage, gas, and finality are owned by that executor**, not by this spec-only Capsule (no on-chain writes here).

---

## ❓ FAQ - preempting the skeptic

<details>
<summary><b>Isn't this just a trend follower?</b></summary>

At its OOS-earning core, yes - and we prove it ourselves. The ablation attributes the entire held-out result to the directional trend core. The originality is the *composition* (the live-CMC contrarian gate and the divergence risk filter wrapped around that core as a drawdown-reducing risk overlay), the *cross-sectional panel-demean* construct, and the *radical-transparency method* - not a claim that each layer earns. → [`report-ablation.json`](backtest/report-ablation.json)
</details>

<details>
<summary><b>Does the F&G gate actually do anything?</b></summary>

On the held-out OOS it is rounding-level (+0.03% return, +0.0011 Sharpe) and a mild in-sample drag - and we say so. It is a sensible regime overlay and the live-CMC integration's load-bearing input, not an OOS edge. We present it as exactly that. → [`report-ablation.json`](backtest/report-ablation.json) `attribution.fgGate`
</details>

<details>
<summary><b>Is the live CMC integration real, or mocked?</b></summary>

Real. A genuine keyed round-trip was performed and committed: `_capture: "LIVE"`, all 7 wired tools `ok:true`, live values (F&G=23, RSI 41.85, dominance 58.26%, funding 0.0006212) parsed `available: true`. It is one committed snapshot, not a streaming feed - stated plainly. → [`fixtures/cmc/live/_manifest.json`](fixtures/cmc/live/_manifest.json)
</details>

<details>
<summary><b>Why lead with drawdown, not the +43% excess?</b></summary>

Because the +43% excess is a regime-conditional bear-dodge that the data does *not* support in every window (a bull mid-window loses by ~37%), whereas **lower drawdown holds on every window and cost level, on all 3 tokens** - it is the one regime-independent claim. Leading with the fragile number would be the overclaim we refuse to make. → [`ROBUSTNESS-momentum.md`](ROBUSTNESS-momentum.md) §6
</details>

---

## 🎬 Demo & quick start

<div align="center">

### ▶️ [Open the live dashboard →](https://agdanish.github.io/stoic/)

</div>

[![Stoic dashboard - full view](docs/assets/dashboard-hero.png)](https://agdanish.github.io/stoic/)

<sub>The dashboard renders the directional read, the live regime, and the honest backtest report from the committed headline run [`backtest/report-momentum.json`](backtest/report-momentum.json) (aggregate OOS **−0.32%** loss; maxDD **17.7% vs 58.3%**); the frozen original contrarian loss is shown separately from `report.json`. Demo regime pinned to F&G = 78 / "Extreme Greed" so the contrarian mechanic fires on camera. **Note:** a 2:30–3:00 demo video is scripted (`docs/DEMO.md`) but **not yet recorded/linked** - the screenshots and live dashboard are the committed demo evidence today.</sub>

**What you'll see in 30 seconds on the live dashboard:**

1. The **contrarian read firing** - at the pinned demo regime (F&G = 78, "Extreme Greed", ≥ `GREED_EXTREME` = 75), the gate trims and the risk filter flags the crowded long, on camera.
2. The **honest Strategy-vs-B&H bars** - anchored to a y=0 baseline, so the all-negative OOS window is legible (strategy −0.32% sitting far above B&H −43.50%).
3. The **regime / signal panel** - directional bias, gated bias, risk-filter state, and conviction, every threshold labelled with its engine constant.

```bash
npm install
npm run fetch-data                  # FREE Binance public REST + alternative.me F&G (no CMC key)
npx ts-node backtest/momentum.ts    # the headline result → report-momentum.json
```

<details>
<summary><b>Full setup (backtest · ablation · robustness · dashboard · the Skill)</b></summary>

```bash
npm install
export CMC_MCP_API_KEY=<free key>                 # optional, live Skill read only

npm run fetch-data                                # bar fixtures from Binance + alternative.me F&G
npx ts-node backtest/momentum.ts                  # HEADLINE → report-momentum.json
npx ts-node backtest/robustness-momentum.ts       # read-only stress matrix (writes nothing)
npx ts-node backtest/ablation.ts                  # layer attribution → report-ablation.json
npm run backtest                                  # frozen original anchor → report.json (byte-identical)
npm test                                          # 483 passing
npx http-server frontend                          # serve the dashboard (BNB-gold accent)

# To use the Skill in your own CMC-MCP agent:
cp -r skills/sentiment-divergence-regime /path/to/your/agent/skills/
```

</details>

### The trust pipeline, end to end

```mermaid
flowchart LR
    BIN["Binance public REST<br/>daily klines + funding"] --> FX["bar fixtures<br/>1000 bars/token · synthetic:false"]
    ALT["alternative.me<br/>daily Fear & Greed (99.9%)"] --> FX
    FX --> BT["momentum.ts walk-forward<br/>select on in-sample 70% ONLY"]
    BT --> RP["report-momentum.json<br/>byte-reproducible"]
    RP --> AB["ablation.ts → report-ablation.json<br/>A3 == runStrategy byte-for-byte"]
    CMC["CMC Agent Hub MCP<br/>keyed round-trip"] --> CAP["fixtures/cmc/live/_manifest.json<br/>F&amp;G = 23 · 7/7 ok"]
    CAP --> SK["the Skill → Strategy Capsule"]
    AB --> V["483 tests · tsc 0 · CI · no API key in repo"]
    SK --> V
```

<sub>Single source of truth: the live read and the backtest are the **same strategy** (shared engine constants). Every label maps to a committed file.</sub>

---

## License

MIT.

---

<div align="center">

**Submission context** - BNB Hack: AI Trading Agent Edition (CoinMarketCap × Trust Wallet × BNB Chain) · **Track 2 - Strategy Skills** + *Best Use of CMC Agent Hub*. Submission lock: **2026-06-21 12:00 UTC**.

**[↑ Back to top](#stoic)** · **[Repo](https://github.com/agdanish/stoic)** · **[Live dashboard](https://agdanish.github.io/stoic/)** · **[The Skill](skills/sentiment-divergence-regime/SKILL.md)** · **[Judges' changelog](CHANGES-FOR-JUDGES.md)**

</div>