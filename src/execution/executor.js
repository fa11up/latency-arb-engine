import { CONFIG } from "../config.js";
import { createLogger } from "../utils/logger.js";
import { sendAlert } from "../utils/alerts.js";
import { RunningStats } from "../utils/math.js";
import { logTrade } from "../utils/tradeLog.js";

const log = createLogger("EXECUTOR");

// ─── TIMING CONSTANTS ──────────────────────────────────────────────────────────
const FILL_TIMEOUT_MS     = 5_000;   // max time to wait for fill confirmation
const FILL_POLL_MS        = 250;     // GET /order polling interval during fill wait
const MONITOR_INTERVAL_MS = 2_000;   // position P&L check frequency
const MAX_HOLD_MS         = 300_000; // 5 minutes — hard maximum for any position
const SAFETY_BUFFER_MS    = 5_000;   // extra window after maxHold before force-exit
const MAX_TRADE_HISTORY   = 500;     // rolling window of closed trades kept in memory

// ─── API response parsing helpers ─────────────────────────────────────────────
// avgPrice, fillPrice, size, remainingSize etc. can all arrive as strings from
// the Polymarket CLOB REST API. Parse defensively throughout.

function parsePrice(raw) {
  if (raw == null) return null;
  const n = parseFloat(raw);
  return isFinite(n) ? n : null;
}

/**
 * Extract how many tokens were actually filled from an order response.
 * Polymarket may use different field names across API versions.
 */
function parseFilledQty(order) {
  // remainingSize is the canonical unfilled amount
  const remaining = parseFloat(
    order.remainingSize ?? order.remaining ?? order.sizeRemaining ?? NaN
  );
  const total = parseFloat(order.size ?? NaN);
  if (isFinite(remaining) && isFinite(total)) {
    return Math.max(0, total - remaining);
  }
  // makerAmount = tokens received on a buy order
  const maker = parseFloat(order.makerAmount ?? NaN);
  if (isFinite(maker) && maker > 0) return maker;
  // No data — assume nothing filled
  return 0;
}

function clampFilledQty(filledQty, requestedQty) {
  if (!isFinite(filledQty) || filledQty <= 0) return 0;
  return Math.min(filledQty, requestedQty);
}

/**
 * Normalize an order status string to a canonical uppercase value.
 * Handles lowercase / mixed-case responses from the API.
 */
function normalizeStatus(raw) {
  return (raw ?? "").toString().toUpperCase();
}

// ─── FILL PROBABILITY TRACKER ─────────────────────────────────────────────────
/**
 * Tracks fill rates bucketed by spread and depth conditions.
 * Used to gate signals with historically low fill probability.
 */
export class FillTracker {
  constructor() {
    // Keyed by "spreadBucket:depthBucket" → { filled, total }
    this._buckets = new Map();
  }

  _spreadBucket(signal) {
    const spread = (signal.contractPrice != null && signal.entryPrice != null)
      ? Math.abs(signal.entryPrice - signal.contractPrice) * 2
      : 0;
    // Use signal-level spread data if available
    const s = signal._spread ?? spread;
    if (s < 0.02) return "narrow";
    if (s <= 0.05) return "medium";
    return "wide";
  }

  _depthBucket(signal) {
    const depth = signal.availableLiquidity ?? 0;
    if (depth < 20) return "thin";
    if (depth <= 100) return "ok";
    return "deep";
  }

  _key(signal) {
    return `${this._spreadBucket(signal)}:${this._depthBucket(signal)}`;
  }

  record(signal, fillStatus) {
    const key = this._key(signal);
    if (!this._buckets.has(key)) this._buckets.set(key, { filled: 0, total: 0 });
    const bucket = this._buckets.get(key);
    bucket.total++;
    if (fillStatus === "MATCHED" || fillStatus === "PARTIAL") {
      bucket.filled++;
    }
  }

  fillProbability(signal) {
    const key = this._key(signal);
    const bucket = this._buckets.get(key);
    if (!bucket || bucket.total < 10) return 1.0; // insufficient data
    return bucket.filled / bucket.total;
  }

