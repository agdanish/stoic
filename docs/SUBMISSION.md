# Stoic — DoraHacks Submission

> BNB Hack: AI Trading Agent Edition (CoinMarketCap x Trust Wallet x BNB Chain).
> **Track 2 — Strategy Skills.** Submission lock: **2026-06-21 12:00 UTC**.
> Fill the `<placeholder>` fields (repo + video) before submitting.

---

> ### What is NOT wired (self-disclosed)
>
> We state the gaps up front so no judge has to find them:
>
> - **No Trust Wallet Agent Kit (TWAK) signing** — no wallet, no key custody, no transaction signing of any kind.
> - **No BNB AI Agent SDK** — the BNB Chain agent SDK is not used anywhere in this repo.
> - **No on-chain / BSC write** — nothing is broadcast, settled, or written on-chain; Track 2 is a spec-only deliverable.
> - **x402 = dry-run code path only** — the keyless x402 transport branch in `src/data/cmc.ts` is wired as a *code path* (`CMC_MCP_X402_URL`, Base 8453 USDC). It is labelled "x402 keyless route — code wired, dry-run, NOT a funded/settled USDC call." No paid/settled x402 transaction has occurred.
> - **7 of 12 CMC tools wired; only 2 feed the committed decision** — 7 tools have real adapters in `src/data/cmc.ts`; of those, exactly **2 feed the committed `runStrategy` decision** (the Fear & Greed regime gate + the RSI/divergence read), and the other **5 are ablation-disclosed context only** (not in the decision path). The remaining 5 of 12 are documented, not wired.
> - **Not alpha** — the held-out OOS aggregate is **−0.32% (a LOSS)**. The win is **≈ halved maximum drawdown** (a risk overlay / bear-dodge), never standalone alpha.
>
> **Why this serves CoinMarketCap:** a real **7-tool keyed CMC round-trip** (committed under `fixtures/cmc/live/`), a **publishable `cmc-mcp` Skill** in CMC's own SKILL.md format, and an **honest failure-handling contract** (missing fields drop their leg, never fabricated; unkeyed default is a strict `{0,0}` no-op) that matches CMC's own Skill-quality bar.

---

## Title

**Stoic — Regime-Aware Directional Core + CoinMarketCap Fear & Greed Gate (a Strategy Skill)**

## Tagline

A CoinMarketCap Skill that emits a backtestable, look-ahead-safe Strategy Capsule for a **regime-aware RISK OVERLAY** — a directional (trend/momentum) core gated by CMC's **live Fear & Greed** contrarian read and risk-filtered by a positioning-vs-flow divergence overlay. On REAL multi-regime daily data it roughly **halves maximum drawdown** vs buy-and-hold across bull/bear/chop (the robust, regime-independent claim); on the bear-tailed held-out OOS it also beats buy-and-hold net of cost on all 3 tokens + aggregate — but as a *bear-dodge*, disclosed honestly as regime-conditional, never as alpha. A per-layer ablation attributes the result to the trend core.

## Track

**Track 2 — Strategy Skills.** Deliverable = a CMC Skill (`SKILL.md`) that generates a backtestable strategy spec (entry / exit / sizing rules). No live execution required.

## Links

- **Repository:** https://github.com/agdanish/stoic
- **Demo video (2:30–3:00):** `<video URL — YouTube/Loom/Drive>` (script: `docs/DEMO.md`)
- **The Skill:** `skills/sentiment-divergence-regime/SKILL.md`
- **Backtest reports (committed):** `backtest/report-momentum.json` (headline risk overlay), `backtest/report-ablation.json` (layer attribution), `backtest/report.json` (frozen original contrarian anchor — a loss, retained verbatim)

## Description

Stoic is a CoinMarketCap **Agent Hub Skill** that turns a live market snapshot into a **Strategy Capsule** — a self-contained, backtestable trading-strategy spec with named entry / exit / invalidation / sizing / risk rules and look-ahead-safe backtest-replay instructions. It does **not** place trades; the deliverable is a reproducible *specification*.

