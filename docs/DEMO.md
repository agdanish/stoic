# Stoic — Demo Script (BNB Hack: AI Trading Agent Edition, Track 2 — Strategy Skills)

**One-liner:** Stoic is a CoinMarketCap **Skill** that turns live Agent Hub data into a
**backtestable Strategy Capsule** — a **regime-aware directional (trend/momentum) core** gated by
CMC's **live Fear & Greed** contrarian read, with a positioning-vs-flow divergence overlay demoted
to a risk filter. It does not place trades; it emits a deterministic spec anyone can replay on real
multi-regime market history, and it reports the result **honestly**: on the held-out out-of-sample
window the directional core **beats buy-and-hold net of cost on all three tokens** — but as a
**bear-dodge**, not standalone alpha (it *lags* buy-and-hold in bulls). The **robust, defensible
claim we lead with is roughly-halved drawdown**; the absolute beat is presented truthfully as
regime-conditional.

> Target length **2:30–3:00**. Record screen + voiceover. Everything shown is real: real CMC Agent
> Hub tool names + wiring (CMC Fear & Greed now LIVE), a real keyless Binance multi-regime daily
> backtest, and metrics read straight from the committed `backtest/*.json`. **No fabricated numbers.
> No invented edge.** Where the strategy lags or loses (in-sample, bull windows), the script says so
> on camera.

---

## What this demo leads with (and why)

This demo leads with the robust, honest result and shows how each point below is **addressed or honestly reframed**, in order:

| Prior gap | What the demo now shows |
|---|---|
| **Negative edge** (original contrarian: full −36.5% vs B&H −5.4%) | We **pivoted the thesis**: a regime-aware **directional trend/momentum core** validated on REAL multi-regime DAILY data. The held-out OOS **beats B&H net-of-cost on all 3 tokens + aggregate** (`report-momentum.json` `verdict.edgeFound: true`) — a *bear-dodge*, with **roughly-halved drawdown** the robust spine. The original contrarian loss is retained, labelled, as the frozen anchor. |
| **CMC not wired** into the evaluated product | CMC's **Fear & Greed is now LIVE** (keyed round-trip committed, F&G = 23) and is the contrarian regime gate; CMC is also wired into the backtest via `RunOpts.advisoryProvider` and **CMC=ON vs CMC=OFF measurably differs**, the tilt **flips sign** with F&G (`report-cmc-compare.json`). |
| **Degenerate construct** (flow legs on ~17% of bars) | The daily backtest uses funding + price (deep history) for the risk filter; the genuine two-leg construct is also re-run on a **full-coverage slice** (`report-fullcoverage.json`). |
| **No demo / anticlimactic hero** | This script + committed dashboard screenshots; the hero fixture is pinned to an **extreme regime** so the contrarian gate fires on camera. |

**Hard honesty rule for the presenter:** the held-out OOS *does* beat buy-and-hold on return — but
**only ever say so framed as a bear-dodge, never as regime-independent alpha.** Always pair it with:
in-sample (a bull) it LAGS B&H +57% vs +262%, a bull mid-window loses by ~37%, BTC/ETH OOS beats are
negative-absolute "lost-less" beats, and per-token Sharpe is mixed. **Lead with the robust claim —
roughly-halved drawdown across bull/bear/chop.** The other on-camera claims: the engine is
look-ahead-safe; every number is byte-reproducible from committed fixtures; CMC's live Fear & Greed
demonstrably gates the product.

---

## Before you hit record (setup)

1. `npm install` once. The reports are already committed — the demo **reads** them; do **not**
   regenerate on camera against a flaky network.
2. Serve the dashboard so its `../backtest/report-momentum.json` fetch resolves:
   - `npx http-server . -p 8123 -c-1` from the repo root, then open
     `http://localhost:8123/frontend/index.html`.
   - Confirm the page titles **"Stoic — Regime-Aware Risk Overlay"**, the honesty banner
     reads **"What this edge IS — and is NOT"**, the regime gate renders **"extreme greed → gate TRIM"**
     (F&G **78 ≥ GREED_EXTREME**), and the Backtest card (the **HEADLINE**, read from
     `report-momentum.json`) shows the held-out OOS aggregate **Max drawdown 17.7% vs B&H 58.3%**
     (the robust claim) and **−0.3% vs B&H −43.5%** with a visible **0% (break-even)** baseline.
     Flip the window toggle to **in-sample (bull)** to show the honest lag (**+57.5% vs B&H +262.1%**),
     and expand the **DEPRECATED original contrarian prototype** panel at the bottom to show the
     retained loss (`report.json`, **−36.5%** / OOS **−18.1%**). (Pre-captured proof:
     `docs/assets/dashboard-hero.png`, `docs/assets/dashboard-hero-fold.png`.)
