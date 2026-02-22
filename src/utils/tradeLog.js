import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("TRADELOG");

const DATA_DIR = join(process.cwd(), "data");
const LOG_PATH = join(DATA_DIR, "trades.ndjson");

// Ensure data dir exists (no-op if already present)
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore — dir already exists */ }

/**
 * Append one trade record to data/trades.ndjson (one JSON object per line).
 * Called on both OPEN and CLOSE events so the file captures full lifecycle.
 * Non-fatal: a write error will not crash the engine, but IS logged so the
 * operator knows the audit trail may have gaps.
 */
export function logTrade(record) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ...record, _at: new Date().toISOString() }) + "\n");
  } catch (err) {
    log.warn("Trade log write failed — audit record lost", { error: err.message, event: record.event, id: record.id });
  }
}
