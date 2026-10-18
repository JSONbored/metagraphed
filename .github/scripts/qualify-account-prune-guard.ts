import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = "fd4605673fe6c61eb57ffdd5f958287afcac3d9c";
const sourcePath = "src/chain-detail-prune.ts";
const testPath = "tests/retention-d1.test.ts";
const candidate = readFileSync(sourcePath, "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const selected = new Map([
  ["account events ahead of retiring coverage retain all advertised children", "failed"],
  ["overlapping account children retire with their coverage in the same batch", "passed"],
  ["a replay between account-only batches preserves newly advertised detail", "failed"],
]);
const filter = [...selected.keys()].map((name) => `^${name}$`).join("|");
const baseline = spawnSync("git", ["show", `${base}:${sourcePath}`], {
  encoding: "utf8",
});
assert.equal(baseline.status, 0, "exact baseline source is available");
const blob = spawnSync("git", ["rev-parse", `${base}:${sourcePath}`], {
  encoding: "utf8",
});
assert.equal(blob.status, 0);
assert.equal(blob.stdout.trim(), "0ddf733f43ac22fdb1fc6ce07403f66c7a1233e6");
assert.notEqual(digest(candidate), digest(baseline.stdout));
mkdirSync("prune-guard-reports", { recursive: true });

interface NativeCase {
  fullName: string;
  status: string;
  failureMessages: string[];
}

interface NativeReport {
  numFailedTests: number;
  numPassedTests: number;
  numTotalTests: number;
  testResults: { assertionResults: NativeCase[]; message: string }[];
}

function run(label: string, extra: string[] = []) {
  const output = `prune-guard-reports/${label}.json`;
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      testPath,
      "--retry=0",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${output}`,
      ...extra,
    ],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    },
  );
  assert.equal(result.signal, null, `${label} process was not terminated`);
  assert.equal(result.error, undefined, `${label} process launched`);
  const raw = readFileSync(output, "utf8");
  // Never copy the known local-debug authentication field into this job's
  // curated output. No raw debug logs or native report artifacts are uploaded.
  if (/MF-Proxy-Shared-Secret/i.test(raw))
    throw new Error("Native report contains blocked local-debug field; output withheld");
  // JSONReporter omits unhandled errors. The native default reporter emits
  // them; reject its error headings without copying captured output.
  if (/Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(
    result.stdout + "\n" + result.stderr,
  ))
    throw new Error("Native reporter recorded an unhandled runtime error; output withheld");
  const report = JSON.parse(raw) as NativeReport;
  assert.equal(report.testResults.length, 1, "exactly one native fixture file ran");
  assert.equal(report.numTotalTests, 35);
  if (report.testResults.some((file) => file.message !== ""))
    throw new Error("Native fixture recorded a file, setup or hook error; output withheld");
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(cases.length, 35);
  return { result, report, cases };
}

try {
  writeFileSync(sourcePath, baseline.stdout);
  const red = run("baseline", ["--testNamePattern", filter]);
  assert.equal(red.result.status, 1, "baseline exits for the expected assertions");
  assert.equal(red.report.numFailedTests, 2);
  assert.equal(red.report.numPassedTests, 1);
  for (const [name, status] of selected) {
    const matches = red.cases.filter((test) => test.fullName === name);
    assert.equal(matches.length, 1, `one selected baseline case: ${name}`);
    const test = matches[0];
    assert.equal(test.status, status, name);
    if (status === "failed") {
      assert.ok(test.failureMessages.length > 0, name);
      assert.match(test.failureMessages.join("\n"), /AssertionError|expected/i);
    }
  }
  const unexpected = red.cases.filter(
    (test) => !selected.has(test.fullName) && test.status !== "pending" && test.status !== "skipped",
  );
  assert.deepEqual(unexpected, [], "all other cases were explicitly filtered");
  console.log(JSON.stringify({
    phase: "baseline",
    source_sha256: digest(baseline.stdout),
    selected: red.cases.filter((test) => selected.has(test.fullName)).map((test) => ({
      name: test.fullName,
      status: test.status,
      assertion: test.failureMessages.join("\n").slice(0, 3000),
    })),
    filtered: red.cases.length - selected.size,
  }, null, 2));

  writeFileSync(sourcePath, candidate);
  const green = run("candidate");
  assert.equal(green.result.status, 0, "candidate complete retention file passes");
  assert.equal(green.report.numFailedTests, 0);
  assert.equal(green.report.numPassedTests, 35);
  assert.equal(green.cases.length, 35);
  assert.ok(green.cases.every((test) => test.status === "passed"));
  assert.ok(green.cases.every((test) => test.failureMessages.length === 0));
  console.log(JSON.stringify({
    phase: "candidate",
    source_sha256: digest(candidate),
    test_sha256: digest(readFileSync(testPath, "utf8")),
    passed: green.report.numPassedTests,
    failed: green.report.numFailedTests,
    cases: green.cases.map((test) => ({ name: test.fullName, status: test.status })),
  }, null, 2));
  writeFileSync("prune-guard-reports/source-receipt.json", JSON.stringify({
    base_commit: base,
    source_sha256: digest(candidate),
    test_sha256: digest(readFileSync(testPath, "utf8")),
    baseline: { selected: 3, failed: 2, passed: 1, filtered: red.cases.length - selected.size },
    candidate: { passed: green.report.numPassedTests, failed: green.report.numFailedTests },
  }, null, 2) + "\n");
} finally {
  writeFileSync(sourcePath, candidate);
}
