import { test } from "node:test";
import assert from "node:assert/strict";

function toWordHex(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeRoundData({ roundId, answer, startedAt, updatedAt }) {
  // AggregatorV3 tuple:
  // (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  return "0x" + [
    toWordHex(roundId),
    toWordHex(answer),
    toWordHex(startedAt),
    toWordHex(updatedAt),
    toWordHex(roundId),
  ].join("");
}

function makeRpcFetch(latestPayload, getRoundPayloadByRoundHex = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body?.params?.[0]?.data ?? "";
    if (data === "0xfeaf968c") {
      return {
        ok: true,
        json: async () => ({ result: latestPayload }),
      };
    }
    if (data.startsWith("0x9a6fc8f5")) {
      const roundHex = data.slice("0x9a6fc8f5".length);
      const payload = getRoundPayloadByRoundHex[roundHex];
      if (!payload) {
        return {
          ok: true,
          json: async () => ({ error: { message: "round not found" } }),
        };
      }
      return {
        ok: true,
        json: async () => ({ result: payload }),
      };
    }
    return {
      ok: true,
      json: async () => ({ result: latestPayload }),
    };
  };
}

test("fetchPriceAtTimestamp: returns latest when latest.updatedAt <= target", async () => {
  const latest = encodeRoundData({
    roundId: 10n,
    answer: 6512493000000n, // 65124.93 * 1e8
    startedAt: 995n,
    updatedAt: 995n,
  });

  const realFetch = global.fetch;
  global.fetch = makeRpcFetch(latest);
  try {
    const { fetchPriceAtTimestamp } = await import("../src/utils/chainlink.js");
    const res = await fetchPriceAtTimestamp("BTC", 1000);
    assert.ok(res, "expected a strike result");
    assert.equal(res.updatedAt, 995);
    assert.equal(res.price, 65124.93);
  } finally {
    global.fetch = realFetch;
  }
});

test("fetchPriceAtTimestamp: returns null when target timestamp is in the future", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const latest = encodeRoundData({
    roundId: 15n,
    answer: 187200495100n, // 1872.004951 * 1e8
    startedAt: nowSec - 20,
    updatedAt: nowSec - 10,
  });

  const realFetch = global.fetch;
  global.fetch = makeRpcFetch(latest);
  try {
    const { fetchPriceAtTimestamp } = await import("../src/utils/chainlink.js");
    const res = await fetchPriceAtTimestamp("ETH", nowSec + 30);
    assert.equal(res, null);
  } finally {
    global.fetch = realFetch;
  }
});