3. Have a terminal ready for `npm test` (shows **498 passing**, incl. the look-ahead-bias suite, the
   21 momentum tests and the 20 ablation tests) and for `npx ts-node backtest/momentum.ts` (regenerates
   `report-momentum.json` byte-identical — the headline result). Have `backtest/report-momentum.json`
   open in an editor to read the OOS numbers verbatim. (The dashboard headline now renders the
   *risk-overlay* result directly from `report-momentum.json`; the *original contrarian anchor*
   from `report.json` is reachable only via the clearly-labelled DEPRECATED panel, never as the hero.)
4. (Special-prize scene) The live CMC round-trip is **done and committed** under `fixtures/cmc/live/`
   (F&G = 23, RSI 41.85, price + funding all `available: true`). Have `fixtures/cmc/live/_manifest.json`
   ready to show. If re-capturing live on camera, set a free `CMC_MCP_API_KEY` and run
   `npx ts-node backtest/cmc-live-roundtrip.ts`.

---

## Scene-by-scene (voiceover + what's on screen)

### 0:00 – 0:18 · Hook (lead with the robust, honest result)
> *"Most trading demos show you a green equity curve and hope you don't ask how. I'm going to do the
> opposite. Stoic is a CoinMarketCap strategy Skill. On real multi-regime data, our directional
> core beats buy-and-hold out-of-sample on all three tokens — but I want to be precise about why: it
> beats it by **sitting out the bear**, not by out-earning the bull. The claim I'll stand behind on
> every window is that it roughly **halves drawdown**. That's the honest product: a regime-aware
> directional strategy with a live CoinMarketCap Fear-and-Greed gate."*
**Screen:** the dashboard hero, then `backtest/report-momentum.json` → `aggregate.outOfSample`
(strategy −0.32% vs B&H −43.50%; maxDD 17.7% vs 58.3%).

### 0:18 – 0:45 · What it is
> *"It's a CoinMarketCap **Skill**. Given a symbol it resolves the CMC id, pulls technicals,
> derivatives positioning, the Fear-and-Greed regime, and trending narratives across the Agent Hub,
> and writes a **Strategy Capsule** — entry, exit, invalidation, sizing, risk. Every threshold in
> that Capsule is an **exported engine constant** — one source of truth, no copied magic numbers. It
> doesn't trade; it emits a spec a backtester, a human, or a Trust-Wallet execution agent can replay
> and reproduce."*
**Screen:** `skills/sentiment-divergence-regime/SKILL.md` frontmatter (`allowed-tools:
mcp__cmc-mcp__…`, **7 tools**) and the Capsule template; then the dashboard **Engine Constants** card.

### 0:45 – 1:20 · The strategy (the originality core)
> *"Here's the mechanic — three layers. **One**, a **directional trend-momentum core**: fast and slow
> EMAs plus price momentum. In an uptrend it goes long and rides it; in a downtrend or chop it goes
> flat. **Two**, a **contrarian Fear-and-Greed gate** — this is CoinMarketCap's own index, live. Extreme
> greed means overvalued, so we trim the long; extreme fear means bargain, so we favour it. It scales
> the position; it never flips the trend's sign. **Three**, the old positioning-vs-flow **divergence**
> signal, demoted to a **risk filter** — it vetoes a long that's running into euphoric, unconfirmed
> crowding. Every read for a bar uses only that bar and the past, and the position is held into the
> next bar, so the decision precedes the move it's paid on — a dedicated test pins exactly that."*
**Screen:** the **Regime Read** card live (the live CMC Fear & Greed gate); then the directional /
conviction signal-over-time chart.