**What we claim, measured (not asserted).** The original purely-contrarian divergence strategy had **no edge** — a contrarian signal cannot out-earn buy-and-hold in a rising market (the original −36.5% full-window loss, retained and labelled below). The honest fix is a **different thesis on better, multi-regime daily data**: a **regime-aware directional trend/momentum core** packaged as a **RISK OVERLAY** that rides bulls and goes flat in bear/chop. **The claim we lead with is drawdown reduction:** it roughly **halves maximum drawdown** vs buy-and-hold (held-out OOS 17.7% vs 58.3%) and does so on every window and cost level tested — the one regime-independent property of the result (`ROBUSTNESS-momentum.md`). On the bear-tailed **held-out out-of-sample** tail (trailing 30%, never used to select any parameter; selected on the in-sample 70% only) it also **beats buy-and-hold net of 10+10 bps cost on all 3 tokens AND the aggregate** (aggregate −0.32% vs B&H −43.50%, excess +43.19%; `backtest/report-momentum.json` `verdict.edgeFound: true`). **The honest other side, stated up front:** that absolute beat is a *bear-dodge*, not standalone alpha — in-sample (a bull) it LAGS B&H by a wide margin (+57% vs +262%), in a bull mid-window it loses to B&H by ~37%, two of the three OOS beats are negative-absolute "lost-less" beats, and per-token OOS Sharpe is mixed. A per-layer ablation (`backtest/report-ablation.json`) attributes the entire OOS result to the directional core and shows the F&G gate + divergence filter are marginal-to-inert on OOS, so we never claim the overlays earn. Byte-reproducible (`test/momentum.test.ts`, `test/ablation.test.ts`).

The strategy is the differentiator. The official Track-2 example — "is sentiment diverging from price?" — is a one-liner that scores zero on originality. Stoic is a **regime-aware composition** (`src/signal/strategy.ts`):

```
1. DIRECTIONAL CORE   (momentum.ts)    → trend/momentum bias on 0..1000 (rides the trend, flat in bear/chop)
2. F&G CONTRARIAN GATE (regimeGate.ts)  → extreme GREED trims/flattens a long; extreme FEAR favours a long
3. DIVERGENCE/FUNDING RISK FILTER       → veto/trim a long that diverges into euphoric, unconfirmed positioning
   → blendScore folds bounded CMC/LLM advisories ({0,0}=no-op) → sizeFromConviction → decideTrade
```

- **Directional core** = fast/slow EMA trend separation + price momentum (selected: EMA 30/80, long-only). Tracks B&H in bulls (EMA lag), goes flat in bear/chop — the source of the bear-dodge.
- **Fear & Greed contrarian gate** = CMC's own guidance (extreme greed = overvalued, extreme fear = bargain), a bounded multiplicative gain on the directional edge that never flips its sign. **This is the live CMC Fear & Greed read** (latest keyed capture F&G = 23).
- **Divergence/funding risk filter** = the original contrarian positioning read, demoted to a veto/trim. On the multi-year daily backtest it uses funding + F&G (deep history); the long/short account ratio + taker-ratio legs (~30d history) stay a recent/live refinement only — stated, not hidden.

Every read for bar `t` uses only closes `≤ t` plus the bar's own F&G/funding; the position decided at `t` is held into `t+1` (the decision precedes the move it is paid on). Every threshold in the emitted Capsule is an **exported constant** from a deterministic engine (`src/signal/momentum.ts`, `regimeGate.ts`, `strategy.ts`, `core.ts`) — one source of truth, no copied magic numbers. Validated by a **look-ahead-safe walk-forward backtest on REAL multi-regime Binance daily data + alternative.me historical Fear & Greed**, with a held-out out-of-sample window, reported per token + aggregate vs buy-and-hold. The optional LLM rationale folds through a bounded blend and no-ops when absent, so the deterministic engine is always the product.

## Best Use of CoinMarketCap Agent Hub (special prize pitch)

