// Pure receipt replay only. Synthetic snapshots do not qualify native behavior.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFailureSupplementalSourceMaps,
  validateFailurePrivateEvidence,
} from "./failure-postgres-private.ts";
import {
  FAILURE_HYPERDRIVES,
  FAILURE_CHAIN_QUERY,
} from "./failure-postgres-policy.ts";
import {
  POSTGRES_OWNER,
  QUEUE_HYPERDRIVES,
  QUEUE_EXTERNAL_SERVICE,
  sha256,
} from "./postgres-owner-fixture.ts";
import { OWNER_SCENARIOS } from "./owner-resource-policy.ts";
import { validateOwnerNativeEvents } from "./owner-native-evidence.ts";
import { failureReplayDiagnostic } from "./failure-replay-diagnostics.ts";
const sha = "a".repeat(64);
const sourceNames = [
  "workers/data-api.ts",
  "src/pg-sql.ts",
  "src/strict-gzip-reader.ts",
  "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
  "src/read-store.ts",
  "src/lane-health-store.ts",
];
const sources = Object.fromEntries(
  sourceNames.map((name) => [name, `exact ${name}`]),
);
function maps(includeRead = true) {
  const names = sourceNames.filter(
    (name) => includeRead || name !== "src/read-store.ts",
  );
  return [
    {
      sources: names.map((name) => "../../" + name),
      sourcesContent: names.map((name) => sources[name]),
    },
  ];
}
test("supplemental maps require exact retained queue and lane-health sources", () => {
  assert.equal(assertFailureSupplementalSourceMaps(maps(), sources).length, 6);
  assert.equal(
    assertFailureSupplementalSourceMaps(maps(false), sources).find(
      (row) => row.source === "src/read-store.ts",
    )!.associations,
    0,
  );
});
for (const name of sourceNames.filter((name) => name !== "src/read-store.ts"))
  test(`missing required map source refuses ${name}`, () => {
    const fixture = maps();
    const index = fixture[0]!.sources.indexOf("../../" + name);
    fixture[0]!.sources.splice(index, 1);
    fixture[0]!.sourcesContent.splice(index, 1);
    assert.throws(() => assertFailureSupplementalSourceMaps(fixture, sources));
  });
