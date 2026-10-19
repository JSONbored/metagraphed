import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { dirname } from "node:path";

const base = "7afb1a5fb1aa00eb0dd261861d9f56f59c3db80d";
const baselineBlobs = {
  "src/self-health.ts": "b7727a211bdb60ff8000db023f03020c0a4a1f50",
  "src/self-health-mcp.ts": "1fe7b1fa97c986a750cbd529b0b96a6f082ef509",
  "workers/request-handlers/entities.ts": "97e337fd2c3780e876aeba6895c3de385b30999b"
};
const sourcePaths = [
  "src/self-health.ts",
  "src/self-health-mcp.ts",
  "workers/request-handlers/entities.ts",
  "schemas-src/routes/self-health.ts",
  "tests/self-health-d1.test.ts",
  "tests/self-health-component-freshness.test.ts",
  "tests/self-health-mcp.test.ts"
];
const candidates = new Map(Object.keys(baselineBlobs).map(path => [path, readFileSync(path, "utf8")]));
const baselines = new Map<string, string>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
for (const [path, expected] of Object.entries(baselineBlobs)) {
  const blob = spawnSync("git", ["rev-parse", base + ":" + path], { encoding: "utf8" });
  assert.equal(blob.status, 0);
  assert.equal(blob.stdout.trim(), expected);
  const result = spawnSync("git", ["show", base + ":" + path], { encoding: "utf8" });
  assert.equal(result.status, 0);
  baselines.set(path, result.stdout);
  assert.notEqual(digest(result.stdout), digest(candidates.get(path)!));
}
const testName = "REST and agent health do not present stopped probes as current success";
const tests = [
  "tests/self-health-d1.test.ts",
  "tests/self-health-component-freshness.test.ts",
  "tests/self-health.test.ts",
  "tests/self-health-mcp.test.ts",
  "tests/self-health-cold-tier.test.ts",
  "tests/self-health-prober.test.ts",
];
mkdirSync("component-freshness-reports", { recursive: true });
interface Case { fullName: string; status: string; failureMessages: string[] }
function run(label: string, paths: string[], extra: string[] = []) {
  const reportPath = "component-freshness-reports/" + label + ".json";
  const result = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs", "run", ...paths, "--retry=0",
    "--reporter=default", "--reporter=json", "--outputFile=" + reportPath, ...extra,
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  if (/Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(result.stdout + result.stderr))
    throw new Error("Native unhandled error; output withheld");
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    numFailedTests: number; numPassedTests: number;
    testResults: { message: string; assertionResults: Case[] }[];
  };
  assert.ok(report.testResults.every(file => file.message === ""));
  return { status: result.status, report, cases: report.testResults.flatMap(file => file.assertionResults) };
}
try {
  for (const [path, content] of baselines) writeFileSync(path, content);
  const baseline = run("baseline", [tests[0]], ["--testNamePattern", "^" + testName + "$"]);
  assert.equal(baseline.status, 1);
  assert.equal(baseline.report.numFailedTests, 1);
  assert.equal(baseline.report.numPassedTests, 0);
  const failed = baseline.cases.filter(item => item.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].fullName, testName);
  assert.equal(failed[0].failureMessages.length, 1);
  assert.match(failed[0].failureMessages[0], /operational/);
  assert.match(failed[0].failureMessages[0], /degraded/);
  console.log(JSON.stringify({ phase: "baseline", failed: 1, expected: "degraded", actual: "operational", test: testName }));
  for (const [path, content] of candidates) writeFileSync(path, content);
  const candidate = run("candidate", tests);
  if (candidate.status !== 0) {
    console.log(JSON.stringify({
      phase: "candidate",
      failed: candidate.cases.filter(item => item.status === "failed")
        .map(item => ({ name: item.fullName, status: item.status })),
    }));
  }
  assert.equal(candidate.status, 0);
  assert.equal(candidate.report.numFailedTests, 0);
  assert.ok(candidate.cases.length > 50);
  assert.ok(candidate.cases.every(item => item.status === "passed" && item.failureMessages.length === 0));
  const diff = spawnSync("git", ["diff", "--name-only", base], { encoding: "utf8" });
  assert.equal(diff.status, 0);
  const generated = diff.stdout.trim().split("\n").filter(path =>
    /^(generated\/|public\/metagraph\/)/.test(path) || path === "openapi.json");
  for (const path of generated)
    assert.ok(/^[A-Za-z0-9_./-]+$/.test(path) && !path.split("/").includes(".."));
  const files = [...new Set([...sourcePaths, ...generated])].filter(path =>
    !["public/metagraph/r2-manifest.json", "public/metagraph/schemas/index.json"].includes(path));
  const receipts: Record<string, string> = {};
  for (const path of files) {
    receipts[path] = digest(readFileSync(path, "utf8"));
    const target = "component-freshness-source/" + path;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(path, target);
  }
  const receipt = {
    base_commit: base,
    baseline: { failed: 1, expected: "degraded", actual: "operational" },
    candidate: { passed: candidate.cases.length, failed: 0, skipped: 0 },
    cases: candidate.cases.map(item => item.fullName),
    files: receipts, production_actions: false,
    scope: "Native synthetic D1, REST response, shared MCP loader and actual GraphQL query; not production recovery"
  };
  writeFileSync("component-freshness-source/source-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "candidate", passed: candidate.cases.length, generated, source_files: files.length }));
} finally {
  for (const [path, content] of candidates) writeFileSync(path, content);
}