Stoic is built **around** the CoinMarketCap Agent Hub, not bolted onto it:

- **The Skill is the product, in CMC's own format.** `SKILL.md` follows CMC's `cmc-mcp` SKILL.md spec exactly: YAML frontmatter (`name` == folder, `description` with explicit Trigger phrases, `license`, `compatibility`, `user-invocable`, `allowed-tools: [mcp__cmc-mcp__...]`) + a markdown workflow body that emits the Strategy Capsule.
- **CMC's Fear & Greed is the contrarian regime gate — and it is LIVE.** A keyed CMC round-trip is committed under `fixtures/cmc/live/` (latest capture **F&G = 23**, RSI 41.85, price + funding all parsing with `available: true`). That live Fear & Greed read is the contrarian gate that modulates the directional core (extreme fear → favour long; extreme greed → trim). The crowd/positioning leg, the technical context, and the attention-momentum advisory also come from Agent Hub tools.
- **Single source of truth.** The Capsule cites engine constants by name and never hard-codes a copied number, so the live CMC read and the offline backtest are the same strategy.
- **Honest degradation.** Missing a CMC field drops that leg (never fabricated); the Capsule still emits, marking live fields "NEEDS YOUR FREE CMC KEY"; the backtest runs keyless. The unkeyed CMC advisory default is a strict `{0,0}` no-op, so the committed reports stay byte-reproducible.

## CoinMarketCap MCP tools used

MCP server `cmc-mcp` at `https://mcp.coinmarketcap.com/mcp`, header `X-CMC-MCP-API-KEY` (free key, 10k credits/mo, `pro.coinmarketcap.com`). Keyless x402 alternative: `https://mcp.coinmarketcap.com/x402/mcp` ($0.01 USDC/call, Base 8453).

**7 wired + 5 documented.** The 7 marked WIRED are in the Skill's `allowed-tools` and each has a real `callTool(...)` adapter in `src/data/cmc.ts` (the mapping is pinned by `test/honesty.test.ts`); the 5 marked DOC are documented for optional context only and are not wired.

| Tool | Status | Use |
|---|---|---|
| `search_cryptos` | WIRED | Resolve ticker → CMC numeric id FIRST. |
| `get_crypto_quotes_latest` | WIRED | Spot price + 24h change (provenance / sizing). |
| `get_crypto_info` | DOC | Asset metadata / context. |
| `get_crypto_technical_analysis` | WIRED | RSI / MACD / EMA50 / EMA200 / ATR — trend + momentum context. |
| `get_crypto_marketcap_technical_analysis` | DOC | Market-cap technical context. |
| `get_crypto_metrics` | WIRED | Holder / whale concentration (optional term). |
| `get_global_metrics_latest` | WIRED | Fear & Greed, BTC dominance, altseason — the regime read. |
| `get_global_crypto_derivatives_metrics` | WIRED | Funding, OI, liquidations, long/short ratio — the crowd leg + funding regime. |
| `trending_crypto_narratives` | WIRED | Narrative attention momentum — optional bounded crowd-leg advisory. |
| `get_upcoming_macro_events` | DOC | Macro-event context for invalidation. |
| `get_crypto_latest_news` | DOC | Headline context / rationale. |
| `search_crypto_info` | DOC | Free-text lookup over CMC metadata. |

## The headline claim — the agent LOST 0.32% (it did not make money); the win is HALVED drawdown

**Read the headline before anything else: aggregate out-of-sample return is −0.32% — a small LOSS, not a profit. The agent did not, on aggregate, make money.** What the product is positioned on is **drawdown reduction**: a regime-aware directional **risk overlay** that roughly **halves maximum drawdown** vs buy-and-hold (held-out OOS **17.7% vs 58.3%**) across bull, bear and chop, on all three tokens and every cost level tested (`ROBUSTNESS-momentum.md`) — the one regime-independent claim. This is an **overlay, not alpha.**

