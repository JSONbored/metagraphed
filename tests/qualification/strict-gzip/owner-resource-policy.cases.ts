// Pure synthetic evidence. No sockets, service, Worker or native binary.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicOwnerProof,
  ownerInspectorListingURL,
  assertOwnerExternalImport,
  OWNER_SCENARIOS,
  type OwnerProof,
  type Owner,
} from "./owner-resource-policy.ts";
const runtime = "a".repeat(64),
  modules = [{ sha256: "b".repeat(64), bytes: 20 }];
const expected = { runtimeSha256: runtime, modules };
function fixture(owner: Owner = "queue"): OwnerProof {
  const spec = OWNER_SCENARIOS[owner];
  return {
    owner,
    scenario: spec.scenario,
    baseCommit: "6b8422966b1411dff6d7c486f4e9a549acecc761",
    primitiveSha256:
      "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec",
    modules: structuredClone(modules),
    nativeEvents: {
      kind: owner === "raw" ? "scheduled" : "queue",
      completed: spec.events,
      outcomesOk: spec.events,
    },
    overlap: {
      ids: [...spec.ids],
      arrivalsMs: [20, 21],
      releaseMs: 30,
      pendingAtRelease: 2,
      settledBeforeRelease: 0,
    },
    durable: { expected: spec.units, verified: spec.units, mismatches: 0 },
    cleanup: { pending: 0, unexplainedSessions: 0, runtimeDisposed: true },
    observations: {
      hostPid: 101,
      runtimePid: 202,
      runtimeStartTicks: "12345",
      runtimeExecutablePath: "/synthetic/workerd",
      runtimeVersion: "1.20260730.1",
      runtimeSha256: runtime,
      owner: spec.worker,
      isolateId: "ab123",
      runtimeRestarts: 0,
      samples: (["baseline", "overlap", "drained"] as const).map(
        (phase, index) => ({
          phase,
          atMs: [10, 25, 40][index]!,
          isolateId: "ab123",
          heapUsed: 10,
          heapTotal: 20,
          backingStorage: null,
          embedderHeap: null,
          nativeExternal: null,
          workerdRss: 40,
          workerdHwm: 50,
          hostRss: 60,
          hostHwm: 70,
          postgresRss: null,
        }),
      ),
      sampleErrors: 0,
      missedSamples: 0,
      maximumGapMs: 15,
      sampling: "explicit-phase-checkpoints",
      postgresMemory: "not-observed",
    },
    productionIsolateMemory: "inconclusive",
    productionCpu: "inconclusive",
    productionCpuBudgetMs: null,
    runtimeResourceLimitEnforced: false,
  };
}
for (const owner of ["raw", "queue"] as const)
  test(`valid ${owner} evidence stays scoped and inconclusive`, () => {
    const result = publicOwnerProof(fixture(owner), expected);
    assert.equal(result.productionIsolateMemory, "inconclusive");
    assert.equal(result.productionCpu, "inconclusive");
    assert.equal(result.scope, "minimal-positive-scenario-only");
    assert.equal(result.deferredFailureCancellationRedelivery, true);
  });
