import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const base = "adf7d871efceb07ef3017e4a7709dc53d177e9ed";
const source = "src/sync-batch-queue.ts";
const sourceBlob = "396079b96f31c255a3de0f1675db4d5ba30bb23c";
const files = [source, "tests/sync-batch-queue.test.ts", "tests/chain-detail-sync-route.test.ts", "tests/sync-batch-decoded-limits.test.ts"];
const tests = [...files.slice(1), "tests/data-api-sync-queue-consumer.test.ts", "tests/data-api-bundle-boundary.test.ts"];
const directory = "queue-admission-reports";
const receiptPath = directory + "/source-receipt.json";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const selected = new Map([
  ["packing accepts exactly the whole-message row ceiling", "passed"],
  ["packing refuses a sum above the consumer row ceiling", "failed"],
  ["qualified queue refusal cannot acknowledge a batch above its row ceiling", "failed"],
  ["the qualified row boundary reaches the queue consumer intact", "passed"],
  ["direct writes keep their existing larger HTTP row admission", "passed"],
  ["the existing exclusion keeps a queue-flagged batch on direct writes", "passed"],
]);

if (process.argv[2] === "--verify-uploaded") {
  const root = "queue-admission-artifact-readback";
  const walk = (path: string): string[] => readdirSync(path).flatMap((name) => {
    const file = path + "/" + name;
    const meta = lstatSync(file);
    assert.equal(meta.isSymbolicLink(), false);
    return meta.isDirectory() ? walk(file) : [file.slice(root.length + 1)];
  });
  const expected = [...files, receiptPath].sort();
  assert.deepEqual(walk(root).sort(), expected);
  const bytes = readFileSync(root + "/" + receiptPath, "utf8");
  assert.equal(bytes, readFileSync(receiptPath, "utf8"));
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.base_commit, base);
  assert.equal(receipt.production_actions, false);
  assert.deepEqual(Object.keys(receipt.files).sort(), [...files].sort());
  for (const [path, hash] of Object.entries(receipt.files)) {
    assert.equal(digest(readFileSync(root + "/" + path, "utf8")), hash);
    assert.equal(digest(readFileSync(path, "utf8")), hash);
  }
  assert.equal(receipt.baseline.failed, 2);
  assert.equal(receipt.baseline.passed, 4);
  assert.equal(receipt.candidate.failed, 0);
  assert.ok(receipt.candidate.passed > selected.size);
  console.log(JSON.stringify({
    phase: "persisted-artifact-readback", exact_members: expected.length,
    source_hashes_match: true, receipt_matches_generated_bytes: true,
    production_actions: false,
  }));
  process.exit(0);
}

const candidate = readFileSync(source, "utf8");
const blob = spawnSync("git", ["rev-parse", base + ":" + source], { encoding: "utf8" });
assert.equal(blob.status, 0);
assert.equal(blob.stdout.trim(), sourceBlob);
const original = spawnSync("git", ["show", base + ":" + source], { encoding: "utf8" });
assert.equal(original.status, 0);
assert.notEqual(digest(candidate), digest(original.stdout));
mkdirSync(directory, { recursive: true });

interface NativeCase { fullName: string; status: string; failureMessages: string[]; }
interface NativeReport {
  numFailedTests: number; numPassedTests: number; numTotalTests: number;
  testResults: { assertionResults: NativeCase[]; message: string }[];
}
function run(label: string, filtered: boolean) {
  const output = directory + "/" + label + ".json";
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    "node_modules/vitest/vitest.mjs", "run", ...tests, "--retry=0",
    "--reporter=json", "--outputFile=" + output,
    ...(filtered ? ["--testNamePattern", [...selected.keys()].join("|")] : []),
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } });
  assert.equal(result.signal, null, label + " process not terminated");
  assert.equal(result.error, undefined, label + " process launched");
  const raw = readFileSync(output, "utf8");
  if (/MF-Proxy-Shared-Secret/i.test(raw) ||
      /Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(result.stdout + "\n" + result.stderr)) {
    throw new Error("Unexpected native diagnostic output withheld");
  }
  const report = JSON.parse(raw) as NativeReport;
  assert.equal(report.testResults.length, tests.length);
  assert.ok(report.numTotalTests > selected.size);
  if (report.testResults.some((file) => file.message !== ""))
    throw new Error("Native file or hook failure; output withheld");
  const cases = report.testResults.flatMap((file) => file.assertionResults);
  assert.equal(cases.length, report.numTotalTests);
  return { result, report, cases, elapsed_ms: Date.now() - started };
}
try {
  writeFileSync(source, original.stdout);
  const baseline = run("baseline", true);
  console.log(JSON.stringify({ phase: "baseline-dispositions", selected: baseline.cases
    .filter((item) => [...selected.keys()].some((name) => item.fullName.endsWith(name)))
    .map((item) => ({ name: item.fullName, status: item.status,
      failure_class: /(?:AssertionError|TypeError|RangeError|SyntaxError|Error)/.exec(item.failureMessages.join(" "))?.[0] ?? null })) }));
  assert.equal(baseline.result.status, 1);
  assert.equal(baseline.report.numFailedTests, 2);
  assert.equal(baseline.report.numPassedTests, 4);
  const selectedCases = [];
  for (const [name, expected] of selected) {
    const matches = baseline.cases.filter((item) => item.fullName.endsWith(name));
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.status, expected);
    if (expected === "failed") {
      assert.equal(matches[0]!.failureMessages.length, 1);
      assert.match(matches[0]!.failureMessages[0]!, /AssertionError/);
    }
    selectedCases.push({ name, status: matches[0]!.status });
  }
  assert.deepEqual(baseline.cases.filter((item) =>
    ![...selected.keys()].some((name) => item.fullName.endsWith(name)) &&
    item.status !== "pending" && item.status !== "skipped"), []);
  console.log(JSON.stringify({ phase: "baseline", selected: selectedCases, production_actions: false }));
  writeFileSync(source, candidate);
  const fixed = run("candidate", false);
  if (fixed.result.status !== 0) {
    console.log(JSON.stringify({ phase: "candidate-refused", failures: fixed.cases
      .filter((item) => item.status === "failed")
      .map((item) => ({
        name: item.fullName,
        failure_class: /(?:AssertionError|TypeError|RangeError|SyntaxError|Error)/.exec(item.failureMessages.join("\n"))?.[0] ?? "unknown",
        source_location: /(?:tests\/[A-Za-z0-9-]+\.test\.ts:\d+:\d+)/.exec(item.failureMessages.join("\n"))?.[0] ?? "unknown",
      })) }));
  }
  assert.equal(fixed.result.status, 0);
  assert.equal(fixed.report.numFailedTests, 0);
  assert.ok(fixed.cases.every((item) => item.status === "passed" && !item.failureMessages.length));
  const receipt = {
    base_commit: base,
    source_blob: sourceBlob,
    files: Object.fromEntries(files.map((path) => [path, digest(readFileSync(path, "utf8"))])),
    baseline: { failed: 2, passed: 4, elapsed_ms: baseline.elapsed_ms, selected: selectedCases },
    candidate: { passed: fixed.report.numPassedTests, failed: 0, elapsed_ms: fixed.elapsed_ms },
    qualification_scope: "Hosted dormant HTTP branch with explicit eligibility spy and pg-mock consumer/writer seam; not live routing, production capacity, workerd memory or concurrency acceptance",
    production_actions: false,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ phase: "candidate", ...receipt }));
} finally {
  writeFileSync(source, candidate);
}
