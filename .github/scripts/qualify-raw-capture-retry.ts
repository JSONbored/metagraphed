import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = "7afb1a5fb1aa00eb0dd261861d9f56f59c3db80d";
const writer = "src/raw-capture-d1.ts";
const expectedWriterBlob = "a2117ac28687f6e83b1c0c9f63d3c7996702cde1";
const current = spawnSync("git", ["rev-parse", "HEAD:" + writer], { encoding: "utf8" });
assert.equal(current.status, 0);
assert.equal(current.stdout.trim(), expectedWriterBlob);
const prior = spawnSync("git", ["rev-parse", base + ":" + writer], { encoding: "utf8" });
assert.equal(prior.status, 0);
assert.equal(prior.stdout.trim(), expectedWriterBlob);
mkdirSync("raw-capture-retry-reports", { recursive: true });
const selected = new Map([
  ["fresh capture provenance resumes one incomplete reservation", "failed"],
  ["exact original replay completes its incomplete reservation", "passed"],
]);
const filter = [...selected.keys()].map((name) => "^" + name + "$").join("|");
const output = "raw-capture-retry-reports/native.json";
const started = Date.now();
const run = spawnSync(process.execPath, [
  "node_modules/vitest/vitest.mjs", "run", "tests/raw-capture-d1.test.ts",
  "--retry=0", "--reporter=json", "--outputFile=" + output,
  "--testNamePattern", filter,
], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 180_000,
  env: { ...process.env, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" } });
assert.equal(run.error, undefined);
assert.equal(run.signal, null);
assert.equal(run.status, 1);
if (/Unhandled Errors|Vitest caught \\d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(run.stdout + "\n" + run.stderr))
  throw new Error("Unclassified native failure; raw output withheld");
const raw = readFileSync(output, "utf8");
assert.ok(!/MF-Proxy-Shared-Secret/i.test(raw));
const report = JSON.parse(raw);
assert.equal(report.numFailedTests, 1);
assert.equal(report.numPassedTests, 1);
assert.equal(report.testResults.length, 1);
assert.equal(report.testResults[0].message, "");
const cases = report.testResults[0].assertionResults;
for (const [name, expected] of selected) {
  const matches = cases.filter((row) => row.fullName === name);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, expected);
  assert.equal(matches[0].failureMessages.length, expected === "failed" ? 1 : 0);
}
assert.ok(cases.filter((row) => !selected.has(row.fullName)).every((row) => ["pending", "skipped"].includes(row.status)));
const state = JSON.parse(readFileSync("raw-capture-retry-reports/fresh-state.json", "utf8"));
assert.deepEqual(Object.keys(state).sort(), ["before", "after", "budget", "chunks", "selected", "originalSha", "freshSha"].sort());
assert.equal(state.before.objects, 1);
assert.equal(state.before.complete, 0);
assert.equal(state.after.objects, 2);
assert.equal(state.after.complete, 0);
assert.ok(Number.isSafeInteger(state.before.bytes) && state.before.bytes > 8 * 65_536);
assert.ok(Number.isSafeInteger(state.after.bytes) && state.after.bytes > state.before.bytes);
assert.equal(state.budget.objects, state.after.objects);
assert.equal(state.budget.bytes, state.after.bytes);
assert.equal(state.selected, null);
assert.notEqual(state.originalSha, state.freshSha);
assert.match(state.originalSha, /^[a-f0-9]{64}$/);
assert.match(state.freshSha, /^[a-f0-9]{64}$/);
assert.equal(state.chunks.length, 2);
assert.deepEqual(new Set(state.chunks.map((row) => row.sha256)), new Set([state.originalSha, state.freshSha]));
for (const row of state.chunks) {
  assert.equal(row.parts, 8);
  assert.equal(row.bytes, 8 * 65_536);
}
const receipt = {
  source_commit: process.env.GITHUB_SHA, base_commit: base, runtime_writer_blob: expectedWriterBlob,
  fixture_sha256: createHash("sha256").update(readFileSync("tests/raw-capture-d1.test.ts")).digest("hex"),
  baseline: { failed: 1, passed: 1, filtered: cases.length - selected.size },
  actual_state: state, elapsed_ms: Date.now() - started,
  scope: "Actual hosted Node SQLite fixture with source writer; not production census, native remote D1 or capacity recovery",
  production_actions: false, raw_output_retained: false,
};
writeFileSync("raw-capture-retry-reports/source-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));
