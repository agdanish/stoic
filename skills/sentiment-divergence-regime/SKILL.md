---
name: sentiment-divergence-regime
description: |
  Emits a BACKTESTABLE crypto trading-strategy SPEC (a "Strategy Capsule") for a
  REGIME-AWARE DIRECTIONAL (trend/momentum) core, modulated by a CoinMarketCap Fear & Greed
  CONTRARIAN regime gate, with a positioning/flow DIVERGENCE signal demoted to a contrarian
  RISK FILTER — not a live order. Resolves the symbol, pulls CoinMarketCap technicals +
  derivatives positioning + the global regime (Fear & Greed / funding) + trending narratives,
  then writes entry / exit / invalidation / sizing / risk rules whose thresholds are the
  engine's own exported constants (single source of truth), plus look-ahead-safe backtest-replay
  instructions. The directional core RIDES bull markets and goes flat in bear/chop; the F&G gate
  trims into extreme greed and favours longs in extreme fear; the divergence/funding overlay
  vetoes entries when positioning diverges into euphoria. Use when the user asks for a
  trend/momentum strategy, a regime-aware directional spec, or a divergence-based risk overlay
  for a token.
  Trigger: "momentum strategy", "trend strategy", "regime-aware strategy", "divergence risk filter", "positioning divergence", "crowd vs flow", "/sentiment-divergence-regime"
license: MIT
compatibility: ">=1.0.0"
user-invocable: true
allowed-tools:
  - mcp__cmc-mcp__search_cryptos
  - mcp__cmc-mcp__get_crypto_quotes_latest
  - mcp__cmc-mcp__get_crypto_technical_analysis
  - mcp__cmc-mcp__get_global_metrics_latest
  - mcp__cmc-mcp__get_global_crypto_derivatives_metrics
  - mcp__cmc-mcp__trending_crypto_narratives
  - mcp__cmc-mcp__get_crypto_metrics
---

# Regime-Aware Directional Core + Fear & Greed Gate + Divergence Risk Filter Skill

This Skill turns a CoinMarketCap data snapshot into a **Strategy Capsule** — a self-contained,
backtestable trading-strategy specification. It does **not** place trades. The deliverable is a
spec (entry / exit / invalidation / sizing / risk + replay instructions) that a human, a
backtester, or a downstream execution agent can run and reproduce.

> **What makes this net-new (not the canned "sentiment divergence" example):** the strategy is a
> **regime-aware composition packaged as a RISK OVERLAY** — a **directional trend/momentum core**
> (`src/signal/momentum.ts`) that RIDES bull markets and goes FLAT in bear/chop, *gated* by a
> **contrarian Fear & Greed regime read** (`src/signal/regimeGate.ts`: trim into extreme greed,
> favour longs in extreme fear) and *risk-filtered* by a **positioning-vs-flow divergence overlay**
> (`src/signal/divergence.ts`, demoted to a veto/trim). It is computed strictly look-ahead-safe
> (every read for bar `t` uses bars `< t` plus the bar's own close; the position decided at `t` is
> held into `t+1`). The bare "is sentiment diverging from price?" idea is the canned example and
> carries no edge on its own; the differentiator is the **composition + the look-ahead-safe
> relative-value cross-sectional construct**, NOT a claim that the divergence overlay earns.
> **Honest scope (the lead claim is DRAWDOWN REDUCTION):** validated on REAL multi-regime DAILY
> data, the overlay roughly **halves max drawdown** vs buy-and-hold across bull/bear/chop (the one
> regime-independent claim); on the bear-tailed held-out OOS it also beats buy-and-hold net-of-cost
> on all 3 tokens + aggregate, but only as a *bear-dodge* (it lags buy-and-hold in bulls, and
> in-sample it loses to the bull by a wide margin). A per-layer **ablation**
> (`backtest/report-ablation.json`) attributes the entire OOS result to the directional core: the
> F&G gate is rounding-level on OOS and the divergence/funding risk filter is numerically **inert**
> on OOS (`divergenceAddsValue: false`) — a non-earning safety veto, exactly as the analysis
> framework below admits. See `backtest/report-momentum.json`, `backtest/report-ablation.json`,
> and `ROBUSTNESS-momentum.md`.

## Core Principle

