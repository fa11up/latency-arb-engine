---
name: audit
description: Audit trading bot readiness by running in dry mode, analyzing logs, and identifying improvements. Use when the user says "audit", "run dry-run analysis", or wants to assess bot health.
disable-model-invocation: false
---

# Dry-Run Audit

Run the engine in dry mode and analyze performance. Follow these steps exactly:

## Step 1 — Run the engine

```bash
cd /Users/azp/a11/latency
NO_TUI=1 timeout 660 npm run dry-run 2>&1 | tee /tmp/dryrun-audit.log
```

Wait for the command to finish (timeout kills it after 11 minutes, which covers 2 full rotations of 5m markets). If the user wants a shorter or longer run, adjust the timeout.

## Step 2 — Extract key metrics from the log

After the run, parse `/tmp/dryrun-audit.log` for these patterns:

```bash
# Rotations
grep -c "Rotating to:" /tmp/dryrun-audit.log

# Signals generated
grep "Signal generated\|Certainty generated" /tmp/dryrun-audit.log

# Blocked signals and reasons
grep "Signal blocked" /tmp/dryrun-audit.log

# Kill switch / drawdown events
grep -i "kill\|drawdown\|halting" /tmp/dryrun-audit.log

# Edge values from signals
grep "edge:" /tmp/dryrun-audit.log | grep -oP "edge: \d+\.\d+%" | sort -t'%' -k1 -rn | head -20

# Feed lag stats
grep "lag:" /tmp/dryrun-audit.log | tail -20

# Vol seeds
grep "Vol seed" /tmp/dryrun-audit.log

# Strike captures
grep "strike captured" /tmp/dryrun-audit.log

# Any errors or warnings
grep -i "error\|warn" /tmp/dryrun-audit.log | grep -v "No active market\|Seeding\|Connecting"
```

## Step 3 — Analyze and report

Evaluate the following dimensions:

### Signal Health
- **Signal rate**: How many signals per rotation? (target: 5-30 per 5m window)
- **Edge distribution**: Are edges clustering just above threshold (noise floor) or well above it? Signals with < 6% edge are borderline.
- **Certainty signals**: Are they appearing in the 0-90s window? Are they being blocked by liquidity or filling?
- **Rejection breakdown**: Which category dominates? Cooldown, liquidity, position limit, or open-position guard? High cooldown rate = signals arriving in bursts (possible feed spike). High liquidity rejection = book too thin for our size.

### Feed Quality
- **Lag distribution**: Is `feedLag` consistently 1-5s (healthy latency-arb zone)? Spikes > 5s = REST polling failing (check for 429s). Zero lag = WS is working but no actual price divergence.
- **Vol calibration**: Compare klines-seeded vol to final realized vol in logs. Large divergence (>50%) means the EMA is picking up a volatile session; that's fine. If vol is near-zero throughout, the EMA isn't updating (feed issue).
- **Stale contract blocks**: How often does `feedLag > 5000ms` gate fire? Should be rare (< 5% of evaluations). High rate = REST polling exhausted or rate-limited.

### Risk/Sizing
- **Position sizing**: Are sizes sensible relative to bankroll? `MAX_BET_FRACTION=4%` of $1300 = ~$52 max. Sizes much smaller = Kelly is capping due to tight edge.
- **Drawdown trajectory**: Is bankroll stable in dry-run? In dry mode, P&L is simulated — volatile swings indicate the model is taking positions at bad prices.
- **Daily loss limit proximity**: Any "daily loss limit" blocks? If yes, the model may be over-trading in a trending market.

### Market Discovery
- **Rotation timing**: Did rotations happen at the expected ±5s window? Check "Rotating to:" timestamps vs. window boundaries.
- **Strike capture latency**: How quickly after rotation does "strike captured" appear? Should be < 3s. Slow capture = Binance WS lagging.
- **Startup suppression working**: Confirm no signals appear in window 1 (marketSetCount=1 guard).

## Step 4 — Identify top 3 improvements

Based on the analysis, identify the highest-ROI improvements. Look for:

1. **False-edge patterns**: Signals with high raw edge but poor direction accuracy suggest vol miscalibration or model saturation not being caught.
2. **Liquidity starvation**: If > 40% of signals are blocked by liquidity, the `MAX_POSITION_USD` or size cap may need lowering, or we need to check book depth more aggressively.
3. **Window timing drift**: If strike capture takes > 5s, there may be a race between the REST poll starting and the WS delivering the first tick.
4. **Certainty-arb underutilization**: If certainty signals are consistently blocked, the `certaintyThreshold` may be too high or `CERTAINTY_MAX_FRACTION` too small.
5. **Cooldown thrashing**: Multiple signals from the same market within the 3s cooldown = the EMA smoothing isn't damping enough. Consider raising `COOLDOWN_MS`.
6. **Cross-asset correlation**: If multiple assets all signal in the same direction simultaneously, it's a macro move — the latency-arb is real but position sizing should account for correlation.

## Step 5 — Implement improvements

For each identified improvement, read the relevant source file, make the targeted change, and run `npm test` to confirm no regressions.

Prioritize changes in this order:
1. Correctness bugs (wrong calculations, missing guards)
2. Risk calibration (position sizes, thresholds)
3. Signal quality (vol, edge filtering)
4. Operational improvements (logging, monitoring)

Always show the user what changed and why before implementing.

## Output format

Present findings as:
```
## Dry-Run Audit Report
**Duration**: Xm Ys | **Rotations**: N | **Markets**: BTC/5m, ETH/5m, ...

### Signals
- Generated: N total (N/rotation avg)
- Blocked: N cooldown, N liquidity, N open-position, N other
- Net executed: N

### Feed Health
- Avg lag: Xms | Max lag: Xms | Stale-gate fires: N
- Vol seeds: BTC X%, ETH X%, SOL X%, XRP X%

### Risk
- Bankroll: $X → $X (Δ$X)
- Max drawdown: X%
- Daily loss blocks: N

### Top Issues
1. [Issue]: [Evidence] → [Proposed fix]
2. ...

### Recommended Changes
[List with code snippets if appropriate]
```