const negatives: Record<string, (row: OwnerProof) => void> = {
  "wrong base": (r) => (r.baseCommit = "0".repeat(40)),
  "wrong primitive": (r) => (r.primitiveSha256 = "0".repeat(64)),
  "wrong runtime source": (r) =>
    (r.observations.runtimeSha256 = "0".repeat(64)),
  "wrong module source": (r) => (r.modules[0]!.sha256 = "0".repeat(64)),
  "wrong module size": (r) => r.modules[0]!.bytes++,
  "missing modules": (r) => (r.modules = []),
  "foreign owner": (r) =>
    ((r as unknown as Record<string, unknown>).owner = "foreign"),
  "wrong scenario": (r) => (r.scenario = "sequential"),
  "wrong runtime version": (r) =>
    ((r.observations as unknown as Record<string, unknown>).runtimeVersion =
      "1.20260907.1"),
  "missing event": (r) => (r.nativeEvents.completed = 1),
  "failed event": (r) => (r.nativeEvents.outcomesOk = 1),
  "missing lane": (r) => r.overlap.ids.pop(),
  "duplicate event": (r) => (r.overlap.ids[1] = r.overlap.ids[0]!),
  "foreign participant": (r) => (r.overlap.ids[1] = "event-c"),
  "sequential execution": (r) => (r.overlap.settledBeforeRelease = 1),
  "single pending owner": (r) => (r.overlap.pendingAtRelease = 1),
  "missing arrival": (r) => r.overlap.arrivalsMs.pop(),
  "release before arrivals": (r) => (r.overlap.releaseMs = 20),
  "sample before arrival": (r) => (r.observations.samples[1]!.atMs = 19),
  "sample after release": (r) => (r.observations.samples[1]!.atMs = 31),
  "warm after arrival": (r) => (r.observations.samples[0]!.atMs = 22),
  "drain before release": (r) => (r.observations.samples[2]!.atMs = 29),
  "wrong durable count": (r) => (r.durable.verified = 79),
  "hidden durable mismatch": (r) => (r.durable.mismatches = 1),
  "pending work": (r) => (r.cleanup.pending = 1),
  "hidden connection leak": (r) => (r.cleanup.unexplainedSessions = 1),
  "missing runtime disposal": (r) => (r.cleanup.runtimeDisposed = false),
  "runtime restart": (r) => (r.observations.runtimeRestarts = 1),
  "replaced isolate": (r) => (r.observations.samples[1]!.isolateId = "dead"),
  "missing sample": (r) => r.observations.samples.pop(),
  "missing heap field": (r) =>
    delete (r.observations.samples[1] as unknown as Record<string, unknown>)
      .heapUsed,
  "infinite memory": (r) => (r.observations.samples[0]!.heapUsed = Infinity),
  "invalid heap relation": (r) => (r.observations.samples[0]!.heapUsed = 30),
  "invented native memory": (r) =>
    ((
      r.observations.samples[0] as unknown as Record<string, unknown>
    ).nativeExternal = 10),
  "invented database memory": (r) =>
    ((
      r.observations.samples[0] as unknown as Record<string, unknown>
    ).postgresRss = 10),
  "sample error": (r) => (r.observations.sampleErrors = 1),
  "missed sample": (r) => (r.observations.missedSamples = 1),
  "false gap": (r) => (r.observations.maximumGapMs = 1),
  "fabricated memory pass": (r) =>
    ((r as unknown as Record<string, unknown>).productionIsolateMemory =
      "pass"),
  "fabricated CPU pass": (r) =>
    ((r as unknown as Record<string, unknown>).productionCpu = "pass"),
  "invented CPU budget": (r) =>
    ((r as unknown as Record<string, unknown>).productionCpuBudgetMs = 30000),
  "invented enforcement": (r) =>
    ((r as unknown as Record<string, unknown>).runtimeResourceLimitEnforced =
      true),
};
for (const [name, change] of Object.entries(negatives))
  test(`rejects ${name}`, () => {
    const row = fixture();
    change(row);
    assert.throws(() => publicOwnerProof(row, expected));
  });
test("public output drops arbitrary titles paths URLs and query data", () => {
  const row = fixture() as OwnerProof & Record<string, unknown>;
  row.secret = "https://secret.invalid/token";
  row.queueDetails = { query: "raw SQL" };
  const text = JSON.stringify(publicOwnerProof(row, expected));
  assert.ok(
    !text.includes("secret.invalid") &&
      !text.includes("raw SQL") &&
      !text.includes("ab123"),
  );
});

test("derives only local HTTP discovery from the pinned websocket inspector origin", () => {
  const input = new URL("ws://127.0.0.1:41873/");
  assert.equal(
    ownerInspectorListingURL(input).href,
    "http://127.0.0.1:41873/json/list",
  );
  assert.equal(input.href, "ws://127.0.0.1:41873/");
});
for (const value of [
  "http://127.0.0.1:41873/",
  "wss://127.0.0.1:41873/",
  "ws://localhost:41873/",
  "ws://0.0.0.0:41873/",
  "ws://203.0.113.1:41873/",
  "ws://[::1]:41873/",
  "ws://127.0.0.1/",
  "ws://127.0.0.1:0/",
  "ws://127.0.0.1:41873/worker",
  "ws://user@127.0.0.1:41873/",
  "ws://127.0.0.1:41873/?secret",
  "ws://127.0.0.1:41873/#secret",
])
  test("rejects an unreviewed inspector origin shape", () => {
    assert.throws(() => ownerInspectorListingURL(new URL(value)));
  });
for (const value of ["node:fs", "node:stream/web", "cloudflare:sockets"])
  test("retains the existing builtin-only external-import allowance", () =>
    assertOwnerExternalImport(value));
for (const [value, label] of [
  ["pg-native", "pg-native"],
  ["bufferutil", "bufferutil"],
  ["utf-8-validate", "utf-8-validate"],
  ["https://secret.invalid/token", "other"],
  ["./module.wasm", "other"],
  ["arbitrary-package", "other"],
  [
    {
      toString() {
        throw new Error("never inspect");
      },
    },
    "other",
  ],
] as const)
  test("refuses other imports with only fixed diagnostics", () => {
    assert.throws(() => assertOwnerExternalImport(value), {
      message: `[owner-import-refused:${label}]`,
    });
  });