> **The deterministic engine is the product; CoinMarketCap is the live data + regime read; the
> LLM is optional rationale.** Every threshold in the emitted Capsule is an **exported constant**
> from the reference engine (`src/signal/momentum.ts`, `src/signal/regimeGate.ts`,
> `src/signal/strategy.ts`, `src/signal/core.ts`, and the divergence risk filter
> `src/signal/divergence.ts`). Cite the constant by name — never hard-code a copied number. If the
> engine constant changes, the Capsule changes; there is one source of truth. When a CMC field is
> unavailable, the corresponding leg degrades to "absent" (it is dropped, never fabricated), and
> any optional advisory it would have produced becomes a strict no-op `{adjustment:0, confidence:0}`
> — so the Capsule stays honest and the backtest stays byte-reproducible.

## Prerequisites

- A working **CoinMarketCap MCP API key** (free, 10k credits/mo at `pro.coinmarketcap.com`),
  configured for the `cmc-mcp` MCP server:
  - URL: `https://mcp.coinmarketcap.com/mcp`
  - Header: `X-CMC-MCP-API-KEY: <your key>`
  - (Keyless alternative: the x402 surface `https://mcp.coinmarketcap.com/x402/mcp`, $0.01 USDC/call on Base 8453.)
- **NEEDS YOUR FREE CMC KEY** — without it the live legs cannot be pulled. The strategy logic and
  thresholds are fully defined offline (they are engine constants), and the backtest runs on FREE
  Binance public REST history with no CMC key, but the *live regime read* in the Capsule's
  "current regime" field requires the key.
- For the backtest-replay step: Node + the reference repo (`stoic`), `npm install`,
  `npm run fetch-data` then `npm run backtest`. No key needed for the historical backtest (it uses
  Binance public REST: klines + funding + long/short account ratio + taker buy/sell volume).

## The strategy in one line (the assembly, `src/signal/strategy.ts`)

```
1. DIRECTIONAL CORE   (momentum.ts)    → trend/momentum bias on 0..1000 (>500 long, <500 flat/short)
2. F&G CONTRARIAN GATE (regimeGate.ts)  → extreme GREED trims/flattens a long; extreme FEAR favours a long
                                          (multiplicative gain bounded [GATE_MIN, GATE_MAX] on the EDGE; never flips sign)
3. DIVERGENCE/FUNDING RISK FILTER       → a LONG bias into extreme greed + stretched-positive funding
                                          (crowded longs unconfirmed) → REDUCE size or VETO entry
4. blendScore (core.ts) folds bounded CMC/LLM advisories ({0,0}=no-op) → sizeFromConviction → decideTrade
```

- **Directional core** = a fast/slow EMA trend separation + price momentum over `MOMENTUM_LOOKBACK`,
  mapped to core.ts's 0..1000 BULLISH scale (500 = no directional edge). In a bull it tracks B&H
  (with EMA lag); in bear/chop it goes flat — the source of the bear-dodge edge.
- **Fear & Greed contrarian gate** = CoinMarketCap's own guidance: extreme GREED (F&G ≥ `GREED_EXTREME`)
  is "overvalued" → trim/flatten a long; extreme FEAR (F&G ≤ `FEAR_EXTREME`) is a "bargain" → favour a
  long. This is the **live CMC Fear & Greed read** (latest keyed capture F&G = 23 → extreme fear).
- **Divergence/funding risk filter** = the original contrarian positioning read (`divergence.ts`),
  demoted: it vetoes/trims a long that coincides with euphoric, unconfirmed positioning. On the
  multi-year DAILY backtest it uses **funding-vs-price + F&G euphoria** (funding has deep history);
  the long/short account ratio + taker-ratio legs have only ~30d history and stay a recent/live
  refinement (honest label: attention/narrative velocity, **not** sentiment polarity).

## Engine constants (single source of truth — cite these, do not copy the numbers)

All values below are the **current exported constants**. The reference is the engine, not this
file; if the engine and this table ever disagree, **the engine wins**. They are reproduced here
ONLY so the Capsule template can name them.

### Directional core + regime gate + risk filter (the new pipeline)

Read from `src/signal/momentum.ts`, `src/signal/regimeGate.ts`, `src/signal/strategy.ts`,
`src/signal/core.ts`. These drive the regime-aware directional strategy validated in
`backtest/report-momentum.json`.

