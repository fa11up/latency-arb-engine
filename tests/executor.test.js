/**
 * Executor + RiskManager unit tests.
 *
 * Tests the execution paths that are hardest to verify manually:
 *   1. Partial entry fill → position opens for filled qty only
 *   2. _waitForFill returns PARTIAL on CANCELLED-with-fills
 *   3. Force-exit-unconfirmed → _finalizeClose with estimated=true
 *   4. Bankroll / P&L invariants across partial + full close lifecycle
 *
 * Uses node:test (built-in, no install needed) + dynamic imports so
 * process.env overrides take effect before dotenv runs in config.js.
 *
 * Run: node --test tests/executor.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Override env BEFORE source modules load ─────────────────────────────────
// dotenv (loaded inside config.js) does NOT override existing process.env keys,
// so setting them here takes precedence over whatever is in .env.
Object.assign(process.env, {
  DRY_RUN:            "false",  // Enable live fill-confirmation path
  BANKROLL:           "1000",
  MAX_BET_FRACTION:   "0.1",
  MAX_POSITION_USD:   "200",
  MAX_OPEN_POSITIONS: "10",
  COOLDOWN_MS:        "0",      // No cooldown between test trades
  SLIPPAGE_BPS:       "15",
  FEE_BPS:            "20",
  DAILY_LOSS_LIMIT:   "500",
  PROFIT_TARGET_PCT:  "0.03",
  STOP_LOSS_PCT:      "0.15",
  ENTRY_THRESHOLD:    "0.03",
  LOG_LEVEL:          "error",  // Suppress engine logs in test output
  POLY_API_KEY:       "test-key",
  POLY_API_SECRET:    "dGVzdC1zZWNyZXQ=",  // base64("test-secret")
  POLY_API_PASSPHRASE: "test-passphrase",
  DISCORD_WEBHOOK_URL: "",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  ASSETS:             "BTC",
  WINDOWS:            "5",
});

// Dynamic imports: config.js (and dotenv) load here, AFTER env is set above.
const { Executor }     = await import("../src/execution/executor.js");
const { RiskManager }  = await import("../src/engine/risk.js");
const { CONFIG }       = await import("../src/config.js");

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRisk() {
  return new RiskManager();
}

/**
 * Build a mock PolymarketFeed with overridable async methods.
 * Default behaviour: successful full-fill entry + full-fill exit.
 */
function makePoly(overrides = {}) {
  return {
    placeOrder: async (params) => ({
      id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: "OPEN",
      ...params,
    }),
    getOrder: async (id) => ({
      id,
      status: "MATCHED",
      size: "10",
      remainingSize: "0",
      avgPrice: "0.60",
    }),
    cancelOrder: async () => ({ success: true }),
    cancelAll:   async () => ({ success: true }),
    fetchOrderbook: async () => ({
      mid: 0.60, bestBid: 0.59, bestAsk: 0.61,
      bidDepth: 500, askDepth: 500,
      timestamp: Date.now(), lag: 0,
    }),
    ...overrides,
  };
}

/** Minimal valid signal object. */
function makeSignal(overrides = {}) {
  return {
    label:     "BTC/5m",
    direction: "BUY_YES",
    isCertainty: false,
    tokenId:   "token-yes-abc123",
    entryPrice: 0.55,
    size:       5.50,   // dollar size
    rawSize:    5.50,
    edge:       0.10,
    modelProb:  0.65,
    contractPrice: 0.55,
    spotPrice:  50000,
    strikePrice: 50000,
    feedLag:    2000,
    vol:        0.015,
    kelly:      0.04,
    odds:       0.82,
    slippage:   0.055,
    fee:        0.055,
    availableLiquidity: 200,
    hoursToExpiry: 0.05,
    ...overrides,
  };
}

/** Build a trade record already inserted into exec.openOrders and risk.openPositions. */
function makeOpenTrade(exec, risk, overrides = {}) {
  const trade = {
    id:         "trade-1",
    signal:     makeSignal(),
    order:      { id: "entry-ord", status: "OPEN" },
    entryPrice: 0.55,
    tokenQty:   10,
    size:       5.50,
    initialSize: 5.50,
    direction:  "BUY_YES",
    status:     "OPEN",
    openTime:   Date.now(),
    executionLatency: 10,
    pnl:        null,
    currentMid: 0.60,
    unrealizedPnl: 0.50,
    realizedPnl: 0,
    ...overrides,
  };
  exec.openOrders.set(trade.id, trade);
  risk.openPosition({ id: trade.id, side: "BUY_YES", size: trade.size, entryPrice: trade.entryPrice });
  return trade;
}

