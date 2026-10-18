import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = "4411b7cba04221610f989e74a479380f85e17ed6";
const sources = new Map([
  ["src/chain-detail-d1-write.ts", "2d0e61cbe326f0355404c4e4ed7ba8ffbe7e63dd"],
  ["src/chain-detail-native-payloads.ts", "68e45729e938790e9853c6c82381d95612a7800f"],
  ["src/chain-detail-payloads.ts", "afdc726980946e16a9e95f3d6c539f05c65218ce"],
]);
const tests = ["tests/chain-detail-d1.test.ts", "tests/chain-detail-native-payloads.test.ts"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const candidates = new Map([...sources.keys()].map((path) => [path, readFileSync(path, "utf8")]));
const baselines = new Map<string, string>();
for (const [path, expected] of sources) {
  const blob = spawnSync("git", ["rev-parse", base + ":" + path], { encoding: "utf8" });
  assert.equal(blob.status, 0);
  assert.equal(blob.stdout.trim(), expected);
  const source = spawnSync("git", ["show", base + ":" + path], { encoding: "utf8" });
  assert.equal(source.status, 0);
  baselines.set(path, source.stdout);
  assert.notEqual(digest(candidates.get(path)!), digest(source.stdout));
}
const selected = new Map([
  ["native D1 distinct failed payloads roll back without leaving chunks", "failed"],
  ["native D1 rejects a later payload family before publishing any chunks", "failed"],
  ["native D1 shared chunks survive a competing late failure and exact replay", "passed"],
]);
const filter = [...selected.keys()].map((name) => "^" + name + "$").join("|");
mkdirSync("atomic-payload-reports", { recursive: true });
interface NativeCase { fullName: string; status: string; failureMessages: string[]; }
interface NativeReport {
  numFailedTests: number; numPassedTests: number; numTotalTests: number;
  testResults: { assertionResults: NativeCase[]; message: string }[];
}
function run(label: string, extra: string[] = []) {
  const output = "atomic-payload-reports/" + label + ".json";
  const rss = "atomic-payload-reports/" + label + "-rss.txt";
  const started = Date.now();
  const result = spawnSync("/usr/bin/time", [
    "-f", "%M", "-o", rss, process.execPath, "node_modules/vitest/vitest.mjs",
    "run", ...tests, "--retry=0", "--reporter=default", "--reporter=json",
    "--outputFile=" + output, ...extra,
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.signal, null, label + " process not terminated");
  assert.equal(result.error, undefined, label + " process launched");
  const raw = readFileSync(output, "utf8");
  if (/MF-Proxy-Shared-Secret/i.test(raw))
    throw new Error("Blocked local debug field; native output withheld");
  if (/Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(result.stdout + "\n" + result.stderr))
    throw new Error("Native unhandled error; output withheld");
  const report = JSON.parse(raw) as NativeReport;
  assert.equal(report.testResults.length, 2);
  assert.equal(report.numTotalTests, 25);
  if (report.testResults.some((file) => file.message !== ""))
    throw new Error("Native file or hook failure; output withheld");
  const cases = report.testResults.flatMap((file) => file.assertionResults);
  assert.equal(cases.length, 25);
  const peak = Number(readFileSync(rss, "utf8").trim().split("\n").at(-1)) * 1024;
  assert.ok(Number.isSafeInteger(peak) && peak > 0);
  return { result, report, cases, elapsed_ms: Date.now() - started, gnu_time_max_rss_bytes: peak };
}
try {
  for (const [path, content] of baselines) writeFileSync(path, content);
  const red = run("baseline", ["--testNamePattern", filter]);
  assert.equal(red.result.status, 1);
  assert.equal(red.report.numFailedTests, 2);
  assert.equal(red.report.numPassedTests, 1);
  for (const [name, expected] of selected) {
    const matches = red.cases.filter((item) => item.fullName === name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, expected);
    if (expected === "failed") {
      assert.equal(matches[0].failureMessages.length, 1);
      assert.match(matches[0].failureMessages[0], /AssertionError|expected/i);
    }
  }
  assert.deepEqual(red.cases.filter((item) => !selected.has(item.fullName) &&
    item.status !== "pending" && item.status !== "skipped"), []);
  console.log(JSON.stringify({ phase: "baseline", selected: red.cases
    .filter((item) => selected.has(item.fullName))
    .map((item) => ({ name: item.fullName, status: item.status,
      assertion: item.failureMessages.join("\n").slice(0, 2200) })),
    filtered: 22, elapsed_ms: red.elapsed_ms,
    gnu_time_max_rss_bytes: red.gnu_time_max_rss_bytes }));
  for (const [path, content] of candidates) writeFileSync(path, content);
  const green = run("candidate");
  if (green.result.status !== 0) {
    console.log(JSON.stringify({ phase: "candidate-refused", failed: green.cases
      .filter((item) => item.status === "failed")
      .map((item) => ({ name: item.fullName, status: item.status,
        failure_class: /(?:AssertionError|TypeError|RangeError|SyntaxError|Error)/.exec(item.failureMessages.join("\\n"))?.[0] ?? "unknown",
        source_location: /(?:tests\\/chain-detail-(?:d1|native-payloads)\\.test\\.ts:\\d+:\\d+)/.exec(item.failureMessages.join("\\n"))?.[0] ?? "unknown" })) }));
  }
  assert.equal(green.result.status, 0);
  assert.equal(green.report.numFailedTests, 0);
  assert.equal(green.report.numPassedTests, 25);
  assert.ok(green.cases.every((item) => item.status === "passed" && !item.failureMessages.length));
  const files = Object.fromEntries([...candidates.keys(), ...tests]
    .map((path) => [path, digest(readFileSync(path, "utf8"))]));
  const receipt = { base_commit: base, files,
    baseline: { failed: 2, passed: 1, filtered: 22, elapsed_ms: red.elapsed_ms,
      gnu_time_max_rss_bytes: red.gnu_time_max_rss_bytes },
    candidate: { passed: 25, failed: 0, elapsed_ms: green.elapsed_ms,
      gnu_time_max_rss_bytes: green.gnu_time_max_rss_bytes },
    resource_scope: "GNU time over hosted native fixtures; not production isolate or configured concurrency acceptance",
    production_actions: false };
  console.log(JSON.stringify({ phase: "candidate", ...receipt }));
  writeFileSync("atomic-payload-reports/source-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
} finally {
  for (const [path, content] of candidates) writeFileSync(path, content);
}
