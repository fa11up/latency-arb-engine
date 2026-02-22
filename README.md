# ⚡ Latency Arb Engine — Binance × Polymarket

Exploits the 3-7 second lag between Binance spot price updates and Polymarket CLOB contract repricing across multiple assets and window sizes.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     ARB ENGINE (multi-market)                   │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   BINANCE     │    │  POLYMARKET   │    │     STRATEGY     │  │
│  │   FEEDS       │───▶│  FEED         │───▶│     ENGINES      │  │
│  │              │    │              │    │                  │  │
│  │  1 WS per    │    │  WS + REST   │    │  1 per market    │  │
│  │  asset       │    │  1s polling  │    │  implied prob    │  │
│  │  depth20@    │    │  per market  │    │  edge calc       │  │
│  │  100ms       │    │  tokenId     │    │  signal gen      │  │
│  └──────────────┘    │  routing     │    └────────┬─────────┘  │
│                      └──────────────┘             │            │
│                                         ┌─────────▼────────┐  │
│  ┌──────────────┐    ┌──────────────┐   │    RISK          │  │
│  │   ALERTS      │◀───│  EXECUTOR    │◀──│    MANAGER       │  │
│  │              │    │              │   │                  │  │
│  │  Discord     │    │  order mgmt  │   │  position limits │  │
│  │  Telegram    │    │  fill track  │   │  drawdown kill   │  │
│  │              │    │  P&L calc    │   │  daily limits    │  │
│  └──────────────┘    └──────────────┘   └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Signal Flow

1. **Binance tick** (every 100ms): spot price, delta, realized vol — one feed per asset
2. **Strategy eval**: compute implied probability via binary option model (N(d2))
3. **Edge detection**: compare model prob vs Polymarket contract mid
4. **Signal guards**: suppress startup window and pre-window signals; route last 90s to certainty-arb mode
5. **Signal generation** (two modes):
   - *Latency-arb* (t > 90s): edge > 5% (5m) / 3% (15m) AND contract stale >1s; blocked when N(d2) > 90% (model saturation) or feedLag > 5s (stale REST data)
   - *Certainty-arb* (0 < t ≤ 90s): edge > 15% as outcome approaches certainty; half-size; force-exits before expiry; skips if token-side price < 15¢ (phantom edge guard)
6. **Risk check**: position limits, drawdown, cooldown, liquidity
7. **Execution**: place order on Polymarket CLOB; poll for fill confirmation
8. **Monitoring**: track position, exit on edge collapse / timeout / stop loss / expiry

## Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Polymarket API credentials

# Run tests
npm test

# Run in dry-run mode (paper trading)
npm run dry-run

# Run live (requires valid API keys)
DRY_RUN=false npm start
```

## Configuration

All configuration is in `.env`. Key parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ASSETS` | `BTC` | Comma-separated assets to monitor (BTC, ETH, SOL, XRP) |
| `WINDOWS` | `5` | Comma-separated window sizes in minutes (5, 15) |
| `BANKROLL` | 1300 | Starting capital in USD |
| `ENTRY_THRESHOLD` | 0.05 | Minimum edge (5%) for 5m latency-arb trades (raised — thin books near noise floor) |
| `ENTRY_THRESHOLD_15M` | 0.03 | Minimum edge (3%) for 15m trades (lower — more liquidity near 50¢) |
| `CERTAINTY_THRESHOLD` | 0.15 | Minimum edge (15%) for certainty-arb in last 90s |
| `CERTAINTY_MAX_FRACTION` | 0.02 | Kelly cap for certainty-arb positions (2% of bankroll) |
| `MAX_BET_FRACTION` | 0.04 | Kelly fraction cap (4% of bankroll) |
| `MAX_POSITION_USD` | 100 | Max USD per single trade |
| `MAX_OPEN_POSITIONS` | 8 | Concurrent position limit |
| `DAILY_LOSS_LIMIT` | 50 | Stop trading after this many USD lost in a day |
| `PROFIT_TARGET_PCT` | 0.08 | Exit a position when it reaches 8% profit |
| `STOP_LOSS_PCT` | 0.15 | Exit a position at 15% loss |
| `COOLDOWN_MS` | 3000 | Minimum ms between trades (stamped atomically) |
| `SLIPPAGE_BPS` | 15 | Expected slippage in basis points |
| `FEE_BPS` | 20 | Polymarket fee in basis points |
| `ORDER_TYPE` | GTC | Order type (GTC = Good Till Cancelled) |
| `DRY_RUN` | true | Paper trading mode — no real orders placed |
| `BTC_VOL` | 0.015 | BTC daily vol seed for Black-Scholes sigma (1.5%) |
| `ETH_VOL` | 0.020 | ETH daily vol seed (2.0%) |
| `SOL_VOL` | 0.030 | SOL daily vol seed (3.0%) |
| `XRP_VOL` | 0.035 | XRP daily vol seed (3.5%) |

