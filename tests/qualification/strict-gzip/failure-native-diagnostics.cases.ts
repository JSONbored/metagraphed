// Pure diagnostics-only checks. No pg/native import, socket, service, or Worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  FAILURE_NATIVE_REASON_CODES,
  FAILURE_NATIVE_REASON_REGISTRY,
} from "./failure-native-reason-codes.ts";
import {
  FAILURE_REQUIRED_TITLES,
  FAILURE_CONTROL_TITLE,
  FAILURE_TEST_FILE,
} from "./failure-test-evidence.ts";
import { failureReplayFailure } from "./failure-replay-diagnostics.ts";
import { OWNER_PROOF_REASON_CODES } from "./owner-proof-reason-codes.ts";
import { ownerProofFailure } from "./owner-proof-reasons.ts";
import {
  failureNativeFailure,
  inheritFailureNativeFailures,
  withFailureNativeReason,
  withFailureNativeReasonAsync,
  failureNativeBoundaryError,
  withFailureNativeBoundary,
  parseFailureNativeMarker,
  publicFailureNativeDiagnostics,
  type FailureNativeBoundary,
} from "./failure-native-diagnostics.ts";
const root = "/synthetic-root";
const location = FAILURE_NATIVE_REASON_CODES[0];
function marker(
  boundary: FailureNativeBoundary = "auth-unfixed-control",
  error: unknown = new Error("private detail"),
) {
  return failureNativeBoundaryError(
    failureNativeFailure(error, location),
    boundary,
  ).message;
}
function report(
  phase = "unfixed-instrumented",
  boundary: FailureNativeBoundary = "auth-unfixed-control",
) {
  const titles =
    phase === "unfixed-instrumented"
      ? [FAILURE_CONTROL_TITLE]
      : FAILURE_REQUIRED_TITLES;
  const index =
    phase === "unfixed-instrumented"
      ? 0
      : ["auth-rejection", "query-cancellation", "decoder-refusal"].indexOf(
          boundary,
        );
  return {
    success: false,
    numTotalTestSuites: 1,
    numPassedTestSuites: 0,
    numFailedTestSuites: 1,
    numPendingTestSuites: 0,
    numTotalTests: titles.length,
    numPassedTests: titles.length - 1,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: root + "/" + FAILURE_TEST_FILE,
        status: "failed",
        message: "",
        assertionResults: titles.map((title, at) => ({
          title,
          fullName: title,
          ancestorTitles: [],
          status: at === index ? "failed" : "passed",
          failureMessages: at === index ? [marker(boundary)] : [],
        })),
      },
    ],
  };
}
const reduce = (
  input: unknown,
  phase = "unfixed-instrumented",
  status = "failed",
) => publicFailureNativeDiagnostics(input, root, phase, status);
test("all fixed source locations are unique and carry bounded source identities", () => {
  assert.equal(
    new Set(FAILURE_NATIVE_REASON_CODES).size,
    FAILURE_NATIVE_REASON_CODES.length,
  );
  for (const row of FAILURE_NATIVE_REASON_REGISTRY) {
    assert.match(row.baselineSha256, /^[a-f0-9]{64}$/);
    assert.match(row.expressionSha256, /^[a-f0-9]{64}$/);
    assert.ok(row.line > 0 && row.column > 0);
    assert.equal(row.file, FAILURE_TEST_FILE);
  }
});
test("branding forwards exact values, return identities and rejected error identities", async () => {
  const value = {};
  assert.equal(
    withFailureNativeReason(location, () => value),
    value,
  );
  const error = new Error("private");
  assert.equal(failureNativeFailure(error, location), error);
  assert.throws(
    () =>
      withFailureNativeReason(location, () => {
        throw error;
      }),
    (caught) => caught === error,
  );
  await assert.rejects(
    withFailureNativeReasonAsync(location, async () => {
      throw error;
    }),
    (caught) => caught === error,
  );
});
test("boundary removes raw messages, paths, causes, errors, custom properties and stack", () => {
  let reads = 0;
  const raw = new Error("private SQL credential path");
  for (const key of ["stack", "message", "cause", "errors", "toJSON"])
    Object.defineProperty(raw, key, {
      get() {
        reads++;
        throw new Error("must not inspect");
      },
      configurable: true,
    });
  const safe = failureNativeBoundaryError(
    failureNativeFailure(raw, location),
    "auth-unfixed-control",
  );
  assert.equal(reads, 0);
  assert.equal(safe.stack, safe.message);
  assert.ok(parseFailureNativeMarker(safe.message));
  assert.deepEqual(Reflect.ownKeys(safe).sort(), ["message", "stack"]);
  assert.ok(!safe.message.includes("private"));
  assert.ok(!safe.message.includes(root));
});
test("revoked proxies and primitives remain uninspected and become fixed fallback markers", () => {
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  for (const value of [
    proxy.proxy,
    null,
    undefined,
    false,
    0,
    "private",
    Symbol("private"),
  ]) {
    const safe = failureNativeBoundaryError(value, "before-all");
    assert.equal(safe.stack, safe.message);
    assert.equal(
      parseFailureNativeMarker(safe.message)?.[0].location,
      "qnf-boundary-before-all",
    );
  }
});
test("existing replay and owner reasons remain deeper than native source locations", () => {
  for (const [error, family, code] of [
    [
      failureReplayFailure(new Error(), "fla-check-045"),
      "failure-replay",
      "fla-check-045",
    ],
    [
      ownerProofFailure(new Error(), OWNER_PROOF_REASON_CODES[0]),
      "owner-proof",
      OWNER_PROOF_REASON_CODES[0],
    ],
  ] as const) {
    const rows = parseFailureNativeMarker(marker("before-all", error));
    assert.equal(rows?.[0].family, family);
    assert.equal(rows?.[0].code, code);
  }
});
test("nested aggregates preserve primary and every captured cleanup reason without walking errors", () => {
  const primary = failureNativeFailure(
    failureReplayFailure(new Error(), "fla-check-045"),
    location,
  );
  const cleanup = failureNativeFailure(new Error(), "qnf-runtime-cleanup");
  const inner = new AggregateError([primary, cleanup], "private aggregate");
  assert.equal(
    inheritFailureNativeFailures(inner, [
      { error: primary, role: "primary", location: "qnf-runtime-primary" },
      { error: cleanup, role: "cleanup", location: "qnf-runtime-cleanup" },
    ]),
    inner,
  );
  const finalCleanup = failureNativeFailure(new Error(), "qnf-fixture-cleanup");
  const outer = new AggregateError([inner, finalCleanup], "private aggregate");
  inheritFailureNativeFailures(outer, [
    { error: inner, role: "primary", location: "qnf-fixture-primary" },
    { error: finalCleanup, role: "cleanup", location: "qnf-fixture-cleanup" },
  ]);
  Object.defineProperty(outer, "errors", {
    get() {
      throw new Error("No reflection");
    },
  });
  const rows = parseFailureNativeMarker(
    failureNativeBoundaryError(outer, "auth-unfixed-control").message,
  )!;
  assert.deepEqual(
    rows.map((row) => row.role),
    ["primary", "cleanup", "cleanup"],
  );
  assert.equal(rows[0].code, "fla-check-045");
});
test("overflow has a fixed explicit truncation reason and never leaks excess values", () => {
  const raw = new AggregateError([], "private");
  inheritFailureNativeFailures(
    raw,
    Array.from({ length: 20 }, () => ({
      error: new Error("private"),
      role: "cleanup" as const,
      location,
    })),
  );
  const rows = parseFailureNativeMarker(
    failureNativeBoundaryError(raw, "after-all").message,
  )!;
  assert.equal(rows.length, 8);
  assert.equal(rows[7].code, "qnf-reasons-truncated");
});
test("each of three scenarios and the genuine control projects only fixed enums", () => {
  for (const phase of ["uninstrumented", "instrumented"])
    for (const boundary of [
      "auth-rejection",
      "query-cancellation",
      "decoder-refusal",
    ] as const)
      assert.equal(
        reduce(report(phase, boundary), phase)[0]?.boundary,
        boundary,
      );
  assert.equal(reduce(report())[0]?.boundary, "auth-unfixed-control");
});
test("suite hook first-message diagnostics preserve exactly available evidence", () => {
  for (const boundary of ["before-all", "after-all"] as const) {
    const input = report();
    input.testResults[0].message = marker(boundary);
    input.testResults[0].assertionResults[0].failureMessages = [];
    assert.equal(reduce(input)[0]?.boundary, boundary);
  }
});
test("module initialization accepts only explicitly empty collection identity", () => {
  const input = report();
  input.numTotalTests = 0;
  input.numPassedTests = 0;
  input.numFailedTests = 0;
  input.testResults[0].assertionResults = [];
  input.testResults[0].message = marker("module");
  assert.equal(reduce(input)[0]?.boundary, "module");
  input.testResults[0].message = marker("before-all");
  assert.deepEqual(reduce(input), []);
});
for (const [name, mutate] of Object.entries({
  "wrong file": (x: any): unknown => (x.testResults[0].name += "x"),
  "wrong title": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].title = "other"),
  "wrong full name": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].fullName += "x"),
  "wrong ancestors": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].ancestorTitles = ["other"]),
  "passed marker": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].status = "passed"),
  "duplicate suite": (x: any): unknown => x.testResults.push(x.testResults[0]),
  "duplicate test": (x: any): unknown =>
    x.testResults[0].assertionResults.push(
      x.testResults[0].assertionResults[0],
    ),
  "duplicate marker": (x: any): unknown =>
    x.testResults[0].assertionResults[0].failureMessages.push(
      x.testResults[0].assertionResults[0].failureMessages[0],
    ),
  "contradictory totals": (x: any): unknown => (x.numFailedTests = 0),
  "contradictory suite": (x: any): unknown =>
    (x.testResults[0].status = "passed"),
  "contradictory success": (x: any): unknown => (x.success = true),
  "sparse messages": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].failureMessages = Array(1)),
  "sparse tests": (x: any): unknown =>
    (x.testResults[0].assertionResults = Array(1)),
  "wrong boundary": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].failureMessages = [
      marker("decoder-refusal"),
    ]),
  "embedded marker": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].failureMessages[0] =
      "arbitrary " + x.testResults[0].assertionResults[0].failureMessages[0]),
  "oversized message": (x: any): unknown =>
    (x.testResults[0].assertionResults[0].failureMessages = [
      "x".repeat(65537),
    ]),
  "unexpected serializer": (x: any): unknown =>
    (x.toJSON = () => {
      throw new Error("No calls");
    }),
  "unknown property": (x: any): unknown => (x.private = "secret"),
  "module marker with collected tests": (x: any): unknown =>
    (x.testResults[0].message = marker("module")),
}))
  test(`rejects ${name}`, () => {
    const input = report();
    mutate(input);
    assert.deepEqual(reduce(input), []);
  });
