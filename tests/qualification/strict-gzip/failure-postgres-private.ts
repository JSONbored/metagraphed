// Private native proof replay. Never publish this input or return raw lifecycle/SQL.
import assert from "node:assert/strict";
import path from "node:path";
import { sha256 } from "./postgres-owner-fixture.ts";
import {
  OWNER_SCENARIOS,
  type OwnerObservations,
} from "./owner-resource-policy.ts";
import {
  assertFailureReceipt,
  validateFailureWaiter,
  assertSameFailureWaiter,
  assertCancellationResult,
  type FailureCaseReceipt,
} from "./failure-postgres-policy.ts";
import type { FailureCancellationEvidence } from "./failure-postgres-fixture.ts";
import type { FailureLifecycleSnapshot } from "./failure-lifecycle-observer.ts";
import {
  assertFailureAuthLifecycle,
  assertFailureUnfixedAuthControl,
  assertFailureQueryLifecycle,
  assertFailureDecoderLifecycle,
  assertFailureSuccessfulLifecycle,
} from "./failure-lifecycle-assertions.ts";
export const FAILURE_PRIVATE_MAX_BYTES = 2 * 1024 * 1024;
export interface FailurePrivateRuntime {
  observation: OwnerObservations | null;
  lifecycleSnapshots: {
    checkpoint: string;
    snapshot: FailureLifecycleSnapshot;
  }[];
}
export interface FailurePrivateCase {
  scenario: FailureCaseReceipt["scenario"];
  runtimes: FailurePrivateRuntime[];
  cancellation: FailureCancellationEvidence | null;
}
export interface FailurePrivateReceipt {
  version: 1;
  phase: FailureCaseReceipt["phase"];
  cases: FailurePrivateCase[];
}
function keys(value: any, expected: readonly string[]) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected].sort());
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
  }
}
function finite(value: unknown) {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
}
function observation(
  value: OwnerObservations,
  expected: FailureCaseReceipt["runtimes"][number],
  scenario: string,
) {
  keys(value, [
    "hostPid",
    "runtimePid",
    "runtimeStartTicks",
    "runtimeExecutablePath",
    "runtimeVersion",
    "runtimeSha256",
    "owner",
    "isolateId",
    "runtimeRestarts",
    "samples",
    "sampleErrors",
    "missedSamples",
    "maximumGapMs",
    "sampling",
    "postgresMemory",
  ]);
  for (const pid of [value.hostPid, value.runtimePid])
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.notEqual(value.hostPid, value.runtimePid);
  assert.match(value.runtimeStartTicks, /^\d{1,30}$/);
  assert.ok(
    typeof value.runtimeExecutablePath === "string" &&
      value.runtimeExecutablePath.length <= 4096 &&
      path.isAbsolute(value.runtimeExecutablePath),
  );
  assert.equal(value.runtimeVersion, "1.20260730.1");
  assert.equal(value.runtimeSha256, expected.runtimeSha256);
  assert.equal(value.owner, OWNER_SCENARIOS.queue.worker);
  assert.match(value.isolateId, /^[a-f0-9]{1,64}$/i);
  assert.equal(sha256(value.isolateId), expected.isolateSha256);
  for (const number of [
    value.runtimeRestarts,
    value.sampleErrors,
    value.missedSamples,
  ])
    assert.equal(number, 0);
  finite(value.maximumGapMs);
  assert.equal(value.sampling, "explicit-phase-checkpoints");
  assert.equal(value.postgresMemory, "not-observed");
  assert.ok(Array.isArray(value.samples));
  assert.deepEqual(
    value.samples.map((row) => row.phase),
    scenario === "query-cancellation"
      ? ["baseline", "overlap", "drained"]
      : ["baseline", "drained"],
  );
  let previous = -1,
    maxGap = 0;
  for (const sample of value.samples) {
    keys(sample, [
      "atMs",
      "phase",
      "isolateId",
      "heapUsed",
      "heapTotal",
      "backingStorage",
      "embedderHeap",
      "nativeExternal",
      "workerdRss",
      "workerdHwm",
      "hostRss",
      "hostHwm",
      "postgresRss",
    ]);
    assert.equal(sample.isolateId, value.isolateId);
    finite(sample.atMs);
    assert.ok(sample.atMs > previous);
    if (previous >= 0) maxGap = Math.max(maxGap, sample.atMs - previous);
    previous = sample.atMs;
    for (const field of [
      "heapUsed",
      "heapTotal",
      "workerdRss",
      "workerdHwm",
      "hostRss",
      "hostHwm",
    ] as const)
      assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0);
    for (const field of ["backingStorage", "embedderHeap"] as const)
      assert.ok(
        sample[field] === null ||
          (Number.isSafeInteger(sample[field]) && sample[field]! >= 0),
      );
    assert.equal(sample.nativeExternal, null);
    assert.equal(sample.postgresRss, null);
  }
  assert.equal(value.maximumGapMs, maxGap);
}
function closedLifecycle(snapshot: FailureLifecycleSnapshot) {
  keys(snapshot, [
    "kind",
    "scenario",
    "dispatches",
    "clients",
    "readers",
    "violations",
    "sequence",
  ]);
  assert.ok(
    Array.isArray(snapshot.dispatches) && snapshot.dispatches.length <= 4,
  );
  assert.ok(Array.isArray(snapshot.clients) && snapshot.clients.length <= 128);
  assert.ok(Array.isArray(snapshot.readers) && snapshot.readers.length <= 40);
  assert.deepEqual(snapshot.violations, []);
  for (const dispatch of snapshot.dispatches) {
    keys(dispatch, ["ordinal", "finished", "messages"]);
    assert.ok(
      Array.isArray(dispatch.messages) && dispatch.messages.length <= 10,
    );
    for (const message of dispatch.messages)
      keys(message, ["id", "wireSha256", "writerCalls"]);
  }
  for (const client of snapshot.clients) {
    keys(client, [
      "id",
      "helper",
      "messageId",
      "dispatch",
      "operations",
      "endEvents",
      "streamCloseEvents",
      "clientEnded",
      "streamDestroyed",
    ]);
    assert.ok(
      Array.isArray(client.operations) && client.operations.length <= 32,
    );
    for (const operation of client.operations)
      keys(operation, [
        "method",
        "call",
        "settlement",
        "status",
        "sqlstate",
        "cancellationCause",
        "querySha256",
        "backendPid",
      ]);
  }
  const inflaterKeys = [
    "submitted",
    "consumed",
    "produced",
    "drained",
    "writes",
    "reads",
    "ends",
    "destroys",
    "queued",
    "destroyed",
  ];
  for (const reader of snapshot.readers) {
    keys(reader, [
      "id",
      "dispatch",
      "messageId",
      "wireSha256",
      "wireBytes",
      "headerBytes",
      "nextCalls",
      "pendingNext",
      "nextSettled",
      "nextDone",
      "nextRejected",
      "closes",
      "nativeEnds",
      "cancelCalls",
      "returnCalls",
      "cancel",
      "current",
      "advancementsAfterCancel",
    ]);
    keys(reader.current, inflaterKeys);
    if (reader.cancel) {
      keys(reader.cancel, [
        "sequence",
        "kind",
        "pendingNext",
        "before",
        "after",
      ]);
      keys(reader.cancel.before, inflaterKeys);
      if (reader.cancel.after) keys(reader.cancel.after, inflaterKeys);
    }
  }
}
const waiterKeys = [
  "pid",
  "database",
  "username",
  "query",
  "backend_start",
  "query_start",
  "query_age_ms",
  "state",
  "wait_event_type",
  "wait_event",
  "blockers",
  "transaction_id",
  "blocker_pid",
  "blocker_backend_start",
  "blocker_database",
  "blocker_username",
  "blocker_state",
];
/** Returns only verified native observations; parent independently matches guard events/bundle. */
export function validateFailurePrivateEvidence(
  input: unknown,
  publicInput: unknown,
): OwnerObservations[] {
  assertFailureReceipt(publicInput);
  const receipt = input as FailurePrivateReceipt;
  keys(receipt, ["version", "phase", "cases"]);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.phase, publicInput.phase);
  assert.ok(Array.isArray(receipt.cases));
  assert.equal(receipt.cases.length, publicInput.cases.length);
  const observations: OwnerObservations[] = [];
  for (const [index, item] of receipt.cases.entries()) {
    const safe: FailureCaseReceipt = publicInput.cases[index]!;
    keys(item, ["scenario", "runtimes", "cancellation"]);
    assert.equal(item.scenario, safe.scenario);
    assert.ok(Array.isArray(item.runtimes));
    assert.equal(item.runtimes.length, safe.runtimes.length);
    let target: { querySha256: string; backendPid: number } | undefined;
    if (item.scenario === "query-cancellation") {
      assert.ok(item.cancellation);
      const cancellation = item.cancellation;
      keys(cancellation, ["holder", "initial", "revalidated", "signalResult"]);
      keys(cancellation.holder, [
        "block",
        "pid",
        "backendStart",
        "transactionId",
      ]);
      for (const rows of [cancellation.initial, cancellation.revalidated]) {
        assert.ok(Array.isArray(rows));
        assert.equal(rows.length, 1);
        keys(rows[0], waiterKeys);
      }
      const first = validateFailureWaiter(
          cancellation.initial,
          cancellation.holder,
        ),
        current = validateFailureWaiter(
          cancellation.revalidated,
          cancellation.holder,
        );
      assertSameFailureWaiter(current, first);
      assertCancellationResult(cancellation.signalResult, first);
      assert.equal(
        cancellation.holder.block,
        receipt.phase === "uninstrumented" ? 9_300_011 : 9_400_011,
      );
      assert.ok(
        cancellation.revalidated[0]!.query_age_ms >=
          cancellation.initial[0]!.query_age_ms,
      );
      target = { querySha256: first.querySha256, backendPid: first.pid };
    } else assert.equal(item.cancellation, null);
    for (const [runtimeIndex, runtime] of item.runtimes.entries()) {
      keys(runtime, ["observation", "lifecycleSnapshots"]);
      assert.ok(runtime.observation);
      observation(
        runtime.observation,
        safe.runtimes[runtimeIndex]!,
        item.scenario,
      );
      observations.push(runtime.observation);
      assert.ok(Array.isArray(runtime.lifecycleSnapshots));
      const checkpoints =
        receipt.phase === "uninstrumented"
          ? []
          : item.scenario === "auth-rejection"
            ? [runtimeIndex === 0 ? "auth-rejection" : "auth-valid-control"]
            : item.scenario === "query-cancellation"
              ? ["query-failure", "query-replay"]
              : item.scenario === "decoder-refusal"
                ? ["decoder-refusal", "decoder-subsequent"]
                : ["auth-unfixed-control"];
      assert.deepEqual(
        runtime.lifecycleSnapshots.map((row) => row.checkpoint),
        checkpoints,
      );
      for (const [
        snapshotIndex,
        entry,
      ] of runtime.lifecycleSnapshots.entries()) {
        keys(entry, ["checkpoint", "snapshot"]);
        const snapshot = entry.snapshot;
        closedLifecycle(snapshot);
        const ids =
          item.scenario === "auth-rejection"
            ? [[runtimeIndex === 0 ? "failure-auth" : "control-auth"]]
            : item.scenario === "query-cancellation"
              ? [["failure-query", "neighbor-query"], ["failure-query"]].slice(
                  0,
                  snapshotIndex + 1,
                )
              : item.scenario === "decoder-refusal"
                ? [
                    ["neighbor-before", "failure-decoder", "neighbor-after"],
                    ["neighbor-later"],
                  ].slice(0, snapshotIndex + 1)
                : [["failure-auth-unfixed"]];
        assert.deepEqual(
          snapshot.dispatches.map((dispatch) =>
            dispatch.messages.map((message) => message.id),
          ),
          ids,
        );
        const names =
          item.scenario === "auth-rejection"
            ? ["failure-auth", "control-auth"]
            : item.scenario === "query-cancellation"
              ? ["failure-query", "neighbor-query"]
              : item.scenario === "decoder-refusal"
                ? [
                    "neighbor-before",
                    "failure-decoder",
                    "neighbor-after",
                    "neighbor-later",
                  ]
                : ["failure-auth-unfixed"];
        for (const dispatch of snapshot.dispatches)
          for (const message of dispatch.messages) {
            assert.equal(
              message.wireSha256,
              safe.bodySha256[names.indexOf(message.id)],
            );
            assert.equal(
              message.writerCalls,
              message.id === "failure-decoder" ? 0 : 1,
            );
          }
        if (entry.checkpoint === "auth-rejection")
          assertFailureAuthLifecycle(snapshot);
        else if (entry.checkpoint === "auth-valid-control")
          assertFailureSuccessfulLifecycle(snapshot, "auth-rejection");
        else if (entry.checkpoint === "auth-unfixed-control")
          assert.deepEqual(
            assertFailureUnfixedAuthControl(snapshot),
            safe.negativeControl,
          );
        else if (item.scenario === "query-cancellation") {
          assert.ok(target);
          assertFailureQueryLifecycle(snapshot, target);
        } else {
          assertFailureDecoderLifecycle(snapshot);
          assertFailureSuccessfulLifecycle(snapshot, "decoder-refusal");
        }
      }
    }
  }
  assert.equal(
    new Set(
      observations.map(
        (row) => `${row.hostPid}:${row.runtimePid}:${row.runtimeStartTicks}`,
      ),
    ).size,
    observations.length,
  );
  return observations;
}
/** Byte-exact source-map association, including optional transformed helpers if retained. */
export function assertFailureSupplementalSourceMaps(
  maps: unknown[],
  sources: Record<string, string>,
) {
  const required = [
    "workers/data-api.ts",
    "src/pg-sql.ts",
    "src/strict-gzip-reader.ts",
    "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
    "src/lane-health-store.ts",
  ];
  const optional = ["src/read-store.ts"];
  keys(sources, [...required, ...optional]);
  assert.ok(Array.isArray(maps) && maps.length >= 1 && maps.length <= 256);
  const counts = new Map(
    [...required, ...optional].map((source) => [source, 0]),
  );
  for (const raw of maps) {
    const map = raw as any;
    assert.ok(
      map && Array.isArray(map.sources) && Array.isArray(map.sourcesContent),
    );
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert.ok(map.sources.length <= 8192);
    const seen = new Set<string>();
    map.sources.forEach((source: unknown, index: number) => {
      assert.equal(typeof source, "string");
      const name = (source as string).replaceAll("\\", "/");
      assert.ok(!seen.has(name));
      seen.add(name);
      for (const logical of counts.keys())
        if (name === logical || name.endsWith("/" + logical)) {
          assert.equal(map.sourcesContent[index], sources[logical]);
          counts.set(logical, counts.get(logical)! + 1);
        }
    });
  }
  for (const logical of required)
    assert.ok(
      counts.get(logical)! >= 1,
      "Required supplemental source association missing",
    );
  return [...counts].map(([source, associations]) => ({
    source,
    associations,
  }));
}
