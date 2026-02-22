# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Latency arbitrage engine that exploits the 3-7 second lag between Binance spot price updates and Polymarket CLOB binary contract repricing. Supports multiple assets (BTC, ETH, SOL, XRP) and window sizes (5m, 15m), running one strategy instance per `(asset × window)` pair. Computes implied probability via a Black-Scholes-style binary option model and trades when edge exceeds a threshold.

## Commands

```bash
npm install                    # Install dependencies
npm run dry-run                # Paper trading mode (DRY_RUN=true)
npm start                      # Start engine (uses DRY_RUN from .env, defaults true)
DRY_RUN=false npm start        # Live trading (requires API keys)
```

No test suite or linter is configured.

## Architecture

**Signal flow:** Binance tick (100ms) → Strategy evaluates edge → Risk manager validates → Executor places order on Polymarket → Position monitored for exit.

Key classes and their roles:

- **`ArbEngine`** (`index.js`) — Main orchestrator. Builds the Cartesian product of `(assets × windows)` from config, wires feeds → strategies → risk → executor. Routes Polymarket book events to the correct strategy via `tokenToMarket` map (keyed by tokenId). Handles lifecycle, TUI dashboard, graceful shutdown.
- **`MarketDiscovery`** (`discovery.js`) — Parametrized by `(asset, windowMins)`. Auto-discovers and rotates Up/Down contracts via Polymarket Gamma API. Slug pattern: `{asset}-updown-{window}m-{unix_timestamp}` aligned to `windowMins × 60` second boundaries. Rotates 5s before expiry. Next-market timestamp is `alignToInterval(Math.round(endMs / 1000))` — the end of the current market IS the start of the next one.
- **`BinanceFeed`** (`feeds/binance.js`) — Parametrized by `symbol`. WebSocket client for `depth20@100ms`. Emits `"price"` events with mid, delta, realized vol. One instance per unique asset symbol (deduplicated). Auto-reconnects with exponential backoff.
- **`PolymarketFeed`** (`feeds/polymarket.js`) — Dual-mode client: WebSocket subscription plus REST polling (1s per market). Handles HMAC-signed API auth. Emits `"book"` events tagged with `tokenId` for routing. NO token WS updates are automatically inverted (`mid = 1 - NO_mid`) before emitting — `Strategy` always receives YES-equivalent prices. Supports concurrent per-market polling via `_pollIntervals` Map.
- **`Strategy`** (`engine/strategy.js`) — Parametrized by `(asset, windowMins)`. Core signal generator using `impliedProbability()` (N(d2) binary option model). **Dynamic strike price** captured from the first Binance tick after each window opens. Two signal modes:
  - *Latency-arb* (t > 90s): EMA-smoothed edge > threshold AND contract stale >1s behind spot
  - *Certainty-arb* (0 < t ≤ 90s): edge > `certaintyThreshold` (15%) as outcome approaches certainty; uses `certaintyMaxFraction` (2%) sizing; signal carries `expiresAt` for executor force-exit
  - Signal guards: (1) startup window suppressed (engine may start mid-window — strike unknown), (2) pre-window period suppressed (before window's official start timestamp)
- **`RiskManager`** (`engine/risk.js`) — Pre-trade gate: cooldown, position limits, drawdown kill switch (25%), daily loss limit ($200), minimum liquidity check, edge-vs-cost validation. `lastTradeTime` is stamped **atomically in `canTrade()`** to prevent concurrent signals from racing through the cooldown.
- **`Executor`** (`execution/executor.js`) — Places orders, monitors positions on 2s intervals. Each position fetches its own token's book via `fetchOrderbook(tokenId)`. Exits on: profit target (3%), stop loss (50%), max hold (5min), edge collapse (within 2% of model), or `CERTAINTY_EXPIRY` (before contract expires). On rotation, `cancelOrdersForLabel(label)` cancels only that market's orders — not all markets.

**Math utilities** (`math.js`):
- `impliedProbability()` — Black-Scholes N(d2) for binary options (Abramowitz & Stegun normal CDF approximation; `normalCdf` is internal, not exported)
- `kellyFraction()` — Half-Kelly position sizing with configurable cap
- `calculatePositionSize()` — Kelly sizing with slippage and fee deduction
- `RunningStats` — Welford's online algorithm for streaming mean/variance/Sharpe
- `EMA` — Exponential moving average for vol smoothing and edge noise rejection

**TUI** (`utils/tui.js`) — blessed terminal dashboard. All log output is redirected to the log pane via `setLogSink()` in `logger.js`. Key detail: pad raw strings **before** wrapping in blessed color tags — `padEnd()` counts tag characters as display width.

## Configuration

All config is via `.env` (see `.env.example`). Loaded in `config.js` using `dotenv`. Config validation runs on startup and halts in live mode if Polymarket API keys are missing.

Key parameters: `ASSETS` (comma-separated, default `BTC`), `WINDOWS` (comma-separated minutes, default `5`), `BANKROLL` (default 1300), `ENTRY_THRESHOLD` (default 3%), `CERTAINTY_THRESHOLD` (default 15%), `CERTAINTY_MAX_FRACTION` (default 2%), `MAX_BET_FRACTION` (max 10%), `ORDER_TYPE` (default GTC), `DRY_RUN`.

Contract IDs are auto-discovered via Gamma API — no manual config needed. Strike price is captured dynamically at each window open — not a config value.

## Dependencies

`ws` (WebSocket), `blessed` (TUI), `dotenv` (env loading). Uses Node.js built-in `fetch` and `crypto`. ESM modules (`"type": "module"` in package.json).
