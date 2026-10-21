// Pure diagnostic regressions. No native process, runtime, service or provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FAILURE_REPLAY_REASON_CODES,
  FAILURE_REPLAY_REASON_REGISTRY,
} from "./failure-replay-reason-codes.ts";
import {
  FAILURE_REPLAY_STAGE_CODES,
  FAILURE_REPLAY_DIAGNOSTIC_LIMIT,
  failureReplayFailure,
  inheritFailureReplayReason,
  failureReplayDiagnostic,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
  parseFailureReplayDiagnostics,
  projectFailureReplayDiagnostics,
} from "./failure-replay-diagnostics.ts";
import { OWNER_PROOF_REASON_CODES } from "./owner-proof-reason-codes.ts";
import { ownerProofFailure } from "./owner-proof-reasons.ts";
import { failurePhase } from "./failure-variants.ts";
import { validateFailurePrivateEvidence } from "./failure-postgres-private.ts";
import { assertFailureAuthLifecycle } from "./failure-lifecycle-assertions.ts";
import { validateFailureTestEvidence } from "./failure-test-evidence.ts";
import { validateFailureReceiptDirectory } from "./failure-evidence.ts";
const first = FAILURE_REPLAY_REASON_CODES[0]!;
const second = FAILURE_REPLAY_REASON_CODES[1]!;
const diagnostic = (code = first, stage = "owner-evidence") => ({
  stage,
  family: "failure-replay",
  code,
});
function caught(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a synthetic refusal");
}
test("fixed registry is deeply frozen, unique, source-bound and covers all nine replay modules", () => {
  assert.ok(Object.isFrozen(FAILURE_REPLAY_REASON_CODES));
  assert.ok(Object.isFrozen(FAILURE_REPLAY_REASON_REGISTRY));
  assert.ok(Object.isFrozen(FAILURE_REPLAY_STAGE_CODES));
  assert.equal(
    new Set(FAILURE_REPLAY_REASON_CODES).size,
    FAILURE_REPLAY_REASON_CODES.length,
  );
  assert.equal(FAILURE_REPLAY_REASON_REGISTRY.length, 586);
  const sources = new Map<string, string>();
  for (const row of FAILURE_REPLAY_REASON_REGISTRY) {
    assert.ok(Object.isFrozen(row));
    assert.match(row.code, /^[a-z][a-z0-9-]{0,95}$/);
    assert.match(
      row.file,
      /^tests\/qualification\/strict-gzip\/failure-[a-z-]+\.ts$/,
    );
    assert.match(row.baselineSha256, /^[a-f0-9]{64}$/);
    assert.match(row.expressionSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(row.line) && row.line > 0);
    assert.ok(Number.isSafeInteger(row.column) && row.column > 0);
    assert.ok(row.description.length > 0 && row.description.length <= 160);
    const basename = row.file.split("/").at(-1)!;
    const source =
      sources.get(basename) ??
      readFileSync(new URL(basename, import.meta.url), "utf8");
    sources.set(basename, source);
    assert.equal(source.split('"' + row.code + '"').length - 1, 1);
  }
  assert.equal(sources.size, 9);
});
for (const code of FAILURE_REPLAY_REASON_CODES)
  test("fixed replay code roundtrip " + code, () => {
    const error = {};
    assert.equal(failureReplayFailure(error, code), error);
    const actual = failureReplayDiagnostic(error, "owner-evidence");
    assert.deepEqual(actual, diagnostic(code));
    assert.deepEqual(parseFailureReplayDiagnostics([actual]), [actual]);
    assert.ok(Object.isFrozen(actual));
  });