test("unknown phase and passed overall result cannot emit diagnostics", () => {
  assert.deepEqual(reduce(report(), "unknown"), []);
  assert.deepEqual(reduce(report(), "unfixed-instrumented", "passed"), []);
});
test("accessors, proxies and custom prototypes are refused without invoking traps", () => {
  let reads = 0;
  const input = report();
  Object.defineProperty(input, "success", {
    get() {
      reads++;
      throw new Error("No getter");
    },
    enumerable: true,
  });
  assert.deepEqual(reduce(input), []);
  const proxy = new Proxy(report(), {
    get() {
      reads++;
      throw new Error("No trap");
    },
  });
  assert.deepEqual(reduce(proxy), []);
  assert.deepEqual(reduce(Object.create(report())), []);
  assert.equal(reads, 0);
});
test("strict markers reject changed enum fields, duplicates, extra text and excess rows", () => {
  const good = marker();
  const prefix = "[failure-native-v1:";
  const payload = JSON.parse(good.slice(prefix.length, -1));
  const change = (fn: (x: any) => void) => {
    const x = structuredClone(payload);
    fn(x);
    return prefix + JSON.stringify(x) + "]";
  };
  for (const value of [
    "Error: " + good,
    good + good,
    good + "\n",
    good.slice(0, -1),
    "x".repeat(17000),
    change((x) => (x.boundary = "unknown")),
    change((x) => (x.reasons[0].location = "unknown")),
    change((x) => (x.reasons[0].code = "unknown")),
    change((x) => (x.reasons[0].role = "unknown")),
    change((x) => (x.reasons[0].family = "unknown")),
    change((x) => (x.reasons = Array(9).fill(x.reasons[0]))),
    change((x) => (x.extra = "private")),
  ])
    assert.equal(parseFailureNativeMarker(value), null);
});
test("safe boundary keeps falsy throws failing without changing inner truthiness semantics", () => {
  for (const value of [false, 0, undefined, null, ""])
    assert.throws(
      () =>
        withFailureNativeBoundary("module", () => {
          throw value;
        }),
      (error) =>
        error instanceof Error && !!parseFailureNativeMarker(error.message),
    );
});
test("negative control lifecycle predicates are byte-identical to the qualified subset candidate", () => {
  const bytes = readFileSync(
    new URL("./failure-lifecycle-assertions.ts", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "54de88045626ee500d29ce1385a693da01fb40f56d373df325e49e591c768220",
  );
});

test("async observation preserves the exact Promise and brands before the awaiting caller", async () => {
  const value = {};
  const successful = Promise.resolve(value);
  const result = withFailureNativeReasonAsync(location, () => successful);
  assert.equal(result, successful);
  assert.equal(await result, value);
  const original = new Error("private rejected value");
  const rejected = Promise.reject(original);
  const observed = withFailureNativeReasonAsync(location, () => rejected);
  assert.equal(observed, rejected);
  try {
    await observed;
    assert.fail("must reject");
  } catch (error) {
    assert.equal(error, original);
    assert.equal(
      parseFailureNativeMarker(
        failureNativeBoundaryError(error, "before-all").message,
      )?.[0].location,
      location,
    );
  }
  const thenable = {
    then() {
      throw new Error("not inspected");
    },
  };
  assert.equal(
    withFailureNativeReasonAsync(location, () => thenable as any),
    thenable,
  );
});

test("actual cleanup callback sources keep distinct rejected operation codes and cleanup roles", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const source = readFileSync(
    new URL("./queue-owner-failure.test.ts", import.meta.url),
    "utf8",
  );
  const callbacks = [...source.matchAll(/await attempt\(([\s\S]*?)\);\n/g)].map(
    (match) => match[1].trim().replace(/,\s*$/, ""),
  );
  assert.equal(callbacks.length, 3);
  const seen = new Set<string>();
  for (const callback of callbacks) {
    const codes = [
      ...callback.matchAll(
        /withFailureNativeReasonAsync\("(qnf-operation-\d+)"/g,
      ),
    ].map((match) => match[1]);
    assert.equal(codes.length, 2);
    const error = new Error("private cleanup failure");
    const promise = Promise.reject(error);
    let calls = 0;
    const fail = () => {
      calls++;
      return promise;
    };
    const execute = runInNewContext(
      "(" + stripTypeScriptTypes(callback) + ")",
      {
        withFailureNativeReasonAsync,
        withinOwnerDeadline: (value: unknown) => value,
        fixture: { rollback: fail },
        observation: { finish: fail },
        native: { dispose: fail },
      },
    );
    assert.equal(execute(), promise);
    await assert.rejects(promise, (caught) => caught === error);
    assert.equal(calls, 1);
    const aggregate = inheritFailureNativeFailures(
      new AggregateError([error], "private"),
      [{ error, role: "cleanup", location: "qnf-runtime-cleanup" }],
    );
    const rows = parseFailureNativeMarker(
      failureNativeBoundaryError(aggregate, "auth-unfixed-control").message,
    )!;
    assert.equal(rows[0].location, codes[1]);
    assert.equal(rows[0].role, "cleanup");
    seen.add(rows[0].location);
  }
  assert.equal(seen.size, 3);
});

test("strict marker tuples reject mismatched native codes and boundary fallback locations", () => {
  const prefix = "[failure-native-v1:";
  const parsed = JSON.parse(marker().slice(prefix.length, -1));
  parsed.reasons[0].code = "qnf-runtime-primary";
  assert.equal(
    parseFailureNativeMarker(prefix + JSON.stringify(parsed) + "]"),
    null,
  );
  parsed.reasons[0].location = "qnf-boundary-module";
  parsed.reasons[0].code = "qnf-boundary-module";
  assert.equal(
    parseFailureNativeMarker(prefix + JSON.stringify(parsed) + "]"),
    null,
  );
  parsed.reasons[0].location = "qnf-reasons-truncated";
  parsed.reasons[0].code = "qnf-reasons-truncated";
  assert.equal(
    parseFailureNativeMarker(prefix + JSON.stringify(parsed) + "]"),
    null,
  );
});