  getStatus() {
    const result = {};
    for (const [key, bucket] of this._buckets) {
      result[key] = { ...bucket, rate: bucket.total > 0 ? bucket.filled / bucket.total : 0 };
    }
    return result;
  }
}

/**
 * Execution layer.
 *
 * Entry flow:
 *   1. Place GTC buy order
 *   2. Poll _waitForFill (up to 5s)
 *   3. MATCHED  → open position at confirmed fill price + qty
 *   4. PARTIAL  → cancel remainder, open position for filled portion only
 *   5. TIMEOUT/CANCELLED with 0 fills → cancel, abort, no risk state touched
 *
 * Exit flow:
 *   1. Place GTC sell order sized from trade.tokenQty (actual held tokens)
 *   2. Poll _waitForFill (up to 5s)
 *   3. Confirmed fill → book realized P&L at actual fill price
 *   4. Unconfirmed → cancel sell, revert status, monitor retries next cycle
 *   5. Safety timeout: if still unconfirmed, force-close risk state at mark and alert
 *
 * Dry-run: SIMULATED orders skip all polling; mark price used for P&L.
 */
export class Executor {
  constructor(polyClient, riskManager) {
    this.poly = polyClient;
    this.risk = riskManager;

    this.openOrders = new Map(); // orderId → trade

    this.pnlStats = new RunningStats();
    this.fillRateStats = { attempted: 0, filled: 0, partial: 0, cancelled: 0, failed: 0 };
    this.fillTracker = new FillTracker();
    this.executionLatencies = [];

    this.tradeHistory = [];
    this.maxHistory = MAX_TRADE_HISTORY;

    this.onTradeEvent = null;
  }

  // ─── CLOSE BOOKKEEPING ─────────────────────────────────────────────
  _finalizeClose(trade, { reason, exitPrice, pnl, estimated = false }) {
    const totalPnl = (trade.realizedPnl ?? 0) + pnl;
    trade.status = "CLOSED";
    trade.pnl = totalPnl;
    trade.exitPrice = exitPrice;
    trade.exitTime = Date.now();
    trade.exitReason = reason;
    trade.holdTime = trade.exitTime - trade.openTime;
    trade.estimatedExit = estimated;

    this.openOrders.delete(trade.id);
    this.risk.closePosition(trade.id, pnl);
    this.pnlStats.push(totalPnl);

    this.tradeHistory.push(trade);
    if (this.tradeHistory.length > this.maxHistory) this.tradeHistory.shift();

    log.trade(`EXIT [${reason}] ${trade.direction}${estimated ? " [EST]" : ""}`, {
      pnl: `$${totalPnl.toFixed(2)}`,
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
      tokenQty: trade.tokenQty,
      size: trade.size,
      pnl: totalPnl,
      pnlPct: trade.initialSize > 0 ? totalPnl / trade.initialSize : 0,
      reason,
      holdMs: trade.holdTime,
      openTime: trade.openTime,
      exitTime: trade.exitTime,
      estimatedExit: estimated,
      adverseSelection: trade._adverseSelection || [],
    });

    this.onTradeEvent?.({ type: "close", trade, estimated });
    return true;
  }