On the **held-out out-of-sample** tail (trailing 30%, 300 daily bars/token — the 2026 YTD drawdown, never used to select any parameter), the in-sample-selected directional core (`long-only + EMA 30/80`) **"beats buy-and-hold net of 10+10 bps cost on all 3 tokens AND the aggregate" — but here that means LOST LESS, not earned**: buy-and-hold fell −43.50% aggregate, so beating it is a **bear-dodge**. **2 of the 3 token beats are negative-absolute** (BTC −7.53%, ETH −11.90% — both lost money, just less than B&H); only BNB (+18.48%) is positive; **the aggregate is a −0.32% loss.** Source: `backtest/report-momentum.json` → `aggregate.outOfSample` + `perToken[].outOfSample`; pinned byte-for-byte by `test/momentum.test.ts`.

| Held-out OOS (trailing 30%, 10+10 bps) | Strategy total return | Buy-and-hold | Strategy max-DD | B&H max-DD |
|---|---:|---:|---:|---:|
| **Aggregate (equal-weight)** | **−0.32%** | **−43.50%** (excess **+43.19%**) | **17.7%** | **58.3%** |
| BTCUSDT | −7.53% | −42.91% (+35.38%) | 8.9% | 51.2% |
| ETHUSDT | −11.90% | −58.92% (+47.02%) | 23.0% | 67.5% |
| BNBUSDT | **+18.48%** | −28.68% (+47.16%) | 21.3% | 56.2% |

G1 passes (`verdict.edgeFound: true`, `aggregateBeatsBuyHoldOOS: true`); aggregate is also a risk-adjusted win (Sharpe −0.595 > B&H −1.000 AND maxDD 17.7% < 58.3%). The OOS beat survives 15+15 bps (excess +42.59%).

**Honest framing of this claim (the spine of our honesty):** this is a **bear-dodge, not standalone alpha.** In-sample (a strong bull) the strategy returns **+57.48% vs B&H +262.05% — it loses to B&H by a wide margin** (a trend core cannot out-earn a +262% bull); in a bull-dominated mid-window it loses to B&H by **~37%** (`ROBUSTNESS-momentum.md`). Two of the three OOS beats (BTC, ETH) are **negative-absolute "lost-less" beats** — only BNB is positive-return; per-token OOS Sharpe is **mixed** (BTC −2.04 is worse than B&H −1.28; ETH/BNB better). The one claim **robust across every window and cost level, on all three tokens, is lower maximum drawdown** (≈ halved). We lead with the drawdown reduction and present the absolute OOS beat truthfully as regime-conditional.

**Layer attribution (we decompose, not assert) — `backtest/report-ablation.json`.** A per-layer ablation holds the locked config fixed and toggles one overlay at a time; arm A3 (full pipeline) reproduces `runStrategy` **byte-for-byte** and equals `report-momentum.json` to the digit (pinned by `test/ablation.test.ts`). It is blunt about where the result comes from: the **directional trend core alone** (A1) produces the entire held-out OOS result — OOS −0.35% vs B&H −43.50%, maxDD 17.75% vs 58.30% (the whole bear-dodge and the whole ~halved drawdown). The **F&G gate** adds rounding-level OOS value (Δreturn +0.03%, ΔSharpe +0.0011) and is a mild in-sample drag; the **divergence/funding risk filter is numerically inert on OOS** (ΔSharpe −3e-12, fired trim=11/veto=0 over 3000 bars) — `divergenceAddsValue: false`, a non-earning safety veto. So we attribute the result honestly to the trend core and **do not claim the "novel" overlays earn OOS**; their contribution is risk control + a look-ahead-safe relative-value construct.

## Originality & impact (what a judge can verify, increment by increment)

