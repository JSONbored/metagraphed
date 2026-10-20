// Synthetic evidence only: no sockets, network APIs, subprocesses or native fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
import {
  COVERED_SOURCES,
  PUBLIC_LIMITS,
  RAW_LIMITS,
  REQUIRED_ASSERTIONS,
  publicRunSummary,
  redactLcov,
  validateCompletionEvidence,
  validateCoverageEvidence,
  validateTestEvidence,
} from "./receipt-policy.ts";
import {
  appendBudget,
  boundedFile,
  validatePublicationDirectory,
  validateReceiptDirectory,
} from "./receipt-files.ts";
import { publish } from "./public-receipts.ts";

const candidate = "/synthetic-candidate";
const secret =
  "https://user:secret@unexpected.example/private?token=private-token";
function tests() {
  const testResults = FOCUSED_TESTS.map((file) => ({
    name: `${candidate}/${file}`,
    status: "passed",
    message: secret,
    assertionResults: (
      REQUIRED_ASSERTIONS[file] ?? ["synthetic assertion"]
    ).map((title) => ({
      title,
      status: "passed",
      fullName: secret,
      failureMessages: [secret],
    })),
  }));
  const guardSuite = testResults.find((suite) =>
    suite.name.endsWith("/tests/strict-gzip-host-guard.test.ts"),
  )!;
  while (guardSuite.assertionResults.length < 18)
    guardSuite.assertionResults.push({
      title: `synthetic guard case ${guardSuite.assertionResults.length}`,
      status: "passed",
      fullName: secret,
      failureMessages: [secret],
    });
  const count = testResults.reduce(
    (n, suite) => n + suite.assertionResults.length,
    0,
  );
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numPassedTests: count,
    numTotalTests: count,
    testResults,
  };
}
function coverage() {
  const metrics = Object.fromEntries(
    ["lines", "statements", "functions", "branches"].map((key) => [
      key,
      { total: 2, covered: 2, skipped: 0, pct: 100 },
    ]),
  );
  return Object.fromEntries(
    ["total", ...COVERED_SOURCES.map((file) => `${candidate}/${file}`)].map(
      (key) => [key, structuredClone(metrics)],
    ),
  );
}
function lcov(absolute = false) {
  return COVERED_SOURCES.map(
    (file) =>
      `TN:${secret}\nSF:${absolute ? candidate + "/" : ""}${file}\nFN:1,${secret}\nFNDA:1,${secret}\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nBRDA:1,0,0,1\nBRF:1\nBRH:1\nend_of_record\n`,
  ).join("");
}
function receipt() {
  return {
    status: "passed",
    code: 0,
    signal: null,
    launchError: null,
    deniedAttempts: 0,
    interceptedWrangler: 1,
    outputLimitExceeded: false,
    guardRecordingFailed: false,
    coordinatorGuard: true,
    workerGuard: true,
    wranglerGuard: true,
    wranglerCliGuard: true,
    everyNodeChildGuarded: true,
    unobservedNativeExits: 0,
    unchangedFixture: true,
    unchangedCandidate: true,
    completionEvidence: true,
    env: { token: secret },
    args: [secret],
    error: secret,
  };
}
function temporary(body: (root: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "strict-gzip-receipt-policy-"));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function rawRun(root: string) {
  const raw = path.join(root, "raw");
  const run = path.join(raw, "native-synthetic");
  mkdirSync(path.join(run, "coverage"), { recursive: true });
  writeFileSync(path.join(run, "receipt.json"), JSON.stringify(receipt()));
  writeFileSync(path.join(run, "vitest-results.json"), JSON.stringify(tests()));
  writeFileSync(
    path.join(run, "coverage/coverage-summary.json"),
    JSON.stringify(coverage()),
  );
  writeFileSync(path.join(run, "coverage/lcov.info"), lcov());
  writeFileSync(path.join(run, "native-output.txt"), secret);
  return { raw, run, output: path.join(root, "public") };
}