| Constant (module) | Module default | Role |
|---|---|---|
| `EMA_FAST` / `EMA_SLOW` (momentum.ts) | `20` / `50` | fast/slow EMA spans for the trend leg (selected backtest config: **30 / 80**) |
| `MOMENTUM_LOOKBACK` (momentum.ts) | `20` | price-momentum lookback (bars) for the directional core |
| `TREND_FULL_SEP` (momentum.ts) | `0.06` | EMA separation that saturates the trend leg |
| `MOMENTUM_FULL_RET` (momentum.ts) | `0.15` | momentum return that saturates the momentum leg |
| `TREND_WEIGHT` / `MOMENTUM_WEIGHT` (momentum.ts) | `0.6` / `0.4` | blend weights of trend vs momentum into the directional bias |
| `FEAR_EXTREME` / `GREED_EXTREME` (regimeGate.ts) | `25` / `75` | F&G ≤ / ≥ → extreme fear (favour long) / extreme greed (trim long) |
| `GATE_MAX` / `GATE_MIN` (regimeGate.ts) | `1.25` / `0.4` | bounds of the multiplicative regime gain on the directional edge |
| `FUNDING_STRETCHED` (strategy.ts) | `0.0005` | `\|funding\|` above this → stretched-positive funding → risk-filter trigger |
| `RISK_FILTER_TRIM` (strategy.ts) | `0.5` | size multiplier applied when the divergence/funding risk filter trims |
| `RISK_FILTER_VETO_INTENSITY` (strategy.ts) | `0.6` | risk-filter intensity at/above which an entry is vetoed (flattened) |
| `ENTRY_THRESHOLD` / `ENTRY_MIN` / `ENTRY_MAX` (core.ts) | `120` / `60` / `220` | `\|conviction−500\|` to trade + calibration bounds |

### Divergence risk-filter internals (the demoted contrarian leg, `src/signal/divergence.ts`)

The original contrarian divergence engine is **retained** and reused as the risk-filter leg; its
constants still apply where it is invoked (and on the original hourly divergence backtest in
`report.json`). Re-exported from `src/signal/signalEngine.ts` for a single import surface.

| Constant (module) | Current value | Role in the Capsule |
|---|---|---|
| `ZSCORE_WINDOW` (divergence.ts) | `48` | rolling z-score lookback `W` (bars) |
| `ZSCORE_MIN_OBS` (divergence.ts) | `12` | min past obs before a z-score is defined (else z = 0, "warming up") |
| `MOMENTUM_LOOKBACK` (divergence.ts) | `12` | price-momentum lookback for the flow leg |
| `DIVERGENCE_DEADBAND_Z` (divergence.ts) | `0.5` | `|divergence|` below this → no edge (`divergenceBias` = 500) |
| `DIVERGENCE_FULL_Z` (divergence.ts) | `2.5` | `|divergence|` at/above this (after regime gain) saturates the bias scale |
| `FEAR_EXTREME` (divergence.ts) | `25` | Fear & Greed ≤ this → extreme-fear regime (favours LONG) |
| `GREED_EXTREME` (divergence.ts) | `75` | Fear & Greed ≥ this → extreme-greed regime (favours SHORT) |
| `FUNDING_STRETCHED` (divergence.ts) | `0.0005` | `|funding|` (fraction/interval) above this → stretched funding regime (amplifies the read) |
| `REGIME_GATE_MAX` / `REGIME_GATE_MIN` (divergence.ts) | `1.35` / `0.5` | regime gain when the regime agrees / disagrees with the contrarian read (1.0 = neutral) |
| `ENTRY_THRESHOLD` (core.ts) | `120` | `|conviction−500|` must exceed this to take a trade |
| `ENTRY_MIN` / `ENTRY_MAX` (core.ts) | `60` / `220` | bounds of the online-calibrated entry threshold |
| `CALIBRATION_STEP` (core.ts) | `10` | entry-threshold nudge per resolved outcome |
| `CONVICTION_FLAT` (core.ts) | `500` | flat / no-edge midpoint of the 0..1000 conviction scale |
| `REGIME_FLATTEN_BAND` (core.ts) | `60` | `|divergenceBias−500|` below this → pull conviction toward flat |
| `STRONG_DIVERGENCE` (core.ts) | `200` | `|divergenceBias−500|` at/above this → full-weight conviction branch |