// ─── Test 1: Partial entry fill ───────────────────────────────────────────────
test("partial entry fill: position opens for filled qty only", async () => {
  const risk = makeRisk();
  let cancelCalled = false;

  // Simulate: order placed (OPEN), then first poll returns CANCELLED with 5 of 10 filled
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-entry", status: "OPEN" }),
    getOrder:   async () => ({
      id: "ord-entry",
      status: "CANCELLED",
      size: "10",
      remainingSize: "5",
      avgPrice: "0.57",
    }),
    cancelOrder: async () => { cancelCalled = true; return { success: true }; },
  });

  const exec = new Executor(poly, risk);
  // Disable position monitor so setInterval/setTimeout don't keep the test process alive.
  // Monitoring behaviour is not under test here.
  exec._monitorPosition = () => {};

  // requestedQty = signal.size / signal.entryPrice = 5.50 / 0.55 = 10 tokens
  const signal = makeSignal({ entryPrice: 0.55, size: 5.50 });

  const trade = await exec.execute(signal);

  assert.ok(trade, "position should be opened despite partial fill");
  assert.equal(trade.tokenQty, 5,     "tokenQty = filled portion (10 total - 5 remaining)");
  assert.equal(trade.entryPrice, 0.57, "entry price from confirmed fill avgPrice");
  assert.ok(cancelCalled,              "unfilled remainder should be cancelled");
  assert.equal(risk.openPositions.size, 1, "one open position registered in RiskManager");
  assert.ok(risk.bankroll < 1000,      "bankroll reduced by actual position cost");
  assert.equal(exec.fillRateStats.partial, 1, "partial fill counter incremented");
});

// ─── Test 2: _waitForFill partial path ───────────────────────────────────────
test("_waitForFill: PARTIAL returned on CANCELLED-with-fills", async () => {
  const poly = makePoly({
    // First poll: CANCELLED with 4 of 10 filled
    getOrder: async () => ({
      status: "CANCELLED",
      size: "10",
      remainingSize: "6",
      avgPrice: "0.58",
    }),
  });
  const exec = new Executor(poly, makeRisk());

  // Short timeout (500ms) so test completes quickly.
  const fill = await exec._waitForFill("ord-1", 10, 500);

  assert.equal(fill.status,    "PARTIAL", "status should be PARTIAL when CANCELLED-with-fills");
  assert.equal(fill.filledQty, 4,         "filledQty = total(10) - remaining(6)");
  assert.equal(fill.avgPrice,  0.58,      "avgPrice parsed from order response");
});

// ─── Test 3: Force-exit-unconfirmed → estimated=true ─────────────────────────
test("force-exit-unconfirmed: _finalizeClose marks trade as estimated", () => {
  const risk = makeRisk();
  const exec = new Executor(makePoly(), risk);
  const trade = makeOpenTrade(exec, risk);

  const markPrice   = 0.62;
  const expectedPnl = (markPrice - trade.entryPrice) * trade.tokenQty; // (0.62-0.55)*10 = 0.70

  // Simulate the safety-timeout body calling _finalizeClose with estimated=true.
  exec._finalizeClose(trade, {
    reason:    "FORCE_EXIT_UNCONFIRMED",
    exitPrice: markPrice,
    pnl:       expectedPnl,
    estimated: true,
  });

  assert.equal(trade.status,        "CLOSED",                  "trade should be CLOSED");
  assert.equal(trade.exitReason,    "FORCE_EXIT_UNCONFIRMED",  "exit reason set");
  assert.equal(trade.estimatedExit, true,                      "estimated flag must be true");
  assert.ok(
    Math.abs(trade.pnl - expectedPnl) < 0.001,
    `P&L should be mark-to-market: expected ${expectedPnl.toFixed(4)}, got ${trade.pnl}`
  );
  assert.ok(!exec.openOrders.has(trade.id),    "removed from openOrders");
  assert.ok(!risk.openPositions.has(trade.id), "removed from risk openPositions");
  assert.equal(exec.pnlStats.n, 1,             "P&L stats updated");
});

