// Observational evidence only. Public workerd does not enforce production
// isolate-memory or request-CPU limits. No number here can certify either.
import assert from "node:assert/strict";
import type { ExpectedOwnerIdentity } from "./owner-build-evidence.ts";

export const OWNER_SCENARIOS = {
  raw: {
    worker: "qualification-raw-owner",
    scenario: "paired-scheduled-25",
    ids: ["mainnet", "testnet"],
    units: 50,
    events: 1,
  },
  queue: {
    worker: "qualification-queue-owner",
    scenario: "two-events-ten-messages",
    ids: ["event-a", "event-b"],
    units: 80,
    events: 2,
  },
} as const;
export type Owner = keyof typeof OWNER_SCENARIOS;
export type Phase = "baseline" | "overlap" | "drained";
export interface OwnerSample {
  atMs: number;
  phase: Phase;
  isolateId: string;
  heapUsed: number;
  heapTotal: number;
  backingStorage: number | null;
  embedderHeap: number | null;
  nativeExternal: null;
  workerdRss: number;
  workerdHwm: number;
  hostRss: number;
  hostHwm: number;
  postgresRss: null;
}
export interface OwnerObservations {
  hostPid: number;
  runtimePid: number;
  runtimeStartTicks: string;
  runtimeExecutablePath: string;
  runtimeVersion: "1.20260730.1";
  runtimeSha256: string;
  owner: string;
  isolateId: string;
  runtimeRestarts: number;
  samples: OwnerSample[];
  sampleErrors: number;
  missedSamples: number;
  maximumGapMs: number;
  sampling: "explicit-phase-checkpoints";
  postgresMemory: "not-observed";
}
export interface OwnerProof {
  owner: Owner;
  scenario: string;
  baseCommit: string;
  primitiveSha256: string;
  modules: { sha256: string; bytes: number }[];
  nativeEvents: {
    kind: "scheduled" | "queue";
    completed: number;
    outcomesOk: number;
  };
  overlap: {
    ids: string[];
    arrivalsMs: number[];
    releaseMs: number;
    pendingAtRelease: number;
    settledBeforeRelease: number;
  };
  durable: { expected: number; verified: number; mismatches: number };
  cleanup: {
    pending: number;
    unexplainedSessions: number;
    runtimeDisposed: boolean;
  };
  observations: OwnerObservations;
  productionIsolateMemory: "inconclusive";
  productionCpu: "inconclusive";
  productionCpuBudgetMs: null;
  runtimeResourceLimitEnforced: false;
}
const HASH = /^[a-f0-9]{64}$/;
const ISOLATE = /^[a-f0-9]{1,64}$/i;
function natural(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  assert.ok(
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max,
  );
}
function finite(value: unknown, max = 600_000): asserts value is number {
  assert.ok(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max,
  );
}
export function publicOwnerProof(
  input: OwnerProof,
  expectedIdentity: ExpectedOwnerIdentity,
) {
  assert.ok(input && Object.hasOwn(OWNER_SCENARIOS, input.owner));
  const expected = OWNER_SCENARIOS[input.owner];
  assert.equal(input.scenario, expected.scenario);
  assert.equal(input.baseCommit, "6b8422966b1411dff6d7c486f4e9a549acecc761");
  assert.equal(
    input.primitiveSha256,
    "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec",
  );
  assert.ok(
    Array.isArray(input.modules) &&
      input.modules.length > 0 &&
      input.modules.length <= 256,
  );
  const modules = input.modules.map((row) => {
    assert.match(row.sha256, HASH);
    natural(row.bytes, 64 * 1024 * 1024);
    assert.ok(row.bytes > 0);
    return { sha256: row.sha256, bytes: row.bytes };
  });
  assert.equal(
    input.nativeEvents.kind,
    input.owner === "raw" ? "scheduled" : "queue",
  );
  assert.equal(input.nativeEvents.completed, expected.events);
  assert.equal(input.nativeEvents.outcomesOk, expected.events);
  assert.deepEqual([...input.overlap.ids].sort(), [...expected.ids].sort());
  assert.equal(input.overlap.arrivalsMs.length, 2);
  input.overlap.arrivalsMs.forEach((v) => finite(v));
  finite(input.overlap.releaseMs);
  assert.ok(input.overlap.arrivalsMs.every((v) => v < input.overlap.releaseMs));
  assert.equal(input.overlap.pendingAtRelease, 2);
  assert.equal(input.overlap.settledBeforeRelease, 0);
  assert.equal(input.durable.expected, expected.units);
  assert.equal(input.durable.verified, expected.units);
  assert.equal(input.durable.mismatches, 0);
  assert.equal(input.cleanup.pending, 0);
  assert.equal(input.cleanup.unexplainedSessions, 0);
  assert.equal(input.cleanup.runtimeDisposed, true);
  assert.deepEqual(modules, expectedIdentity.modules);
  const observation = input.observations;
  assert.equal(observation.runtimeSha256, expectedIdentity.runtimeSha256);
  assert.equal(observation.runtimeVersion, "1.20260730.1");
  assert.match(observation.runtimeSha256, HASH);
  assert.equal(observation.owner, expected.worker);
  assert.match(observation.isolateId, ISOLATE);
  assert.equal(observation.runtimeRestarts, 0);
  assert.equal(observation.sampleErrors, 0);
  assert.equal(observation.missedSamples, 0);
  assert.equal(observation.sampling, "explicit-phase-checkpoints");
  assert.equal(observation.postgresMemory, "not-observed");
  assert.equal(observation.samples.length, 3);
  let previous = -1,
    maximumGapMs = 0;
  const samples = observation.samples.map((sample, index) => {
    assert.equal(
      sample.phase,
      (["baseline", "overlap", "drained"] as const)[index],
    );
    finite(sample.atMs);
    assert.ok(sample.atMs > previous);
    if (index) maximumGapMs = Math.max(maximumGapMs, sample.atMs - previous);
    previous = sample.atMs;
    assert.equal(sample.isolateId, observation.isolateId);
    for (const number of [
      sample.heapUsed,
      sample.heapTotal,
      sample.workerdRss,
      sample.workerdHwm,
      sample.hostRss,
      sample.hostHwm,
    ])
      natural(number);
    assert.ok(
      sample.heapUsed <= sample.heapTotal &&
        sample.workerdRss > 0 &&
        sample.hostRss > 0,
    );
    for (const number of [sample.backingStorage, sample.embedderHeap])
      if (number !== null) natural(number);
    assert.equal(sample.nativeExternal, null);
    assert.equal(sample.postgresRss, null);
    return {
      atMs: sample.atMs,
      phase: sample.phase,
      heapUsed: sample.heapUsed,
      heapTotal: sample.heapTotal,
      backingStorage: sample.backingStorage,
      embedderHeap: sample.embedderHeap,
      nativeExternal: null,
      workerdRss: sample.workerdRss,
      workerdHwm: sample.workerdHwm,
      hostRss: sample.hostRss,
      hostHwm: sample.hostHwm,
      postgresRss: null,
    };
  });
  assert.equal(observation.maximumGapMs, maximumGapMs);
  assert.ok(
    observation.samples[0]!.atMs < Math.min(...input.overlap.arrivalsMs),
  );
  assert.ok(
    observation.samples[1]!.atMs >= Math.max(...input.overlap.arrivalsMs),
  );
  assert.ok(observation.samples[1]!.atMs < input.overlap.releaseMs);
  assert.ok(observation.samples[2]!.atMs > input.overlap.releaseMs);
  assert.equal(input.productionIsolateMemory, "inconclusive");
  assert.equal(input.productionCpu, "inconclusive");
  assert.equal(input.productionCpuBudgetMs, null);
  assert.equal(input.runtimeResourceLimitEnforced, false);
  return {
    schemaVersion: 1,
    owner: input.owner,
    scenario: expected.scenario,
    baseCommit: input.baseCommit,
    primitiveSha256: input.primitiveSha256,
    modules,
    scope: "minimal-positive-scenario-only",
    deferredFailureCancellationRedelivery: true,
    functional: "pass",
    nativeEventPath: "pass",
    requiredOverlap: "pass",
    custodyAndCleanup: "pass",
    observationsComplete: true,
    nativeEvents: {
      kind: input.nativeEvents.kind,
      completed: input.nativeEvents.completed,
    },
    overlap: {
      kind:
        input.owner === "raw"
          ? "host-rpc-responses"
          : "actual-pg-writer-operations",
      writerOverlapEstablished: input.owner === "queue",
      participants: 2,
      arrivalsMs: [...input.overlap.arrivalsMs],
      releaseMs: input.overlap.releaseMs,
      pendingAtRelease: 2,
    },
    durable: { verified: expected.units },
    observations: {
      runtimeVersion: observation.runtimeVersion,
      runtimeSha256: observation.runtimeSha256,
      owner: expected.worker,
      sameIsolate: true,
      runtimeRestarts: 0,
      samples,
      maximumGapMs,
      sampleErrors: 0,
      missedSamples: 0,
      sampling: observation.sampling,
      baselineKind:
        input.owner === "raw"
          ? "scheduled-no-work-warmed-api"
          : "native-module-startup-before-first-queue-event",
      postgresMemory: "not-observed",
      synchronousPeaksMayBeMissed: true,
    },
    productionIsolateMemory: "inconclusive",
    productionCpu: "inconclusive",
    productionCpuBudgetMs: null,
    runtimeResourceLimitEnforced: false,
  };
}
