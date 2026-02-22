import { createLogger } from "../utils/logger.js";
import { sendAlert } from "../utils/alerts.js";
import { RunningStats } from "../utils/math.js";
import { logTrade } from "../utils/tradeLog.js";

const log = createLogger("EXECUTOR");

/**
 * Execution layer.
 *
 * Receives validated signals from the strategy engine,
 * places orders on Polymarket, and tracks fills/outcomes.
 *
 * Responsibilities:
 *   - Place limit orders at or near the signal price
 *   - Track order status (open → filled → resolved)
 *   - Report P&L back to risk manager
 *   - Handle partial fills, timeouts, cancellations
 *   - Log all trades to data/trades.ndjson
 *   - Expose getOpenSnapshot() + restorePositions() for crash recovery
 */
export class Executor {
  constructor(polyClient, riskManager) {
    this.poly = polyClient;
    this.risk = riskManager;

    // Active orders
    this.openOrders = new Map(); // orderId → trade

    // Stats
    this.pnlStats = new RunningStats();
    this.fillRateStats = { attempted: 0, filled: 0, cancelled: 0, failed: 0 };
    this.executionLatencies = [];

    // Trade history (ring buffer)
    this.tradeHistory = [];
    this.maxHistory = 500;

    // Called whenever a trade opens or closes — used by ArbEngine to persist state.
    this.onTradeEvent = null;
  }

  // ─── EXECUTE SIGNAL ─────────────────────────────────────────────────
  async execute(signal) {
    const start = Date.now();
    this.fillRateStats.attempted++;

    try {
      const orderParams = {
        tokenId: signal.tokenId,
        side: "BUY",
        price: signal.entryPrice,
        size: signal.size / signal.entryPrice,
        orderType: "GTC",
      };

      log.trade(`Executing: ${signal.direction} $${signal.size.toFixed(2)} @ ${signal.entryPrice.toFixed(4)}`, {
        edge: `${(signal.edge * 100).toFixed(1)}%`,
        model: `${(signal.modelProb * 100).toFixed(1)}%`,
        spot: `$${signal.spotPrice.toFixed(1)}`,
      });

      const order = await this.poly.placeOrder(orderParams);
      const latency = Date.now() - start;
      this.executionLatencies.push(latency);
      if (this.executionLatencies.length > 100) this.executionLatencies.shift();

      const trade = {
        id: order.id,
        signal,
        order,
        entryPrice: signal.entryPrice,
        size: signal.size,
        direction: signal.direction,
        status: "OPEN",
        openTime: Date.now(),
        executionLatency: latency,
        pnl: null,
        currentMid: null,    // updated by monitor every 2s — used by TUI
        unrealizedPnl: null, // ditto
      };

      this.openOrders.set(order.id, trade);
      this.risk.openPosition({
        id: order.id,
        side: signal.direction,
        size: signal.size,
        entryPrice: signal.entryPrice,
      });

      this.fillRateStats.filled++;
      log.trade(`Order live: ${order.id}`, { latency: `${latency}ms` });

      logTrade({
        event: "open",
        id: trade.id,
        label: signal.label,
        direction: signal.direction,
        entryPrice: signal.entryPrice,
        size: signal.size,
        edge: signal.edge,
        modelProb: signal.modelProb,
        spotPrice: signal.spotPrice,
        strikePrice: signal.strikePrice,
        openTime: trade.openTime,
        isCertainty: signal.isCertainty || false,
      });

      this._monitorPosition(trade);
      this.onTradeEvent?.({ type: "open", trade });

      return trade;

    } catch (err) {
      this.fillRateStats.failed++;
      log.error("Execution failed", {
        error: err.message,
        signal: { direction: signal.direction, size: signal.size.toFixed(2), edge: `${(signal.edge * 100).toFixed(1)}%` },
      });
      return null;
    }
  }