// ─── Test 4: Bankroll / P&L invariants ───────────────────────────────────────
test("bankroll invariant: P&L reconciles across partial close + full close lifecycle", () => {
  const risk = makeRisk();
  const initial = risk.bankroll; // 1000 from env override

  // Open two positions
  risk.openPosition({ id: "p1", side: "BUY_YES", size: 10, entryPrice: 0.50 });
  risk.openPosition({ id: "p2", side: "BUY_NO",  size: 20, entryPrice: 0.40 });

  assert.equal(risk.bankroll, initial - 30, "bankroll reduced by sum of open sizes");

  // Close p1 with $2 profit: bankroll += pos.size(10) + pnl(2) = 12
  risk.closePosition("p1", 2);
  assert.equal(risk.bankroll, initial - 30 + 12, "after p1 close: capital + profit returned");

  // Partial close p2: $5 notional returned + $0.50 profit
  risk.applyPartialClose("p2", { realizedNotional: 5, realizedPnl: 0.50 });
  const afterPartial = initial - 30 + 12 + 5 + 0.50; // = 987.50
  assert.ok(
    Math.abs(risk.bankroll - afterPartial) < 0.001,
    `after partial close: expected ${afterPartial}, got ${risk.bankroll}`
  );

  // Verify pos.size decreased
  assert.equal(risk.openPositions.get("p2").size, 15, "p2 pos.size reduced by realizedNotional");

  // Close remaining p2 with $1 loss: bankroll += pos.size(15) + pnl(-1) = 14
  risk.closePosition("p2", -1);
  const expectedFinal = afterPartial + 15 - 1; // 1001.50
  assert.ok(
    Math.abs(risk.bankroll - expectedFinal) < 0.001,
    `final bankroll: expected ${expectedFinal}, got ${risk.bankroll}`
  );

  // Daily P&L: 2 + 0.50 + (-1) = 1.50
  const expectedDailyPnl = 2 + 0.50 - 1;
  assert.ok(
    Math.abs(risk.dailyPnl - expectedDailyPnl) < 0.001,
    `dailyPnl: expected ${expectedDailyPnl}, got ${risk.dailyPnl}`
  );

  // Net bankroll change = sum of all P&L (initial capital fully recovered)
  const netChange = risk.bankroll - initial;
  assert.ok(
    Math.abs(netChange - expectedDailyPnl) < 0.001,
    `net bankroll change (${netChange.toFixed(4)}) should equal total P&L (${expectedDailyPnl})`
  );
});

// ─── Test 5: _waitForFill timeout path ───────────────────────────────────────
test("_waitForFill: TIMEOUT returned when order stays OPEN with zero fills", async () => {
  const poly = makePoly({
    getOrder: async () => ({
      status: "OPEN",
      size: "10",
      remainingSize: "10",
    }),
  });
  const exec = new Executor(poly, makeRisk());

  const fill = await exec._waitForFill("ord-timeout", 10, 1);
  assert.equal(fill.status, "TIMEOUT");
  assert.equal(fill.filledQty, 0);
  assert.equal(fill.avgPrice, null);
});

// ─── Test 6: _waitForFill status normalization ───────────────────────────────
test("_waitForFill: lowercase 'filled' status normalizes to MATCHED", async () => {
  const poly = makePoly({
    getOrder: async () => ({
      status: "filled",
      size: "10",
      remainingSize: "0",
      avgPrice: "0.61",
    }),
  });
  const exec = new Executor(poly, makeRisk());

  const fill = await exec._waitForFill("ord-filled", 10, 250);
  assert.equal(fill.status, "MATCHED");
  assert.equal(fill.filledQty, 10);
  assert.equal(fill.avgPrice, 0.61);
});

// ─── Test 7: Partial exit updates remaining exposure + risk state ────────────
test("_exitPosition partial: reduces trade tokenQty/size and applies partial risk close", async () => {
  const risk = makeRisk();
  let cancelledId = null;
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-exit", status: "OPEN" }),
    cancelOrder: async (id) => { cancelledId = id; return { success: true }; },
  });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk);

  // Drive this call into partial-exit branch.
  exec._waitForFill = async () => ({
    status: "PARTIAL",
    filledQty: 4,
    avgPrice: 0.62,
  });

  const beforeBankroll = risk.bankroll; // after openPosition has already debited.
  const exited = await exec._exitPosition(trade, "EDGE_COLLAPSED", 0.62);

  assert.equal(exited, false, "partial fill should keep position open");
  assert.equal(trade.status, "OPEN", "trade should revert to OPEN for retry");
  assert.equal(trade.tokenQty, 6, "remaining token qty should decrease by filled amount");
  assert.ok(Math.abs(trade.size - 3.3) < 0.001, "remaining dollar size should decrease by realized notional");
  assert.ok(Math.abs(risk.openPositions.get(trade.id).size - 3.3) < 0.001, "risk open position size should match trade size");
  assert.ok(cancelledId, "resting remainder should be cancelled");

  const expectedRealizedPnl = (0.62 - 0.55) * 4; // 0.28
  const expectedRealizedNotional = 4 * 0.55; // 2.2
  const expectedBankroll = beforeBankroll + expectedRealizedNotional + expectedRealizedPnl;
  assert.ok(Math.abs(risk.bankroll - expectedBankroll) < 0.001, "bankroll should credit partial realization");
});

