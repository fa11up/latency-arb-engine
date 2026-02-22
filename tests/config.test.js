import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runConfigSnippet(envOverrides, code) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...envOverrides },
      encoding: "utf8",
    }
  );
}

test("config: envNum rejects Infinity values", () => {
  const res = runConfigSnippet(
    { BANKROLL: "Infinity", DRY_RUN: "true" },
    "import('./src/config.js').then(()=>console.log('UNEXPECTED_OK')).catch(e=>{console.error(e.message); process.exit(42);});"
  );

  assert.equal(res.status, 42, `expected import failure, got status=${res.status}, stderr=${res.stderr}`);
  assert.ok(
    (res.stderr || "").includes("Invalid number for BANKROLL"),
    `expected BANKROLL validation message, got stderr=${res.stderr}`
  );
});

test("config: validateConfig rejects out-of-range risk percentages", () => {
  const res = runConfigSnippet(
    {
      DRY_RUN: "true",
      PROFIT_TARGET_PCT: "2",
      STOP_LOSS_PCT: "-0.5",
    },
    [
      "import('./src/config.js').then(({ validateConfig }) => {",
      "  const errors = validateConfig();",
      "  console.log(JSON.stringify(errors));",
      "});",
    ].join("\n")
  );

  assert.equal(res.status, 0, `snippet should run, got status=${res.status}, stderr=${res.stderr}`);
  const line = (res.stdout || "").trim().split("\n").pop() || "[]";
  const errors = JSON.parse(line);
  assert.ok(errors.some(e => e.includes("PROFIT_TARGET_PCT")), `missing profit-target validation: ${line}`);
  assert.ok(errors.some(e => e.includes("STOP_LOSS_PCT")), `missing stop-loss validation: ${line}`);
});
