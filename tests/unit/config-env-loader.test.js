import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("config.repoRoot resolves correctly from an outside cwd", () => {
 const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), "config-reporoot-"));
 try {
 const configUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "index.js")).href;
 const out = execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(configUrl) + ").then(({ config }) => console.log(JSON.stringify({ repoRoot: config.repoRoot })))"], { cwd: outsideCwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
 const result = JSON.parse(out);
 assert.equal(result.repoRoot, REPO_ROOT, "repoRoot must be derived from module location, not process.cwd()");
 } finally {
 fs.rmSync(outsideCwd, { recursive: true, force: true });
 }
});

test("ADR-0034 §3.2.1: DISCOVERY_FRESH_EVALUATION_BUDGET absent -> default 25", () => {
 const configUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "index.js")).href;
 const env = { ...process.env };
 delete env.DISCOVERY_FRESH_EVALUATION_BUDGET;
 const out = execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(configUrl) + ").then(({ config }) => console.log(JSON.stringify({ budget: config.discoveryFreshEvaluationBudget })))"], { env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
 const result = JSON.parse(out);
 assert.equal(result.budget, 25, "absent DISCOVERY_FRESH_EVALUATION_BUDGET must default to 25");
});

test("ADR-0034 §3.2.1: DISCOVERY_FRESH_EVALUATION_BUDGET valid explicit values are accepted as non-negative integers", () => {
 const configUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "index.js")).href;
 for (const [raw, expected] of [["0", 0], ["1", 1], ["25", 25], ["9007199254740991", 9007199254740991]]) {
  const env = { ...process.env, DISCOVERY_FRESH_EVALUATION_BUDGET: raw };
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(configUrl) + ").then(({ config }) => console.log(JSON.stringify({ budget: config.discoveryFreshEvaluationBudget })))"], { env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const result = JSON.parse(out);
  assert.equal(result.budget, expected, "DISCOVERY_FRESH_EVALUATION_BUDGET=" + JSON.stringify(raw) + " must parse to " + expected);
 }
});

test("ADR-0034 §3.2.1: DISCOVERY_FRESH_EVALUATION_BUDGET invalid explicit values fail config load before fresh evaluation, with an explicit attributable error, and never coerce to 0, fall back to 25, or leave the budget unbounded", () => {
 const configUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "index.js")).href;
 for (const raw of ["-1", "1.5", "abc", "NaN", "Infinity", "", "   "]) {
  const env = { ...process.env, DISCOVERY_FRESH_EVALUATION_BUDGET: raw };
  assert.throws(
   () => execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(configUrl) + ")"], { env, stdio: ["ignore", "pipe", "pipe"] }),
   /must be a non-negative integer/,
   "DISCOVERY_FRESH_EVALUATION_BUDGET=" + JSON.stringify(raw) + " must fail config load with an explicit, attributable error"
  );
 }
});

test("ADR-0034 §3.2.1: DISCOVERY_FRESH_EVALUATION_BUDGET rejects a digits-only value whose parsed number is non-finite (overflow to Infinity)", () => {
 const configUrl = pathToFileURL(path.join(REPO_ROOT, "src", "config", "index.js")).href;
 const raw = "9".repeat(309);
 const env = { ...process.env, DISCOVERY_FRESH_EVALUATION_BUDGET: raw };
 assert.throws(
  () => execFileSync(process.execPath, ["--input-type=module", "-e", "import(" + JSON.stringify(configUrl) + ")"], { env, stdio: ["ignore", "pipe", "pipe"] }),
  /must be a non-negative integer/,
  "a digits-only DISCOVERY_FRESH_EVALUATION_BUDGET that overflows to Infinity must fail config load with an explicit, attributable error"
 );
});