// ─── Test 8: partial then full close keeps cumulative pnl consistent ─────────
test("partial then full close: final trade pnl equals cumulative realized pnl", async () => {
  const risk = makeRisk();
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-exit-2", status: "OPEN" }),
    cancelOrder: async () => ({ success: true }),
  });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk);

  // 1) partial close 4 tokens @ 0.62
  exec._waitForFill = async () => ({ status: "PARTIAL", filledQty: 4, avgPrice: 0.62 });
  await exec._exitPosition(trade, "EDGE_COLLAPSED", 0.62);

  // 2) final close remaining 6 tokens @ 0.60
  exec._waitForFill = async () => ({ status: "MATCHED", filledQty: 6, avgPrice: 0.60 });
  const exited = await exec._exitPosition(trade, "PROFIT_TARGET", 0.60);
  assert.equal(exited, true);
  assert.equal(trade.status, "CLOSED");

  const expectedTotalPnl = ((0.62 - 0.55) * 4) + ((0.60 - 0.55) * 6); // 0.58
  assert.ok(Math.abs(trade.pnl - expectedTotalPnl) < 0.001, "closed trade pnl should include partial + final pnl");
  assert.equal(exec.pnlStats.n, 1, "only one closed trade should be counted");
  assert.ok(Math.abs(exec.pnlStats.sum - expectedTotalPnl) < 0.001, "stats sum should match cumulative pnl");
  assert.ok(!risk.openPositions.has(trade.id), "risk position should be fully closed");
});

// ─── Test 9: cancelAllOrders writes estimated close bookkeeping ───────────────
test("cancelAllOrders: closes open trades at mark with estimated flag and updates stats", async () => {
  const risk = makeRisk();
  const poly = makePoly({ cancelAll: async () => ({ success: true }) });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk, { currentMid: 0.60 });

  await exec.cancelAllOrders();

  assert.equal(exec.openOrders.size, 0, "all open orders should be removed");
  assert.equal(exec.tradeHistory.length, 1, "shutdown close should be recorded");
  assert.equal(exec.tradeHistory[0].estimatedExit, true, "shutdown close should be marked estimated");
  assert.equal(exec.tradeHistory[0].exitReason, "SHUTDOWN");
  assert.equal(exec.pnlStats.n, 1, "pnl stats should include shutdown close");
  assert.ok(!risk.openPositions.has(trade.id), "risk open position should be closed");
});

