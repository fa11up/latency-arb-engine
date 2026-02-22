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
   - *Latency-arb* (t > 90s): edge > 3% AND contract stale >1s behind spot
   - *Certainty-arb* (0 < t ≤ 90s): edge > 15% as outcome approaches certainty; half-size; force-exits before expiry
6. **Risk check**: position limits, drawdown, cooldown, liquidity
7. **Execution**: place order on Polymarket CLOB
8. **Monitoring**: track position, exit on edge collapse / timeout / stop loss

## Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Polymarket API credentials

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
| `ENTRY_THRESHOLD` | 0.03 | Minimum edge (3%) to enter a latency-arb trade |
| `CERTAINTY_THRESHOLD` | 0.15 | Minimum edge (15%) for certainty-arb in last 90s |
| `CERTAINTY_MAX_FRACTION` | 0.02 | Kelly cap for certainty-arb positions (2% of bankroll) |
| `MAX_BET_FRACTION` | 0.04 | Kelly fraction cap (4% of bankroll) |
| `MAX_POSITION_USD` | 100 | Max USD per single trade |
| `MAX_OPEN_POSITIONS` | 5 | Concurrent position limit |
| `COOLDOWN_MS` | 3000 | Minimum ms between trades |
| `SLIPPAGE_BPS` | 15 | Expected slippage in basis points |
| `FEE_BPS` | 20 | Polymarket fee in basis points |
| `ORDER_TYPE` | GTC | Order type (GTC = Good Till Cancelled) |

## Risk Controls

- **Kelly Criterion**: Half-Kelly sizing with configurable cap
- **Max Drawdown Kill Switch**: Auto-stops at 25% drawdown from peak
- **Daily Loss Limit**: Stops trading after $200 daily loss
- **Position Limits**: Max concurrent positions and per-trade USD cap
- **Cooldown**: Minimum ms between trades (stamped atomically to prevent race conditions)
- **Liquidity Check**: Rejects signals with insufficient book depth

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
│   └── polymarket.js        # Polymarket CLOB WS + REST polling
├── engine/
│   ├── strategy.js          # Signal generation (latency-arb + certainty-arb)
│   └── risk.js              # Risk management (limits, kill switch)
├── execution/
│   └── executor.js          # Order placement + position tracking
└── utils/
    ├── logger.js            # Structured logging with TUI sink
    ├── math.js              # Probability, Kelly, statistics
    ├── alerts.js            # Discord/Telegram alerts
    └── tui.js               # blessed terminal dashboard
```

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