test("maps reject byte drift, duplicate identities, suffix collision and unmatched content lengths", () => {
  for (const edit of [
    (m: any) => (m[0].sourcesContent[0] += "changed"),
    (m: any) => {
      m[0].sources.push(m[0].sources[0]);
      m[0].sourcesContent.push(m[0].sourcesContent[0]);
    },
    (m: any) => (m[0].sources[1] = "../../bogus-src/pg-sql.ts"),
    (m: any) => m[0].sourcesContent.pop(),
    (m: any) =>
      (m[0].sourcesContent[sourceNames.indexOf("src/read-store.ts")] =
        "changed optional bytes"),
  ]) {
    const fixture = maps();
    edit(fixture);
    assert.throws(() => assertFailureSupplementalSourceMaps(fixture, sources));
  }
});
function lifecycle(
  scenario: string,
  names: string[][],
  rejected = false,
  unfixed = false,
): any {
  const query = scenario === "query-cancellation";
  const operations = [
    {
      method: "connect",
      call: 1,
      settlement: 2,
      status: rejected ? "rejected" : "fulfilled",
      sqlstate: rejected ? "28P01" : null,
      cancellationCause: null,
      querySha256: null,
      backendPid: 61,
    },
  ];
  if (!rejected)
    operations.push({
      method: "query",
      call: 3,
      settlement: 4,
      status: query ? "rejected" : "fulfilled",
      sqlstate: query ? "57014" : null,
      cancellationCause: query ? ("user-request" as any) : null,
      querySha256: query ? (sha256(FAILURE_CHAIN_QUERY) as any) : (sha as any),
      backendPid: 61,
    });
  if (!unfixed) {
    const call = rejected ? 3 : 5;
    operations.push({
      method: "end",
      call,
      settlement: call + 1,
      status: "fulfilled",
      sqlstate: null,
      cancellationCause: null,
      querySha256: null,
      backendPid: 61,
    });
  }
  const snapshot: any = {
    kind: "supplemental-source-bound-lifecycle-v1",
    scenario,
    dispatches: names.map((ids, index) => ({
      ordinal: index + 1,
      finished: true,
      messages: ids.map((id) => ({
        id,
        wireSha256: sha,
        writerCalls: id === "failure-decoder" ? 0 : 1,
      })),
    })),
    clients: [
      {
        id: 1,
        helper: "createPgSql",
        messageId: null,
        dispatch: null,
        operations,
        endEvents: unfixed ? 0 : 1,
        streamCloseEvents: unfixed ? 0 : 1,
        clientEnded: !unfixed,
        streamDestroyed: false,
      },
    ],
    readers: [],
    violations: [],
    sequence: 20,
  };
  if (scenario === "decoder-refusal") {
    const before = {
      submitted: 80,
      consumed: 30,
      produced: 79_393_025,
      drained: 79_393_025,
      writes: 1,
      reads: 1,
      ends: 0,
      destroys: 0,
      queued: 0,
      destroyed: false,
    };
    const after = { ...before, destroys: 1, destroyed: true };
    snapshot.readers = [
      {
        id: 1,
        dispatch: 1,
        messageId: "failure-decoder",
        wireSha256: sha,
        wireBytes: 100,
        headerBytes: 10,
        nextCalls: 1,
        pendingNext: 0,
        nextSettled: 1,
        nextDone: 0,
        nextRejected: 0,
        closes: 1,
        nativeEnds: 0,
        cancelCalls: 1,
        returnCalls: 0,
        cancel: { sequence: 7, kind: "cancel", pendingNext: 0, before, after },
        current: after,
        advancementsAfterCancel: 0,
      },
    ];
  }
  return snapshot;
}
function pair(phase = "uninstrumented"): { safe: any; private: any } {
  let runtimeId = 100;
  const runtime = (scenario: string, wrong = false, snapshots: any[] = []) => {
    const pid = ++runtimeId,
      isolate = pid.toString(16),
      phases =
        scenario === "query-cancellation"
          ? ["baseline", "overlap", "drained"]
          : ["baseline", "drained"];
    const observation = {
      hostPid: 5,
      runtimePid: pid,
      runtimeStartTicks: String(pid),
      runtimeExecutablePath: "/tmp/pinned/workerd",
      runtimeVersion: "1.20260730.1",
      runtimeSha256: sha,
      owner: OWNER_SCENARIOS.queue.worker,
      isolateId: isolate,
      runtimeRestarts: 0,
      samples: phases.map((phase, index) => ({
        atMs: index + 1,
        phase,
        isolateId: isolate,
        heapUsed: 1,
        heapTotal: 2,
        backingStorage: null,
        embedderHeap: null,
        nativeExternal: null,
        workerdRss: 1,
        workerdHwm: 2,
        hostRss: 1,
        hostHwm: 2,
        postgresRss: null,
      })),
      sampleErrors: 0,
      missedSamples: 0,
      maximumGapMs: 1,
      sampling: "explicit-phase-checkpoints",
      postgresMemory: "not-observed",
    };
    return {
      safe: {
        mappingSha256: sha256(
          JSON.stringify(wrong ? FAILURE_HYPERDRIVES : QUEUE_HYPERDRIVES),
        ),
        serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
        isolateSha256: sha256(isolate),
        runtimeSha256: sha,
        guardedNativeLaunches: 1,
        observedNativeExits: 1,
        restarts: 0,
        blockedOutbound: 0,
        pending: 0,
        remainingWriterSessions: 0,
        stableZeroSamples: 2,
      },
      private: {
        observation,
        lifecycleSnapshots: phase === "uninstrumented" ? [] : snapshots,
        ...(phase === "unfixed-instrumented"
          ? {
              postExitDrain: {
                boundary: "after-observed-native-exit",
                remainingWriterSessions: 0,
                stableZeroSamples: 2,
              },
            }
          : {}),
      },
    };
  };
  const negative = phase === "unfixed-instrumented";
  const plans = negative
    ? [
        {
          scenario: "auth-unfixed-control",
          bodies: 1,
          partial: [0, 0, 0, 0],
          final: [0, 0, 0, 0],
          replay: "no-replay",
          dispositions: [{ ack: [], retry: ["failure-auth-unfixed"] }],
          runtimes: [
            runtime("auth-unfixed-control", true, [
              {
                checkpoint: "auth-unfixed-control",
                snapshot: lifecycle(
                  "auth-rejection",
                  [["failure-auth-unfixed"]],
                  true,
                  true,
                ),
              },
            ]),
          ],
        },
      ]
    : [
        {
          scenario: "auth-rejection",
          bodies: 2,
          partial: [0, 0, 0, 0],
          final: [1, 1, 1, 1],
          replay: "separate-valid-runtime",
          dispositions: [
            { ack: [], retry: ["failure-auth"] },
            { ack: ["control-auth"], retry: [] },
          ],
          runtimes: [
            runtime("auth-rejection", true, [
              {
                checkpoint: "auth-rejection",
                snapshot: lifecycle("auth-rejection", [["failure-auth"]], true),
              },
            ]),
            runtime("auth-rejection", false, [
              {
                checkpoint: "auth-valid-control",
                snapshot: lifecycle("auth-rejection", [["control-auth"]]),
              },
            ]),
          ],
        },
        {
          scenario: "query-cancellation",
          bodies: 2,
          partial: [1, 2, 1, 2],
          final: [2, 2, 2, 2],
          replay: "byte-identical-same-isolate",
          dispositions: [
            { ack: ["neighbor-query"], retry: ["failure-query"] },
            { ack: ["failure-query"], retry: [] },
          ],
          runtimes: [
            runtime("query-cancellation", false, [
              {
                checkpoint: "query-failure",
                snapshot: lifecycle("query-cancellation", [
                  ["failure-query", "neighbor-query"],
                ]),
              },
              {
                checkpoint: "query-replay",
                snapshot: lifecycle("query-cancellation", [
                  ["failure-query", "neighbor-query"],
                  ["failure-query"],
                ]),
              },
            ]),
          ],
        },
        {
          scenario: "decoder-refusal",
          bodies: 4,
          partial: [2, 2, 2, 2],
          final: [3, 3, 3, 3],
          replay: "same-isolate-subsequent-success",
          dispositions: [
            {
              ack: ["neighbor-before", "neighbor-after"],
              retry: ["failure-decoder"],
            },
            { ack: ["neighbor-later"], retry: [] },
          ],
          runtimes: [
            runtime("decoder-refusal", false, [
              {
                checkpoint: "decoder-refusal",
                snapshot: lifecycle("decoder-refusal", [
                  ["neighbor-before", "failure-decoder", "neighbor-after"],
                ]),
              },
              {
                checkpoint: "decoder-subsequent",
                snapshot: lifecycle("decoder-refusal", [
                  ["neighbor-before", "failure-decoder", "neighbor-after"],
                  ["neighbor-later"],
                ]),
              },
            ]),
          ],
        },
      ];
  const safe = {
    version: 1,
    phase,
    cases: plans.map((p) => ({
      scenario: p.scenario,
      phase,
      modules: [{ sha256: sha, bytes: 100 }],
      lifecycle: negative
        ? "negative-control-passed"
        : phase === "uninstrumented"
          ? "not-instrumented"
          : "supplemental-passed",
      productionMemory: "inconclusive",
      productionCpu: "inconclusive",
      bodySha256: Array(p.bodies).fill(sha),
      dispositions: p.dispositions,
      partialCounts: p.partial,
      partialSha256: sha,
      finalCounts: p.final,
      finalSha256: sha,
      runtimes: p.runtimes.map((r) => r.safe),
      replay: p.replay,
      ...(negative
        ? {
            negativeControl: {
              clients: 1,
              rejectedConnects: 1,
              observedEndCalls: 0,
              fixedLifecycleOracle: "rejected-missing-end",
            },
          }
        : {}),
    })),
  };
  const holder = {
    block: phase === "uninstrumented" ? 9_300_011 : 9_400_011,
    pid: 51,
    backendStart: "2026-10-20 10:00:00.123456+00",
    transactionId: "201",
  };
  const row = {
    pid: 61,
    database: POSTGRES_OWNER.database,
    username: POSTGRES_OWNER.writer,
    query: FAILURE_CHAIN_QUERY,
    backend_start: "2026-10-20 10:01:00.123456+00",
    query_start: "2026-10-20 10:02:00.123456+00",
    query_age_ms: 42,
    state: "active",
    wait_event_type: "Lock",
    wait_event: "transactionid",
    blockers: [holder.pid],
    transaction_id: holder.transactionId,
    blocker_pid: holder.pid,
    blocker_backend_start: holder.backendStart,
    blocker_database: POSTGRES_OWNER.database,
    blocker_username: POSTGRES_OWNER.admin,
    blocker_state: "idle in transaction",
  };
  const cancellation = {
    holder,
    initial: [row],
    revalidated: [{ ...row, query_age_ms: 43 }],
    signalResult: [
      {
        pid: row.pid,
        backend_start: row.backend_start,
        query_start: row.query_start,
        cancelled: true,
      },
    ],
  };
  return {
    safe,
    private: {
      version: 1,
      phase,
      cases: plans.map((p) => ({
        scenario: p.scenario,
        runtimes: p.runtimes.map((r) => r.private),
        cancellation: p.scenario === "query-cancellation" ? cancellation : null,
      })),
    },
  };
}
for (const phase of ["uninstrumented", "instrumented", "unfixed-instrumented"])
  test(`private replay accepts bounded closed ${phase} proof and returns only native observations`, () => {
    const fixture = pair(phase);
    const result = validateFailurePrivateEvidence(
      fixture.private,
      fixture.safe,
    );
    assert.equal(result.length, phase === "unfixed-instrumented" ? 1 : 4);
    assert.ok(
      result.every(
        (row) => !Object.hasOwn(row, "clients") && !Object.hasOwn(row, "query"),
      ),
    );
  });
