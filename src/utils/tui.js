import blessed from "blessed";
import { CONFIG } from "../config.js";

/**
 * Terminal UI — renders a live dashboard using blessed.
 *
 * Layout (top → bottom):
 *   - Header bar        (1 line)
 *   - Markets table     (1 row per active market)
 *   - Open trades table (1 row per open position, min 3 lines)
 *   - Risk/stats row    (bankroll, P&L, feeds)
 *   - Log pane          (fills remaining height, scrollable)
 *
 * Usage:
 *   const tui = new TUI(marketCount);
 *   tui.render(data);    // call every second
 *   tui.log("message");  // append to log pane
 *   tui.destroy();       // restore terminal on exit
 */
export class TUI {
  constructor(marketCount = 1) {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "⚡ Latency Arb Engine",
      fullUnicode: true,
    });

    const marketsHeight = marketCount + 4;        // border×2 + header + N rows
    const tradesHeight  = CONFIG.risk.maxOpenPositions + 3; // border×2 + header + N rows
    const statsHeight   = 5;

    // ─── Header bar ──────────────────────────────────────────────────
    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, right: 0, height: 1,
      tags: true,
    });

    // ─── Markets table ───────────────────────────────────────────────
    this.marketsBox = blessed.box({
      parent: this.screen,
      top: 1, left: 0, right: 0, height: marketsHeight,
      label: " {bold}MARKETS{/bold} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, right: 1 },
    });

    // ─── Open trades table ───────────────────────────────────────────
    this.tradesBox = blessed.box({
      parent: this.screen,
      top: 1 + marketsHeight, left: 0, right: 0, height: tradesHeight,
      label: " {bold}OPEN TRADES{/bold} ",
      border: { type: "line" },
      style: { border: { fg: "yellow" }, label: { fg: "yellow" } },
      tags: true,
      padding: { left: 1, right: 1 },
    });

    // ─── Risk / stats bar ────────────────────────────────────────────
    this.statsBox = blessed.box({
      parent: this.screen,
      top: 1 + marketsHeight + tradesHeight, left: 0, right: 0, height: statsHeight,
      label: " {bold}RISK & EXECUTION{/bold} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, right: 1 },
    });

    // ─── Log pane ────────────────────────────────────────────────────
    this.logBox = blessed.log({
      parent: this.screen,
      top: 1 + marketsHeight + tradesHeight + statsHeight,
      left: 0, right: 0, bottom: 0,
      label: " {bold}LOG{/bold}  {dim}(scroll: ↑↓  |  q: quit){/dim} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      scrollback: 500,
      scrollbar: { ch: "▐", style: { fg: "cyan" } },
      mouse: true,
      keys: true,
    });

    // ─── Key bindings ────────────────────────────────────────────────
    this.screen.key(["q", "C-c"], () => process.emit("SIGINT"));

    this.screen.render();
  }

  /**
   * Redraw all panels with fresh data.
   * @param {object} data - { uptime, mode, markets[], poly, risk, execution }
   */
  render({ uptime, mode, markets, poly, risk, execution }) {
    const now = new Date().toISOString().slice(11, 19) + " UTC";
    const modeTag = mode === "DRY RUN" ? "{yellow-fg}DRY RUN{/yellow-fg}" : "{red-fg}{bold}LIVE{/bold}{/red-fg}";

    // ─── Header ──────────────────────────────────────────────────────
    this.header.setContent(
      `{bold}⚡ LATENCY ARB{/bold}  ${modeTag}  Bankroll: {bold}$${risk.bankroll.toFixed(2)}{/bold}  Uptime: ${uptime}m  {dim}${now}{/dim}`
    );

    // ─── Markets table ───────────────────────────────────────────────
    const mCols = { label: 9, spot: 12, strike: 11, mid: 10, edge: 8, lag: 9 };
    const head =
      `{bold}{cyan-fg}` +
      `${"MARKET".padEnd(mCols.label)} ` +
      `${"SPOT".padEnd(mCols.spot)} ` +
      `${"STRIKE".padEnd(mCols.strike)} ` +
      `${"MID".padEnd(mCols.mid)} ` +
      `${"EDGE".padEnd(mCols.edge)} ` +
      `${"LAG".padEnd(mCols.lag)} ` +
      `EXPIRY{/cyan-fg}{/bold}`;

    const rows = markets.map(({ bStats, sStats }) => {
      const dot    = bStats.connected ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
      const label  = (sStats.label || "—").padEnd(mCols.label - 2);
      const spot   = (sStats.spotPrice   ? `$${sStats.spotPrice.toFixed(2)}`           : "—").padEnd(mCols.spot);
      const strike = (sStats.strikePrice ? `$${sStats.strikePrice.toFixed(2)}`         : "—").padEnd(mCols.strike);
      const mid    = (sStats.contractMid ? `${(sStats.contractMid * 100).toFixed(1)}¢` : "—").padEnd(mCols.mid);
      const lagStr = (sStats.feedLag != null ? `${sStats.feedLag}ms`                   : "—").padEnd(mCols.lag);

      let edgeStr;
      if (sStats.edge) {
        const padded = ((sStats.edge * 100).toFixed(1) + "%").padEnd(mCols.edge);
        edgeStr = sStats.edge >= 0.03 ? `{green-fg}${padded}{/green-fg}` : padded;
      } else {
        edgeStr = "—".padEnd(mCols.edge);
      }

      let expiry = "—";
      if (sStats.marketEndDate) {
        const sec = Math.round((new Date(sStats.marketEndDate).getTime() - Date.now()) / 1000);
        if (sec <= 0) {
          expiry = "{yellow-fg}expiring{/yellow-fg}";
        } else {
          const str = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
          expiry = sec < 90 ? `{yellow-fg}${str}{/yellow-fg}` : str;
        }
      }

      return `${dot} ${label} ${spot} ${strike} ${mid} ${edgeStr} ${lagStr} ${expiry}`;
    });

    this.marketsBox.setContent([head, ...rows].join("\n"));

    // ─── Open trades table ───────────────────────────────────────────
    const tCols = { label: 9, dir: 9, entry: 9, curr: 9, pnl: 10, age: 7 };
    const tHead =
      `{bold}{yellow-fg}` +
      `${"MARKET".padEnd(tCols.label)} ` +
      `${"DIR".padEnd(tCols.dir)} ` +
      `${"ENTRY".padEnd(tCols.entry)} ` +
      `${"CURR".padEnd(tCols.curr)} ` +
      `${"P&L".padEnd(tCols.pnl)} ` +
      `AGE{/yellow-fg}{/bold}`;

    const openTrades = execution.openTrades || [];
    let tradeRows;
    if (openTrades.length === 0) {
      tradeRows = ["{dim}no open positions{/dim}"];
    } else {
      tradeRows = openTrades.map(t => {
        const label = (t.label || "—").padEnd(tCols.label);
        const dir   = t.direction.padEnd(tCols.dir);
        const entry = `${(t.entryPrice * 100).toFixed(1)}¢`.padEnd(tCols.entry);
        const curr  = (t.currentMid != null ? `${(t.currentMid * 100).toFixed(1)}¢` : "—").padEnd(tCols.curr);
        const ageSec = Math.round((Date.now() - t.openTime) / 1000);
        const age   = `${Math.floor(ageSec / 60)}:${String(ageSec % 60).padStart(2, "0")}`;

        let pnlStr;
        if (t.unrealizedPnl != null) {
          const raw   = `${t.unrealizedPnl >= 0 ? "+" : ""}$${t.unrealizedPnl.toFixed(2)}`;
          const padded = raw.padEnd(tCols.pnl);
          pnlStr = t.unrealizedPnl >= 0 ? `{green-fg}${padded}{/green-fg}` : `{red-fg}${padded}{/red-fg}`;
        } else {
          pnlStr = "—".padEnd(tCols.pnl);
        }

        return `${label} ${dir} ${entry} ${curr} ${pnlStr} ${age}`;
      });
    }

    this.tradesBox.setContent([tHead, ...tradeRows].join("\n"));

    // ─── Stats / risk ────────────────────────────────────────────────
    const dailyColor = risk.dailyPnl  >= 0 ? "{green-fg}" : "{red-fg}";
    const totalColor = execution.pnlStats.sum >= 0 ? "{green-fg}" : "{red-fg}";
    const polyDot    = poly.connected ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
    const bookIcon   = poly.lastBook  ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";

    this.statsBox.setContent([
      `Bankroll: {bold}$${risk.bankroll.toFixed(2)}{/bold}   Drawdown: ${risk.drawdownPct}   Open: ${risk.openPositions}/${risk.maxOpen}   Daily P&L: ${dailyColor}$${risk.dailyPnl.toFixed(2)}{/}`,
      `Total P&L: ${totalColor}$${execution.pnlStats.sum.toFixed(2)}{/}   Avg/trade: $${execution.pnlStats.mean.toFixed(2)}   Sharpe: ${execution.pnlStats.sharpe.toFixed(2)}   Trades: ${execution.pnlStats.n}   Win: ${(execution.last20WinRate * 100).toFixed(0)}%   Latency: ${execution.avgExecutionLatency}ms`,
      `Polymarket: ${polyDot} ${poly.messageCount} msgs   REST: ${poly.avgRestLatency}ms   Book: ${bookIcon}   Polls: ${poly.polls}`,
    ].join("\n"));

    this.screen.render();
  }

  /** Append a line to the scrollable log pane (strips ANSI escape codes). */
  log(line) {
    this.logBox.log(line.replace(/\x1b\[[0-9;]*m/g, ""));
  }

  destroy() {
    this.screen.destroy();
  }
}
