# HONEST_SEARCH_RULES.md — Stoic parameter-search & reporting contract

**Status: binding for every agent in the fix workflow.** This file governs how any new
window, config, or knob value may be searched, selected, and reported. It exists because
the only thing keeping this submission above a much lower score is its radical honesty
(the frozen baseline numbers). Breaking any rule here forfeits that — a
defensible honest result beats a fabricated win. If a rule and a phase instruction
conflict, the stricter (more honest) reading wins; flag the conflict in
`CHANGES-FOR-JUDGES.md` rather than resolving it silently.

These rules apply to **all** search/optimization work (Phase 1 edge search, Phase 2 CMC
on/off, Phase 4 originality differentiator) — not just Phase 1.

---

## 0. The frozen baseline (never deleted, never overwritten)

The committed full-window result below is the **anchor of record**. It is retained in
`backtest/report.json` and cited unchanged in README/SUBMISSION/CHANGES-FOR-JUDGES no
matter what any new run produces. New results are reported **alongside** it, never **in
place of** it.

Aggregate (equal-weight over BTC/ETH/BNB, 1h bars, txCost 10bps + slippage 10bps,
oosFraction 0.30; `report.json` lines 18-36, 201-239):

| Segment | Strategy total return | Buy-and-hold | Sharpe | Trades | Win rate |
|---|---|---|---|---|---|
| Full (8640 bars) | **-36.48%** | -5.36% | -12.24 | 843 | 27.83% |
| In-sample (6045 bars) | -22.47% | +13.87% | -10.92 | 468 | 27.93% |
| Held-out OOS (2595 bars) | **-18.07%** | -16.65% | -15.50 | 375 | 27.66% |

The current committed strategy **loses to buy-and-hold net of cost on every segment**,
including the held-out OOS tail. That is the fact any new work must honestly improve upon
or be reframed against (Phase 1b). Per-token flow coverage: funding ~0.999;
longShortRatio / takerBuySellRatio / openInterest ~0.1736 (`report.json` lines 53-57) —
i.e. the advertised two-leg construct is non-degenerate on only ~17.4% of bars.

---

## 1. In-sample-only selection (the cardinal rule)

1.1 **Every** tunable choice — window length, `DIVERGENCE_DEADBAND_Z`,
`ENTRY_THRESHOLD`, dwell/cooldown, regime-extreme gating, the choice of
full-coverage window, the choice of which tokens to trade, vol-adaptive window params,
cross-sectional / lead-lag knobs, and any CMC advisory weight — is selected using metrics
computed **only on the in-sample segment** (the leading `1 - oosFraction` of bars;
`report.json` line 43, methodology bullet 4).

1.2 The in-sample / OOS split is fixed **before** any search begins (default
`oosFraction = 0.30`, `report.json` line 24). The split boundary is never moved to
flatter a result. If a different split is ever used, the change and its motivation are
disclosed and the default-split result is **also** reported.

1.3 The walk-forward must stay look-ahead-safe: the decision for bar `i` uses only bars
`<= i`, and the rolling z-score window ends at `t-1` (the `< t` loop at
`src/signal/divergence.ts:140`; `report.json` methodology bullets 1-2). No selection rule
may peek past the bar it acts on. The look-ahead test suite must stay green.

---

## 2. Held-out OOS reported unconditionally (never selected on)

2.1 The held-out OOS tail is run **exactly once per candidate config**, **after**
selection is locked on the in-sample segment, and its metrics are reported **as-is** —
win, loss, or break-even.

2.2 The OOS segment is **never** an input to any choice. You may not: re-run the search
after seeing OOS, pick the config with the best OOS, "peek" at OOS to break an in-sample
tie, or quietly discard a candidate because its OOS was bad. Selecting on OOS is the
single most disqualifying violation here.

2.3 If a config wins in-sample but loses OOS, that is reported plainly as the result.
A config that is good in-sample and bad OOS is **not** a winner — it is in-sample
overfit, and saying so is mandatory.

---

## 3. Full disclosure of tokens and windows (no silent cherry-picking)

3.1 **All tokens evaluated are disclosed.** The universe is BTCUSDT, ETHUSDT, BNBUSDT.
Every per-token result is committed and shown — you may not report only the token that
happened to work and bury the other two. If an aggregate is reported, the per-token
breakdown that produced it is also committed.

