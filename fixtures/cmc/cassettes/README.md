# CMC MCP recorded cassettes (live-HTTP-branch test fixtures)

These are **recorded HTTP response bodies** for the CoinMarketCap MCP `tools/call` endpoint
(`https://mcp.coinmarketcap.com/mcp`). Each file is the JSON body that `callTool` (src/data/cmc.ts:182-202)
receives from `await res.json()` on the LIVE transport path — i.e. the JSON-RPC `result` envelope
the server returns, with the tool payload double-encoded under `result.content[].text` per the MCP spec.

## Why they exist

The committed default report + the offline contract tests run in FIXTURE mode (no key), so the
**live HTTP branch of `callTool` was never exercised by a test** (eval gap 7). `test/cmcLive.test.ts`
loads these cassettes, stubs `globalThis.fetch` to return them, sets a dummy `CMC_MCP_API_KEY`, and
drives the REAL adapter end-to-end through the live branch — proving the HTTP path + `unwrapMcp` +
each defensive parser handle the wire shape correctly, per wired tool.

## Honesty

- These are **SHAPE cassettes**: the envelope structure mirrors the documented MCP `tools/call`
  response, but the VALUES are the same labelled SAMPLE numbers as `fixtures/cmc/*.json` — they are
  NOT a real captured live response. The one place a real captured envelope belongs is
  `fixtures/cmc/live/`; when the user runs the keyed round-trip that
  raw envelope is committed there and labelled `LIVE`.
- No cassette is consumed by the committed `report.json` / `report-fullcoverage.json` /
  `report-search.json` / `report-cmc-compare.json`. They only back the live-branch test.

## Filenames

One per wired tool (the 7 in `skills/sentiment-divergence-regime/SKILL.md`):
`search_cryptos`, `get_crypto_quotes_latest`, `get_crypto_technical_analysis`,
`get_global_metrics_latest`, `get_global_crypto_derivatives_metrics`,
`trending_crypto_narratives`, `get_crypto_metrics`.
