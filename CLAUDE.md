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
npm test                       # Run test suite (node:test, no install needed)
```

## Architecture

**Signal flow:** Binance tick (100ms) → Strategy evaluates edge → Risk manager validates → Executor places order on Polymarket → Position monitored for exit.

Key classes and their roles:

- **`ArbEngine`** (`index.js`) — Main orchestrator. Builds the Cartesian product of `(assets × windows)` from config, wires feeds → strategies → risk → executor. Routes Polymarket book events to the correct strategy via `tokenToMarket` map (keyed by tokenId). Handles lifecycle, TUI dashboard, graceful shutdown. Injects live `risk.bankroll` getter into each Strategy via `setBankrollGetter()`. unhandledRejection handler activates the kill-switch after 5+ rejections in a 60s sliding window.
- **`MarketDiscovery`** (`discovery.js`) — Parametrized by `(asset, windowMins)`. Auto-discovers and rotates Up/Down contracts via Polymarket Gamma API. Slug pattern: `{asset}-updown-{window}m-{unix_timestamp}` aligned to `windowMins × 60` second boundaries. Rotates 5s before expiry. Next-market timestamp is `alignToInterval(Math.round(endMs / 1000))` — the end of the current market IS the start of the next one.
- **`BinanceFeed`** (`feeds/binance.js`) — Parametrized by `symbol`. WebSocket client for `depth20@100ms`. Emits `"price"` events with mid, delta, realized vol. One instance per unique asset symbol (deduplicated). Auto-reconnects with exponential backoff.
- **`PolymarketFeed`** (`feeds/polymarket.js`) — Dual-mode client: WebSocket subscription plus REST polling (1s per market). Handles HMAC-signed API auth. Emits `"book"` events tagged with `tokenId` for routing. NO token WS updates are automatically inverted (`mid = 1 - NO_mid`) before emitting — `Strategy` always receives YES-equivalent prices. Supports concurrent per-market polling via `_pollIntervals` Map. REST calls retry on HTTP 429 with exponential backoff (3 retries, 1s/2s/4s ± 500ms jitter).
- **`Strategy`** (`engine/strategy.js`) — Parametrized by `(asset, windowMins)`. Core signal generator using `impliedProbability()` (N(d2) binary option model). **Dynamic strike price** captured from the first Binance tick after each window opens. Two signal modes:
  - *Latency-arb* (t > 90s): EMA-smoothed edge > threshold AND contract stale >1s behind spot
  - *Certainty-arb* (0 < t ≤ 90s): edge > `certaintyThreshold` (15%) as outcome approaches certainty; uses `certaintyMaxFraction` (2%) sizing; signal carries `expiresAt` for executor force-exit
  - Signal guards: (1) startup window suppressed (engine may start mid-window — strike unknown), (2) pre-window period suppressed (before window's official start timestamp)
  - Bankroll sizing uses live `risk.bankroll` (injected via `setBankrollGetter()`) — never the stale CONFIG value.
- **`RiskManager`** (`engine/risk.js`) — Pre-trade gate: cooldown, position limits, drawdown kill switch (25%), daily loss limit, minimum liquidity check (1× for certainty signals, 2× for normal), edge-vs-cost validation. `lastTradeTime` is stamped **atomically in `canTrade()`** to prevent concurrent signals from racing through the cooldown. Key methods:
  - `applyPartialClose(tradeId, { realizedNotional, realizedPnl })` — single point of truth for partial exit accounting; updates `pos.size`, `bankroll`, `dailyPnl`, `peakBankroll` atomically. Executor must never mutate risk fields directly.
  - `closePosition(tradeId, pnl)` — called on full close or shutdown.
- **`Executor`** (`execution/executor.js`) — Places orders, monitors positions on `MONITOR_INTERVAL_MS` (2s) intervals. Entry flow: place GTC order → poll for fill confirmation (`FILL_TIMEOUT_MS` = 5s, `FILL_POLL_MS` = 250ms) → open position at confirmed price+qty. Partial entry fills cancel the remainder and open for the filled portion only. Exit flow: place sell → confirm fill → book realized P&L. Partial exit fills call `risk.applyPartialClose()` and retry next cycle. On rotation, `cancelOrdersForLabel(label)` cancels only that market's orders. On shutdown (`cancelAllOrders`), all positions are closed at mark-to-market with `estimated: true` flag for audit-trail clarity. Safety timeout (`MAX_HOLD_MS + SAFETY_BUFFER_MS`) force-closes at mark if exit remains unconfirmed, with an alert for manual verification.
  - **Size field convention:** `trade.tokenQty` and `trade.size` are **mutable** (decremented on partial exits). `trade.initialSize` is **immutable** (frozen at open, used only for `pnlPct` in close log events). Never use `trade.size` for percentage calculations in close events.

**Math utilities** (`math.js`):
- `impliedProbability()` — Black-Scholes N(d2) for binary options (Abramowitz & Stegun normal CDF approximation; `normalCdf` is internal, not exported)
- `kellyFraction()` — Half-Kelly position sizing with configurable cap
- `calculatePositionSize()` — Kelly sizing with slippage and fee deduction. For BUY_NO, win probability = `1 - modelProb`.
- `RunningStats` — Welford's online algorithm for streaming mean/variance/Sharpe
- `EMA` — Exponential moving average for vol smoothing and edge noise rejection

**TUI** (`utils/tui.js`) — blessed terminal dashboard. All log output is redirected to the log pane via `setLogSink()` in `logger.js`. Key detail: pad raw strings **before** wrapping in blessed color tags — `padEnd()` counts tag characters as display width.

**Utilities:**
- `stateStore.js` — atomic write-to-temp + rename for crash-safe state. Save failures emit `log.warn` (non-fatal but visible).
- `tradeLog.js` — appends NDJSON records to `data/trades.ndjson`. Write failures emit `log.warn` so audit gaps are visible.

## Configuration

All config is via `.env` (see `.env.example`). Loaded in `config.js` using `dotenv`. Config validation runs on startup and halts in live mode if Polymarket API keys are missing.

Key parameters: `ASSETS` (comma-separated, default `BTC`), `WINDOWS` (comma-separated minutes, default `5`), `BANKROLL` (default 1300), `ENTRY_THRESHOLD` (default 5%, applied to 5m markets), `ENTRY_THRESHOLD_15M` (default 3%, applied to 15m+ markets — lower because 15m contracts stay near 50¢ longer with better depth), `CERTAINTY_THRESHOLD` (default 15%), `CERTAINTY_MAX_FRACTION` (default 2%), `MAX_BET_FRACTION` (max 10%), `MAX_OPEN_POSITIONS` (default 8), `DAILY_LOSS_LIMIT` (default $50), `PROFIT_TARGET_PCT` (default 3%), `STOP_LOSS_PCT` (default 15%), `ORDER_TYPE` (default GTC), `DRY_RUN`.

**Per-asset volatility:** `BTC_VOL` (default 1.5%), `ETH_VOL` (default 2.0%), `SOL_VOL` (default 3.0%), `XRP_VOL` (default 3.5%). Used as the Black-Scholes sigma seed until the realized-vol EMA warms up (~20 ticks after window open). Using BTC vol for all assets produced 20-24% phantom edge on XRP/SOL normal intraday moves. Tune to 30-day realized vol for each asset.

**Kill switch baseline:** `peakBankroll` is **not restored** across sessions. On every startup, `peakBankroll` is reset to the current `bankroll`. This gives each session a fresh 25% drawdown buffer — restoring the historical peak would cause the kill switch to trip immediately after any prior losing session. `bankroll` is still fully persisted and restored.

**Per-market position limit:** The signal handler in `ArbEngine` rejects a new signal if that market already has an open position (`executor.openOrders.values()` filtered by `t.signal.label === signal.label`). This prevents stacking multiple concurrent positions in the same direction on one market, which is the most common cause of compounding stop-loss losses.

**Certainty-arb price guard:** `_evaluateCertainty` skips entry if the token side we'd buy is already below `CERTAINTY_MIN_PRICE` (15¢). At those prices (e.g. buying NO when YES is at 87¢) the market has already committed to the outcome — BS vol calibrated to 30-day realized vol underestimates near-expiry resolution certainty and the apparent edge is phantom. Without this guard, stop-loss → cooldown → re-entry cascades occur as the losing token collapses toward zero.

Contract IDs are auto-discovered via Gamma API — no manual config needed. Strike price is captured dynamically at each window open — not a config value.

## Named Constants

Rather than magic numbers, timing values are named constants at the top of each file:

| Constant | Value | File |
|----------|-------|------|
| `FILL_TIMEOUT_MS` | 5000 | executor.js |
| `FILL_POLL_MS` | 250 | executor.js |
| `MONITOR_INTERVAL_MS` | 2000 | executor.js |
| `MAX_HOLD_MS` | 300000 | executor.js |
| `SAFETY_BUFFER_MS` | 5000 | executor.js |
| `MAX_TRADE_HISTORY` | 500 | executor.js |
| `CERTAINTY_WINDOW_SECS` | 90 | strategy.js |
| `MIN_EXPIRY_BUFFER_MS` | 5000 | strategy.js |
| `MODEL_SATURATION_THRESHOLD` | 0.90 | strategy.js |
| `STALE_CONTRACT_MAX_MS` | 5000 | strategy.js |
| `CERTAINTY_MIN_PRICE` | 0.15 | strategy.js |
| `POLL_START_DELAY_MS` | 5000 | index.js |
| `SAVE_INTERVAL_MS` | 30000 | index.js |

## Tests

```bash
npm test    # runs tests/executor.test.js via node:test (built-in, no framework needed)
```

Test env overrides `.env` values by setting `process.env` before dynamic imports — dotenv never overrides pre-set env keys. Tests run with `DRY_RUN=false` so fill-confirmation paths execute; all exchange calls use mock `poly` objects.

Coverage includes: partial entry fill, partial exit fill, cumulative P&L across partial+full close, force-exit-unconfirmed with `estimated=true`, bankroll/P&L invariants, `cancelAllOrders` mark-to-market accounting, monitor race condition (real and mock `_exitPosition`), `_waitForFill` status normalization + makerAmount fallback + overfill clamping, `cancelOrdersForLabel` isolation, `canTrade` kill conditions (daily loss limit, drawdown kill-switch, liquidity 1×/2× rule, cooldown reservation).

## Dependencies

`ws` (WebSocket), `blessed` (TUI), `dotenv` (env loading). Uses Node.js built-in `fetch`, `crypto`, and `node:test`. ESM modules (`"type": "module"` in package.json).