3.2 **Per-token wins must be labelled as such.** A positive edge on 1 of 3 tokens is
reported as "1 of 3 tokens," never implied as a portfolio result. Cross-token cherry-
picking (claiming the strategy "works" on the strength of one token while hiding the
losers) is prohibited.

3.3 **Every window evaluated is disclosed.** If more than one window/segment is run
(e.g. the default full window plus a fetched ~30-day full-coverage window, or any stress
window), all are committed and named. You may not search several windows and report only
the best. The full-coverage window is an *honesty fix* for the 17.4%-coverage degeneracy
(making measured == advertised), **not** a license to window-shop for returns: it is
chosen by data coverage (the contiguous tail where flow legs are present, or a fresh
`MONTHS_BACK=1` fetch), not by its result.

3.4 **Stress disclosure is mandatory for any claimed winner.** Any config that beats B&H
on the held-out full-coverage window must also be run on (a) an adjacent window or token
and (b) a +5/+5 bps cost bump (15+15 bps). The stress outcomes are reported and any
fragility is stated explicitly. A winner that survives only at exactly 10+10 bps on
exactly one window is disclosed as fragile.

---

## 4. Report only what an actual committed run produced

4.1 No metric appears in any doc, the demo, or the chart unless it was produced by an
**actual run whose output is committed** (the relevant `report*.json`). No hand-typed,
remembered, interpolated, rounded-for-effect, or "expected" numbers. Every number traces
to a committed JSON field at a citable `file:line`.

4.2 **Byte-reproducibility is preserved.** `npm run backtest` must regenerate
`backtest/report.json` byte-for-byte (`git diff` clean) — this is a frozen strength
(the frozen baseline). Any new full-coverage run is emitted to a **separate**
file (`backtest/report-fullcoverage.json`) with its own byte-reproducibility test;
`report.json` itself is **not** touched by Phase 1+ work.

4.3 **All 218 mocha tests stay green and `tsc --noEmit` stays exit 0** after every phase.
New behaviour is added behind opt-in flags (e.g. `FULL_COVERAGE=1`, a keyed CMC path)
so the unkeyed/default path is byte-identical and the existing suite is unchanged. The
unkeyed CMC advisory default must remain a strict `{0,0}` no-op.

