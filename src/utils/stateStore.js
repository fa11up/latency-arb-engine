import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const STATE_PATH = join(DATA_DIR, "state.json");
const TMP_PATH  = STATE_PATH + ".tmp";

try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

/**
 * Atomically write state to data/state.json.
 * Uses write-to-temp + rename so a crash mid-write never corrupts the file.
 */
export function saveState(state) {
  try {
    writeFileSync(TMP_PATH, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
    renameSync(TMP_PATH, STATE_PATH);
  } catch { /* non-fatal */ }
}

/**
 * Load state from data/state.json.
 * Returns null if the file doesn't exist or is unparseable.
 */
export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}
