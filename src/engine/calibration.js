import { createLogger } from "../utils/logger.js";

const log = createLogger("CALIBRATION");

const NUM_BINS = 10;

/**
 * Binned calibration table for adjusting raw model probabilities
 * based on observed win rates.
 *
 * Divides the [0, 1] probability range into NUM_BINS equal bins.
 * For each bin, tracks the observed win rate from historical trade outcomes.
 * Applies a conservative blend: adjusted = raw * (1 - w) + calibrated * w
 * where w = min(observations_in_bin / 50, 0.5).
 *
 * This corrects systematic bias in the BS N(d2) model without requiring
 * a large dataset — the blend weight prevents overcorrection when data is sparse.
 */
export class CalibrationTable {
  constructor() {
    // Each bin: { wins, total, observedRate }
    this.bins = Array.from({ length: NUM_BINS }, () => ({
      wins: 0,
      total: 0,
      observedRate: null,
    }));
  }

  _binIndex(prob) {
    const idx = Math.floor(prob * NUM_BINS);
    return Math.max(0, Math.min(NUM_BINS - 1, idx));
  }

  /**
   * Record a trade outcome into the calibration table.
   * @param {number} modelProb - The model probability at time of signal
   * @param {boolean} won - Whether the trade was profitable
   */
  record(modelProb, won) {
    const idx = this._binIndex(modelProb);
    const bin = this.bins[idx];
    bin.total++;
    if (won) bin.wins++;
    bin.observedRate = bin.total > 0 ? bin.wins / bin.total : null;
  }

  /**
   * Adjust a raw model probability using the calibration table.
   * Returns the raw probability unchanged if the relevant bin has insufficient data.
   *
   * @param {number} modelProb - Raw N(d2) probability
   * @returns {number} Calibrated probability
   */
  adjust(modelProb) {
    const idx = this._binIndex(modelProb);
    const bin = this.bins[idx];

    if (bin.total < 5 || bin.observedRate === null) return modelProb;

    // Conservative blend weight: ramp from 0 to max 0.5 over 50 observations
    const w = Math.min(bin.total / 50, 0.5);
    return modelProb * (1 - w) + bin.observedRate * w;
  }

  /**
   * Build a calibration table from historical features and trades.
   * @param {Array} features - Feature rows with { modelProb, label, timestamp, outcome }
   * @param {Array} trades - Trade rows with { label, openTime, pnl, event }
   * @returns {CalibrationTable}
   */
  static fromHistory(features, trades) {
    const table = new CalibrationTable();

    // Index close events by label+openTime for matching
    const closeMap = new Map();
    for (const t of trades) {
      if (t.event === "close") {
        const key = `${t.label}:${t.openTime}`;
        closeMap.set(key, t);
      }
    }

    // Match fired features to trade outcomes
    for (const f of features) {
      if (f.outcome !== "fired") continue;
      if (f.modelProb == null) continue;

      // Find the closest trade within 10s of the feature timestamp
      const key = `${f.label}:${f.timestamp}`;
      let trade = closeMap.get(key);

      if (!trade) {
        // Try fuzzy match: find a close event for this label within 10s
        for (const [k, t] of closeMap) {
          if (k.startsWith(f.label + ":")) {
            if (Math.abs(t.openTime - f.timestamp) < 10_000) {
              trade = t;
              break;
            }
          }
        }
      }

      if (trade && trade.pnl != null) {
        table.record(f.modelProb, trade.pnl > 0);
      }
    }

    return table;
  }

  /**
   * Get a reliability diagram representation for analysis.
   * Returns bins with { range, predicted, observed, count }.
   */
  toReliabilityDiagram() {
    return this.bins.map((bin, i) => ({
      range: `${(i / NUM_BINS).toFixed(1)}-${((i + 1) / NUM_BINS).toFixed(1)}`,
      predicted: (i + 0.5) / NUM_BINS,
      observed: bin.observedRate,
      count: bin.total,
    }));
  }

  toJSON() {
    return this.bins.map((bin, i) => ({
      bin: i,
      range: `${(i / NUM_BINS).toFixed(1)}-${((i + 1) / NUM_BINS).toFixed(1)}`,
      ...bin,
    }));
  }
}