for (const [name, edit] of [
  ["changed phase", (p: any) => (p.phase = "unfixed-instrumented")],
  ["wrong scenario", (p: any) => (p.cases[0].scenario = "query-cancellation")],
  ["missing runtime", (p: any) => p.cases[0].runtimes.pop()],
  [
    "hidden restart",
    (p: any) => (p.cases[0].runtimes[0].observation.runtimeRestarts = 1),
  ],
  [
    "other isolate",
    (p: any) => (p.cases[0].runtimes[0].observation.isolateId = "abcd"),
  ],
  [
    "missing checkpoint",
    (p: any) => p.cases[1].runtimes[0].lifecycleSnapshots.pop(),
  ],
  [
    "wrong checkpoint",
    (p: any) =>
      (p.cases[0].runtimes[0].lifecycleSnapshots[0].checkpoint =
        "auth-valid-control"),
  ],
  [
    "wire substitution",
    (p: any) =>
      (p.cases[0].runtimes[0].lifecycleSnapshots[0].snapshot.dispatches[0].messages[0].wireSha256 =
        "f".repeat(64)),
  ],
  [
    "query identity advance",
    (p: any) =>
      (p.cases[1].cancellation.revalidated[0].query_start =
        "2026-10-20 10:03:00.123456+00"),
  ],
  [
    "signal false",
    (p: any) => (p.cases[1].cancellation.signalResult[0].cancelled = false),
  ],
  [
    "missing error witness",
    (p: any) =>
      (p.cases[1].runtimes[0].lifecycleSnapshots[0].snapshot.clients[0].operations[1].status =
        "fulfilled"),
  ],
  [
    "natural timeout",
    (p: any) =>
      (p.cases[1].runtimes[0].lifecycleSnapshots[0].snapshot.clients[0].operations[1].cancellationCause =
        "statement-timeout"),
  ],
  [
    "decoder writer crossed",
    (p: any) =>
      (p.cases[2].runtimes[0].lifecycleSnapshots[0].snapshot.dispatches[0].messages[1].writerCalls = 1),
  ],
  [
    "unsettled teardown",
    (p: any) =>
      (p.cases[0].runtimes[1].lifecycleSnapshots[0].snapshot.clients[0].operations[2].status =
        "pending"),
  ],
  [
    "raw unexpected field",
    (p: any) =>
      (p.cases[0].runtimes[0].lifecycleSnapshots[0].snapshot.password =
        "forbidden"),
  ],
] as const)
  test(`private replay rejects ${name}`, () => {
    const fixture = pair("instrumented");
    edit(fixture.private);
    assert.throws(() =>
      validateFailurePrivateEvidence(fixture.private, fixture.safe),
    );
  });

