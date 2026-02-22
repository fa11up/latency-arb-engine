import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { createLogger } from "./logger.js";

const log = createLogger("STATE");

const DATA_DIR = join(process.cwd(), "data");
const STATE_PATH = join(DATA_DIR, "state.json");
const TMP_PATH  = STATE_PATH + ".tmp";

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore — dir already exists */ }

/**
 * Atomically write state to data/state.json.
 * Uses write-to-temp + rename so a crash mid-write never corrupts the file.
 * Non-fatal: logs a warning on failure so the operator knows recovery data is stale.
 */
export function saveState(state) {
  try {
    writeFileSync(TMP_PATH, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
    renameSync(TMP_PATH, STATE_PATH);
  } catch (err) {
    log.warn("State save failed — crash recovery data may be stale", { error: err.message });
  }
}

/**
 * Load state from data/state.json.
 * Returns null if the file doesn't exist (first run) or is unparseable.
 */
export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch (err) {
    // ENOENT on first run is expected and not worth logging.
    if (err.code !== "ENOENT") {
      log.warn("State load failed — starting fresh", { error: err.message });
    }
    return null;
  }
}