// ─── Test 10: monitor race (interval exit + safety timeout overlap) ──────────
test("_monitorPosition race: no double-close when safety timeout overlaps in-flight exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const risk = makeRisk();
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-exit-race", status: "OPEN" }),
    fetchOrderbook: async () => ({
      mid: 0.70, bestBid: 0.69, bestAsk: 0.71, bidDepth: 500, askDepth: 500, timestamp: Date.now(), lag: 0,
    }),
  });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk, {
    id: "race-trade",
    signal: makeSignal({ isCertainty: true, expiresAt: Date.now() }), // maxHold collapses to 5s
  });

  // Deterministic slow close: first call waits 12s, safety call during CLOSING returns false.
  let closeAttempts = 0;
  let closeCommitted = 0;
  exec._exitPosition = async (tTrade) => {
    closeAttempts++;
    if (tTrade.status === "CLOSING" || tTrade.status === "CLOSED") return false;
    if (!exec.openOrders.has(tTrade.id)) return false;
    tTrade.status = "CLOSING";
    await new Promise(resolve => setTimeout(resolve, 12_000));
    if (!exec.openOrders.has(tTrade.id)) return false;
    tTrade.status = "CLOSED";
    exec.openOrders.delete(tTrade.id);
    risk.closePosition(tTrade.id, 0);
    exec.tradeHistory.push(tTrade);
    exec.pnlStats.push(0);
    closeCommitted++;
    return true;
  };

  exec._monitorPosition(trade);

  // 2s: interval fires -> _exitPosition enters CLOSING and waits on _waitForFill.
  t.mock.timers.tick(2_000);
  await Promise.resolve();
  assert.equal(trade.status, "CLOSING", "trade should be in-flight closing after monitor trigger");

  // 10s total: safety timeout fires while first close still in-flight.
  t.mock.timers.tick(8_000);
  await Promise.resolve();

  // 14s total: in-flight close resolves (wait started at t=2s, waits 12s).
  t.mock.timers.tick(4_000);
  await Promise.resolve();

  assert.equal(closeAttempts, 2, "race should produce exactly 2 close attempts: monitor + safety timeout");
  assert.equal(closeCommitted, 1, "only one close should commit");
  assert.equal(exec.tradeHistory.length, 1, "exactly one close event must be recorded");
  assert.equal(exec.pnlStats.n, 1, "P&L stats should only be updated once");
  assert.ok(!exec.openOrders.has(trade.id), "trade must be closed");
  assert.ok(!risk.openPositions.has(trade.id), "risk position must be closed once");
});

// ─── Test 11: idempotent finalize under repeated close calls ──────────────────
test("_finalizeClose path: repeated _exitPosition calls do not duplicate close records", async () => {
  const risk = makeRisk();
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-final", status: "OPEN" }),
  });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk, { id: "idem-trade" });

  exec._waitForFill = async () => ({
    status: "MATCHED",
    filledQty: trade.tokenQty,
    avgPrice: 0.61,
  });

  const first = await exec._exitPosition(trade, "PROFIT_TARGET", 0.61);
  const second = await exec._exitPosition(trade, "PROFIT_TARGET", 0.61);

  assert.equal(first, true, "first close should succeed");
  assert.equal(second, false, "second close attempt should be ignored");
  assert.equal(exec.tradeHistory.length, 1, "only one close should be recorded");
  assert.equal(exec.pnlStats.n, 1, "only one pnl stat push expected");
});

// ─── Test 12: Entry TIMEOUT with zero fills → null returned, bankroll unchanged ─
test("execute: TIMEOUT with zero fills → null returned, bankroll untouched, no risk state", async () => {
  const risk = makeRisk();
  const initialBankroll = risk.bankroll;
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-timeout-entry", status: "OPEN" }),
    cancelOrder: async () => ({ success: true }),
  });
  const exec = new Executor(poly, risk);
  exec._monitorPosition = () => {};
  // Bypass the poll loop: immediately report TIMEOUT with nothing filled.
  exec._waitForFill = async () => ({ status: "TIMEOUT", avgPrice: null, filledQty: 0 });

  const result = await exec.execute(makeSignal());

  assert.equal(result, null, "execute should return null when no tokens filled");
  assert.equal(risk.openPositions.size, 0, "no risk position should be registered");
  assert.equal(risk.bankroll, initialBankroll, "bankroll must be unchanged — no capital was committed");
  assert.equal(exec.openOrders.size, 0, "nothing should remain in openOrders");
  assert.equal(exec.fillRateStats.cancelled, 1, "cancelled counter must be incremented");
  assert.equal(exec.fillRateStats.filled, 0, "filled counter must remain zero");
});

// ─── Test 13: cancelAllOrders with null currentMid falls back to entryPrice ───
test("cancelAllOrders: null currentMid falls back to entryPrice — zero estimated P&L", async () => {
  const risk = makeRisk();
  const exec = new Executor(makePoly(), risk);
  // Trade that opened but never had a monitor tick: currentMid stays null.
  const trade = makeOpenTrade(exec, risk, { currentMid: null });

  await exec.cancelAllOrders();

  const closed = exec.tradeHistory[0];
  assert.equal(closed.exitPrice, trade.entryPrice, "exit price should equal entry price when no mark available");
  assert.ok(Math.abs(closed.pnl) < 0.001, "P&L should be zero when exit = entry price");
  assert.equal(closed.estimatedExit, true, "must be flagged estimated");
  assert.equal(closed.exitReason, "SHUTDOWN");
  assert.equal(exec.openOrders.size, 0);
  assert.ok(!risk.openPositions.has(trade.id));
});