for (const [clientEnded, endEvents, streamCloseEvents] of [
  [false, 0, 0],
  [true, 0, 1],
  [true, 1, 1],
] as const)
  test(`negative replay preserves observed closure tuple ${clientEnded}/${endEvents}/${streamCloseEvents}`, () => {
    const fixture = pair("unfixed-instrumented");
    const client =
      fixture.private.cases[0].runtimes[0].lifecycleSnapshots[0].snapshot
        .clients[0];
    Object.assign(client, { clientEnded, endEvents, streamCloseEvents });
    const original = structuredClone(fixture);
    const observations = validateFailurePrivateEvidence(
      fixture.private,
      fixture.safe,
    );
    assert.equal(observations.length, 1);
    assert.deepEqual(fixture, original);
    assert.equal(Object.hasOwn(observations[0]!, "postExitDrain"), false);
    assert.equal(
      Object.hasOwn(fixture.safe.cases[0].runtimes[0], "postExitDrain"),
      false,
    );
  });

for (const [name, edit, code] of [
  ["missing marker", (r: any) => delete r.postExitDrain, "fpr-check-071"],
  [
    "undefined marker",
    (r: any) => (r.postExitDrain = undefined),
    "fpr-check-001",
  ],
  ["null marker", (r: any) => (r.postExitDrain = null), "fpr-check-001"],
  ["array marker", (r: any) => (r.postExitDrain = []), "fpr-check-001"],
  [
    "string marker",
    (r: any) => (r.postExitDrain = "after-observed-native-exit"),
    "fpr-check-001",
  ],
  [
    "wrong boundary",
    (r: any) => (r.postExitDrain.boundary = "before-disposal"),
    "fpr-check-072",
  ],
  [
    "wrong boundary type",
    (r: any) => (r.postExitDrain.boundary = 1),
    "fpr-check-072",
  ],
  [
    "missing boundary",
    (r: any) => delete r.postExitDrain.boundary,
    "fpr-check-003",
  ],
  [
    "missing writer count",
    (r: any) => delete r.postExitDrain.remainingWriterSessions,
    "fpr-check-003",
  ],
  [
    "missing sample count",
    (r: any) => delete r.postExitDrain.stableZeroSamples,
    "fpr-check-003",
  ],
  ["extra key", (r: any) => (r.postExitDrain.disposed = true), "fpr-check-003"],
  [
    "nonzero writers",
    (r: any) => (r.postExitDrain.remainingWriterSessions = 1),
    "fpr-check-073",
  ],
  [
    "negative writers",
    (r: any) => (r.postExitDrain.remainingWriterSessions = -1),
    "fpr-check-073",
  ],
  [
    "writer string",
    (r: any) => (r.postExitDrain.remainingWriterSessions = "0"),
    "fpr-check-073",
  ],
  [
    "writer boolean",
    (r: any) => (r.postExitDrain.remainingWriterSessions = false),
    "fpr-check-073",
  ],
  [
    "writer NaN",
    (r: any) => (r.postExitDrain.remainingWriterSessions = NaN),
    "fpr-check-073",
  ],
  [
    "only one zero sample",
    (r: any) => (r.postExitDrain.stableZeroSamples = 1),
    "fpr-check-074",
  ],
  [
    "extra zero sample",
    (r: any) => (r.postExitDrain.stableZeroSamples = 3),
    "fpr-check-074",
  ],
  [
    "sample string",
    (r: any) => (r.postExitDrain.stableZeroSamples = "2"),
    "fpr-check-074",
  ],
  [
    "sample boolean",
    (r: any) => (r.postExitDrain.stableZeroSamples = true),
    "fpr-check-074",
  ],
  [
    "sample NaN",
    (r: any) => (r.postExitDrain.stableZeroSamples = NaN),
    "fpr-check-074",
  ],
  [
    "inherited marker fields",
    (r: any) => (r.postExitDrain = Object.create(r.postExitDrain)),
    "fpr-check-002",
  ],
  [
    "non-enumerable marker field",
    (r: any) =>
      Object.defineProperty(r.postExitDrain, "boundary", { enumerable: false }),
    "fpr-check-004",
  ],
] as const)
  test(`negative replay rejects post-exit ${name}`, () => {
    const fixture = pair("unfixed-instrumented");
    edit(fixture.private.cases[0].runtimes[0]);
    assert.throws(
      () => validateFailurePrivateEvidence(fixture.private, fixture.safe),
      (error: unknown) => {
        assert.equal(
          failureReplayDiagnostic(error, "owner-evidence")!.code,
          code,
        );
        return true;
      },
    );
  });