  // ─── POSITION MONITORING ────────────────────────────────────────────
  _monitorPosition(trade) {
    const checkInterval = 2000;
    const maxHoldMs = trade.signal.isCertainty
      ? Math.max((trade.signal.expiresAt || 0) - trade.openTime, 5000)
      : 300000;
    const profitTarget = 0.03;
    const stopLoss = -0.5;

    const monitor = setInterval(async () => {
      // Stop if this trade was cancelled externally (e.g. market rotation).
      if (!this.openOrders.has(trade.id)) {
        clearInterval(monitor);
        return;
      }

      const age = Date.now() - trade.openTime;

      let currentMid;
      try {
        const currentBook = await this.poly.fetchOrderbook(trade.signal.tokenId);
        if (!currentBook || currentBook.bestBid === 0 && currentBook.bestAsk === 1) return;
        currentMid = currentBook.mid;
      } catch {
        return;
      }

      const unrealizedPnl = (currentMid - trade.entryPrice) * (trade.size / trade.entryPrice);
      const pnlPct = unrealizedPnl / trade.size;

      // Update trade in-place so TUI can read current state
      trade.currentMid = currentMid;
      trade.unrealizedPnl = unrealizedPnl;

      let shouldExit = false;
      let exitReason = "";

      if (age >= maxHoldMs)                                                  { shouldExit = true; exitReason = "MAX_HOLD_TIME"; }
      if (pnlPct >= profitTarget)                                            { shouldExit = true; exitReason = "PROFIT_TARGET"; }
      if (pnlPct <= stopLoss)                                                { shouldExit = true; exitReason = "STOP_LOSS"; }
      if (trade.signal.isCertainty && Date.now() >= trade.signal.expiresAt) { shouldExit = true; exitReason = "CERTAINTY_EXPIRY"; }

      const targetPrice = trade.direction === "BUY_YES" ? trade.signal.modelProb : 1 - trade.signal.modelProb;
      if (Math.abs(currentMid - targetPrice) < 0.02) { shouldExit = true; exitReason = "EDGE_COLLAPSED"; }

      if (shouldExit) {
        clearInterval(monitor);
        await this._exitPosition(trade, unrealizedPnl, exitReason, currentMid);
      }
    }, checkInterval);

    // Safety: always exit after max hold
    setTimeout(async () => {
      clearInterval(monitor);
      if (this.openOrders.has(trade.id)) {
        let currentMid = trade.currentMid ?? trade.entryPrice;
        try {
          const currentBook = await this.poly.fetchOrderbook(trade.signal.tokenId);
          if (currentBook) currentMid = currentBook.mid;
        } catch { /* use last known */ }
        const pnl = (currentMid - trade.entryPrice) * (trade.size / trade.entryPrice);
        this._exitPosition(trade, pnl, "FORCE_EXIT", currentMid);
      }
    }, maxHoldMs + 5000);
  }

  async _exitPosition(trade, pnl, reason, exitPrice) {
    trade.status = "CLOSED";
    trade.pnl = pnl;
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    trade.exitReason = reason;
    trade.holdTime = trade.exitTime - trade.openTime;

    this.openOrders.delete(trade.id);
    this.risk.closePosition(trade.id, pnl);
    this.pnlStats.push(pnl);

    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > this.maxHistory) this.tradeHistory.shift();

    log.trade(`EXIT [${reason}] ${trade.direction}`, {
      pnl: `$${pnl.toFixed(2)}`,
      entry: trade.entryPrice.toFixed(4),
      exit: exitPrice.toFixed(4),
      hold: `${(trade.holdTime / 1000).toFixed(1)}s`,
    });

    logTrade({
      event: "close",
      id: trade.id,
      label: trade.signal.label,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice,
      size: trade.size,
      pnl,
      pnlPct: pnl / trade.size,
      reason,
      holdMs: trade.holdTime,
      openTime: trade.openTime,
      exitTime: trade.exitTime,
    });

    this.onTradeEvent?.({ type: "close", trade });