## Workflow

### 1. Resolve the symbol FIRST (`search_cryptos`)

Every quotes / TA / metrics tool keys off the CMC **numeric id**, not the ticker. Call
`mcp__cmc-mcp__search_cryptos` with the ticker (e.g. `"BTC"`), take the exact-symbol match (else the
highest-ranked row), and carry its numeric `id` into every later call. If no id resolves, stop and
report — do not guess an id.

### 2. Pull the data legs (batch where independent)

These four calls are independent — issue them together:

- `mcp__cmc-mcp__get_crypto_technical_analysis` (id) → RSI / MACD histogram / EMA50 / EMA200 / ATR
  (the trend + momentum context terms).
- `mcp__cmc-mcp__get_global_crypto_derivatives_metrics` (symbol) → **funding rate**, open interest,
  liquidations, **long/short ratio** (the crowd/positioning leg + the funding regime input).
- `mcp__cmc-mcp__get_global_metrics_latest` → **Fear & Greed** (0..100), BTC dominance, altseason
  (the regime read).
- `mcp__cmc-mcp__trending_crypto_narratives` → narrative **attention momentum** (optional crowd-leg
  advisory; honest label = attention velocity, not polarity).

Optional context (only if relevant to the request):

- `mcp__cmc-mcp__get_crypto_quotes_latest` (id) → spot price + 24h change (provenance / position
  sizing context).
- `mcp__cmc-mcp__get_crypto_metrics` (id) → holder / whale concentration (optional concentration term).

**Defensive reads:** every CMC field can be absent or a surprise shape. Treat a missing field as
"absent" — drop that leg this bar; do not coerce to zero or invent a value.

### 3. Compute the directional core (trend/momentum)

Apply the directional core (`momentum.ts`) on the price history (look-ahead-safe; EMAs are a
forward recurrence over closes `≤ t`):

- Trend leg: the fast/slow EMA separation (`EMA_FAST`/`EMA_SLOW`), saturating at `TREND_FULL_SEP`.
- Momentum leg: the return over `MOMENTUM_LOOKBACK`, saturating at `MOMENTUM_FULL_RET`.
- Blend by `TREND_WEIGHT` / `MOMENTUM_WEIGHT` into a 0..1000 **directional bias** (>500 = long,
  <500 = flat/short). In a bull this leans long (rides the trend); in bear/chop it pulls toward
  flat.

### 4. Read the regime + apply the F&G contrarian gate, then the risk filter (look-ahead-safe)

This is the engine path the Capsule is a spec OF — for a *live single-bar* read you apply it to the
history ending at the prior bar; for the *backtest* the engine walks every bar (step 6). Both use
the identical code (`strategy.ts`):

1. **F&G contrarian gate** (`regimeGate.ts`): Fear & Greed ≤ `FEAR_EXTREME` → extreme fear → keep/
   boost a long bias and dampen a short; Fear & Greed ≥ `GREED_EXTREME` → extreme greed → scale the
   long bias DOWN (trim/flatten); neutral → pass-through (gain 1.0). The gain is multiplicative on
   the directional EDGE (distance from 500), bounded `[GATE_MIN, GATE_MAX]`; it **never flips** the
   core's sign.
2. **Divergence/funding risk filter** (the demoted contrarian read): when a LONG bias coincides with
   extreme greed AND stretched-positive funding (`|funding|` ≥ `FUNDING_STRETCHED` = crowded longs
   unconfirmed), trim size by `RISK_FILTER_TRIM` or, at/above `RISK_FILTER_VETO_INTENSITY`, VETO the
   entry (flatten). On the multi-year DAILY backtest this uses funding + F&G; the long/short account
   ratio + taker-ratio legs (~30d history) are a recent/live refinement only.
3. `blendScore` (core.ts) folds any optional CMC/LLM advisory (each a strict `{0,0}` no-op when
   absent) into the final 0..1000 conviction (500 = flat).

### 5. Decide the trade (the entry rule the Capsule encodes)

`decideTrade` (src/agent/decide.ts): with `edge = conviction − CONVICTION_FLAT`,

