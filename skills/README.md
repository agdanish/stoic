# Stoic — CMC Skills

CoinMarketCap **Agent Hub** Skills for Stoic. The Track-2 deliverable lives here:
a Skill that turns a CMC data snapshot into a **backtestable Strategy Capsule** — it emits a
strategy *spec* (entry / exit / invalidation / sizing / risk + replay instructions), not a live
order.

## Skills

| Skill | What it does |
|---|---|
| [`sentiment-divergence-regime`](./sentiment-divergence-regime/SKILL.md) | Emits a Strategy Capsule for a **regime-gated, rolling-window z-scored positioning/attention-vs-flow divergence** signal. Resolves the symbol, pulls CMC technicals + derivatives positioning + the global regime (Fear & Greed / funding) + trending narratives, and writes rules whose thresholds are the engine's own exported constants (single source of truth). |

Each skill folder contains:

- `SKILL.md` — YAML frontmatter (`name` == folder, `description` with explicit trigger phrases,
  `license`, `compatibility`, `user-invocable`, `allowed-tools`) + the workflow / analysis
  framework / Strategy-Capsule report template.
- `capsule.schema.json` — JSON Schema (draft-07) the emitted **Strategy Capsule** validates against.

## Install

Copy the skill folder into your agent's skills directory (the same `cp -r` install pattern as
CoinMarketCap's own `cmc-mcp` skill):

```bash
cp -r skills/sentiment-divergence-regime /path/to/skills/
```

On Windows (PowerShell):

```powershell
Copy-Item -Recurse skills\sentiment-divergence-regime C:\path\to\skills\
```

## Prerequisites

- A working **CoinMarketCap MCP API key** (free, 10k credits/mo at `pro.coinmarketcap.com`) wired to
  the `cmc-mcp` MCP server:
  - URL: `https://mcp.coinmarketcap.com/mcp`
  - Header: `X-CMC-MCP-API-KEY: <your key>`
  - mcpServers config key: `cmc-mcp`.
  - Keyless alternative: the x402 surface `https://mcp.coinmarketcap.com/x402/mcp` ($0.01 USDC/call
    on Base 8453).
- The strategy logic and all thresholds are defined offline (they are exported engine constants),
  and the **backtest runs with no CMC key** on FREE Binance public REST history. The live *regime
  read* in the Capsule needs the key — fields are marked **"NEEDS YOUR FREE CMC KEY"** when absent.

## Single source of truth

Every numeric rule in a Capsule **cites an exported engine constant by name** rather than copying a
literal — see `src/signal/divergence.ts` and `src/signal/core.ts` (re-exported from
`src/signal/signalEngine.ts`). If a SKILL table and the engine ever disagree, **the engine wins**;
regenerate the Capsule. To change a threshold, change the constant — never edit a number only in a
Capsule.

## License

MIT.