test("negative replay rejects marker accessors without evaluating them", () => {
  for (const field of ["postExitDrain", "boundary"]) {
    const fixture = pair("unfixed-instrumented");
    const runtime = fixture.private.cases[0].runtimes[0];
    let reads = 0;
    Object.defineProperty(
      field === "postExitDrain" ? runtime : runtime.postExitDrain,
      field,
      {
        enumerable: true,
        get() {
          reads++;
          throw new Error("must not invoke marker accessor");
        },
      },
    );
    assert.throws(() =>
      validateFailurePrivateEvidence(fixture.private, fixture.safe),
    );
    assert.equal(reads, 0);
  }
});

for (const phase of ["uninstrumented", "instrumented"])
  test(`fixed ${phase} replay rejects even a valid or undefined post-exit marker`, () => {
    for (const marker of [
      pair("unfixed-instrumented").private.cases[0].runtimes[0].postExitDrain,
      undefined,
    ]) {
      const fixture = pair(phase);
      fixture.private.cases[0].runtimes[0].postExitDrain = marker;
      assert.throws(
        () => validateFailurePrivateEvidence(fixture.private, fixture.safe),
        (error: unknown) => {
          assert.equal(
            failureReplayDiagnostic(error, "owner-evidence")!.code,
            "fpr-check-071",
          );
          return true;
        },
      );
    }
  });

