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