Beyond the headline overlay, the repo ships concrete, byte-checkable increments — each pinned to committed proof, none claiming alpha. (1) **Deterministic multi-tool regime classifier** (`backtest/cmc-regime-briefing.ts`, `test/regimeBriefing.test.ts`, fixture `fixtures/cmc/live/regime-briefing.json`): the 7-tool CMC briefing's flat string-join is promoted to a pure `classifyRegime` that maps normalized tool reads to ONE label from a fixed enum (`BEAR_CAPITULATION_FAVOUR_LONG` / `GREED_TRIM` / `RISK_OFF_CROWDED_LONG` / `NEUTRAL_PASS_THROUGH` / `UNKNOWN_INSUFFICIENT_DATA`); each branch records a `because` citing real engine constants and only 2 of 7 tools feed the label (the rest are `context only`), with 5 unit tests pinning the label boundaries. (2) **Concrete schema-validated `capsule.example.json`** for BTC (`skills/sentiment-divergence-regime/capsule.example.json`) plus a committed-file test (`test/capsuleExample.test.ts`) and an isolated npm script — all green — so the Capsule shape is a real artifact, not prose. (3) The **surfaced cross-sectional construct** is reported vs B&H as-is (retained `report-crosssectional.json`), a look-ahead-safe relative-value leg, not an earner. (4) A **self-ablating Honesty Contract** (`HONESTY-CONTRACT.md`): a one-page four-clause contract pinning every claim to committed proof (`report*.json` + tests) and framing the system as a regime-aware drawdown overlay, never alpha. (5) An **Unattended-Use Safety Contract** (`guardrails.json`): four machine-readable guardrails, every value cross-checked against committed code (`src/signal/regimeGate.ts`, `src/signal/cmcAdvisory.ts`) and `backtest/report-ablation.json`.

(6) A **drawdown-state exposure control** is added strictly as isolated ablation arm **A5** (it does NOT touch the headline `report-momentum.json`). Measured on the same held-out OOS window, A5 vs the trend-core baseline A1: maxDD **17.75% → 13.79%** (**−3.96pp shallower**, real) at a cost of return **−0.35% → −3.29%** (**−2.94pp**) and a lower Sharpe (−0.597 → −0.778, ΔSharpe −0.1819). By the committed bite criterion (OOS maxDD reduction ≥ 1pp **AND** OOS return give-up ≤ 2pp) it does **NOT bite** — the drawdown cut is genuine but the return give-up is too large — so it is published as a **disclosed inert de-risking overlay, NOT alpha, NOT a driver/edge, and it does not beat B&H** (`report-ablation.json` → `attribution.drawdownScaler`, `verdict.drawdownScalerBites: false`). Because the scaler de-risks after price has already fallen and lags re-entry on the sharp OOS recovery, it surrenders more upside than drawdown on this 2026 window — the textbook honest failure mode of a reactive drawdown overlay, disclosed as such. The earner remains the vanilla EMA-30/80 trend core's bear-dodge; this null/negative result is published openly, not hidden.

## The original contrarian loss (the frozen anchor, retained verbatim from `backtest/report.json`)

This is the original purely-contrarian rolling-window z-scored *divergence* backtest. **We do not claim it as a win — it loses to B&H on every segment, and it is retained, labelled, and never overwritten** (byte-identical; the momentum work never touches it). REAL Binance public-REST data (keyless): spot klines OHLCV + USDT-M futures funding / long-short / taker / OI. Symbols **BTCUSDT, ETHUSDT, BNBUSDT**, **1h** bars, **2026-02-17 → 2026-06-17**. Cost model: 10 bps tx + 10 bps slippage on |Δ signed notional| (a configurable assumption; organizer model unconfirmed). Aggregate is equal-weight across the three tokens.

| Aggregate | Full period | In-sample (lead 70%) | Held-out out-of-sample (trail 30%) |
|---|---:|---:|---:|
| Total return | −36.5% | −22.5% | −18.1% |
| Buy-and-hold (same bars) | −5.4% | +13.9% | −16.6% |
| Win rate | 27.8% | 27.9% | 27.7% |
| Max drawdown | 36.8% | 22.8% | 18.2% |
| Sharpe (annualised, cost-inclusive) | −12.24 | −10.92 | −15.50 |
| Sortino | −15.94 | −14.42 | −19.36 |
| Trades | 843 | 468 | 375 |