test("pre-disposal drain counts and drained resource sample cannot replace post-exit evidence", () => {
  const fixture = pair("unfixed-instrumented");
  const runtime = fixture.private.cases[0].runtimes[0];
  const publicRuntime = fixture.safe.cases[0].runtimes[0];
  assert.equal(publicRuntime.remainingWriterSessions, 0);
  assert.equal(publicRuntime.stableZeroSamples, 2);
  assert.equal(runtime.observation.samples.at(-1).phase, "drained");
  delete runtime.postExitDrain;
  assert.throws(() =>
    validateFailurePrivateEvidence(fixture.private, fixture.safe),
  );
  runtime.postExitDrain = {
    remainingWriterSessions: publicRuntime.remainingWriterSessions,
    stableZeroSamples: publicRuntime.stableZeroSamples,
  };
  assert.throws(() =>
    validateFailurePrivateEvidence(fixture.private, fixture.safe),
  );
});

for (const [name, edit] of [
  [
    "wrong native hash",
    (p: any) => (p.observation.runtimeSha256 = "b".repeat(64)),
  ],
  [
    "wrong native version",
    (p: any) => (p.observation.runtimeVersion = "1.0.0"),
  ],
  ["hidden restart", (p: any) => (p.observation.runtimeRestarts = 1)],
  ["wrong owner", (p: any) => (p.observation.owner = "another-worker")],
  [
    "wrong message",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.dispatches[0].messages[0].id =
        "failure-auth"),
  ],
  [
    "wrong body",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.dispatches[0].messages[0].wireSha256 =
        "b".repeat(64)),
  ],
  [
    "missing writer custody",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.dispatches[0].messages[0].writerCalls = 0),
  ],
  [
    "unfinished handler",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.dispatches[0].finished = false),
  ],
  [
    "wrong SQLSTATE",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].operations[0].sqlstate =
        "08006"),
  ],
  [
    "pending connect",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].operations[0].status =
        "pending"),
  ],
  [
    "query substitution",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].operations[0].method =
        "query"),
  ],
  [
    "end substitution",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].operations[0].method =
        "end"),
  ],
  [
    "duplicate close events",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].streamCloseEvents = 2),
  ],
  [
    "inconsistent closure tuple",
    (p: any) =>
      (p.lifecycleSnapshots[0].snapshot.clients[0].clientEnded = true),
  ],
] as const)
  test(`valid post-exit marker cannot excuse ${name}`, () => {
    const fixture = pair("unfixed-instrumented");
    edit(fixture.private.cases[0].runtimes[0]);
    assert.throws(() =>
      validateFailurePrivateEvidence(fixture.private, fixture.safe),
    );
  });