### 1:20 – 1:45 · Look-ahead safety, on camera
> *"This is the claim everything rests on, so let's prove it, not assert it."*
**Screen:** in terminal, run **`npm test`** → **498 passing**. Point to the suites
*"LOOK-AHEAD BIAS — appending/truncating FUTURE bars cannot change the PAST"* and the momentum
look-ahead/truncation-invariance tests (`test/momentum.test.ts`, `test/strategy.test.ts`).
> *"Four hundred and thirty-six tests. Truncate the series at any bar — every past read, every past
> conviction, every past trade is byte-identical. The future cannot leak into the past. That's a
> property, machine-checked, on both the directional and divergence engines."*

### 1:45 – 2:10 · Live CoinMarketCap Agent Hub — Fear & Greed gates the product
> *"The eval's sharpest hit was that CoinMarketCap, the thing we're branded on, didn't touch the
> evaluated product. It does now — and it's **live**. We pulled a keyed CoinMarketCap round-trip:
> Fear-and-Greed twenty-three, RSI forty-two, price and funding, all parsing. Fear-and-Greed twenty-
> three is extreme fear — and that's exactly the contrarian gate input: extreme fear favours staying
> long. Watch what the keyed read does to the conviction."*
**Screen:** show `fixtures/cmc/live/_manifest.json` (the LIVE capture: F&G 23, RSI 41.85, funding,
price), then `backtest/report-cmc-compare.json` `sensitivitySweep`:
> *"Across the regime axis the tilt flips sign — extreme **fear** tilts the conviction contrarian-
> **bullish**, extreme **greed** tilts it **bearish**, neutral is zero. The keyed read changes the
> conviction on every bar across three tokens, and the backtest metrics differ from the offline run.
> The unkeyed default is a strict zero-zero no-op, so the committed reports stay byte-reproducible."*

### 2:10 – 2:40 · The honest backtest (the trust scene)
> *"Now the result, straight, and this is the part I most want you to trust. Our **original** purely-
> contrarian strategy **lost** — minus thirty-six percent versus minus five for buy-and-hold. We keep
> that loss committed in `report.json`, untouched, because that's why we pivoted: a contrarian signal
> can't out-earn a rising market. So we changed the thesis — a directional core on multi-regime daily
> data — and we report it honestly, in-sample **and** out-of-sample. **In-sample, in a big bull, we
> LOSE to buy-and-hold by a wide margin — plus fifty-seven percent versus plus two-sixty-two.** A
> trend-follower can't out-earn a tripling market; we say so. **Out-of-sample**, in the 2026 drawdown,
> we beat buy-and-hold on all three tokens — but by **dodging the bear**: we go flat while it falls.
> Two of those three beats are 'lost less,' not gains, and I'll tell you that on camera. The claim
> that holds on **every** window I tested is the one I lead with: we roughly **halve the drawdown** —
> seventeen-point-seven percent versus fifty-eight."*
**Screen:** `backtest/report-momentum.json` → `aggregate.inSample` (+57.48% vs +262.05%),
`aggregate.outOfSample` (−0.32% vs −43.50%, maxDD 17.7% vs 58.3%), `verdict` (`edgeFound: true`),
then `ROBUSTNESS-momentum.md` (the bull mid-window loses to B&H by ~37%; lower drawdown is robust),
then `backtest/report-ablation.json` `verdict` + `attribution`.
> *"And I'll go one further — I'll show you which layer actually does the work. We ablate the
> pipeline one layer at a time. The trend core alone produces the entire out-of-sample result — the
> whole bear-dodge, the whole halved drawdown. The Fear-and-Greed gate moves it by hundredths of a
> percent; the divergence risk filter is numerically inert out-of-sample — it's a safety veto, and
> we say so in the JSON. We don't pretend the fancy layers earn. The earner is the trend core; the
> claim we stand behind is the drawdown reduction. Every word of that is in the JSON and the
> robustness report — the lag and the bear-dodge said out loud."*

### 2:40 – 2:55 · Why it fits Track 2
> *"Track 2 asks for a backtestable strategy Skill, not a live trader — and that's exactly this: a
> regime-aware directional spec with a live CoinMarketCap Fear-and-Greed gate, a deterministic engine,
> a look-ahead-safe backtest on multi-regime data, and a Capsule any execution layer can consume.
> The strategy logic is the deliverable; the engine is the product; the LLM is optional rationale
> that no-ops when it's absent."*
**Screen:** the README Track-2 rubric table.

