# Refreshing the committed CMC capture

The published demo (GitHub Pages) reads a **committed snapshot** of the CoinMarketCap MCP
round-trip from `fixtures/cmc/live/`. Without help, that snapshot stays frozen at whenever it
was last captured (2026-06-17). The `Refresh CMC capture` GitHub Action
(`.github/workflows/refresh-cmc.yml`) keeps it current through judging.

## What it does — and what it is NOT

- **On a schedule** (every 6 hours) and on manual **Run workflow**, it re-runs the existing
  keyed live round-trip (`backtest/cmc-live-roundtrip.ts`), which performs one real
  `tools/call` per wired CMC tool and rewrites the raw envelopes under `fixtures/cmc/live/`.
- If the capture **changed**, it commits and pushes to **`main`**. Because `main` is the
  GitHub Pages source, that push rebuilds the published site with the fresher capture.
- If the capture is **unchanged**, or the secret is **missing**, it does nothing and the run
  stays green — no empty commit, no noisy failure.

**Honest framing:** this keeps the committed capture *fresh* — it is still a **snapshot taken
once per run** (every ~6h), **not** a per-visitor live feed. Each successful run just moves the
snapshot forward in time. Nothing about the strategy, reports, or headline numbers changes;
only the `fixtures/cmc/live/` evidence is updated.

## One-time setup (repo owner)

The workflow does nothing useful until both of these are done:

1. **Add the repo secret `CMC_MCP_API_KEY`.**
   - Get a free key (10k credits/mo) at <https://pro.coinmarketcap.com>.
   - GitHub repo -> **Settings -> Secrets and variables -> Actions -> New repository secret**.
   - Name: `CMC_MCP_API_KEY` — value: your key. (The key is never hardcoded anywhere in the
     repo; it is only ever read from this secret.)

2. **Allow the Action to push.**
   - GitHub repo -> **Settings -> Actions -> General -> Workflow permissions** ->
     select **Read and write permissions** -> Save.

That's it. The next scheduled run (or a manual **Actions -> Refresh CMC capture -> Run
workflow**) will refresh `fixtures/cmc/live/` and push to `main`.

## Notes

- **No key set?** The round-trip prints its usage and exits 0 without writing, so the run is a
  quiet no-op success. Safe to leave the workflow enabled before the secret exists.
- **Schedule cadence:** change the `cron` in `refresh-cmc.yml` to capture more/less often.
  `"0 */6 * * *"` is every 6 hours (UTC); GitHub may delay scheduled runs under load.
- **`[skip ci]`** is in the refresh commit message so the separate CI workflow doesn't run on
  these automated fixture-only commits.
- **Scope:** this workflow only ever touches `fixtures/cmc/live/`. It does not modify the
  strategy, the reports, or any committed headline number.