4.4 No capability is described as live/wired unless it actually runs in the evaluated
path. "Documented but not wired" is stated as such (see the tool-count fix: "7 wired + 5
documented").

---

## 5. The cost model stays a labelled assumption

5.1 The transaction-cost + slippage model (default **10 bps + 10 bps**, charged on
`|Δ signed notional|` per position change, folded into the equity curve) remains a
**configurable, clearly-labelled assumption** — the exact organizer model is unconfirmed
(`report.json` lines 19-20, 26). This label is never dropped or softened.

5.2 All headline returns and Sharpe/Sortino are reported **net of this cost** (cost-
inclusive). You may not quietly switch to a gross/zero-cost number to manufacture an edge.
If a result is shown at a different cost assumption, the assumption is stated next to it
and the 10+10 bps result is shown too (per 3.4).

---

## 6. GO / NO-GO GATE (Phase 1 success criterion)

**A candidate config PASSES the gate if and only if ALL of the following hold:**

- **G1 — Honest beat:** On the **held-out OOS segment of the full-coverage window**
  (coverage ~100% on all flow legs, so measured == advertised), the strategy's
  **net-of-cost total return beats buy-and-hold on the same bars**, for **at least one
  disclosed token OR the disclosed aggregate**. (The current baseline fails this:
  OOS -18.07% vs B&H -16.65%.)
- **G2 — Selected only in-sample:** Every knob value was fixed on the in-sample segment
  (Rule 1); OOS was run once, after, and reported as-is (Rule 2).
- **G3 — Look-ahead clean:** The look-ahead test suite is green; the `< t` invariant
  holds for every new code path (Rule 1.3).
- **G4 — Reproducible:** The full-coverage run is committed
  (`backtest/report-fullcoverage.json`) and regenerates byte-for-byte; default
  `report.json` is untouched; all 218 (+ new) tests pass; `tsc --noEmit` exits 0
  (Rule 4).
- **G5 — Disclosed & stress-checked:** All tokens and windows evaluated are committed
  (Rule 3); the winner survives, or its fragility is disclosed under, the adjacent-
  window/token and +5/+5 bps stress (Rule 3.4); the frozen baseline is retained
  unchanged (Section 0).

A "beat" means **strictly greater** net-of-cost total return than B&H on the identical
bars. A statistical tie or a beat only inside transaction-cost noise is **not** a pass —
report it as "did not beat B&H."

### Fixed compute budget for the Phase-1 search

To keep the search honest (no infinite re-rolling until something passes by chance), the
in-sample search is bounded **before it starts**:

- **At most ~24 in-sample configurations total** across the coordinate-style knob sweep:
  `DIVERGENCE_DEADBAND_Z` ∈ {0.5, 0.75, 1.0}; `ENTRY_THRESHOLD` ∈ {120, 200, 300};
  min-dwell/cooldown ∈ {0, 1, 3 bars}; trade-only-at-regime-extremes ∈ {off, on}.
  Sweep one axis at a time around the current default rather than the full grid.
- **At most one** full-coverage window definition (the coverage-defined tail, or one
  `MONTHS_BACK=1` fetch) — chosen by coverage, not by result (Rule 3.3).
- **At most one** OOS evaluation per surviving candidate (Rule 2.1).
- Once the budget is exhausted, **stop**. Do not widen the grid, add windows, or re-seed
  to chase a pass. Exhausting the budget without a pass triggers the decision rule below.

---

## 7. PHASE-1-vs-REPOSITION (Phase 1b) DECISION RULE

After the bounded search completes, decide deterministically:

- **If ≥ 1 candidate PASSES the go/no-go gate (all of G1–G5):**
  → **Proceed with Phase 1.** Lead the submission with that full-coverage,
  held-out-OOS, B&H-beating result. Retain the frozen full-window loss labelled as the
  original honest result (Section 0). Disclose the per-token / per-window picture and the
  stress outcomes in full.

- **If NO candidate passes within the fixed budget (no honest full-coverage held-out OOS
  beat of B&H net-of-cost):**
  → **STOP searching. Do NOT fabricate, fish further, loosen the cost model, move the
  split, or select on OOS to manufacture a pass.** Trigger **Phase 1b**: reposition the
  deliverable as a reproducible, look-ahead-safe **positioning-vs-flow divergence
  detector / risk-overlay research tool**, and stop benchmarking the headline against a
  B&H it loses to. Re-anchor value on a **measurable, defensible claim proven by the same
  harness**, e.g.:
    - **lower OOS max-drawdown than B&H** on the full-coverage held-out window (the
      baseline already shows OOS drawdown 18.21% vs a B&H that drew down comparably — if a
      config measurably reduces OOS drawdown vs B&H net-of-cost, that is the claim), or
    - **divergence-event lead-time**: divergence flags precede adverse moves by a
      measurable, reported margin on held-out data.
  The repositioned claim is held to the **same** rules (in-sample selection, unconditional
  OOS, disclosure, reproducibility). State plainly in README/SUBMISSION/DEMO/
  CHANGES-FOR-JUDGES that the headline B&H benchmark was not beaten and why the reframed
  claim is the honest value proposition.

**Ship exactly one of Phase 1 or Phase 1b — never both, never a blend that implies a beat
that did not happen.** Borderline calls resolve toward Phase 1b (the more conservative,
less overclaiming path).

---

## 8. Self-check before committing any new result

Before committing any `report*.json`, doc number, or claim, confirm every box:

- [ ] Was every knob selected using **in-sample only**? (Rule 1)
- [ ] Was OOS run **once, after** selection, and reported **as-is**? (Rule 2)
- [ ] Are **all** tokens and **all** windows evaluated **committed and disclosed**? (Rule 3)
- [ ] Does **every** number trace to a **committed run** at a citable `file:line`? (Rule 4.1)
- [ ] Is default `report.json` **byte-identical** and are all 218 (+new) tests green,
      `tsc` exit 0? (Rules 4.2–4.3)
- [ ] Is the cost model still a **labelled 10+10 bps assumption**, results net-of-cost? (Rule 5)
- [ ] Is the **frozen baseline (Section 0) retained**, not replaced?
- [ ] If claiming a win: does it **strictly** beat B&H on the **held-out full-coverage**
      window, and is its **fragility disclosed** under stress? (Rules 3.4, 6)
- [ ] Is the **look-ahead suite green** and the `< t` invariant intact? (Rule 1.3)

If any box is unchecked, the result is **not** committed as a claim. Fix it, downgrade the
claim to match the run, or reposition (Phase 1b).