  // ─── FILL CONFIRMATION ──────────────────────────────────────────────
  /**
   * Poll until the order reaches a terminal state or timeout.
   *
   * Returns a normalized fill result:
   *   { status: "MATCHED"|"PARTIAL"|"CANCELLED"|"TIMEOUT", avgPrice, filledQty }
   *
   * status meanings:
   *   MATCHED   — fully filled; avgPrice and filledQty are reliable
   *   PARTIAL   — partially filled (timeout or OPEN→cancel path);
   *               filledQty is the filled portion, avgPrice may be null
   *   CANCELLED — exchange cancelled with no fills
   *   TIMEOUT   — polling expired, fill state unknown; filledQty best-effort
   *
   * Dry-run orders (id starts with "dry-") are immediately MATCHED.
   */
  async _waitForFill(orderId, requestedQty, timeoutMs = FILL_TIMEOUT_MS) {
    if (CONFIG.execution.dryRun) {
      return { status: "MATCHED", avgPrice: null, filledQty: requestedQty };
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, FILL_POLL_MS));
      try {
        const order = await this.poly.getOrder(orderId);
        const status = normalizeStatus(order.status);

        if (status === "MATCHED" || status === "FILLED") {
          const filledQty = clampFilledQty(parseFilledQty(order) || requestedQty, requestedQty);
          return {
            status: "MATCHED",
            avgPrice: parsePrice(order.avgPrice ?? order.fillPrice),
            filledQty,
          };
        }
        if (status === "CANCELLED") {
          const filledQty = clampFilledQty(parseFilledQty(order), requestedQty);
          return {
            status: filledQty > 0 ? "PARTIAL" : "CANCELLED",
            avgPrice: parsePrice(order.avgPrice ?? order.fillPrice),
            filledQty,
          };
        }
        // Status still OPEN — keep polling
      } catch { /* transient network error — keep polling */ }
    }

    // Timed out — do one final fetch to detect any partial fill
    try {
      const order = await this.poly.getOrder(orderId);
      const filledQty = clampFilledQty(parseFilledQty(order), requestedQty);
      if (filledQty > 0) {
        return {
          status: "PARTIAL",
          avgPrice: parsePrice(order.avgPrice ?? order.fillPrice),
          filledQty,
        };
      }
    } catch { /* can't determine — treat as zero */ }

    return { status: "TIMEOUT", avgPrice: null, filledQty: 0 };
  }

  // ─── ORDER STRATEGY SELECTION ──────────────────────────────────────
  /**
   * Determine whether to take (cross the spread) or post as maker.
   *
   * Returns { type: "take"|"maker", price }
   *   - Wide spread (>= 3c) AND > 120s to expiry: post maker inside the spread
   *   - Otherwise: take at executable price (current behavior)
   */
  _selectOrderStrategy(signal) {
    const secsToExpiry = signal.hoursToExpiry * 3600;
    const spread = signal.direction === "BUY_YES"
      ? (signal.entryPrice - (signal.contractPrice - (signal.entryPrice - signal.contractPrice)))
      : 0;
    // Compute spread from signal context
    const bestBid = signal.contractPrice - (signal.entryPrice - signal.contractPrice);
    const bestAsk = signal.direction === "BUY_YES" ? signal.entryPrice : undefined;
    const actualSpread = signal._spread ?? Math.abs(signal.entryPrice - signal.contractPrice) * 2;

    if (actualSpread >= 0.03 && secsToExpiry > 120) {
      // Post maker inside the spread: bestBid + 1c for BUY_YES
      const makerPrice = signal.direction === "BUY_YES"
        ? signal.contractPrice + 0.01  // just inside from mid toward ask
        : signal.contractPrice - 0.01; // just inside from mid toward bid (for BUY_NO: want lower YES price)

      // Clamp to (0, 1)
      const clampedPrice = Math.max(0.01, Math.min(0.99, makerPrice));

      return { type: "maker", price: clampedPrice };
    }

    return { type: "take", price: signal.entryPrice };
  }

  // ─── EXECUTE SIGNAL ─────────────────────────────────────────────────
  async execute(signal) {
    const start = Date.now();
    this.fillRateStats.attempted++;

    try {
      const orderStrategy = this._selectOrderStrategy(signal);
      const entryPrice = orderStrategy.price;
      const requestedQty = signal.size / entryPrice; // tokens requested

      const orderParams = {
        tokenId: signal.tokenId,
        side: "BUY",
        price: entryPrice,
        size: requestedQty,
        orderType: "GTC",
      };

      log.trade(`Executing: ${signal.direction} $${signal.size.toFixed(2)} @ ${entryPrice.toFixed(4)} [${orderStrategy.type}]`, {
        edge: `${(signal.edge * 100).toFixed(1)}%`,
        model: `${(signal.modelProb * 100).toFixed(1)}%`,
        spot: `$${signal.spotPrice.toFixed(1)}`,
      });

      let order = await this.poly.placeOrder(orderParams);
      const latency = Date.now() - start;
      this.executionLatencies.push(latency);
      if (this.executionLatencies.length > 100) this.executionLatencies.shift();

      // ── Fill confirmation (live only) ──────────────────────────────
      let actualEntryPrice = entryPrice;
      let actualTokenQty   = requestedQty;

      if (order.status !== "SIMULATED") {
        let fill;

        if (orderStrategy.type === "maker") {
          // Maker order: allow reprice up to MAX_REPRICES if not filled within 2s
          const MAX_REPRICES = 2;
          let reprices = 0;
          fill = await this._waitForFill(order.id, requestedQty, MONITOR_INTERVAL_MS);

          while (fill.status === "TIMEOUT" && fill.filledQty === 0 && reprices < MAX_REPRICES) {
            // Cancel stale maker order and reprice closer to market
            try { await this.poly.cancelOrder(order.id); } catch { /* best effort */ }
            reprices++;

            // Fetch updated book for reprice
            let newPrice = entryPrice;
            try {
              const book = await this.poly.fetchOrderbook(signal.tokenId);
              if (book) {
                // Move price 1c closer to the taker side
                newPrice = signal.direction === "BUY_YES"
                  ? Math.min((book.bestAsk ?? entryPrice), entryPrice + 0.01 * reprices)
                  : Math.max((book.bestBid ?? entryPrice), entryPrice - 0.01 * reprices);
                newPrice = Math.max(0.01, Math.min(0.99, newPrice));
              }
            } catch { /* use previous price */ }

            log.trade(`[${signal.label}] Maker reprice #${reprices}: ${entryPrice.toFixed(4)} → ${newPrice.toFixed(4)}`);

            const repriceQty = signal.size / newPrice;
            order = await this.poly.placeOrder({
              ...orderParams,
              price: newPrice,
              size: repriceQty,
            });
            fill = await this._waitForFill(order.id, repriceQty, MONITOR_INTERVAL_MS);
          }

          // After MAX_REPRICES exhausted, fall through to taker if still unfilled
          if (fill.status === "TIMEOUT" && fill.filledQty === 0) {
            try { await this.poly.cancelOrder(order.id); } catch { /* best effort */ }
            log.trade(`[${signal.label}] Maker exhausted ${MAX_REPRICES} reprices — taking`);

            const takeQty = signal.size / signal.entryPrice;
            order = await this.poly.placeOrder({
              ...orderParams,
              price: signal.entryPrice,
              size: takeQty,
            });
            fill = await this._waitForFill(order.id, takeQty, FILL_TIMEOUT_MS);
          }
        } else {
          fill = await this._waitForFill(order.id, requestedQty, FILL_TIMEOUT_MS);
        }

        this.fillTracker.record(signal, fill.status);

        if (fill.status === "MATCHED") {
          actualEntryPrice = fill.avgPrice ?? entryPrice;
          actualTokenQty   = fill.filledQty;
          this.fillRateStats.filled++;

        } else if (fill.status === "PARTIAL" && fill.filledQty > 0) {
          // Cancel the unfilled remainder, then open a position for what filled.
          try { await this.poly.cancelOrder(order.id); } catch { /* best effort */ }
          actualEntryPrice = fill.avgPrice ?? entryPrice;
          actualTokenQty   = fill.filledQty;
          this.fillRateStats.partial++;
          log.warn(`[${signal.label}] Partial fill: ${fill.filledQty.toFixed(4)} of ${requestedQty.toFixed(4)} tokens @ ${actualEntryPrice.toFixed(4)}`);

        } else {
          // TIMEOUT/CANCELLED with zero fills — cancel any resting order and abort.
          try { await this.poly.cancelOrder(order.id); } catch { /* best effort */ }
          this.fillRateStats.cancelled++;
          log.warn(`[${signal.label}] Entry order not filled (${fill.status}) — cancelled`);
          return null;
        }

        log.trade(`Order fill confirmed: ${order.id}`, {
          fillPrice: actualEntryPrice.toFixed(4),
          fillQty: actualTokenQty.toFixed(4),
        });
      } else {
        this.fillRateStats.filled++;
      }
      // ───────────────────────────────────────────────────────────────

      const actualDollarSize = actualTokenQty * actualEntryPrice;

      // Size field convention:
      //   tokenQty    — MUTABLE: actual tokens held; decremented on each partial exit
      //   size        — MUTABLE: remaining dollar exposure = tokenQty × entryPrice; decremented on partial exits;
      //                 used for unrealized P&L % in monitor (% of remaining exposure)
      //   initialSize — IMMUTABLE: dollar exposure at open; never modified;
      //                 used only for pnlPct in close events (% of original bet)
      const trade = {
        id: order.id,
        signal,
        order,
        entryPrice: actualEntryPrice,
        tokenQty: actualTokenQty,
        size: actualDollarSize,
        initialSize: actualDollarSize,
        direction: signal.direction,
        status: "OPEN",
        openTime: Date.now(),
        executionLatency: latency,
        pnl: null,
        currentMid: null,
        unrealizedPnl: null,
      };

      this.openOrders.set(order.id, trade);
      this.risk.openPosition({
        id: order.id,
        side: signal.direction,
        size: actualDollarSize,
        entryPrice: actualEntryPrice,
      });

      log.trade(`Order live: ${order.id}`, { latency: `${latency}ms` });

      logTrade({
        event: "open",
        id: trade.id,
        label: signal.label,
        direction: signal.direction,
        entryPrice: actualEntryPrice,
        tokenQty: actualTokenQty,
        size: actualDollarSize,
        edge: signal.edge,
        modelProb: signal.modelProb,
        spotPrice: signal.spotPrice,
        strikePrice: signal.strikePrice,
        openTime: trade.openTime,
        realizedSlippage: actualEntryPrice - signal.entryPrice,
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
    const checkInterval = MONITOR_INTERVAL_MS;
    const maxHoldMs = MAX_HOLD_MS;
    const profitTarget = CONFIG.risk.profitTargetPct;
    const stopLoss = -CONFIG.risk.stopLossPct;

    const monitor = setInterval(async () => {
      if (!this.openOrders.has(trade.id)) { clearInterval(monitor); return; }
      if (trade.status === "CLOSING") return;

      const age = Date.now() - trade.openTime;

      let currentMid;
      try {
        const currentBook = await this.poly.fetchOrderbook(trade.signal.tokenId);
        if (!currentBook || currentBook.bestBid === 0 && currentBook.bestAsk === 1) return;
        currentMid = currentBook.mid;
      } catch {
        return;
      }

      // P&L using actual token quantity held
      const unrealizedPnl = (currentMid - trade.entryPrice) * trade.tokenQty;
      const pnlPct = unrealizedPnl / trade.size;

      trade.currentMid = currentMid;
      trade.unrealizedPnl = unrealizedPnl;

      // Adverse selection checkpoints: snapshot P&L at 5s, 15s, 30s after open
      if (!trade._adverseSelection) trade._adverseSelection = [];
      const ageSec = (Date.now() - trade.openTime) / 1000;
      for (const cp of [5, 15, 30]) {
        if (ageSec >= cp && !trade._adverseSelection.some(s => s.checkpoint === cp)) {
          trade._adverseSelection.push({
            checkpoint: cp,
            currentMid,
            midMove: currentMid - trade.entryPrice,
            pnlPct: unrealizedPnl / trade.size,
          });
        }
      }

      let shouldExit = false;
      let exitReason = "";

      if (age >= maxHoldMs)     { shouldExit = true; exitReason = "MAX_HOLD_TIME"; }
      if (pnlPct >= profitTarget) { shouldExit = true; exitReason = "PROFIT_TARGET"; }
      if (pnlPct <= stopLoss)   { shouldExit = true; exitReason = "STOP_LOSS"; }

      const targetPrice = trade.direction === "BUY_YES" ? trade.signal.modelProb : 1 - trade.signal.modelProb;
      if (Math.abs(currentMid - targetPrice) < 0.02) { shouldExit = true; exitReason = "EDGE_COLLAPSED"; }

      if (shouldExit) {
        const exited = await this._exitPosition(trade, exitReason, currentMid);
        if (exited) clearInterval(monitor);
      }
    }, checkInterval);

    // Safety: force exit after max hold regardless of prior exit attempts.
    setTimeout(async () => {
      clearInterval(monitor);
      if (!this.openOrders.has(trade.id)) return;
      let currentMid = trade.currentMid ?? trade.entryPrice;
      try {
        const currentBook = await this.poly.fetchOrderbook(trade.signal.tokenId);
        if (currentBook) currentMid = currentBook.mid;
      } catch { /* use last known */ }

      const exited = await this._exitPosition(trade, "FORCE_EXIT", currentMid);
      if (!exited && this.openOrders.has(trade.id) && trade.status !== "CLOSING") {
        // Sell order still unconfirmed. Close risk state at mark to prevent
        // permanent drift — but alert that the exchange position may still be open.
        const pnl = (currentMid - trade.entryPrice) * trade.tokenQty;
        log.error(`FORCE_EXIT unconfirmed for ${trade.id} — closing risk at mark; verify on exchange`, { pnl: pnl.toFixed(2) });
        sendAlert(`⚠️ Exit unconfirmed for ${trade.id} — closed risk at mark, verify on exchange`, "error");
        this._finalizeClose(trade, {
          reason: "FORCE_EXIT_UNCONFIRMED",
          exitPrice: currentMid,
          pnl,
          estimated: true,
        });
      }
    }, maxHoldMs + SAFETY_BUFFER_MS);
  }

  /**
   * Place a sell order for the actual token quantity held, wait for fill,
   * then book realized P&L at the confirmed fill price.
   *
   * Returns true  — position closed, P&L booked.
   * Returns false — sell not confirmed; trade reverted to OPEN for retry.
   */
  async _exitPosition(trade, reason, markPrice) {
    if (trade.status === "CLOSING" || trade.status === "CLOSED") return false;
    if (!this.openOrders.has(trade.id)) return false;
    trade.status = "CLOSING";

    let actualExitPrice = markPrice;

    if (trade.order.status !== "SIMULATED") {
      // ── Live: place sell sized from actual token quantity ──────────
      let exitOrder;
      try {
        exitOrder = await this.poly.placeOrder({
          tokenId: trade.signal.tokenId,
          side: "SELL",
          price: markPrice,
          size: trade.tokenQty,   // actual tokens held, not intent-based estimate
          orderType: "GTC",
        });
      } catch (err) {
        log.error("Exit order placement failed", { tradeId: trade.id, error: err.message });
        sendAlert(`⚠️ Exit order failed for ${trade.id}: ${err.message}`, "error");
        trade.status = "OPEN";
        return false;
      }

      const fill = await this._waitForFill(exitOrder.id, trade.tokenQty, FILL_TIMEOUT_MS);

      if (fill.status === "PARTIAL" && fill.filledQty > 0) {
        // Book partial realization and keep the remainder open.
        const exitPx = fill.avgPrice ?? markPrice;
        const filledQty = Math.min(fill.filledQty, trade.tokenQty);
        const realizedPnl = (exitPx - trade.entryPrice) * filledQty;
        const realizedNotional = filledQty * trade.entryPrice;
        trade.realizedPnl = (trade.realizedPnl ?? 0) + realizedPnl;

        // Adjust remaining position so next exit attempt is correctly sized.
        trade.tokenQty = Math.max(0, trade.tokenQty - filledQty);
        trade.size = Math.max(0, trade.size - realizedNotional);

        // Reflect realized cashflow in risk accounting via the RiskManager API.
        this.risk.applyPartialClose(trade.id, { realizedNotional, realizedPnl });

        log.trade(`EXIT_PARTIAL ${trade.direction}`, {
          tradeId: trade.id,
          filledQty: filledQty.toFixed(4),
          remainingQty: trade.tokenQty.toFixed(4),
          realizedPnl: `$${realizedPnl.toFixed(2)}`,
          cumulativePnl: `$${trade.realizedPnl.toFixed(2)}`,
        });

        logTrade({
          event: "partial_close",
          id: trade.id,
          label: trade.signal.label,
          direction: trade.direction,
          entryPrice: trade.entryPrice,
          exitPrice: exitPx,
          tokenQty: filledQty,
          remainingQty: trade.tokenQty,
          realizedNotional,
          pnl: realizedPnl,
          openTime: trade.openTime,
          at: Date.now(),
        });

        this.onTradeEvent?.({ type: "partial_close", trade, filledQty, realizedPnl });

        // If fully exhausted via partial fills, finalize now.
        if (trade.tokenQty <= 1e-8 || trade.size <= 1e-8) {
          return this._finalizeClose(trade, {
            reason: `${reason}_PARTIAL_EXHAUSTED`,
            exitPrice: exitPx,
            pnl: 0,
            estimated: false,
          });
        }

        try { await this.poly.cancelOrder(exitOrder.id); } catch { /* best effort */ }
        trade.status = "OPEN";
        return false;
      }

      if (fill.status !== "MATCHED") {
        try { await this.poly.cancelOrder(exitOrder.id); } catch { /* best effort */ }
        log.warn(`[${trade.signal.label}] Exit sell ${fill.status} — retrying next cycle`);
        trade.status = "OPEN";
        return false;
      }

      actualExitPrice = fill.avgPrice ?? markPrice;
      // ─────────────────────────────────────────────────────────────
    }

    // Confirmed full fill — book realized P&L using actual token quantity and fill price.
    const pnl = (actualExitPrice - trade.entryPrice) * trade.tokenQty;
    return this._finalizeClose(trade, {
      reason,
      exitPrice: actualExitPrice,
      pnl,
      estimated: false,
    });
  }

  // ─── EMERGENCY ──────────────────────────────────────────────────────
  async cancelAllOrders() {
    log.warn("Cancelling all open orders");
    try {
      await this.poly.cancelAll();
      // Close all positions at mark-to-market. Using estimated=true so the audit
      // log clearly distinguishes these from confirmed exchange fills.
      for (const trade of [...this.openOrders.values()]) {
        const markPrice = trade.currentMid ?? trade.entryPrice;
        const pnl = (markPrice - trade.entryPrice) * (trade.tokenQty ?? 0);
        this._finalizeClose(trade, {
          reason: "SHUTDOWN",
          exitPrice: markPrice,
          pnl,
          estimated: true,
        });
      }
      log.info("All orders cancelled — positions closed at mark (estimated)");
    } catch (err) {
      log.error("Failed to cancel all orders", { error: err.message });
    }
  }

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
      // Use _finalizeClose so rotation cancels are recorded in tradeHistory / pnlStats
      // and emitted to logTrade — identical treatment to SHUTDOWN closes.
      const markPrice = trade.currentMid ?? trade.entryPrice;
      const pnl = (markPrice - trade.entryPrice) * (trade.tokenQty ?? 0);
      this._finalizeClose(trade, {
        reason: "ROTATION_CANCEL",
        exitPrice: markPrice,
        pnl,
        estimated: true,
      });
    }
    this.onTradeEvent?.({ type: "rotation_cancel", label });
  }

  // ─── CRASH RECOVERY ─────────────────────────────────────────────────
  getOpenSnapshot() {
    return [...this.openOrders.values()].map(t => ({
      id: t.id,
      direction: t.direction,
      entryPrice: t.entryPrice,
      tokenQty: t.tokenQty,
      size: t.size,
      openTime: t.openTime,
      signal: t.signal,
      order: { id: t.order.id, status: t.order.status },
    }));
  }

  restorePositions(snapshots) {
    const now = Date.now();
    const maxHold = MAX_HOLD_MS;

    for (const snap of snapshots) {
      const age = now - snap.openTime;

      if (age > maxHold + 60000) {
        log.warn(`Skipping stale position ${snap.id} (age: ${Math.round(age / 1000)}s)`);
        this.risk.closePosition(snap.id, 0);
        logTrade({ event: "expired_on_restore", id: snap.id, label: snap.signal?.label, age });
        continue;
      }

      // Back-compat: snapshots saved before tokenQty was added
      const tokenQty = snap.tokenQty ?? (snap.size / snap.entryPrice);

      const trade = {
        id: snap.id,
        signal: snap.signal,
        order: snap.order || { id: snap.id, status: "RESTORED" },
        entryPrice: snap.entryPrice,
        tokenQty,
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