### 2:55 – 3:00 · Close
> *"Stoic: original where it counts, real in its data, and honest about its results — a
> regime-aware directional strategy that rides the bull, dodges the bear, and roughly halves drawdown,
> not a fairy-tale equity curve. One command reproduces every number you just saw."*
**Screen:** the quick-start block; `npx ts-node backtest/momentum.ts` regenerating
`report-momentum.json` byte-identical (and `npm run backtest` regenerating the frozen `report.json`).

---

## Why it earns the score (mapped to the Track 2 rubric)

| Rubric axis | Stoic's answer |
|---|---|
| **Technical execution** | Deterministic pure engine: directional trend/momentum core + F&G gate + divergence risk filter; dedicated look-ahead-bias suite; cost-inclusive walk-forward backtester on multi-regime daily data; per-layer ablation (A3 == `runStrategy` byte-for-byte); live CMC Fear & Greed gate; **498** mocha+chai tests; GitHub Actions CI (`tsc --noEmit` + `npm test`). |
| **Originality** | A **regime-aware composition packaged as a risk overlay** — directional core *gated* by a contrarian CMC Fear & Greed read and *risk-filtered* by a positioning-vs-flow divergence overlay — that rides bulls, dodges bears and roughly halves drawdown, validated on real multi-regime daily data. A per-layer **ablation** attributes the OOS result honestly (trend core earns; gate + filter marginal-to-inert), so originality rests on the composition + the look-ahead-safe relative-value cross-sectional construct, not on a claim that the overlays earn. Not a sentiment-vs-price one-liner. |
| **Real-world relevance** | Live CMC Agent Hub (**7 tools wired + 5 documented**, Fear & Greed LIVE at F&G = 23); execution-agnostic Capsule a BSC/Trust-Wallet agent can consume; backtested on real multi-regime history; held-out OOS beats B&H (bear-dodge) with halved drawdown — disclosed as regime-conditional. |
| **Demo / presentation** | This 2:30–3:00 script; committed dashboard screenshots; `npm test` (498) run on camera; one-command reproduction. |

## Honest framing (pre-empt the skeptics) — say these if asked

- The backtest is **REAL** (multi-regime Binance daily klines + funding + alternative.me historical
  Fear & Greed; every token `"synthetic": false`). Not a scripted scenario.
- **The OOS beat is real but is a bear-dodge, not regime-independent alpha.** Held-out OOS the directional
  core beats B&H net of cost on all 3 tokens + aggregate (agg −0.32% vs −43.50%; `report-momentum.json`
  `verdict.edgeFound: true`) — but **in-sample (a bull) it LAGS B&H +57% vs +262%**, a bull mid-window
  loses to B&H by **~37%** (`ROBUSTNESS-momentum.md`), and BTC/ETH OOS beats are negative-absolute
  "lost-less" beats with mixed per-token Sharpe. The **robust** claim is **lower drawdown** (≈ halved).
- **The original purely-contrarian result is a loss** (`report.json`: full −36.5% vs B&H −5.4%; OOS
  −18.1% vs −16.6%), retained verbatim as the frozen anchor — never claimed as a win, never overwritten.
- **The trend core is the earner; the overlays are marginal-to-inert (proven by ablation).**
  `report-ablation.json` decomposes the headline: the trend core alone produces the whole OOS bear-dodge
  and halved drawdown; the F&G gate adds rounding-level OOS value (Δreturn +0.03%) and the divergence
  risk filter is numerically inert OOS (`divergenceAddsValue: false`, trim=11/veto=0 over 3000 bars).
  We attribute the result honestly to the trend core and do **not** claim the "novel" overlays earn.
- **CMC's Fear & Greed is wired LIVE into the evaluated product** as the contrarian regime gate (keyed
  capture committed, F&G = 23). The keyed advisory also flips the conviction tilt with the regime
  (`report-cmc-compare.json`); the unkeyed default is a strict `{0,0}` no-op, so the committed reports
  and all **498** tests stay byte-reproducible.
- The cost/slippage model (10 bps + 10 bps) is a **labelled configurable assumption**; the organizer
  model is unconfirmed; the OOS beat survives 15+15 and 25+25 bps stress.
- The "attention" leg is **momentum**, not polarity; the LLM rationale **no-ops** when absent; the
  deterministic engine is the product.
- **No on-chain claims** for Track 2 — nothing is written on-chain.

## Reproduce everything you saw