**This is why we pivoted.** A contrarian signal cannot out-earn buy-and-hold in a rising market, and on the old 4-month hourly window the held-out tail is a bull. The two-leg construct was also degenerate on ~82% of bars (the free futures endpoints retain only ~30 days of long/short, taker and OI history). The honest fix was the **different thesis on better, multi-regime daily data** above — keeping this loss as the original anchor, never replaced. (Two further divergence-side runs, `report-fullcoverage.json` and `report-crosssectional.json`, are also retained and report their OOS results vs B&H as-is.)

## Compliance

- **Public code repo** — https://github.com/agdanish/stoic .
- **Reproducible** — `npm install` → `npm run fetch-data` → `npx ts-node backtest/momentum.ts` (headline) / `npx ts-node backtest/ablation.ts` (layer attribution) / `npm run backtest` (frozen anchor) → `npm test` (498 passing); setup in `README.md`; 2:30–3:00 video.
- **Uses a sponsor capability (CMC mandatory for T2)** — the Skill is built on the CMC Agent Hub MCP (`cmc-mcp`): **7 tools wired** (each backed by a real adapter in `src/data/cmc.ts`, pinned by `test/honesty.test.ts`) **+ 5 documented** for optional context. CMC's **live Fear & Greed** is the contrarian regime gate (keyed round-trip committed under `fixtures/cmc/live/`, F&G = 23).
- **Track-2 deliverable is a backtestable strategy spec as a Skill** — `skills/sentiment-divergence-regime/SKILL.md` emits the Strategy Capsule; `backtest/momentum.ts` backtests the directional pivot (headline) and `backtest/run.ts` the original contrarian anchor.
- **SKILL.md structure** — frontmatter (name == dir, description with triggers, license, compatibility, user-invocable, allowed-tools) + markdown body, per CMC's `cmc-mcp` format.
- **No token launches / fundraising / liquidity / airdrop activity** during the event — n/a, and stated.
- **No on-chain claims** for Track 2 — nothing is written on-chain.

## Honest framing (carried into the submission)

- Backtest is **REAL**, not synthetic (multi-regime Binance daily klines + funding + alternative.me historical Fear & Greed).
- The claim we **lead with** is **lower drawdown** (≈ halved across every window + cost — the regime-independent property). On the bear-tailed held-out OOS the directional core also **beats B&H net of cost on all 3 tokens + aggregate** (`report-momentum.json` `verdict.edgeFound: true`) — but as a **bear-dodge**, disclosed in full: in-sample (a bull) it LAGS B&H +57% vs +262%, the bull mid-window loses by ~37%, BTC/ETH OOS beats are negative-absolute "lost-less" beats, and per-token OOS Sharpe is mixed.
- **We decompose the result rather than assert it.** The ablation (`report-ablation.json`, pinned by `test/ablation.test.ts`; arm A3 == `runStrategy` byte-for-byte) attributes the entire held-out OOS to the directional trend core; the F&G gate is rounding-level on OOS (Δreturn +0.03%) and the divergence/funding risk filter is numerically inert (`divergenceAddsValue: false`, trim=11/veto=0 over 3000 bars). We never claim the "novel" overlays earn OOS — their contribution is risk control + a look-ahead-safe relative-value construct.
- The **original contrarian divergence result is a loss** on every segment (`report.json`), reported straight and retained unchanged as the frozen anchor — never overwritten.
- Cost/slippage is a **configurable assumption**; organizer model unconfirmed; stress at 15+15 and 25+25 bps disclosed.
- CMC **Fear & Greed is LIVE** and is the contrarian regime gate (keyed capture committed, F&G = 23); the unkeyed advisory default is a strict `{0,0}` no-op so the committed reports stay byte-reproducible.
- LLM rationale is **optional and no-op-safe**; the attention leg is **momentum**, not polarity.
- The directional core + F&G gate + divergence risk filter are **NET-NEW**, not a relabel of the predecessor RWA project's stateless sentiment override.
