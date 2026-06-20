# `fixtures/cmc/live/` — real keyed CMC MCP round-trip captures (USER-WRITTEN)

This directory is **empty of live data on purpose**. It is the one place a **real captured
live envelope** belongs. It is populated **only** by the user's single keyed round-trip:

```bash
CMC_MCP_API_KEY=<your-free-key> npx ts-node backtest/cmc-live-roundtrip.ts
```

(Re-run any time with the command above and a free key.)

## What the round-trip writes here

When run with a key, `backtest/cmc-live-roundtrip.ts` performs ONE real `tools/call` per
wired tool against `https://mcp.coinmarketcap.com/mcp` and writes:

- `search_cryptos.json`, `get_crypto_quotes_latest.json`,
  `get_crypto_technical_analysis.json`, `get_global_metrics_latest.json`,
  `get_global_crypto_derivatives_metrics.json`, `trending_crypto_narratives.json`,
  `get_crypto_metrics.json` — each the **RAW** JSON-RPC envelope the server returned,
  wrapped with `_capture:"LIVE"`, a UTC `capturedAt`, the `tool`, the `args`, and the
  `unwrapMcp`-ed payload. See `_SCAFFOLD.json` in this folder for the **exact expected
  layout** (placeholder values only — it is NOT a live capture).
- `_manifest.json` — per-tool `ok` flag plus the normalized parse the defensive adapters
  extracted, so any real-vs-expected field drift is immediately visible
  (`available:false` on a field == the live path differs from the parser; fix
  `src/data/cmc.ts` then re-run).

## Honesty (non-negotiable)

- Files here are labelled `_capture:"LIVE"`. They are **never** copied into the SAMPLE
  fixtures (`../*.json`) or the SHAPE cassettes (`../cassettes/*.json`) and relabelled.
- Nothing here is consumed by `backtest/report.json` (or the other committed reports) —
  those stay offline-reproducible by design. A live capture is **evidence the integration
  is real**, not an input to the headline backtest.
- Until the user runs the keyed round-trip, this folder contains only this README and
  `_SCAFFOLD.json` — no fabricated live response exists anywhere in the repo.

## Verified-vs-documented note (parser readiness)

The 7 wired tool names were **verified** against CoinMarketCap's official MCP listing
(`coinmarketcap.com/api/mcp/`, 2026-06): `search_cryptos`, `get_crypto_quotes_latest`,
`get_crypto_technical_analysis`, `get_global_metrics_latest`,
`get_global_crypto_derivatives_metrics`, `trending_crypto_narratives`,
`get_crypto_metrics` — all real. (The server also lists 5 we document but do not wire:
`get_crypto_info`, `get_crypto_marketcap_technical_analysis`, `get_upcoming_macro_events`,
`get_crypto_latest_news`, `search_crypto_info` — hence "7 wired + 5 documented".)

CMC's quotes/metrics maps are keyed by **whichever query param you send** — `id` ->
`data["1"]`, `symbol` -> `data["BTC"]` (verified against CMC standards-and-conventions).
The defensive parsers in `src/data/cmc.ts` now handle **both** keyings (covered by
`test/cmcLive.test.ts`), so the keyed round-trip should parse regardless of which the
server returns.
