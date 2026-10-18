import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const phonePath = "apps/ui/tests/e2e/chain-stream-state.spec.ts";
const controlledPath = ".diagnostics/chain-stream-child-commit-controlled.spec.ts";
const sourceFiles = [
  "apps/ui/src/components/metagraphed/chain-stream/block-activity-window.tsx",
  "apps/ui/src/components/metagraphed/chain-stream/block-activity-window.test.tsx",
  phonePath,
];
const ordinary = readFileSync(phonePath, "utf8");
const controlled = readFileSync(controlledPath, "utf8");
const directory = "/tmp/chain-stream-child-commit";
const title = "lets a phone reader inspect an activity mark before following its block link";
mkdirSync(directory, { recursive: true });
const provenance = {
  source: process.env.GITHUB_SHA,
  baseline: "712f19e88bd259f7158bd57e6ba5f8cab80fbb7b",
  sourceFiles: Object.fromEntries(
    sourceFiles.map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  controlledSource: createHash("sha256").update(controlled).digest("hex"),
};
writeFileSync(directory + "/provenance.json", JSON.stringify(provenance, null, 2) + "\n");
console.log("CHILD_COMMIT_PROVENANCE " + JSON.stringify(provenance));

function collectTests(suites) {
  const tests = [];
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      assert.equal(spec.title, title, "only the reviewed phone case may run");
      tests.push(...spec.tests);
    }
    tests.push(...collectTests(suite.suites));
  }
  return tests;
}

const summaries = [];
try {
  for (const [phase, source, repeats] of [
    ["ordinary", ordinary, 20],
    ["controlled", controlled, 10],
  ]) {
    writeFileSync(phonePath, source);
    rmSync("apps/ui/test-results", { recursive: true, force: true });
    console.log("CHILD_COMMIT_PHASE " + phase);
    const result = spawnSync(
      "npm",
      [
        "run", "test:e2e", "--workspace=apps/ui", "--",
        "tests/e2e/chain-stream-state.spec.ts",
        "--project=interaction", "--no-deps",
        "--grep=" + title,
        "--repeat-each=" + repeats, "--retries=0", "--workers=1",
      ],
      { stdio: "inherit", env: process.env },
    );
    if (existsSync("apps/ui/test-results")) {
      cpSync("apps/ui/test-results", directory + "/" + phase, { recursive: true });
    }
    assert.equal(result.error, undefined, "the browser process must start");
    const reportPath = "apps/ui/test-results/e2e-results.json";
    assert.ok(existsSync(reportPath), "native JSON report must exist for " + phase);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const tests = collectTests(report.suites);
    assert.equal(tests.length, repeats, "exactly the requested repetitions must run");
    assert.equal(
      tests.every((test) => test.results.length === 1 && test.results[0].retry === 0),
      true,
      "no retry may qualify an attempt",
    );
    const summary = {
      phase,
      source: process.env.GITHUB_SHA,
      repetitions: repeats,
      exitCode: result.status,
      signal: result.signal,
      stats: report.stats,
      reportErrors: report.errors,
      results: tests.map((test) => ({
        status: test.status,
        attempts: test.results.map((attempt) => ({
          status: attempt.status,
          retry: attempt.retry,
          startTime: attempt.startTime,
          duration: attempt.duration,
          errors: attempt.errors,
        })),
      })),
    };
    if (phase === "controlled") {
      const attachments = tests.flatMap((test) =>
        test.results.flatMap((attempt) => attempt.attachments ?? []),
      );
      const decode = (name) =>
        attachments
          .filter((attachment) => attachment.name === name)
          .map((attachment) =>
            JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8")),
          );
      const before = decode("child-readiness-before-release");
      const after = decode("child-readiness-before-touch");
      summary.beforeRelease = before;
      summary.beforeTouch = after;
    }
    summaries.push(summary);
    writeFileSync(directory + "/summary.json", JSON.stringify(summaries, null, 2) + "\n");
    console.log("CHILD_COMMIT_RESULT " + JSON.stringify(summary));
  }
} finally {
  writeFileSync(phonePath, ordinary);
}

for (const summary of summaries) {
  assert.equal(summary.exitCode, 0, summary.phase + " must pass every attempt");
  assert.equal(summary.stats.expected, summary.repetitions);
  assert.equal(summary.stats.unexpected, 0);
  assert.equal(summary.stats.skipped, 0);
  assert.equal(summary.stats.flaky, 0);
  assert.equal(summary.reportErrors.length, 0);
}
const observed = summaries.find((summary) => summary.phase === "controlled");
assert.equal(observed.beforeRelease.length, 10);
assert.equal(observed.beforeTouch.length, 10);
for (let index = 0; index < 10; index += 1) {
  const before = observed.beforeRelease[index];
  const after = observed.beforeTouch[index];
  assert.equal(before.markerBefore, null);
  assert.equal(before.firstMarkTabIndex, "0");
  assert.equal(before.targetSelectedBefore, false);
  assert.ok(before.heldScripts.length > 0);
  assert.ok(before.heldScripts.every(
    (script) => script.url.startsWith("http://localhost:8080/")
      && script.status >= 200 && script.status < 300,
  ));
  assert.equal(after.markerAfter, "true");
  assert.equal(after.sameSectionNode, true);
  assert.equal(after.targetSelectedAfter, false);
  assert.equal(after.targetHrefAfter, before.targetHrefBefore);
}
