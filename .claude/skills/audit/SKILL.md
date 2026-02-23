---
name: audit
description: Audit trading bot readiness by running in dry mode, analyzing logs, and identifying improvements. Use when the user says "audit", "run dry-run analysis", or wants to assess bot health.
disable-model-invocation: false
---

# Dry-Run Audit

Run the engine in dry mode and analyze performance. Follow these steps exactly:

## Step 1 — Reset state and run the engine

**Always delete state.json before auditing.** The state file persists `dailyPnl` across sessions — if a previous run hit the daily loss limit, the engine will restore that loss and block all signals immediately, making the audit useless.

```bash
cd /Users/azp/a11/latency
rm -f data/state.json data/trades.ndjson
NO_TUI=1 npm run dry-run > /tmp/dryrun-audit.log 2>&1 &
AUDIT_PID=$!
echo "Audit PID: $AUDIT_PID"
```

`timeout` is not available on macOS — run in background and kill manually after the desired duration. For 2 full 5m rotations (~12 min):

```bash
sleep 720 && kill $AUDIT_PID
```

Or kill early once daily loss limit is hit or enough rotations are observed.

## Step 2 — Extract key metrics from the log

After stopping the run, parse `/tmp/dryrun-audit.log` and `data/trades.ndjson`:

```bash
# Rotations
grep -c "Rotating to:" /tmp/dryrun-audit.log

# Signals generated (engine side)
grep -cE "Signal generated|Certainty generated" /tmp/dryrun-audit.log

# Blocked signals and reasons
grep "Signal blocked" /tmp/dryrun-audit.log | grep -oE "Signal blocked: [^{]+" | sed 's/ *$//' | sort | uniq -c | sort -rn

# Kill switch / drawdown events
grep -iE "kill switch|drawdown|halting|daily loss" /tmp/dryrun-audit.log

# Vol seeds
grep "Vol seed" /tmp/dryrun-audit.log

# Strike captures
grep "strike captured" /tmp/dryrun-audit.log | head -20

# Warnings and errors
grep -iE "WARN|ERROR" /tmp/dryrun-audit.log | grep -v "No active market" | head -20
```

Parse trade P&L and exit reasons directly from `data/trades.ndjson` — the log P&L lines may not appear if TUI redirects them:

```bash
python3 -c "
import json
trades = [json.loads(l) for l in open('data/trades.ndjson')]
opens = {r['id']: r for r in trades if r['event'] == 'open'}
closes = [r for r in trades if r['event'] == 'close']
pairs = [(opens[r['id']], r) for r in closes if r['id'] in opens]
pnls = [c['pnl'] for o,c in pairs]
wins = [p for p in pnls if p > 0]
losses = [p for p in pnls if p <= 0]
reasons = {}
for o,c in pairs:
    r = c['reason']
    if r not in reasons: reasons[r] = []
    reasons[r].append(c['pnl'])
print(f'Trades: {len(pairs)} | Wins: {len(wins)} ({100*len(wins)/max(len(pairs),1):.1f}%) | Avg W: +\${sum(wins)/max(len(wins),1):.2f} | Avg L: -\${abs(sum(losses)/max(len(losses),1)):.2f}')
wl = (sum(wins)/max(len(wins),1)) / max(abs(sum(losses)/max(len(losses),1)), 0.01)
print(f'W:L: {wl:.2f} | Net PnL: \${sum(pnls):.2f}')
print()
for reason, rpnls in sorted(reasons.items()):
    w = len([p for p in rpnls if p > 0])
    print(f'  {reason}: {len(rpnls)} trades | avg \${sum(rpnls)/len(rpnls):.2f} | wins: {w} losses: {len(rpnls)-w}')
print()
by_asset = {}
for o,c in pairs:
    a = o[\"label\"].split(\"/\")[0]
    if a not in by_asset: by_asset[a] = []
    by_asset[a].append(c[\"pnl\"])
for a, apnls in sorted(by_asset.items()):
    print(f'  {a}: {len(apnls)} trades | net \${sum(apnls):.2f} | win rate {100*len([p for p in apnls if p>0])/len(apnls):.0f}%')
"
```

## Step 3 — Analyze and report

Evaluate the following dimensions:

### Signal Health
- **Signal rate**: How many signals per rotation? (target: 5-30 per 5m window)
- **Edge distribution**: Are edges clustering just above threshold (noise floor) or well above it? Signals with < 10% edge are borderline at current thresholds.
- **Certainty signals**: Are they appearing in the 0-90s window? Are they being blocked by liquidity or filling?
- **Rejection breakdown**: Which category dominates? Daily-loss blocks on startup = state was not reset. Liquidity rejections > 40% = book too thin. Cooldown thrashing = signals arriving in bursts.