## Risk Controls

- **Kelly Criterion**: Half-Kelly sizing with configurable cap; uses live bankroll (not static startup value)
- **Max Drawdown Kill Switch**: Auto-stops at 25% drawdown from peak; sticky — does not reset
- **Daily Loss Limit**: Stops trading after `DAILY_LOSS_LIMIT` USD lost (resets at UTC midnight)
- **Position Limits**: Max concurrent positions and per-trade USD cap; per-market stacking prevented
- **Cooldown**: Minimum ms between trades, stamped atomically in `canTrade()` to prevent races
- **Liquidity Check**: Rejects signals if available book depth is below position size; relaxed threshold for certainty-arb
- **Model Saturation Guard**: Suppresses latency-arb signals when N(d2) > 90% — in tiny-T regime the Chainlink oracle's ~1-min TWAP means apparent edge is not real
- **Stale Contract Guard**: Suppresses signals when feedLag > 5s — beyond that the lag reflects a REST polling failure, not genuine Polymarket repricing
- **Certainty-Arb Price Guard**: Skips certainty entry if the token side we'd buy is below 15¢ — at those prices the market has committed to the outcome and BS vol underestimates near-expiry certainty, producing phantom edge
- **Per-Asset Vol Calibration**: Each asset uses its own daily vol seed (`BTC_VOL` … `XRP_VOL`) pre-seeded from recent 1m Binance klines at startup, preventing phantom 20-24% edge on high-vol assets from BTC vol assumptions
- **Unhandled Rejection Kill Switch**: 5+ unhandled promise rejections in a 60s sliding window halts trading
- **Shutdown Accounting**: On shutdown, open positions are marked to current book mid (`estimated: true`) — no forced break-even

## Multi-Market Support

The engine runs one `MarketDiscovery` + `Strategy` instance per `(asset × window)` pair, sharing a single `PolymarketFeed`, deduplicated `BinanceFeed` per asset, and a single `RiskManager`.

- **Discovery**: Auto-discovers contracts via Gamma API slug pattern (`{asset}-updown-{window}m-{unix_timestamp}` aligned to window boundaries). Rotates 5s before expiry.
- **Book routing**: Every Polymarket book event is tagged with `tokenId` and routed to the correct strategy via `tokenToMarket` map.
- **Rotation safety**: On rotation, only the expiring market's open orders are cancelled (not all markets). Old tokens are unsubscribed; new tokens are subscribed and polling starts immediately.

Example: `ASSETS=BTC,ETH,SOL,XRP WINDOWS=5,15` runs 8 parallel market instances.

## Files

```
src/
├── index.js                 # Main orchestrator (ArbEngine)
├── config.js                # Config loader + validation
├── discovery.js             # Auto-discovers Up/Down contracts (Gamma API)
├── feeds/
│   ├── binance.js           # Binance depth WebSocket (depth20@100ms)
│   └── polymarket.js        # Polymarket CLOB WS + REST polling (429 retry)
├── engine/
│   ├── strategy.js          # Signal generation (latency-arb + certainty-arb)
│   └── risk.js              # Risk management (limits, kill switch, partial-close accounting)
├── execution/
│   └── executor.js          # Order placement, fill confirmation, position monitoring
└── utils/
    ├── logger.js            # Structured logging with TUI sink
    ├── math.js              # Probability, Kelly, statistics
    ├── alerts.js            # Discord/Telegram alerts
    ├── tui.js               # blessed terminal dashboard
    ├── tradeLog.js          # Append-only NDJSON trade audit log (data/trades.ndjson)
    └── stateStore.js        # JSON crash-recovery state (data/state.json)

tests/
└── executor.test.js         # 24 tests (node:test built-in)

.claude/skills/audit/
└── SKILL.md                 # /audit skill — runs dry-mode analysis and generates a structured report
```

## Tests

```bash
npm test
```

Uses Node.js built-in `node:test`. No external test framework required. Coverage includes: partial fill handling, fill timeout, partial-exit risk accounting, cumulative P&L, shutdown mark-to-market, monitor race conditions, idempotent finalization, `canTrade` kill conditions, liquidity rules, cooldown reservation, and per-market order isolation.

## Realistic Expectations

This is **not** a money printer. Real-world constraints:

- **Liquidity**: Most Polymarket contracts have $50-500 at any price level
- **Competition**: Market makers also watch Binance — you're racing them
- **Availability**: Contracts aren't always available or liquid across all assets
- **Slippage**: Your order moves the book, especially at size
- **Resolution**: Contracts resolve at specific times via Chainlink CEX aggregated price

Expected realistic performance:
- Win rate: 55-65% (not 95%)
- Edge per trade: 2-8% (not 20-50%)
- Trades per day: 5-20 per market pair

## Disclaimer

This is for educational purposes. Trading prediction markets involves risk of total loss. Past performance does not indicate future results.