- `|edge| ≤ threshold` → **FLAT** (size 0); `threshold` defaults to `ENTRY_THRESHOLD`, calibratable
  within `[ENTRY_MIN, ENTRY_MAX]` via `calibrateEntryThreshold`.
- `edge > 0` → **LONG**, `edge < 0` → **SHORT**; size = `sizeFromConviction(conviction)` bps
  (distance from flat scaled linearly, 0 bps at flat → 10000 bps at the extremes).

### 6. Emit the Strategy Capsule + backtest-replay instructions

Fill the **Strategy Capsule** template below from the live reads (regime, universe, current
divergence/conviction) and the engine constants (entry / exit / invalidation / sizing / risk). Then
append the look-ahead-safe **backtest-replay** instructions so the reader can reproduce the edge on
a held-out window. Validate the JSON Capsule against `capsule.schema.json` (same folder) before
returning it.

## Analysis framework

- **Why a directional core (the new earner):** a contrarian signal cannot out-earn buy-and-hold in
  a rising market — that is why the original purely-contrarian divergence backtest lost (`report.json`).
  A trend/momentum core *rides* the bull (tracking B&H with EMA lag) and *goes flat* in bear/chop,
  so it loses far less when the market falls. **Honest mechanism, both directions:** on the
  multi-regime DAILY backtest (`report-momentum.json`) the held-out OOS beats B&H net-of-cost on all
  3 tokens + aggregate — but as a **bear-dodge**: in-sample (a bull) it LAGS B&H by a wide margin
  (+57% vs +262%), and in a bull mid-window it loses to B&H by ~37% (`ROBUSTNESS-momentum.md`). The
  robust claim is roughly-halved drawdown. The OOS beat is never presented as regime-independent alpha.
- **Why the Fear & Greed contrarian gate:** CoinMarketCap's own guidance treats extreme greed as
  overvalued and extreme fear as a bargain. Gating the directional core with it trims longs into
  euphoria and favours longs in capitulation — a contrarian overlay that is the **live CMC read**
  (alternative.me historical F&G, ~100% coverage, is the backtest proxy). **Honest about its size:**
  the ablation (`backtest/report-ablation.json`) shows the gate's OOS effect is rounding-level
  (Δreturn +0.03%, ΔSharpe +0.0011) and that it is a mild drag in-sample (it trims longs into the
  greedy bull). It is a sensible regime overlay, not an OOS edge — we present it as such.
- **Why the divergence is demoted to a risk filter (and what the ablation says about it):** the
  positioning-vs-flow divergence has **no standalone return edge here** — it is kept purely as a
  risk-control veto that flattens a long the trend core wants while positioning is euphoric and
  unconfirmed (crowded longs + stretched funding). The per-layer ablation
  (`backtest/report-ablation.json`) is blunt about its OOS contribution: the filter is
  **numerically inert on the held-out OOS** (ΔSharpe −3e-12, Δreturn 0.00%) and fired trim=11 /
  veto=0 across the entire 3-token × 1000-bar universe, almost all of it in-sample
  (`divergenceAddsValue: false`). It only bites a LONG running into extreme greed + stretched-positive
  funding, which on a 2026-drawdown (FEAR) OOS essentially never occurs. We keep it for the
  risk-control behaviour it encodes, **not** as a return engine, and never claim it earns OOS.
  A test pins `|ΔOOS return| < 5 bps` as an honesty guard.
- **Why cross-sectional dislocation (a divergence-side differentiator):** the per-token divergence is
  a *time-series* read — this token vs its own history. The net-new **cross-sectional dislocation**
  term (`src/signal/crossSectional.ts`) is a *relative-value* read: at each bar it **demeans the
  divergence across the {BTC, ETH, BNB} panel** and re-standardises by the panel's dispersion, then
  fades only the **most dislocated** token. The demean removes the common market-wide (beta)
  component — when the whole market is crowded long, the per-token signal fires SHORT on every token
  (= shorting beta, no edge); subtracting the panel mean leaves only the **idiosyncratic residual**,
  the token offside *relative to its peers*, which is the cleaner mean-reversion target. This is a
  market-neutral-flavoured selection the per-token engine cannot express. It is look-ahead-safe (the
  cross-section at bar `t` reads only per-token divergences each computed from bars `< t`; a
  dedicated truncation-invariance test pins it) and validated head-to-head against the per-token arm
  on the same full-coverage slice + walk-forward + cost model (`backtest/crossSectional.ts` →
  `report-crosssectional.json`). The held-out OOS is reported **unconditionally**: it improves on the
  per-token arm (lower loss, far lower drawdown) but does **not** beat buy-and-hold on the rising OOS
  tail — stated plainly, never overclaimed.
