import { createLogger } from "./logger.js";

const log = createLogger("CHAINLINK");

// Public Polygon mainnet RPC endpoints — tried in order, first success wins.
const RPC_URLS = [
  "https://polygon.rpc.subquery.network/public",
  "https://polygon-bor-rpc.publicnode.com",
];

// Chainlink price feed proxy addresses on Polygon mainnet (8 decimal places).
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=polygon
export const CHAINLINK_FEEDS = {
  BTC: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  ETH: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
  SOL: "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC",
  XRP: "0x785ba89291f676b5386652eB12b30cF361020694",
};

const DECIMALS   = 8;
const RPC_TIMEOUT_MS = 6_000;

// ─── JSON-RPC HELPERS ─────────────────────────────────────────────────────────

async function ethCallWithRpc(rpcUrl, to, data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const resp = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal:  controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// Try RPCs in order, return first success.
async function ethCall(to, data) {
  let lastErr;
  for (const rpc of RPC_URLS) {
    try {
      return await ethCallWithRpc(rpc, to, data);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Decode Chainlink AggregatorV3 5-tuple response (5 × 32 bytes = 160 bytes).
function decodeRoundData(hex) {
  const d = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (d.length < 320) throw new Error(`Short round data: ${d.length} chars`);
  return {
    roundId:    BigInt("0x" + d.slice(0,   64)),
    answer:     BigInt("0x" + d.slice(64,  128)),
    startedAt:  Number(BigInt("0x" + d.slice(128, 192))),
    updatedAt:  Number(BigInt("0x" + d.slice(192, 256))),
  };
}

// latestRoundData() — selector 0xfeaf968c
async function latestRoundData(feedAddress) {
  return decodeRoundData(await ethCall(feedAddress, "0xfeaf968c"));
}

// getRoundData(uint80 roundId) — selector 0x9a6fc8f5
async function getRoundData(feedAddress, roundId) {
  const encoded = BigInt(roundId).toString(16).padStart(64, "0");
  return decodeRoundData(await ethCall(feedAddress, "0x9a6fc8f5" + encoded));
}

// ─── PRICE AT TIMESTAMP ───────────────────────────────────────────────────────

/**
 * Fetch the Chainlink oracle price that was current at `targetTimestampSec`.
 *
 * Returns the last round whose updatedAt ≤ targetTimestampSec — i.e., the price
 * the oracle was reporting at the exact moment the market window opened.
 *
 * Uses a linear backward search from the latest round. For recent targets
 * (last ~10 min) BTC/USD updates every ~27s, so this takes ~15 RPC calls max.
 *
 * @param {string} asset  — "BTC" | "ETH" | "SOL" | "XRP"
 * @param {number} targetTimestampSec — Unix timestamp in seconds
 * @returns {{ price: number, updatedAt: number, roundId: string } | null}
 */
export async function fetchPriceAtTimestamp(asset, targetTimestampSec) {
  const feedAddress = CHAINLINK_FEEDS[asset.toUpperCase()];
  if (!feedAddress) {
    log.warn(`No Chainlink feed for ${asset}`);
    return null;
  }

  try {
    const latest  = await latestRoundData(feedAddress);
    const phaseId = latest.roundId >> 64n;
    const latestAgg = latest.roundId & 0xFFFFFFFFFFFFFFFFn;

    // Guard true future targets (clock skew / bad market time). In this case we
    // cannot determine an "as-of target" strike yet.
    const nowSec = Math.floor(Date.now() / 1000);
    if (targetTimestampSec > nowSec + 1) {
      log.warn(`Chainlink target (${targetTimestampSec}) is in the future (now=${nowSec})`, { asset });
      return null;
    }

    // If latest <= target, latest itself is the correct "as-of target" round.
    // Returning null here would incorrectly force Binance fallback.
    if (latest.updatedAt <= targetTimestampSec) {
      const price = Number(latest.answer) / 10 ** DECIMALS;
      log.info(`Chainlink strike for ${asset}`, {
        price: `$${price.toFixed(4)}`,
        updatedAt: new Date(latest.updatedAt * 1000).toISOString(),
        targetTime: new Date(targetTimestampSec * 1000).toISOString(),
        lagSec: targetTimestampSec - latest.updatedAt,
        roundsBack: "0",
      });
      return { price, updatedAt: latest.updatedAt, roundId: latest.roundId.toString() };
    }

    // Walk backward from the latest round until updatedAt ≤ targetTimestampSec.
    const MAX_LOOKBACK = 120n;
    for (let i = 1n; i <= MAX_LOOKBACK; i++) {
      const aggRound = latestAgg - i;
      if (aggRound < 1n) break;

      let round;
      try {
        round = await getRoundData(feedAddress, (phaseId << 64n) | aggRound);
      } catch {
        // Gap in aggregator rounds — skip and continue.
        continue;
      }

      if (round.updatedAt <= targetTimestampSec) {
        const price = Number(round.answer) / 10 ** DECIMALS;
        log.info(`Chainlink strike for ${asset}`, {
          price:      `$${price.toFixed(4)}`,
          updatedAt:  new Date(round.updatedAt * 1000).toISOString(),
          targetTime: new Date(targetTimestampSec * 1000).toISOString(),
          lagSec:     targetTimestampSec - round.updatedAt,
          roundsBack: i.toString(),
        });
        return { price, updatedAt: round.updatedAt, roundId: round.roundId.toString() };
      }
    }

    log.warn(`Chainlink: could not find round at target timestamp after ${MAX_LOOKBACK} lookback`, { asset, targetTimestampSec });
    return null;

  } catch (err) {
    log.warn(`Chainlink fetch failed`, { asset, error: err.message });
    return null;
  }
}