// ─── Test 14: canTrade — daily loss limit ─────────────────────────────────────
test("canTrade: daily loss limit blocks new trades", () => {
  const risk = makeRisk();
  // Inject a loss that exceeds the configured DAILY_LOSS_LIMIT (500 in test env).
  risk.dailyPnl = -501;

  const { allowed, reasons } = risk.canTrade(makeSignal());

  assert.equal(allowed, false, "trade should be blocked when daily loss limit is hit");
  assert.ok(reasons.some(r => r.includes("Daily loss limit")),
    `expected 'Daily loss limit' in reasons, got: ${reasons}`);
});

// ─── Test 15: canTrade — max drawdown activates kill switch ──────────────────
test("canTrade: drawdown beyond maxDrawdownPct activates kill switch", () => {
  const risk = makeRisk();
  // Push bankroll below the 25% drawdown threshold (configured in risk.js as 0.25).
  // peakBankroll = 1000 (initial), trigger at bankroll < 750.
  risk.bankroll = 740;

  const { allowed } = risk.canTrade(makeSignal());

  assert.equal(allowed, false, "trade should be blocked when max drawdown exceeded");
  assert.equal(risk.killed, true, "kill switch must be activated");
  assert.ok(risk.killReason?.includes("drawdown"), `killReason should mention drawdown, got: ${risk.killReason}`);
  // Subsequent canTrade calls must also be blocked (kill is sticky).
  const { allowed: secondCall } = risk.canTrade(makeSignal());
  assert.equal(secondCall, false, "kill switch must remain active on subsequent calls");
});

// ─── Test 16: real _exitPosition race path (no method override) ───────────────
test("_monitorPosition race (real _exitPosition): monitor + safety overlap still commits one close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const flush = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

  const risk = makeRisk();
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-exit-real-race", status: "OPEN" }),
    fetchOrderbook: async () => ({
      mid: 0.70, bestBid: 0.69, bestAsk: 0.71, bidDepth: 500, askDepth: 500, timestamp: Date.now(), lag: 0,
    }),
  });
  const exec = new Executor(poly, risk);
  const trade = makeOpenTrade(exec, risk, {
    id: "race-trade-real",
    signal: makeSignal({ isCertainty: true, expiresAt: Date.now() }), // maxHold => 5s
  });

  // Keep first _exitPosition in-flight long enough to overlap safety timeout.
  exec._waitForFill = async () =>
    new Promise(resolve =>
      setTimeout(() => resolve({ status: "MATCHED", filledQty: trade.tokenQty, avgPrice: 0.62 }), 12_000)
    );

  const originalExit = exec._exitPosition.bind(exec);
  let exitCalls = 0;
  exec._exitPosition = async (...args) => {
    exitCalls++;
    return originalExit(...args);
  };

  exec._monitorPosition(trade);

  // t=2s: monitor interval triggers first close attempt.
  t.mock.timers.tick(2_000);
  await flush();
  assert.equal(trade.status, "CLOSING");

  // t=10s: safety timeout overlaps; second close attempt should return false.
  t.mock.timers.tick(8_000);
  await flush();

  // First in-flight close resolves at t=14s.
  t.mock.timers.tick(20_000);
  await flush(12);

  assert.equal(exitCalls, 2, "expected monitor close attempt + safety overlap attempt");
  assert.equal(exec.tradeHistory.length, 1, "exactly one close should be recorded");
  assert.equal(exec.pnlStats.n, 1, "pnl stats must be pushed once");
  assert.ok(!exec.openOrders.has(trade.id));
  assert.ok(!risk.openPositions.has(trade.id));
});

// ─── Test 17: parser edge case — malformed avgPrice falls back to signal price ─
test("execute: malformed fill avgPrice falls back to signal.entryPrice", async () => {
  const risk = makeRisk();
  const poly = makePoly({
    placeOrder: async () => ({ id: "ord-bad-avg", status: "OPEN" }),
    getOrder: async () => ({
      status: "MATCHED",
      size: "10",
      remainingSize: "0",
      avgPrice: "not-a-number",
    }),
  });
  const exec = new Executor(poly, risk);
  exec._monitorPosition = () => {};
  const signal = makeSignal({ entryPrice: 0.55, size: 5.50 });

  const trade = await exec.execute(signal);
  assert.ok(trade);
  assert.equal(trade.entryPrice, 0.55, "invalid avgPrice should fall back to requested entryPrice");
});