test("ten suites, required custody assertions and two coverage identities validate", () => {
  const evidence = validateCompletionEvidence(
    tests(),
    coverage(),
    lcov(),
    candidate,
  );
  assert.equal(evidence.tests.suites.length, 10);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.equal(
    redactLcov(lcov(true), candidate),
    redactLcov(lcov(), candidate),
  );
});
for (const [label, change] of [
  ["missing suite", (v: ReturnType<typeof tests>) => v.testResults.pop()],
  [
    "duplicate suite",
    (v: ReturnType<typeof tests>) => {
      v.testResults[1] = structuredClone(v.testResults[0]!);
    },
  ],
  [
    "foreign suite",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.name = "/elsewhere/test.ts";
    },
  ],
  [
    "failed suite",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.status = "failed";
    },
  ],
  [
    "skipped assertion",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.assertionResults[0]!.status = "pending";
    },
  ],
  [
    "todo assertion",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.assertionResults[0]!.status = "todo";
    },
  ],
  [
    "failed assertion",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.assertionResults[0]!.status = "failed";
    },
  ],
  [
    "missing custody assertion",
    (v: ReturnType<typeof tests>) => {
      v.testResults[3]!.assertionResults[0]!.title = "some other passing test";
    },
  ],
  [
    "false success",
    (v: ReturnType<typeof tests>) => {
      v.success = false;
    },
  ],
  [
    "pending total",
    (v: ReturnType<typeof tests>) => {
      v.numPendingTests = 1;
    },
  ],
  [
    "incorrect total",
    (v: ReturnType<typeof tests>) => {
      v.numTotalTests += 1;
    },
  ],
] as const)
  test(`refuses ${label}`, () => {
    const v = tests();
    change(v);
    assert.throws(() => validateTestEvidence(v, candidate));
  });
for (const [label, change] of [
  [
    "foreign coverage",
    (v: ReturnType<typeof coverage>) => {
      v[secret] = v.total!;
    },
  ],
  [
    "missing coverage",
    (v: ReturnType<typeof coverage>) => {
      delete v[`${candidate}/${COVERED_SOURCES[0]}`];
    },
  ],
  [
    "negative metric",
    (v: ReturnType<typeof coverage>) => {
      v.total!.lines!.total = -1;
    },
  ],
  [
    "invalid percentage",
    (v: ReturnType<typeof coverage>) => {
      v.total!.lines!.pct = Infinity;
    },
  ],
  [
    "skipped coverage",
    (v: ReturnType<typeof coverage>) => {
      v.total!.lines!.skipped = 1;
    },
  ],
] as const)
  test(`refuses ${label}`, () => {
    const v = coverage();
    change(v);
    assert.throws(() => validateCoverageEvidence(v, candidate));
  });
for (const bad of [
  lcov().replace("SF:src/strict-gzip-reader.ts", `SF:${secret}`),
  lcov().replace("DA:1,1", "DA:1,secret"),
  lcov().replace("end_of_record", ""),
  lcov() + "unexpected:secret\n",
  "x".repeat(RAW_LIMITS["coverage/lcov.info"] + 1),
]) {
  test("refuses malformed or oversized LCOV", () =>
    assert.throws(() => redactLcov(bad, candidate)));
}
for (const key of [
  "coordinatorGuard",
  "workerGuard",
  "wranglerGuard",
  "wranglerCliGuard",
  "everyNodeChildGuarded",
  "unchangedFixture",
  "unchangedCandidate",
  "completionEvidence",
] as const) {
  test(`passed receipt requires ${key}`, () => {
    const v = receipt();
    v[key] = false;
    assert.throws(() => publicRunSummary(v));
  });
}
for (const key of ["outputLimitExceeded", "guardRecordingFailed"] as const)
  test(`passed receipt rejects ${key}`, () => {
    const v = receipt();
    v[key] = true;
    assert.throws(() => publicRunSummary(v));
  });