### Trade P&L — Key Benchmarks
- **Win rate target**: > 45% (current sessions running ~35% — directional accuracy is the primary open problem)
- **W:L ratio target**: > 1.5 (below 1.0 is terminal regardless of win rate)
- **Stop-loss dominance**: If > 50% of exits are STOP_LOSS, entry quality is the issue, not exit parameters
- **PT vs EC parity**: PROFIT_TARGET exits and EDGE_COLLAPSED exits should produce similar avg PnL. If PT avg >> EC avg, there may still be value in a higher PT. If they're equal (as observed), PT=0.99 (effectively disabled) is correct — EC naturally catches the same exit.

### Feed Quality
- **Lag distribution**: Is `feedLag` consistently 1-5s (healthy latency-arb zone)? Spikes > 5s = REST polling failing (check for 429s).
- **Vol calibration**: Compare klines-seeded vol to config defaults. Large divergence means a volatile session — acceptable. Near-zero = EMA not updating (feed issue).
- **Stale contract blocks**: Should be rare (< 5% of evaluations). High rate = REST polling exhausted or rate-limited.

### Risk/Sizing
- **Position sizing**: `MAX_BET_FRACTION=4%` of $2000 bankroll = ~$80 max. Actual sizes ~$50 = Kelly capping due to moderate edge — expected.
- **Drawdown trajectory**: Volatile swings in dry-run = model taking positions at bad prices.
- **Daily loss limit**: `DAILY_LOSS_LIMIT=200`. If hit within first 15 min, win rate and/or position sizing is too aggressive.

### Market Discovery
- **Rotation timing**: Did rotations happen at the expected ±5s window? Should be consistent.
- **Strike capture latency**: Should be < 3s after rotation. Slow = Binance WS lagging.
- **Startup suppression**: No signals in window 1.

## Step 4 — Identify top improvements

Based on analysis, identify the highest-ROI improvements. Look for:

1. **Stop-loss dominance (> 50% SL exits)**: Directional accuracy is wrong. Investigate whether the model is consistently wrong on one direction (BUY_YES vs BUY_NO). Check if entries are happening after the move has already completed (feedLag > 3s may mean the arb is gone by execution).
2. **False-edge patterns**: 34.9% win rate in the Feb 22 session suggests phantom edge. The 8% threshold may need to go higher, or a direction-confirmation signal is needed before entry.
3. **Liquidity starvation**: If > 40% of signals are blocked by liquidity, lower `MAX_POSITION_USD` so we can get fills at thinner books.
4. **Certainty-arb underutilization**: Certainty signals appearing but not filling = threshold too high or size too small.
5. **Cooldown thrashing**: Multiple signals from same market within 3s cooldown = EMA not damping enough. Raise `COOLDOWN_MS`.
6. **Cross-asset correlation**: Multiple assets signaling same direction simultaneously = macro move, not latency-arb. Position sizing should account for correlation.

## Step 5 — Implement improvements

For each identified improvement, read the relevant source file, make the targeted change, and run `npm test` to confirm no regressions.

Prioritize:
1. Correctness bugs (wrong calculations, missing guards)
2. Risk calibration (position sizes, thresholds)
3. Signal quality (vol, edge filtering)
4. Operational improvements (logging, monitoring)

Always show the user what changed and why before implementing.

## Known findings from prior audits

**2026-02-22 session findings:**
- Win rate: 34.9% (target > 45%) — directional accuracy is the primary open problem
- 65% of exits are STOP_LOSS — entering in wrong direction more often than a coin flip
- `PROFIT_TARGET_PCT` set to 0.99 (effectively disabled) after backtest suggested it cut winners short. However, actual PT exits ($6.94 avg) and EC exits ($6.85 avg) were nearly identical — PT removal is neutral, not harmful. The backtest simulation overestimated the benefit (predicted +$35 avg winner; actual was +$6.94). The 1m kline BS model does not represent real Polymarket book dynamics reliably.
- Feed health is excellent: vol seeds from klines, strike capture < 2s, no stale contract issues, no 429s
- State persistence bug: `dailyPnl` carries over across same-day sessions — always delete `data/state.json` before auditing

## Output format

```
## Dry-Run Audit Report
**Duration**: Xm Ys | **Rotations**: N | **Markets**: BTC/5m, ETH/5m, ...

### Signals
- Generated: N total (N/rotation avg)
- Blocked: N daily-loss, N liquidity, N open-position, N cooldown
- Net executed: N

### Trade P&L
- Trades: N | Win rate: X% | Avg W: +$X | Avg L: -$X | W:L: X.XX | Net: $X
- Exit breakdown: PT: N | SL: N | EC: N | MH: N

### Feed Health
- Vol seeds: BTC X%, ETH X%, SOL X%, XRP X%
- Strike capture: < Xs (all markets)
- Stale-gate fires: N | 429s: N

### Risk
- Bankroll: $X → $X (Δ$X)
- Daily loss blocks: N

### Top Issues
1. [Issue]: [Evidence] → [Proposed fix]
2. ...

### Recommended Changes
[List with code snippets if appropriate]
```
