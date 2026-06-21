# Honesty Contract

**What this is:** a regime-aware drawdown overlay with a falsifiable, self-ablating honesty contract.

The earner is a vanilla EMA-30/80 trend core (the bear-dodge: sit flat through the 2026 drawdown). Every claim below is **already true** and is pinned to committed proof in this repo. Each clause is designed to **fail loudly** if a future change quietly breaks it — a null or inert result is published as-is, never hidden.

---

## The four clauses (each TRUE, each with committed proof)

**(1) The headline numbers are byte-reproducible.**
The committed `report*.json` files serialize to the *exact* bytes the tests pin. A single lucky run cannot be disguised as a result.
→ Proof: `test/backtest.test.ts` — "matches the committed `backtest/report.json` byte-for-byte" and "buildReport serializes deterministically (same input → byte-identical output)". `test/honesty.test.ts` — "buildReport over the committed fixtures serializes to identical bytes twice". `test/ablation.test.ts` — "buildAblationReport serialises to the EXACT committed bytes".

**(2) A published per-layer ablation openly demotes its own overlays to inert.**
`backtest/report-ablation.json` holds the in-sample-locked config fixed and toggles ONE overlay at a time on the held-out OOS: A1 trend-core-alone (−0.35%), A2 +F&G gate (−0.32%, Δret +0.03%), A3 +divergence/funding filter (−0.32%, **Δret 0.00%, trim=11/veto=0 — inert**). The verdict (`drawdownScalerBites: false`, `divergenceAddsValue: false`) is **computed from the metrics, never hand-set**. The report now also carries the **A5 drawdown-scaler arm**, published exactly like A1–A3: A5 vs A1 is Δreturn −2.94%, ΔmaxDD −3.96% — it does **not** bite on this OOS and is labelled a disclosed, inert monitor.
→ Proof: `backtest/report-ablation.json` (arms A1, A2, A3, A5; `attribution`, `verdict`). `test/ablation.test.ts` — "the trend core ALONE (A1) already carries essentially the entire OOS result" and "A3 aggregate + per-token OOS metrics equal the committed report-momentum.json".

**(3) An honesty-guard test pins |ΔOOS return| small for inert overlays.**
If a future change silently makes the divergence/funding filter load-bearing on the OOS, this guard trips.
→ Proof: `test/ablation.test.ts` — "the risk filter is near-INERT on the held-out OOS (it does NOT swing the result)": `|ΔOOS return| < 0.0005` (5 bps). Supported by "the risk filter only ever REDUCES |edge| (trim/veto), never increases it" and the trim=11/veto=0 accounting.

**(4) Gates read only point-in-time fields — no look-ahead.**
Truncating the bar series at bar *k* leaves every decision, conviction, and equity at bars ≤ *k* byte-identical, on synthetic AND real committed fixtures, for every ablation arm. The CMC advisory reads no bar data, so it is truncation-invariant by construction.
→ Proof: `test/backtest.test.ts` — "look-ahead safety (truncation invariance)" incl. "holds on the REAL committed fixtures too". `test/ablation.test.ts` — "look-ahead safety (truncation invariance, every arm)". `test/cmcAdvisory.test.ts` — "look-ahead-safe (truncation invariant)". `test/bars.test.ts` — "does not leak a future funding settle backward".

---

> ## ⚠️ What this is NOT
>
> - **NOT alpha.** Aggregate out-of-sample return is **−0.32% — a small LOSS, not a profit** (`backtest/report-momentum.json` → `aggregate.outOfSample`). The only win is risk: maximum drawdown roughly halved, **17.7% vs buy-and-hold's 58.3%** OOS.
> - **NOT a working divergence signal.** The divergence/funding filter is **inert OOS**: Δreturn 0.00%, ΔSharpe −3e-12, fired trim=11 / veto=0 across the entire universe (`report-ablation.json` → `attribution.divergenceRiskFilter`). It is a non-earning safety veto, not an edge.
> - **NOT 12 tools.** There are **7 wired CMC tools** (all `ok:true`, one committed keyed snapshot) plus 5 documented — never 12. Of the wired tools, **2 feed the decision path**: the live Fear & Greed contrarian gate and the divergence/funding risk filter (`fixtures/cmc/live/_manifest.json`).
> - **NOT regime-independent on return.** The absolute OOS "beat" is a **regime-conditional bear-dodge**: on a bull mid-window the same strategy loses to buy-and-hold by roughly 37% (`backtest/report-momentum.json`). The drawdown reduction is the durable property; the return is not.

---

**The contract in one line:** the trend core is the earner; the F&G gate adds only rounding-level value (+0.03%); the divergence filter and the A5 drawdown scaler are inert on this OOS — and every one of those admissions is pinned to a committed report and a test that fails if the claim ever stops being true.