test("deepest local and pre-existing owner proof reasons survive sync, async and inherited wrappers", async () => {
  const error = {};
  assert.equal(
    caught(() =>
      withFailureReplayReason(second, () =>
        withFailureReplayReason(first, () => {
          throw error;
        }),
      ),
    ),
    error,
  );
  assert.equal(failureReplayDiagnostic(error, "owner-evidence")!.code, first);
  const outer = inheritFailureReplayReason({}, error);
  failureReplayFailure(outer, second);
  assert.equal(failureReplayDiagnostic(outer, "owner-evidence")!.code, first);
  const existing = ownerProofFailure({}, OWNER_PROOF_REASON_CODES[0]!);
  failureReplayFailure(existing, first);
  const inherited = inheritFailureReplayReason({}, existing);
  const inheritedAgain = inheritFailureReplayReason({}, inherited);
  failureReplayFailure(inheritedAgain, second);
  for (const value of [existing, inherited, inheritedAgain])
    assert.deepEqual(failureReplayDiagnostic(value, "owner-evidence"), {
      stage: "owner-evidence",
      family: "owner-proof",
      code: OWNER_PROOF_REASON_CODES[0],
    });
  const already = failureReplayFailure({}, second);
  inheritFailureReplayReason(already, existing);
  assert.equal(
    failureReplayDiagnostic(already, "owner-evidence")!.code,
    second,
  );
  const rejected = {};
  await assert.rejects(
    withFailureReplayReasonAsync(second, async () =>
      withFailureReplayReasonAsync(first, async () => {
        throw rejected;
      }),
    ),
    (cause) => cause === rejected,
  );
  assert.equal(
    failureReplayDiagnostic(rejected, "owner-evidence")!.code,
    first,
  );
  const value = {};
  assert.equal(
    withFailureReplayReason(first, () => value),
    value,
  );
  const promise = Promise.resolve(value);
  assert.equal(
    withFailureReplayReason(first, () => promise),
    promise,
  );
  assert.equal(await withFailureReplayReasonAsync(first, () => promise), value);
});
test("branding never traps proxies, revoked proxies, accessors, causes or coercions", () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw new Error("private poison");
  };
  const poison = new Proxy(
    {},
    {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const accessors = Object.defineProperties(
    {},
    Object.fromEntries(
      ["message", "cause", "stack", "code", "name", "toString"].map((key) => [
        key,
        { get: trap },
      ]),
    ),
  );
  for (const error of [poison, revoked.proxy, accessors]) {
    assert.equal(
      failureReplayDiagnostic(error, "owner-evidence")!.code,
      "replay-owner-evidence",
    );
    assert.equal(failureReplayFailure(error, first), error);
    assert.equal(failureReplayDiagnostic(error, "owner-evidence")!.code, first);
    assert.equal(parseFailureReplayDiagnostics(error), null);
  }
  assert.equal(reads, 0);
});
for (const value of [
  undefined,
  null,
  0,
  true,
  "private-secret",
  Symbol("private-secret"),
  1n,
])
  test("primitive thrown value remains unchanged " + typeof value, () => {
    assert.equal(failureReplayFailure(value, first), value);
    assert.equal(
      caught(() =>
        withFailureReplayReason(first, () => {
          throw value;
        }),
      ),
      value,
    );
    assert.equal(
      failureReplayDiagnostic(value, "owner-evidence")!.code,
      "replay-owner-evidence",
    );
  });
test("forged error properties and unsupported codes cannot forge private branding", () => {
  const forged = {
    message: "[owner-proof-reason:" + OWNER_PROOF_REASON_CODES[0] + "]",
    code: first,
    cause: failureReplayFailure({}, first),
    family: "failure-replay",
  };
  assert.equal(
    failureReplayDiagnostic(forged, "owner-evidence")!.code,
    "replay-owner-evidence",
  );
  failureReplayFailure(forged, "private/secret" as any);
  failureReplayFailure(forged, {
    toString() {
      throw 0;
    },
  } as any);
  assert.equal(
    failureReplayDiagnostic(forged, "owner-evidence")!.code,
    "replay-owner-evidence",
  );
  assert.equal(failureReplayDiagnostic(forged, "private/secret" as any), null);
});
for (const [name, value] of [
  ["unknown code", [diagnostic("unknown" as any)]],
  ["unknown family", [{ ...diagnostic(), family: "raw-error" }]],
  ["unknown stage", [diagnostic(first, "private path")]],
  ["wrong family", [{ ...diagnostic(), family: "owner-proof" }]],
  ["duplicate", [diagnostic(), diagnostic()]],
  ["conflicting stage", [diagnostic(), diagnostic(second)]],
  [
    "overflow",
    Array.from({ length: FAILURE_REPLAY_DIAGNOSTIC_LIMIT + 1 }, () =>
      diagnostic(),
    ),
  ],
  ["oversized code", [{ ...diagnostic(), code: "x".repeat(65536) }]],
  ["sparse array", new Array(1)],
  ["extra array field", Object.assign([diagnostic()], { extra: "secret" })],
  ["extra row field", [{ ...diagnostic(), message: "secret" }]],
  ["null prototype", [Object.assign(Object.create(null), diagnostic())]],
  ["symbol field", [{ ...diagnostic(), [Symbol("secret")]: 0 }]],
  ["nonarray", { 0: diagnostic(), length: 1 }],
  ["primitive", "secret"],
] as const)
  test("public parser rejects " + name, () =>
    assert.equal(parseFailureReplayDiagnostics(value), null),
  );