for (const [name, edit] of [
  ["missing native exit count", (r: any) => (r.observedNativeExits = 0)],
  ["nonzero pre-disposal writers", (r: any) => (r.remainingWriterSessions = 1)],
  ["insufficient pre-disposal samples", (r: any) => (r.stableZeroSamples = 1)],
] as const)
  test(`post-exit marker preserves public rejection of ${name}`, () => {
    const fixture = pair("unfixed-instrumented");
    edit(fixture.safe.cases[0].runtimes[0]);
    assert.throws(() =>
      validateFailurePrivateEvidence(fixture.private, fixture.safe),
    );
  });

test("correct post-exit schema does not substitute for independent guarded native exit validation", () => {
  const fixture = pair("unfixed-instrumented");
  const [identity] = validateFailurePrivateEvidence(
    fixture.private,
    fixture.safe,
  );
  assert.ok(identity);
  const pin = {
    path: identity.runtimeExecutablePath,
    sha256: identity.runtimeSha256,
    version: identity.runtimeVersion,
    packagePath:
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64",
  };
  const launch = {
    kind: "native-child",
    pid: identity.hostPid,
    threadId: 0,
    role: "workerd",
    childPid: identity.runtimePid,
    synchronous: false,
    launchId: `${identity.hostPid}:1`,
  };
  const events: any[] = [
    {
      kind: "guard-start",
      pid: identity.hostPid,
      threadId: 0,
      entry: "/synthetic/node_modules/vitest/dist/workers/forks.js",
    },
    launch,
    {
      ...launch,
      kind: "native-child-exit",
      observation: "exit-event",
      code: null,
      signal: "SIGKILL",
    },
  ];
  assert.equal(
    validateOwnerNativeEvents(events, identity, pin).observedNativeExits,
    1,
  );
  for (const edit of [
    (rows: any[]) => rows.pop(),
    (rows: any[]) => (rows[2].launchId = `${identity.hostPid}:2`),
    (rows: any[]) => (rows[2].childPid = identity.runtimePid + 1),
    (rows: any[]) => (rows[2].pid = identity.hostPid + 1),
    (rows: any[]) => (rows[2].observation = "resolved-promise"),
    (rows: any[]) => ([rows[1], rows[2]] = [rows[2], rows[1]]),
  ]) {
    const rows = structuredClone(events);
    edit(rows);
    assert.throws(() => validateOwnerNativeEvents(rows, identity, pin));
  }
  for (const field of ["path", "sha256", "version"])
    assert.throws(() =>
      validateOwnerNativeEvents(events, identity, { ...pin, [field]: "wrong" }),
    );
});
