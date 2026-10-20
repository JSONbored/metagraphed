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
import { pathToFileURL } from "node:url";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
import {
  COVERED_SOURCES,
  MAX_DENIAL_GROUPS,
  aggregateDenials,
  PUBLIC_LIMITS,
  RAW_LIMITS,
  REQUIRED_ASSERTIONS,
  publicRunSummary,
  publicTestProgress,
  threadLifecycleEvidence,
  processChildGuardEvidence,
  nativeUnobservedExitCount,
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
import { DENIAL_OPERATIONS, POLICY_CODES } from "./launch-policy.ts";

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
    denialCounts: [] as unknown[],
    interceptedWrangler: 1,
    outputLimitExceeded: false,
    guardRecordingFailed: false,
    coordinatorGuard: true,
    workerGuard: true,
    wranglerGuard: true,
    wranglerCliGuard: true,
    everyNodeChildGuarded: true,
    everyThreadGuarded: true,
    acceptedThreads: 1,
    completedThreads: 1,
    threadFailures: 0,
    unobservedNativeExits: 0,
    observedWorkerSigterms: 0,
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

test("refusal diagnostics preserve only fixed enums and exact aggregate counts", () => {
  const rows = aggregateDenials([
    {
      operation: "process-fork",
      policyCode: "unexpected-environment",
      target: secret,
    },
    {
      operation: "process-fork",
      policyCode: "unexpected-environment",
      argument: secret,
    },
    { operation: secret, policyCode: secret },
  ]);
  const result = publicRunSummary({
    ...receipt(),
    status: "failed",
    deniedAttempts: 3,
    denialCounts: rows,
  });
  assert.deepEqual(result.denialCounts, [
    { operation: "other", policyCode: "other", count: 1 },
    {
      operation: "process-fork",
      policyCode: "unexpected-environment",
      count: 2,
    },
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
test("public diagnostics re-sanitize raw aggregate labels without stringification", () => {
  const dangerous = {
    toString() {
      throw new Error("must not stringify");
    },
  };
  const result = publicRunSummary({
    ...receipt(),
    status: "failed",
    deniedAttempts: 3,
    denialCounts: [
      { operation: secret, policyCode: secret, count: 1 },
      { operation: dangerous, policyCode: dangerous, count: 2 },
    ],
  });
  assert.deepEqual(result.denialCounts, [
    { operation: "other", policyCode: "other", count: 3 },
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
for (const [label, rows, total] of [
  ["missing", undefined, 0],
  ["negative", [{ operation: "TLS", policyCode: "tls-denied", count: -1 }], 0],
  ["zero", [{ operation: "TLS", policyCode: "tls-denied", count: 0 }], 0],
  [
    "fractional",
    [{ operation: "TLS", policyCode: "tls-denied", count: 0.5 }],
    1,
  ],
  [
    "too large",
    [{ operation: "TLS", policyCode: "tls-denied", count: 100001 }],
    1,
  ],
  [
    "inconsistent",
    [{ operation: "TLS", policyCode: "tls-denied", count: 2 }],
    1,
  ],
  [
    "too many groups",
    Array.from({ length: MAX_DENIAL_GROUPS + 1 }, () => ({ count: 1 })),
    MAX_DENIAL_GROUPS + 1,
  ],
] as const)
  test(`refusal diagnostics reject ${label} counts`, () => {
    assert.throws(() =>
      publicRunSummary({
        ...receipt(),
        status: "failed",
        deniedAttempts: total,
        denialCounts: rows,
      }),
    );
  });
test("diagnostic aggregation is bounded and never loses refusals", () => {
  const events = DENIAL_OPERATIONS.flatMap((operation) =>
    POLICY_CODES.map((policyCode) => ({ operation, policyCode })),
  );
  const rows = aggregateDenials(events);
  assert.ok(rows.length <= MAX_DENIAL_GROUPS);
  assert.equal(
    rows.reduce((sum, row) => sum + row.count, 0),
    events.length,
  );
  assert.ok(
    rows.find((row) => row.operation === "other" && row.policyCode === "other")!
      .count > 0,
  );
  assert.equal(
    publicRunSummary({
      ...receipt(),
      status: "failed",
      deniedAttempts: events.length,
      denialCounts: rows,
    }).denialCounts.length,
    rows.length,
  );
  assert.throws(() => aggregateDenials(Array(100001)));
});
test("publisher exposes bounded refusal codes without raw logs or arguments", () =>
  temporary((root) => {
    const { raw, run, output } = rawRun(root);
    writeFileSync(
      path.join(run, "receipt.json"),
      JSON.stringify({
        ...receipt(),
        status: "failed",
        code: 1,
        deniedAttempts: 1,
        denialCounts: [
          {
            operation: "process-fork",
            policyCode: "unexpected-environment",
            count: 1,
            target: secret,
          },
        ],
      }),
    );
    publish(raw, output, candidate);
    const text = readFileSync(
      path.join(output, "qualification-summary.json"),
      "utf8",
    );
    assert.equal(text.includes(secret), false);
    assert.deepEqual(JSON.parse(text).run.denialCounts, [
      {
        operation: "process-fork",
        policyCode: "unexpected-environment",
        count: 1,
      },
    ]);
  }));

test("qualification config uses numeric loopback while preserving base server options", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "strict-gzip-config-policy-"));
  const keys = [
    "DECODER_QUALIFICATION_ROOT",
    "DECODER_QUALIFICATION_PRELOAD",
    "DECODER_QUALIFICATION_RESULT",
  ] as const;
  const prior = keys.map((key) => process.env[key]);
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const guard = Symbol.for("decoder-qualification.host-guard");
  const previousGuard = globals[guard];
  const source =
    'export default { server: { host: "localhost", hmr: false, port: 1234 }, test: { coverage: { thresholds: { lines: 77 } } } };';
  try {
    writeFileSync(path.join(root, "vitest.targeted.config.ts"), source);
    process.env.DECODER_QUALIFICATION_ROOT = root;
    process.env.DECODER_QUALIFICATION_PRELOAD = pathToFileURL(
      path.join(root, "synthetic-preload.ts"),
    ).href;
    process.env.DECODER_QUALIFICATION_RESULT = path.join(root, "results.json");
    globals[guard] = true;
    // The base is a synthetic data-only module. No Vitest/Vite/native import runs.
    const { default: config } = await import("./vitest.config.ts");
    assert.deepEqual(config.server, {
      host: "127.0.0.1",
      hmr: false,
      port: 1234,
    });
    assert.deepEqual(
      (config.test.coverage as Record<string, unknown>).thresholds,
      { lines: 77 },
    );
    assert.equal(
      readFileSync(path.join(root, "vitest.targeted.config.ts"), "utf8"),
      source,
    );
  } finally {
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
    if (previousGuard === undefined) delete globals[guard];
    else globals[guard] = previousGuard;
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual worker SIGTERM observations are reported as a bounded count", () => {
  assert.equal(
    publicRunSummary({ ...receipt(), observedWorkerSigterms: 10 })
      .observedWorkerSigterms,
    10,
  );
  for (const value of [undefined, -1, 0.5, 10001, secret])
    assert.throws(() =>
      publicRunSummary({ ...receipt(), observedWorkerSigterms: value }),
    );
});

test("failed-run progress retains only pinned files, fixed statuses and counts", () => {
  const value = tests();
  value.testResults[0]!.status = "failed";
  value.testResults[0]!.assertionResults[0]!.status = "failed";
  value.testResults[1]!.assertionResults[0]!.status = "pending";
  const rows = publicTestProgress(value, candidate);
  assert.equal(rows.length, 10);
  assert.equal(JSON.stringify(rows).includes(secret), false);
  assert.equal(
    rows.find((row) => row.path === FOCUSED_TESTS[0])!.status,
    "failed",
  );
  assert.equal(
    rows.find((row) => row.path === FOCUSED_TESTS[1])!.status,
    "incomplete",
  );
  const custody = rows.find(
    (row) => row.path === "tests/data-api-sync-queue-consumer.test.ts",
  )!;
  assert.equal(custody.requiredPassed, 5);
  assert.equal(custody.requiredTotal, 5);
  assert.equal(custody.status, "passed");
});
test("empty and missing-required progress cannot be labeled passed", () => {
  const value = tests();
  value.testResults[0]!.assertionResults = [];
  const custody = value.testResults.find((row) =>
    row.name.endsWith("/data-api-sync-queue-consumer.test.ts"),
  )!;
  custody.assertionResults[0]!.title = "unrelated assertion";
  const rows = publicTestProgress(value, candidate);
  assert.equal(
    rows.find((row) => row.path === FOCUSED_TESTS[0])!.status,
    "incomplete",
  );
  assert.equal(
    rows.find(
      (row) => row.path === "tests/data-api-sync-queue-consumer.test.ts",
    )!.status,
    "incomplete",
  );
});
for (const [label, mutate] of [
  [
    "foreign file",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.name = secret;
    },
  ],
  [
    "duplicate file",
    (v: ReturnType<typeof tests>) => {
      v.testResults[1] = structuredClone(v.testResults[0]!);
    },
  ],
  [
    "unknown suite status",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.status = secret;
    },
  ],
  [
    "unknown test status",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.assertionResults[0]!.status = secret;
    },
  ],
  [
    "too many files",
    (v: ReturnType<typeof tests>) => {
      v.testResults.push(structuredClone(v.testResults[0]!));
    },
  ],
  [
    "too many assertions",
    (v: ReturnType<typeof tests>) => {
      v.testResults[0]!.assertionResults = Array.from(
        { length: 10001 },
        () => v.testResults[1]!.assertionResults[0]!,
      );
    },
  ],
] as const)
  test(`progress refuses ${label}`, () => {
    const value = tests();
    mutate(value);
    assert.throws(() => publicTestProgress(value, candidate));
  });
test("publisher exposes failed-run progress without stamping acceptance", () =>
  temporary((root) => {
    const { raw, run, output } = rawRun(root);
    writeFileSync(
      path.join(run, "receipt.json"),
      JSON.stringify({ ...receipt(), status: "failed", code: 1 }),
    );
    const value = tests();
    value.success = false;
    value.testResults[0]!.status = "failed";
    writeFileSync(path.join(run, "vitest-results.json"), JSON.stringify(value));
    publish(raw, output, candidate);
    const text = readFileSync(
      path.join(output, "qualification-summary.json"),
      "utf8",
    );
    const summary = JSON.parse(text);
    assert.equal(summary.status, "failed");
    assert.equal(summary.evidenceValidated, false);
    assert.equal(summary.testProgress.length, 10);
    assert.equal(text.includes(secret), false);
  }));

test("progress requires all eighteen corrected guard assertions before labeling that suite passed", () => {
  for (const count of [17, 19]) {
    const value = tests();
    const suite = value.testResults.find((row) =>
      row.name.endsWith("/strict-gzip-host-guard.test.ts"),
    )!;
    if (count === 17) suite.assertionResults.pop();
    else
      suite.assertionResults.push(structuredClone(suite.assertionResults[0]!));
    assert.equal(
      publicTestProgress(value, candidate).find(
        (row) => row.path === "tests/strict-gzip-host-guard.test.ts",
      )!.status,
      "incomplete",
    );
  }
});

function queueDiagnostic(messages: string[]) {
  const value = tests();
  const suite = value.testResults.find((row) =>
    row.name.endsWith("/data-api-sync-queue-consumer.test.ts"),
  )!;
  suite.status = "failed";
  suite.assertionResults[2]!.status = "failed";
  suite.assertionResults[2]!.failureMessages = messages;
  const row = publicTestProgress(value, candidate).find(
    (row) => row.path === "tests/data-api-sync-queue-consumer.test.ts",
  )!;
  return { value, suite, row };
}

test("required-case diagnostics expose fixed index/status and numeric known-source frames only", () => {
  const source = `${candidate}/tests/data-api-sync-queue-consumer.test.ts`;
  const { row } = queueDiagnostic([
    `${secret}\n at arbitrarySecretFunction (${source}:720:15)\n at ${source}:720:15\n at ${source}:721:2`,
  ]);
  assert.equal(row.requiredPassed, 4);
  assert.equal(row.status, "failed");
  assert.deepEqual(row.requiredCases[2], {
    index: 2,
    status: "failed",
    frames: [
      { line: 720, column: 15 },
      { line: 721, column: 2 },
    ],
  });
  assert.equal(row.requiredCases.length, 5);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.equal(JSON.stringify(row).includes("arbitrarySecretFunction"), false);
  assert.equal(JSON.stringify(row).includes(candidate), false);
  assert.equal(
    JSON.stringify(row).includes(REQUIRED_ASSERTIONS[row.path]![2]!),
    false,
  );
});

test("source frames refuse foreign paths, malformed positions and unbounded messages", () => {
  const source = `${candidate}/tests/data-api-sync-queue-consumer.test.ts`;
  const { row } = queueDiagnostic([
    `${secret}:1:2`,
    `/foreign${source}:1:2`,
    `${source}.other:1:2`,
    `${source}:0:2`,
    `${source}:1:0`,
    `${source}:100000:2`,
    `${source}:1:10000`,
    `${source}:1:2suffix`,
    `${source}:1:2\n` + "x".repeat(65536),
    `${candidate}/tests/strict-gzip-reader.test.ts:1:2`,
  ]);
  assert.deepEqual(row.requiredCases[2]!.frames, []);
  assert.deepEqual(
    queueDiagnostic(Array(101).fill(`${source}:1:2`)).row.requiredCases[2]!
      .frames,
    [],
  );
});

test("source frames remain unique and capped at three per failed required case", () => {
  const source = `${candidate}/tests/data-api-sync-queue-consumer.test.ts`;
  const { row } = queueDiagnostic(
    Array.from({ length: 100 }, (_, i) => ` at (${source}:${i + 1}:1)`),
  );
  assert.deepEqual(row.requiredCases[2]!.frames, [
    { line: 1, column: 1 },
    { line: 2, column: 1 },
    { line: 3, column: 1 },
  ]);
});

test("missing and duplicate required identities have fixed diagnostic statuses", () => {
  const value = tests();
  const suite = value.testResults.find((row) =>
    row.name.endsWith("/data-api-sync-queue-consumer.test.ts"),
  )!;
  suite.assertionResults[1]!.title = secret;
  suite.assertionResults.push(structuredClone(suite.assertionResults[0]!));
  const row = publicTestProgress(value, candidate).find(
    (row) => row.path === "tests/data-api-sync-queue-consumer.test.ts",
  )!;
  assert.deepEqual(row.requiredCases[0], {
    index: 0,
    status: "ambiguous",
    frames: [],
  });
  assert.deepEqual(row.requiredCases[1], {
    index: 1,
    status: "missing",
    frames: [],
  });
  assert.equal(row.status, "incomplete");
  assert.equal(JSON.stringify(row).includes(secret), false);
});

test("only uniquely failed required assertions receive diagnostic frames", () => {
  const { value, suite } = queueDiagnostic([]);
  suite.assertionResults[0]!.failureMessages = [`${suite.name}:1:2`];
  suite.assertionResults[1]!.status = "todo";
  suite.assertionResults[1]!.failureMessages = [`${suite.name}:1:2`];
  suite.assertionResults.push({
    title: secret,
    status: "failed",
    fullName: secret,
    failureMessages: [`${suite.name}:1:2`],
  });
  const row = publicTestProgress(value, candidate).find(
    (row) => row.path === "tests/data-api-sync-queue-consumer.test.ts",
  )!;
  assert.deepEqual(row.requiredCases[0], {
    index: 0,
    status: "passed",
    frames: [],
  });
  assert.deepEqual(row.requiredCases[1], {
    index: 1,
    status: "skipped",
    frames: [],
  });
  assert.equal(row.requiredCases.length, 5);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.throws(() => validateTestEvidence(value, candidate));
});

test("publisher retains bounded case diagnostics without converting failure to acceptance", () =>
  temporary((root) => {
    const { raw, run, output } = rawRun(root);
    writeFileSync(
      path.join(run, "receipt.json"),
      JSON.stringify({ ...receipt(), status: "failed", code: 1 }),
    );
    const { value } = queueDiagnostic([
      `${secret}\n at (${candidate}/tests/data-api-sync-queue-consumer.test.ts:720:15)`,
    ]);
    writeFileSync(path.join(run, "vitest-results.json"), JSON.stringify(value));
    publish(raw, output, candidate);
    const text = readFileSync(
      path.join(output, "qualification-summary.json"),
      "utf8",
    );
    const result = JSON.parse(text);
    assert.equal(result.status, "failed");
    assert.equal(result.evidenceValidated, false);
    assert.deepEqual(
      result.testProgress.find(
        (row: { path: string }) =>
          row.path === "tests/data-api-sync-queue-consumer.test.ts",
      ).requiredCases[2],
      { index: 2, status: "failed", frames: [{ line: 720, column: 15 }] },
    );
    assert.equal(text.includes(secret), false);
  }));

function threadEvents() {
  const common = {
    pid: 123,
    ownerPid: 123,
    targetThreadId: 7,
    threadLaunchId: "123:thread:1",
  };
  return [
    { ...common, threadId: 0, kind: "thread-launch" },
    { ...common, threadId: 7, kind: "thread-guard-start" },
    { ...common, threadId: 7, kind: "thread-ready" },
    { ...common, threadId: 0, kind: "thread-handshake" },
    {
      ...common,
      threadId: 0,
      kind: "thread-terminate-request",
      reason: "requested",
    },
    { ...common, threadId: 0, kind: "thread-exit", code: 1, failed: false },
  ] as Record<string, unknown>[];
}

test("thread evidence requires real bijective launch, guard, ready, handshake and observed exit", () => {
  assert.deepEqual(threadLifecycleEvidence(threadEvents()), {
    acceptedThreads: 1,
    completedThreads: 1,
    threadFailures: 0,
    everyThreadGuarded: true,
  });
  const natural = threadEvents().filter(
    (row) => row.kind !== "thread-terminate-request",
  );
  natural.at(-1)!.code = 0;
  assert.equal(threadLifecycleEvidence(natural).everyThreadGuarded, true);
  assert.equal(threadLifecycleEvidence([]).everyThreadGuarded, false);
  // Thread startup may race the parent launch receipt; handshake may not.
  const racing = threadEvents();
  [racing[0], racing[1]] = [racing[1]!, racing[0]!];
  assert.equal(threadLifecycleEvidence(racing).everyThreadGuarded, true);
});

for (const kind of [
  "thread-launch",
  "thread-guard-start",
  "thread-ready",
  "thread-handshake",
  "thread-exit",
]) {
  test(`thread evidence refuses missing ${kind}`, () =>
    assert.equal(
      threadLifecycleEvidence(threadEvents().filter((row) => row.kind !== kind))
        .everyThreadGuarded,
      false,
    ));
  test(`thread evidence refuses duplicate ${kind}`, () => {
    const rows = threadEvents();
    rows.push({ ...rows.find((row) => row.kind === kind)! });
    assert.equal(threadLifecycleEvidence(rows).everyThreadGuarded, false);
  });
}
for (const [label, mutate] of [
  [
    "wrong owner writer",
    (rows: Record<string, unknown>[]) => {
      rows[0]!.threadId = 7;
    },
  ],
  [
    "wrong thread writer",
    (rows: Record<string, unknown>[]) => {
      rows[1]!.threadId = 0;
    },
  ],
  [
    "missing writer",
    (rows: Record<string, unknown>[]) => {
      delete rows[1]!.threadId;
    },
  ],
  [
    "wrong owner pid",
    (rows: Record<string, unknown>[]) => {
      rows[1]!.pid = 124;
    },
  ],
  [
    "different target id",
    (rows: Record<string, unknown>[]) => {
      rows[1]!.targetThreadId = 8;
    },
  ],
  [
    "invalid launch id",
    (rows: Record<string, unknown>[]) => {
      rows[1]!.threadLaunchId = secret;
    },
  ],
  [
    "zero target id",
    (rows: Record<string, unknown>[]) => {
      rows[1]!.targetThreadId = 0;
    },
  ],
  [
    "missing ready before handshake",
    (rows: Record<string, unknown>[]) => {
      [rows[2], rows[3]] = [rows[3]!, rows[2]!];
    },
  ],
  [
    "exit before handshake",
    (rows: Record<string, unknown>[]) => {
      [rows[3], rows[5]] = [rows[5]!, rows[3]!];
    },
  ],
  [
    "termination after exit",
    (rows: Record<string, unknown>[]) => {
      [rows[4], rows[5]] = [rows[5]!, rows[4]!];
    },
  ],
  [
    "startup-failure termination",
    (rows: Record<string, unknown>[]) => {
      rows[4]!.reason = "startup-failure";
    },
  ],
  [
    "unknown termination reason",
    (rows: Record<string, unknown>[]) => {
      rows[4]!.reason = secret;
    },
  ],
  [
    "unrequested code one",
    (rows: Record<string, unknown>[]) => {
      rows.splice(4, 1);
    },
  ],
  [
    "unexpected exit code",
    (rows: Record<string, unknown>[]) => {
      rows[5]!.code = 2;
    },
  ],
  [
    "latched exit failure",
    (rows: Record<string, unknown>[]) => {
      rows[5]!.failed = true;
    },
  ],
  [
    "missing exit failure state",
    (rows: Record<string, unknown>[]) => {
      delete rows[5]!.failed;
    },
  ],
  [
    "missing exit code",
    (rows: Record<string, unknown>[]) => {
      delete rows[5]!.code;
    },
  ],
  [
    "duplicate terminate request",
    (rows: Record<string, unknown>[]) => {
      rows.splice(4, 0, { ...rows[4]! });
    },
  ],
  [
    "orphan identity",
    (rows: Record<string, unknown>[]) => {
      rows.push({
        ...rows[1]!,
        threadLaunchId: "123:thread:2",
        targetThreadId: 8,
        threadId: 8,
      });
    },
  ],
  [
    "unknown thread event",
    (rows: Record<string, unknown>[]) => {
      rows.push({ ...rows[0]!, kind: "thread-unknown" });
    },
  ],
] as const)
  test(`thread evidence refuses ${label}`, () => {
    const rows = threadEvents();
    mutate(rows);
    assert.equal(threadLifecycleEvidence(rows).everyThreadGuarded, false);
  });

test("thread errors and failures remain fatal despite later requested termination and real exit", () => {
  for (const kind of ["thread-error", "thread-failure"]) {
    const rows = threadEvents();
    rows.splice(4, 0, { ...rows[0]!, kind });
    const result = threadLifecycleEvidence(rows);
    assert.equal(result.everyThreadGuarded, false);
    assert.equal(result.threadFailures, 1);
    assert.equal(result.completedThreads, 0);
  }
});
test("thread count is derived from actual identities rather than prior refusal attempts", () => {
  const second = threadEvents().map((row) => ({
    ...row,
    targetThreadId: 8,
    threadLaunchId: "123:thread:2",
    threadId: row.threadId === 7 ? 8 : 0,
  }));
  assert.deepEqual(threadLifecycleEvidence([...threadEvents(), ...second]), {
    acceptedThreads: 2,
    completedThreads: 2,
    threadFailures: 0,
    everyThreadGuarded: true,
  });
  const reused = second.map((row) => ({
    ...row,
    targetThreadId: 7,
    threadId: row.threadId === 8 ? 7 : 0,
  }));
  assert.equal(
    threadLifecycleEvidence([...threadEvents(), ...reused]).everyThreadGuarded,
    false,
  );
});

test("same-pid thread events can never satisfy Node process guard or parent exit evidence", () => {
  const rows = [
    {
      kind: "node-child",
      threadId: 0,
      pid: 100,
      childPid: 123,
      launchId: "100:1",
    },
    { kind: "guard-start", threadId: 0, pid: 123 },
    { kind: "guard-exit", threadId: 0, pid: 123 },
    {
      kind: "node-child-exit",
      threadId: 0,
      pid: 100,
      childPid: 123,
      launchId: "100:1",
    },
  ];
  assert.equal(processChildGuardEvidence(rows), true);
  for (let i = 0; i < rows.length; i++) {
    const changed = structuredClone(rows);
    changed[i]!.threadId = 7;
    assert.equal(processChildGuardEvidence(changed), false);
    assert.equal(
      processChildGuardEvidence([...changed, ...threadEvents()]),
      false,
    );
  }
});

test("public thread evidence is bounded, fixed-field and fails closed", () => {
  const result = publicRunSummary({
    ...receipt(),
    threadSource: secret,
    threadArguments: [secret],
  });
  assert.equal(result.acceptedThreads, 1);
  assert.equal(result.checks.everyThreadGuarded, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  for (const change of [
    { acceptedThreads: 0 },
    { completedThreads: 0 },
    { threadFailures: 1 },
    { acceptedThreads: 10001 },
    { completedThreads: 2 },
    { everyThreadGuarded: false },
    { threadFailures: -1 },
  ])
    assert.throws(() => publicRunSummary({ ...receipt(), ...change }));
  assert.equal(
    publicRunSummary({
      ...receipt(),
      status: "failed",
      code: 1,
      everyThreadGuarded: false,
      completedThreads: 0,
      threadFailures: 1,
    }).checks.everyThreadGuarded,
    false,
  );
});

test("positive-thread-ID events cannot impersonate native child launches or exits", () => {
  const child = {
    kind: "native-child",
    threadId: 0,
    launchId: "123:1",
    role: "esbuild",
  };
  const exit = {
    kind: "native-child-exit",
    threadId: 0,
    launchId: "123:1",
    role: "esbuild",
  };
  assert.equal(nativeUnobservedExitCount([child]), 1);
  assert.equal(nativeUnobservedExitCount([child, exit]), 0);
  assert.equal(nativeUnobservedExitCount([child, { ...exit, threadId: 7 }]), 1);
  assert.equal(nativeUnobservedExitCount([{ ...child, threadId: 7 }]), 0);
  assert.equal(nativeUnobservedExitCount([{ ...child, threadId: 7 }, exit]), 0);
});