test("failed receipt strips raw launch errors, paths and credentials", () => {
  const v = {
    ...receipt(),
    status: "failed",
    code: 1,
    launchError: secret,
    signal: secret,
  };
  const publicValue = publicRunSummary(v);
  assert.equal(JSON.stringify(publicValue).includes(secret), false);
  assert.equal(publicValue.launchFailed, true);
});
test("output accounting never writes above a fixed limit", () => {
  const first = appendBudget(0, Buffer.from("abcd"), 5);
  assert.equal(first.used, 4);
  assert.equal(first.exceeded, false);
  const last = appendBudget(first.used, Buffer.from("efgh"), 5);
  assert.equal(last.used, 5);
  assert.equal(last.exceeded, true);
  assert.equal(Buffer.from(last.accepted).toString(), "e");
  assert.throws(() => appendBudget(0, Buffer.alloc(0), -1));
});
test("bounded reads reject oversized files and symlinks without reading targets", () =>
  temporary((root) => {
    const target = path.join(root, "large");
    writeFileSync(target, "secret");
    assert.throws(() => boundedFile(target, 2));
    const link = path.join(root, "link");
    symlinkSync(target, link);
    assert.throws(() => boundedFile(link, 64));
    assert.equal(boundedFile(target, 6).toString(), "secret");
  }));
for (const mode of [
  "unexpected",
  "symlink",
  "oversized",
  "extra-directory",
] as const)
  test(`raw artifact validation rejects ${mode}`, () =>
    temporary((root) => {
      const { run } = rawRun(root);
      if (mode === "unexpected")
        writeFileSync(path.join(run, "credentials.txt"), secret);
      if (mode === "symlink") {
        rmSync(path.join(run, "native-output.txt"));
        symlinkSync("receipt.json", path.join(run, "native-output.txt"));
      }
      if (mode === "oversized")
        truncateSync(
          path.join(run, "native-output.txt"),
          RAW_LIMITS["native-output.txt"] + 1,
        );
      if (mode === "extra-directory") mkdirSync(path.join(run, "extra"));
      assert.throws(() => validateReceiptDirectory(run));
    }));
test("publisher emits only validated summary and redacted LCOV", () =>
  temporary((root) => {
    const { raw, output } = rawRun(root);
    publish(raw, output, candidate);
    const summary = readFileSync(
      path.join(output, "qualification-summary.json"),
      "utf8",
    );
    assert.equal(JSON.parse(summary).status, "passed");
    assert.equal(summary.includes(secret), false);
    assert.equal(
      readFileSync(
        path.join(output, "candidate-coverage.lcov"),
        "utf8",
      ).includes(secret),
      false,
    );
    validatePublicationDirectory(output);
  }));
test("publisher refuses a passed receipt without named test evidence", () =>
  temporary((root) => {
    const { raw, run, output } = rawRun(root);
    writeFileSync(path.join(run, "vitest-results.json"), "{}");
    assert.throws(() => publish(raw, output, candidate));
  }));
test("publisher emits fixed setup failure when runtime never started", () =>
  temporary((root) => {
    const output = path.join(root, "public");
    publish(path.join(root, "missing"), output, candidate);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(output, "qualification-summary.json"), "utf8"),
      ).status,
      "setup-failed",
    );
  }));
test("publisher refuses raw-root symlink, duplicate runs, nested output and reused output", () =>
  temporary((root) => {
    const { raw, output } = rawRun(root);
    const link = path.join(root, "link");
    symlinkSync(raw, link);
    assert.throws(() => publish(link, output, candidate));
    assert.throws(() => publish(raw, path.join(raw, "public"), candidate));
    mkdirSync(path.join(raw, "native-extra"));
    assert.throws(() => publish(raw, output, candidate));
    mkdirSync(output);
    assert.throws(() => publish(path.join(root, "missing"), output, candidate));
  }));
test("public directory rejects raw files and oversize summaries", () =>
  temporary((root) => {
    const { raw, output } = rawRun(root);
    publish(raw, output, candidate);
    writeFileSync(path.join(output, "native-output.txt"), secret);
    assert.throws(() => validatePublicationDirectory(output));
    rmSync(path.join(output, "native-output.txt"));
    truncateSync(
      path.join(output, "qualification-summary.json"),
      PUBLIC_LIMITS["qualification-summary.json"] + 1,
    );
    assert.throws(() => validatePublicationDirectory(output));
  }));

test("unobserved native exits are reported honestly rather than invented as closes", () => {
  const value = { ...receipt(), unobservedNativeExits: 2 };
  assert.equal(publicRunSummary(value).unobservedNativeExits, 2);
  assert.throws(() =>
    publicRunSummary({ ...value, unobservedNativeExits: -1 }),
  );
});