// ─── Test 18: parser edge case — overfilled qty is clamped to requested qty ───
test("_waitForFill: filledQty is clamped to requestedQty", async () => {
  const poly = makePoly({
    getOrder: async () => ({
      status: "MATCHED",
      size: "10",
      remainingSize: "-5", // implies 15 filled from raw parser; should be clamped to requested
      avgPrice: "0.60",
    }),
  });
  const exec = new Executor(poly, makeRisk());

  const fill = await exec._waitForFill("ord-overfill", 10, 250);
  assert.equal(fill.status, "MATCHED");
  assert.equal(fill.filledQty, 10, "filled qty should never exceed requested qty");
});

// ─── Test 19: parser edge case — makerAmount fallback for partial detection ───
test("_waitForFill: makerAmount fallback reports PARTIAL when size fields missing", async () => {
  const poly = makePoly({
    getOrder: async () => ({
      status: "CANCELLED",
      makerAmount: "3.5",
      avgPrice: "0.59",
    }),
  });
  const exec = new Executor(poly, makeRisk());

  const fill = await exec._waitForFill("ord-maker", 10, 250);
  assert.equal(fill.status, "PARTIAL");
  assert.equal(fill.filledQty, 3.5);
  assert.equal(fill.avgPrice, 0.59);
});

// ─── Test 20: cancelOrdersForLabel only touches matching market positions ─────
test("cancelOrdersForLabel: cancels only matching label and preserves others", async () => {
  const risk = makeRisk();
  const cancelled = [];
  const poly = makePoly({
    cancelOrder: async (id) => { cancelled.push(id); return { success: true }; },
  });
  const exec = new Executor(poly, risk);

  const tradeA = makeOpenTrade(exec, risk, {
    id: "btc-trade",
    signal: makeSignal({ label: "BTC/5m", tokenId: "btc-token" }),
  });
  const tradeB = makeOpenTrade(exec, risk, {
    id: "eth-trade",
    signal: makeSignal({ label: "ETH/5m", tokenId: "eth-token" }),
  });

  await exec.cancelOrdersForLabel("BTC/5m");

  assert.deepEqual(cancelled, ["btc-trade"], "only BTC/5m order should be cancelled");
  assert.ok(!exec.openOrders.has(tradeA.id), "matching trade removed");
  assert.ok(exec.openOrders.has(tradeB.id), "non-matching trade preserved");
  assert.ok(!risk.openPositions.has(tradeA.id), "risk state closed for matching trade");
  assert.ok(risk.openPositions.has(tradeB.id), "risk state kept for non-matching trade");
});

// ─── Test 21: canTrade liquidity rule — certainty 1x vs normal 2x ─────────────
test("canTrade liquidity: certainty trades need 1x size, normal trades need 2x", () => {
  const risk = makeRisk();

  const certaintySignal = makeSignal({
    isCertainty: true,
    size: 10,
    availableLiquidity: 10,
  });
  const normalSignal = makeSignal({
    isCertainty: false,
    size: 10,
    availableLiquidity: 10,
  });

  const certainty = risk.canTrade(certaintySignal);
  const normal = risk.canTrade(normalSignal);

  assert.equal(certainty.allowed, true, "certainty trade should pass with 1x liquidity");
  assert.equal(normal.allowed, false, "normal trade should fail with only 1x liquidity");
  assert.ok(normal.reasons.some(r => r.includes("Insufficient liquidity")));
});

// ─── Test 22: cooldown reservation only on allowed trade ──────────────────────
test("canTrade cooldown reservation: lastTradeTime updates only when allowed", () => {
  const risk = makeRisk();
  const prevCooldown = CONFIG.risk.cooldownMs;
  CONFIG.risk.cooldownMs = 1_000;

  try {
    const start = risk.lastTradeTime;
    const allowed = risk.canTrade(makeSignal({ availableLiquidity: 1000 }));
    assert.equal(allowed.allowed, true);
    assert.ok(risk.lastTradeTime >= start, "lastTradeTime should reserve slot when allowed");

    const afterAllowed = risk.lastTradeTime;
    const blocked = risk.canTrade(makeSignal({ availableLiquidity: 1000 }));
    assert.equal(blocked.allowed, false, "second immediate trade should be blocked by cooldown");
    assert.equal(risk.lastTradeTime, afterAllowed, "blocked check must not update lastTradeTime");
  } finally {
    CONFIG.risk.cooldownMs = prevCooldown;
  }
});