- **Why look-ahead-safe matters:** any read that peeks at future bars inflates every backtest metric.
  Every read for bar `t` uses only closes `≤ t` (EMAs are a forward recurrence) plus the bar's own
  F&G/funding; the position decided at `t` is held into `t+1`, so the decision precedes the move it
  is paid on. Appending or truncating future bars cannot change any past bar's conviction. This is
  the property the dedicated leakage tests pin (for both the directional and divergence engines).
- **Honesty:** the live CMC narrative term is **attention momentum**, not sentiment polarity — it is
  folded as a bounded advisory and degrades to a no-op offline, so it never silently props up the
  backtest. Report metrics on a **held-out** out-of-sample window vs **buy-and-hold**; never
  cherry-pick the window.

## Report structure — the Strategy Capsule

Return BOTH (a) a human-readable Capsule using the template below, and (b) the machine-readable JSON
that validates against `capsule.schema.json`. Every numeric rule cites its engine constant by name.

```
STRATEGY CAPSULE — Regime-Aware Directional Core + F&G Gate + Divergence Risk Filter
====================================================================================
Strategy id     : sentiment-divergence-regime
Generated       : <ISO-8601 UTC>   |  Engine constants version: <git sha / package version>
Data sources    : CMC MCP (live regime/positioning/narratives) + Binance public REST (backtest history)

REGIME (live read, step 4 — the CONTRARIAN gate)
  Fear & Greed  : <value 0..100>  → <extreme-fear | neutral | extreme-greed | unknown>
                  (FEAR_EXTREME=<…>, GREED_EXTREME=<…>)
  Funding       : <funding fraction/interval>  → <stretched-positive | normal>  (FUNDING_STRETCHED=<…>)
  Gate effect   : <extreme greed → trim/flatten long | extreme fear → favour long | neutral → pass-through>
  Regime gain   : <… bounded [GATE_MIN, GATE_MAX], multiplicative on the directional edge; never flips sign>

UNIVERSE
  Symbol(s)     : <e.g. BTC>   CMC numeric id(s): <from search_cryptos, step 1>
  Bar interval  : 1d           Pair convention: <SYMBOL>USDT
  (Resolve every symbol via search_cryptos first; an unresolved id is excluded, never guessed.)

SIGNAL (current bar, look-ahead-safe — reads only closes ≤ t + the bar's own F&G/funding)
  directionalBias : <0..1000, 500 = no directional edge, >500 long, <500 flat/short>
  gatedBias       : <directionalBias after the F&G contrarian gain>
  riskFilter      : <none | trim×RISK_FILTER_TRIM | VETO>  (long into greed + stretched funding)
  conviction      : <0..1000, 500 = flat, after blendScore folds any {0,0}-default advisory>
  Core params     : EMA_FAST/EMA_SLOW (selected 30/80), MOMENTUM_LOOKBACK, TREND_WEIGHT/MOMENTUM_WEIGHT
  Saturation      : trend at TREND_FULL_SEP, momentum at MOMENTUM_FULL_RET

ENTRY RULE
  Compute conviction via the strategy assembly (strategy.ts). Trade only when
  |conviction − CONVICTION_FLAT| > ENTRY_THRESHOLD (calibratable in [ENTRY_MIN, ENTRY_MAX]).
    conviction > 500 + ENTRY_THRESHOLD → LONG
    conviction < 500 − ENTRY_THRESHOLD → SHORT  (the selected backtest config is LONG/FLAT only)
  (Directional: an uptrend drives conviction above 500 → LONG; a downtrend/flat read pulls toward 500.)

EXIT RULE
  Exit to FLAT when |conviction − CONVICTION_FLAT| falls back to ≤ ENTRY_THRESHOLD (the trend
  weakens / momentum fades), OR the side flips (decideTrade.flip = true → close then re-enter).

INVALIDATION
  - Trend separation collapses / momentum reverses → directional bias returns toward 500 → FLAT.
  - The F&G gate flips against the open side (extreme greed onto an open long) → trim/flatten.
  - The divergence/funding risk filter fires at/above RISK_FILTER_VETO_INTENSITY → VETO/flatten.

POSITION SIZING
  sizeBps = sizeFromConviction(conviction): 0 bps at flat → 10000 bps at the conviction extreme,
  linear in |conviction − CONVICTION_FLAT|, then scaled by the risk filter (trim) and maxLeverage.
  Scale by the account's per-trade risk budget.

RISK LIMITS
  - Per-trade cap: clamp sizeBps to your max single-position bps; selected config maxLeverage = 1.0.
  - Entry selectivity self-tunes via calibrateEntryThreshold, bounded to [ENTRY_MIN, ENTRY_MAX].
  - No look-ahead: every read at bar t uses only closes ≤ t; position held into t+1.
  - Optional advisories (CMC F&G / RSI / narratives / LLM) are bounded via blendScore and can never
    override the deterministic engine; absent → strict {0,0} no-op.

BACKTEST-REPLAY INSTRUCTIONS (reproduce the result, look-ahead-safe)
  1. npm install
  2. npm run fetch-data   # FREE Binance public REST (daily klines + funding) + alternative.me F&G
                          #   → validated multi-regime DAILY bar fixtures (no CMC key needed)
  3. npx ts-node backtest/momentum.ts   # walk-forward over the real DAILY bars via the strategy
                          #   assembly: directional core → F&G gate → risk filter → decideTrade,
                          #   apply simulated tx cost + slippage, emit report-momentum.json
  4. Report on the HELD-OUT out-of-sample window: total return, max drawdown, Sharpe/Sortino — vs
     buy-and-hold, per token + aggregate. Params selected on the in-sample 70% ONLY; OOS run once.
     LEAD with the drawdown-reduction claim (≈ halved); present the absolute OOS beat as a
     bear-dodge. Stress at 15+15 / 25+25 bps and per-regime are disclosed (ROBUSTNESS-momentum.md).
  5. npx ts-node backtest/ablation.ts   # per-layer attribution → report-ablation.json: confirms the
     directional core is the entire OOS earner and the F&G gate + divergence filter are
     marginal-to-inert on OOS (A3 reproduces runStrategy byte-for-byte; pinned by test/ablation.test.ts).
  6. Determinism: with no CMC/LLM key the advisories are {0,0} no-ops, so report-momentum.json is
     byte-reproducible from the committed fixtures (rebuts "one lucky run"). The frozen original
     contrarian report.json is retained, byte-identical, as the original anchor.
  7. npx ts-node backtest/cmc-regime-briefing.ts   # multi-tool CMC explainability TRACE: composes
     ALL 7 wired CMC MCP tools into ONE regime briefing (call + real returned value + interpretation
     per tool, then a combined regime read), replaying the committed live captures (fixtures/cmc/live/*.json)
     through the production parsers with NO key → fixtures/cmc/live/regime-briefing.json. HONEST scope:
     this is a regime briefing, NOT a backtest — only the Fear & Greed gate + RSI advisory feed the
     committed decision; the other 5 tools are context, and derivedStance is a description, not alpha.
```

## Error handling

- **No CMC id resolves** (`search_cryptos` empty) → stop; report the symbol could not be resolved.
  Never invent a numeric id.
- **A live CMC leg is missing / malformed** → treat that leg as absent (dropped from the rolling
  window) and any advisory it would emit becomes `{0,0}`; the Capsule still emits from the remaining
  legs and is labelled with which legs were unavailable.
- **No CMC key** → emit the Capsule with the strategy logic + engine-constant thresholds fully
  populated and the live "REGIME" / "SIGNAL" fields marked "NEEDS YOUR FREE CMC KEY"; the
  backtest-replay path still runs (it uses only Binance public REST).
- **Any threshold the user asks to change** → change the engine constant and regenerate; never edit
  a number only in the Capsule (that breaks the single-source-of-truth contract).

## Adapting to user sophistication

- **Casual** → return the human-readable Capsule (regime + current side + the one-line signal) and
  a plain-English "why".
- **Quant / builder** → include the JSON Capsule, the engine-constant table, and the
  backtest-replay block so they can reproduce and re-parameterise.