```bash
npm install
npm run fetch-data          # FREE Binance public REST (daily klines + funding) + alternative.me F&G
npx ts-node backtest/momentum.ts   # HEADLINE: walk-forward → backtest/report-momentum.json (byte-reproducible)
npx ts-node backtest/robustness-momentum.ts   # read-only stress matrix (adjacent splits, mid-window, cost bumps, per-regime)
npm run backtest            # frozen original contrarian anchor → backtest/report.json (byte-identical)
npx ts-node backtest/ablation.ts   # layer attribution → backtest/report-ablation.json (byte-reproducible)
npm test                    # 498 tests: determinism / BVA / look-ahead-bias / momentum / ablation / CMC-on-vs-off / cassette
npx http-server . -p 8123 -c-1   # then open http://localhost:8123/frontend/index.html

# CMC in the evaluated loop (no key needed):
npx ts-node backtest/cmc-compare.ts          # → backtest/report-cmc-compare.json (CMC=ON vs OFF)
# ONE live CMC round-trip (already done + committed under fixtures/cmc/live/; re-run with a free key):
CMC_MCP_API_KEY=<key> npx ts-node backtest/cmc-live-roundtrip.ts
```

---

## Committed demo artifacts (in this repo)

- `docs/assets/dashboard-hero.png` — full dashboard (1280-wide, full page): the **Regime-Aware Risk
  Overlay** headline + the "What this edge IS — and is NOT" honesty banner + KPI strip leading with
  **Max DD 17.7% vs B&H 58.3%** + Strategy Capsule (risk-overlay text) + the directional-core chart +
  the Backtest card with the **drawdown comparison** (the robust claim) and the honest Strategy-vs-B&H
  bar (y=0 baseline) + the collapsed **DEPRECATED original contrarian prototype** panel at the bottom.
- `docs/assets/dashboard-hero-fold.png` — the Backtest / risk-overlay panel (the punchy thumbnail for
  the submission card / video poster frame): max-drawdown halved (17.7% vs 58.3%) + the bear-dodge verdict.

These are rendered from the **real** committed `report-momentum.json` (the risk-overlay headline) served
locally, with the original contrarian `report.json` loss reachable only via the labelled DEPRECATED panel.
They are evidence the dashboard works, and a fallback if the live screen-record glitches. The dashboard
now shows the **headline** momentum numbers directly; the `report.json` contrarian loss is never the hero.

---

## After recording — upload + paste the REAL URL (USER STEP, do not skip)

The video file and its hosting are a human task. Do **not** fabricate a URL. Once the recording is
uploaded:

1. **Record** the 2:30–3:00 walkthrough following the scenes above (screen + voiceover).
2. **Upload** to YouTube (unlisted is fine), Loom, or Google Drive (set link-sharing to "anyone with
   the link"). Confirm the link opens in a private/incognito window.
3. **Paste the real URL** into:
   - `docs/SUBMISSION.md` line ~24 — replace `<video URL — YouTube/Loom/Drive>` with the real link.
   - `README.md` — add the same link to the demo line if one is present.
4. **Paste the repo URL** the same way (`docs/SUBMISSION.md` `Repository:` field) once the repo is
   public.
5. **Commit** the screenshot artifacts already generated (they are in `docs/assets/`):

   ```bash
   git add docs/assets/dashboard-hero.png docs/assets/dashboard-hero-fold.png docs/DEMO.md
   git commit -m "Demo: 2:30-3:00 script (leads with reframed risk claim) + committed dashboard screenshots"
   ```

6. (If you ran the live round-trip) also commit `fixtures/cmc/live/` and a screenshot of its stdout
   (`docs/assets/cmc-live-roundtrip.png`), and reference it here.

**Honesty checkpoint before submitting:** the held-out OOS *does* beat buy-and-hold — but the script
must **only ever** present that as a **bear-dodge**, paired in the same breath with: the in-sample bull
LAG (+57% vs +262%), the ~37% bull-mid-window loss, the negative-absolute "lost-less" BTC/ETH beats,
and the mixed per-token Sharpe. **Lead with the drawdown-reduction claim** (the one robust across every
window) and let `report-momentum.json`'s `verdict.edgeFound: true` and `ROBUSTNESS-momentum.md` both
stand on screen. Never imply a regime-independent beat the data does not support. That honesty is the
reason the eval did not score us lower — keep it.
