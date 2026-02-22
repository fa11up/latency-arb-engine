# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Latency arbitrage engine that exploits the 3-7 second lag between Binance BTC spot price updates and Polymarket CLOB binary contract repricing. It monitors both feeds, computes implied probability via a Black-Scholes-style binary option model, and trades when the edge exceeds a threshold.

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

- **`ArbEngine`** (`index.js`) — Main orchestrator. Wires feeds → strategy → risk → executor. Handles lifecycle, status dashboard, graceful shutdown.
- **`MarketDiscovery`** (`discovery.js`) — Auto-discovers and rotates BTC Up/Down 5-minute contracts via the Polymarket Gamma API. Resolves contracts by slug (`btc-updown-5m-{unix_timestamp}` on 300s boundaries). Rotates 5s before expiry.
- **`BinanceFeed`** (`feeds/binance.js`) — WebSocket client for `depth20@100ms` BTCUSDT orderbook. Emits `"price"` events with mid, delta, realized vol. Auto-reconnects with exponential backoff.
- **`PolymarketFeed`** (`feeds/polymarket.js`) — Dual-mode client: WebSocket subscription (always started) plus REST polling (always running at 1s as baseline). Handles HMAC-signed API auth for order placement. Emits `"book"` events with YES-equivalent prices — NO token WS updates are automatically inverted (`mid = 1 - NO_mid`) before emitting, so `Strategy` always receives consistent YES prices regardless of which token triggered the WS update.
- **`Strategy`** (`engine/strategy.js`) — Core signal generator. Uses `impliedProbability()` (N(d2) binary option model) with a **dynamic strike price** captured from the first Binance tick when each 5-minute window opens (not a fixed `STRIKE_PRICE`). Signal guards suppress trading during: (1) the startup window (engine may have started mid-window — strike unknown), (2) the pre-window period (before the window's official start timestamp), and (3) the last 60s before expiry (book empties, prices unreliable). Generates signals when EMA-smoothed edge > threshold AND contract is stale (>1s behind spot).
- **`RiskManager`** (`engine/risk.js`) — Pre-trade gate: cooldown, position limits, drawdown kill switch (25%), daily loss limit ($200), minimum liquidity check, edge-vs-cost validation. `lastTradeTime` is stamped **atomically in `canTrade()`** (not after async order placement) to prevent concurrent signals from all passing the cooldown check before the first order registers.
- **`Executor`** (`execution/executor.js`) — Places orders, monitors positions on 2s intervals. Each position fetches its own token's book via `fetchOrderbook(tokenId)` — not `lastBook` — to prevent market rotation from corrupting P&L. Exits on: profit target (3%), stop loss (50%), max hold (5min), or edge collapse (contract catches up to model within 2%). For BUY_NO, edge-collapsed check compares NO token price against `1 - modelProb`.

**Math utilities** (`math.js`):
- `impliedProbability()` — Black-Scholes N(d2) for binary options using Abramowitz & Stegun normal CDF approximation
- `kellyFraction()` — Half-Kelly position sizing with configurable cap
- `RunningStats` — Welford's online algorithm for streaming mean/variance/Sharpe
- `EMA` — Exponential moving average used for vol smoothing and edge noise rejection

## Configuration

All config is via `.env` (see `.env.example`). Loaded in `config.js` using `dotenv`. Config validation runs on startup and halts in live mode if Polymarket API keys are missing. Key parameters: `BANKROLL` (default 1300), `STRIKE_PRICE` (fallback only — overridden at runtime by dynamic strike capture), `ENTRY_THRESHOLD` (default 3%), `MIN_EDGE` (default 3%), `MAX_BET_FRACTION` (max 10%), `ORDER_TYPE` (default GTC), `DRY_RUN`.

Contract IDs (`POLY_CONDITION_ID`, `POLY_TOKEN_ID_YES`, `POLY_TOKEN_ID_NO`) are optional — `MarketDiscovery` resolves them automatically at runtime if not set.

## Dependencies

Minimal: `ws` (WebSocket client), `dotenv` (env loading). Uses Node.js built-in `fetch` and `crypto`. ESM modules (`"type": "module"` in package.json).