    try {
      if (trade.order.status !== "SIMULATED") {
        await this.poly.placeOrder({
          tokenId: trade.signal.tokenId,
          side: "SELL",
          price: exitPrice,
          size: trade.size / trade.entryPrice,
          orderType: "GTC",
        });
      }
    } catch (err) {
      log.error("Exit order failed — position may be orphaned", { tradeId: trade.id, error: err.message });
      sendAlert(`⚠️ Exit order failed for ${trade.id}: ${err.message}`, "error");
    }
  }

  // ─── EMERGENCY ──────────────────────────────────────────────────────
  async cancelAllOrders() {
    log.warn("Cancelling all open orders");
    try {
      await this.poly.cancelAll();
      this.openOrders.clear();
      log.info("All orders cancelled");
    } catch (err) {
      log.error("Failed to cancel all orders", { error: err.message });
    }
  }

  /** Cancel only the orders belonging to a specific market label (e.g. "BTC/5m"). */
  async cancelOrdersForLabel(label) {
    const matches = [...this.openOrders.values()].filter(t => t.signal.label === label);
    if (matches.length === 0) return;
    log.warn(`Cancelling ${matches.length} order(s) for ${label}`);
    for (const trade of matches) {
      try {
        await this.poly.cancelOrder(trade.id);
      } catch (err) {
        log.error(`Failed to cancel order ${trade.id}`, { error: err.message });
      }
      this.openOrders.delete(trade.id);
      this.risk.closePosition(trade.id, 0);
    }
    this.onTradeEvent?.({ type: "rotation_cancel", label });
  }

  // ─── CRASH RECOVERY ─────────────────────────────────────────────────
  /**
   * Serialize all open positions for persistence.
   * Stored in data/state.json and restored on next startup.
   */
  getOpenSnapshot() {
    return [...this.openOrders.values()].map(t => ({
      id: t.id,
      direction: t.direction,
      entryPrice: t.entryPrice,
      size: t.size,
      openTime: t.openTime,
      signal: t.signal,
      order: { id: t.order.id, status: t.order.status },
    }));
  }

  /**
   * Restore open positions from a saved snapshot and restart their monitors.
   * Risk manager state must be restored separately (via risk.restoreState)
   * BEFORE calling this — we do NOT call risk.openPosition here to avoid
   * double-counting positions that are already in the restored risk state.
   */
  restorePositions(snapshots) {
    const now = Date.now();
    const maxHold = 300000; // 5min

    for (const snap of snapshots) {
      const age = now - snap.openTime;

      // Position too old to be worth monitoring — clean up risk state and skip.
      if (age > maxHold + 60000) {
        log.warn(`Skipping stale position ${snap.id} (age: ${Math.round(age / 1000)}s)`);
        this.risk.closePosition(snap.id, 0);
        logTrade({ event: "expired_on_restore", id: snap.id, label: snap.signal?.label, age });
        continue;
      }

      const trade = {
        id: snap.id,
        signal: snap.signal,
        order: snap.order || { id: snap.id, status: "RESTORED" },
        entryPrice: snap.entryPrice,
        size: snap.size,
        direction: snap.direction,
        status: "OPEN",
        openTime: snap.openTime,
        executionLatency: 0,
        pnl: null,
        currentMid: null,
        unrealizedPnl: null,
      };

      this.openOrders.set(trade.id, trade);
      log.info(`Restored position ${trade.id}`, {
        label: trade.signal?.label,
        direction: trade.direction,
        age: `${Math.round(age / 1000)}s`,
      });
      this._monitorPosition(trade);
    }
  }

  // ─── STATUS ─────────────────────────────────────────────────────────
  getStatus() {
    const avgLatency = this.executionLatencies.length > 0
      ? this.executionLatencies.reduce((a, b) => a + b, 0) / this.executionLatencies.length
      : 0;

    const recentTrades = this.tradeHistory.slice(-20);
    const winRate = recentTrades.length > 0
      ? recentTrades.filter(t => t.pnl > 0).length / recentTrades.length
      : 0;

    return {
      openOrders: this.openOrders.size,
      openTrades: [...this.openOrders.values()].map(t => ({
        id: t.id,
        label: t.signal.label,
        direction: t.direction,
        entryPrice: t.entryPrice,
        currentMid: t.currentMid,
        unrealizedPnl: t.unrealizedPnl,
        size: t.size,
        openTime: t.openTime,
        isCertainty: t.signal.isCertainty || false,
      })),
      fillRate: this.fillRateStats,
      avgExecutionLatency: Math.round(avgLatency),
      pnlStats: this.pnlStats.toJSON(),
      last20WinRate: winRate,
      recentTrades: recentTrades.slice(-5).map(t => ({
        id: t.id,
        direction: t.direction,
        pnl: t.pnl?.toFixed(2),
        reason: t.exitReason,
        hold: t.holdTime ? `${(t.holdTime / 1000).toFixed(1)}s` : null,
      })),
    };
  }
}