test("public parser refuses proxy/accessor input without invoking it", () => {
  let reads = 0;
  const trap = () => {
    reads++;
    throw 0;
  };
  const row = Object.defineProperty(diagnostic(), "code", { get: trap });
  const array = Object.defineProperty([diagnostic()], "0", { get: trap });
  const poison = new Proxy([diagnostic()], {
    get: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
  });
  const poisonRow = new Proxy(diagnostic(), {
    get: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
  });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  for (const input of [[row], array, poison, [poisonRow], revoked.proxy])
    assert.equal(parseFailureReplayDiagnostics(input), null);
  assert.equal(reads, 0);
});
test("projection publishes only independent fixed failure codes and cannot satisfy success", () => {
  const fresh = [diagnostic()];
  assert.deepEqual(
    projectFailureReplayDiagnostics(undefined, fresh, "failed"),
    fresh,
  );
  assert.deepEqual(
    projectFailureReplayDiagnostics(fresh, fresh, "failed"),
    fresh,
  );
  for (const status of [
    "passed",
    "missing",
    "setup-failed",
    true,
    {
      toString() {
        throw 0;
      },
    },
  ])
    assert.deepEqual(projectFailureReplayDiagnostics(fresh, fresh, status), []);
  assert.deepEqual(
    projectFailureReplayDiagnostics(
      fresh,
      [{ ...diagnostic(), code: "secret" }],
      "failed",
    ),
    [],
  );
  for (const claimed of [
    [diagnostic(second)],
    [diagnostic(), diagnostic()],
    [{ ...diagnostic(), message: "secret" }],
    new Proxy([], {
      get() {
        throw 0;
      },
    }),
  ]) {
    const projected = projectFailureReplayDiagnostics(claimed, fresh, "failed");
    assert.deepEqual(projected, [
      ...fresh,
      {
        stage: "diagnostic-cross-check",
        family: "failure-replay",
        code: "replay-diagnostic-cross-check",
      },
    ]);
    assert.ok(!JSON.stringify(projected).includes("secret"));
    assert.ok(Object.isFrozen(projected));
  }
});
test("real nested replay oracles retain specific source-bound reason families", () => {
  for (const [action, file] of [
    [() => failurePhase("invalid"), "failure-variants.ts"],
    [
      () => validateFailurePrivateEvidence(null, {}),
      "failure-postgres-policy.ts",
    ],
    [
      () => assertFailureAuthLifecycle(null as any),
      "failure-lifecycle-assertions.ts",
    ],
    [
      () => validateFailureTestEvidence({}, "/synthetic", "uninstrumented"),
      "failure-test-evidence.ts",
    ],
    [
      () =>
        validateFailureReceiptDirectory("/synthetic/absent-diagnostic-fixture"),
      "failure-evidence.ts",
    ],
  ] as const) {
    const error = caught(action);
    const code = failureReplayDiagnostic(error, "owner-evidence")!.code;
    const row = FAILURE_REPLAY_REASON_REGISTRY.find(
      (row) => row.code === code,
    )!;
    assert.ok(row);
    assert.ok(row.file.endsWith("/" + file));
    assert.ok(
      !JSON.stringify(
        failureReplayDiagnostic(error, "owner-evidence"),
      ).includes("synthetic"),
    );
    failureReplayFailure(error, second);
    assert.equal(failureReplayDiagnostic(error, "owner-evidence")!.code, code);
  }
});
