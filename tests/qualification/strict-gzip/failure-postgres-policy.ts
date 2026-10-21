// Pure policy for the additional synthetic failure fixture. No connection or service.
import assert from "node:assert/strict";
import {
  POSTGRES_OWNER,
  QUEUE_EXTERNAL_SERVICE,
  QUEUE_HYPERDRIVES,
  QUEUE_HYPERDRIVE_URL,
  sha256,
} from "./postgres-owner-fixture.ts";

export const FAILURE_WRONG_PASSWORD =
  "synthetic-deliberately-wrong-writer-only";
export const FAILURE_HYPERDRIVE_URL =
  "postgresql://qualification_writer:synthetic-deliberately-wrong-writer-only@127.0.0.1:55432/whole_owner_fixture?sslmode=disable";
export const FAILURE_HYPERDRIVES = Object.freeze({
  HYPERDRIVE: FAILURE_HYPERDRIVE_URL,
});
export type FailureAuth = "valid" | "wrong-password";
export function assertFailureHyperdriveMap(
  value: unknown,
  auth: FailureAuth,
): void {
  assert.ok(auth === "valid" || auth === "wrong-password");
  assert.ok(value && typeof value === "object");
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value), ["HYPERDRIVE"]);
  const descriptor = Object.getOwnPropertyDescriptor(value, "HYPERDRIVE");
  assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
  const wanted = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
  assert.deepEqual(value, wanted);
  const url = new URL(descriptor.value);
  assert.equal(url.href, wanted.HYPERDRIVE);
  assert.equal(url.hostname, POSTGRES_OWNER.host);
  assert.equal(url.port, String(POSTGRES_OWNER.port));
  assert.equal(url.username, POSTGRES_OWNER.writer);
  assert.equal(url.pathname, `/${POSTGRES_OWNER.database}`);
  assert.equal(url.search, "?sslmode=disable");
  assert.equal(url.hash, "");
  assert.notEqual(FAILURE_WRONG_PASSWORD, POSTGRES_OWNER.writerPassword);
}
export function failureBinding(auth: FailureAuth) {
  assertFailureHyperdriveMap(
    auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES,
    auth,
  );
  return [
    {
      name: "HYPERDRIVE",
      hyperdrive: {
        designator: { name: "hyperdrive:HYPERDRIVE" },
        database: POSTGRES_OWNER.database,
        user: POSTGRES_OWNER.writer,
        password:
          auth === "valid"
            ? POSTGRES_OWNER.writerPassword
            : FAILURE_WRONG_PASSWORD,
        scheme: "postgresql",
      },
    },
  ];
}
function assertParsed(options: any, auth: FailureAuth) {
  assert.ok(options && options.hyperdrives);
  assert.deepEqual(Reflect.ownKeys(options.hyperdrives), ["HYPERDRIVE"]);
  const descriptor = Object.getOwnPropertyDescriptor(
    options.hyperdrives,
    "HYPERDRIVE",
  );
  assert.ok(
    descriptor && "value" in descriptor && descriptor.value instanceof URL,
  );
  assertFailureHyperdriveMap({ HYPERDRIVE: descriptor.value.href }, auth);
}
export async function inspectFailureTransport(plugin: any, auth: FailureAuth) {
  const mapping = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
  assertFailureHyperdriveMap(mapping, auth);
  const options = plugin.options.parse({ hyperdrives: { ...mapping } });
  assertParsed(options, auth);
  assert.deepEqual(plugin.getBindings(options), failureBinding(auth));
  const services = await plugin.getServices({
    options,
    hyperdriveProxyController: {
      createProxyServer() {
        throw new Error("Failure fixture forbids Hyperdrive proxy/TLS");
      },
    },
  });
  assert.deepEqual(services, [QUEUE_EXTERNAL_SERVICE]);
  return {
    mappingSha256: sha256(JSON.stringify(mapping)),
    serviceSha256: sha256(JSON.stringify(services)),
  };
}
/** Observe actual native config generation, including password binding and TCP service.
 * Originals, receivers, arguments, and exact returned objects remain intact. */
export function observeFailureTransport(plugin: any, auth: FailureAuth) {
  const originalBindings = plugin.getBindings,
    originalServices = plugin.getServices;
  let bindingCalls = 0,
    serviceCalls = 0,
    serviceSettled = false,
    failed = false,
    restored = false;
  const bindings = function (this: unknown, ...args: any[]) {
    try {
      assert.equal(restored, false);
      assert.equal(bindingCalls++, 0);
      assertParsed(args[0], auth);
      const result = Reflect.apply(originalBindings, this, args);
      assert.deepEqual(result, failureBinding(auth));
      return result;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const services = function (this: unknown, ...args: any[]) {
    try {
      assert.equal(restored, false);
      assert.equal(serviceCalls++, 0);
      assertParsed(args[0]?.options, auth);
      const result: any = Reflect.apply(originalServices, this, args);
      // Observe without replacing the original return Promise/object.
      if (result && typeof result.then === "function") {
        result.then(
          (value: unknown) => {
            try {
              assert.deepEqual(value, [QUEUE_EXTERNAL_SERVICE]);
              serviceSettled = true;
            } catch {
              failed = true;
            }
          },
          () => {
            failed = true;
          },
        );
      } else {
        assert.deepEqual(result, [QUEUE_EXTERNAL_SERVICE]);
        serviceSettled = true;
      }
      return result;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  plugin.getBindings = bindings;
  plugin.getServices = services;
  return {
    assertObserved() {
      assert.equal(failed, false);
      assert.equal(serviceSettled, true);
      assert.equal(bindingCalls, 1);
      assert.equal(serviceCalls, 1);
      return {
        bindingCalls: 1,
        serviceCalls: 1,
        serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
      };
    },
    restore() {
      assert.equal(plugin.getBindings, bindings);
      assert.equal(plugin.getServices, services);
      plugin.getBindings = originalBindings;
      plugin.getServices = originalServices;
      restored = true;
    },
  };
}
export const FAILURE_CHAIN_QUERY =
  "INSERT INTO chain_detail_chain_events (block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (block_number, event_index) DO UPDATE SET pallet = EXCLUDED.pallet, method = EXCLUDED.method, args = EXCLUDED.args, phase = EXCLUDED.phase, extrinsic_index = EXCLUDED.extrinsic_index, observed_at = EXCLUDED.observed_at";
export interface FailureHolder {
  block: number;
  pid: number;
  backendStart: string;
  transactionId: string;
}
export interface FailureWaiter {
  pid: number;
  backendStart: string;
  queryStart: string;
  querySha256: string;
  holder: FailureHolder;
}
// Exact authenticated identity plus owned transaction lock, not pid alone.
export const FAILURE_CANCEL_MAX_QUERY_AGE_MS = 10_000;
export const FAILURE_WAIT_SQL = `
SELECT a.pid, a.datname AS database, a.usename AS username, a.query,
 a.backend_start::text AS backend_start, a.query_start::text AS query_start,
 (EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000)::double precision AS query_age_ms,
 a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers,
 w.transactionid::text AS transaction_id, h.pid AS blocker_pid,
 c.backend_start::text AS blocker_backend_start, c.datname AS blocker_database,
 c.usename AS blocker_username, c.state AS blocker_state
FROM pg_stat_activity a
JOIN pg_locks w ON w.pid = a.pid AND w.locktype = 'transactionid' AND w.mode = 'ShareLock' AND NOT w.granted
JOIN pg_locks h ON h.transactionid = w.transactionid AND h.locktype = 'transactionid' AND h.mode = 'ExclusiveLock' AND h.granted
JOIN pg_stat_activity c ON c.pid = h.pid
WHERE a.datname = $1 AND a.usename = $2 AND h.pid = $3
ORDER BY a.pid`;
function validIdentityText(value: unknown): asserts value is string {
  assert.equal(typeof value, "string");
  assert.ok((value as string).length >= 20 && (value as string).length <= 64);
  assert.ok(Number.isFinite(Date.parse(value as string)));
}
export function validateFailureWaiter(
  rows: Record<string, any>[],
  holder: FailureHolder,
): FailureWaiter {
  assert.ok(
    Number.isSafeInteger(holder.block) &&
      holder.block > 0 &&
      holder.block <= 2_147_483_647,
  );
  assert.ok(Number.isSafeInteger(holder.pid) && holder.pid > 0);
  assert.match(holder.transactionId, /^[1-9][0-9]{0,19}$/);
  validIdentityText(holder.backendStart);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.ok(
    Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== holder.pid,
  );
  assert.equal(row.database, POSTGRES_OWNER.database);
  assert.equal(row.username, POSTGRES_OWNER.writer);
  assert.equal(row.query, FAILURE_CHAIN_QUERY);
  validIdentityText(row.backend_start);
  validIdentityText(row.query_start);
  assert.ok(
    typeof row.query_age_ms === "number" &&
      Number.isFinite(row.query_age_ms) &&
      row.query_age_ms >= 0 &&
      row.query_age_ms < FAILURE_CANCEL_MAX_QUERY_AGE_MS,
  );
  assert.equal(row.state, "active");
  assert.equal(row.wait_event_type, "Lock");
  assert.equal(row.wait_event, "transactionid");
  assert.equal(row.transaction_id, holder.transactionId);
  assert.equal(row.blocker_pid, holder.pid);
  assert.equal(row.blocker_backend_start, holder.backendStart);
  assert.equal(row.blocker_database, POSTGRES_OWNER.database);
  assert.equal(row.blocker_username, POSTGRES_OWNER.admin);
  assert.equal(row.blocker_state, "idle in transaction");
  assert.deepEqual(row.blockers, [holder.pid]);
  return {
    pid: row.pid,
    backendStart: row.backend_start,
    queryStart: row.query_start,
    querySha256: sha256(row.query),
    holder: { ...holder },
  };
}
export function assertSameFailureWaiter(
  current: FailureWaiter,
  witnessed: FailureWaiter,
): void {
  assert.deepEqual(current, witnessed);
}
// Repeat every identity/lock predicate in the signal-bearing statement. A re-used
// PID, advanced query, released controller, unrelated lock or no-op returns no row.
export const FAILURE_CANCEL_SQL = `
SELECT a.pid, a.backend_start::text AS backend_start, a.query_start::text AS query_start,
 pg_cancel_backend(a.pid) AS cancelled
FROM pg_stat_activity a
JOIN pg_locks w ON w.pid = a.pid AND w.locktype = 'transactionid' AND w.mode = 'ShareLock' AND NOT w.granted
JOIN pg_locks h ON h.transactionid = w.transactionid AND h.locktype = 'transactionid' AND h.mode = 'ExclusiveLock' AND h.granted
JOIN pg_stat_activity c ON c.pid = h.pid
WHERE a.datname = $1 AND a.usename = $2 AND a.pid = $3
 AND a.backend_start::text = $4 AND a.query_start::text = $5 AND a.query = $6
 AND a.state = 'active' AND a.wait_event_type = 'Lock' AND a.wait_event = 'transactionid'
 AND a.query_start > clock_timestamp() - interval '10 seconds' AND a.query_start <= clock_timestamp()
 AND w.transactionid::text = $7 AND h.pid = $8 AND c.backend_start::text = $9
 AND c.datname = $1 AND c.usename = $10 AND c.state = 'idle in transaction'
 AND pg_blocking_pids(a.pid) = ARRAY[$8::integer]`;
export function cancelParameters(witness: FailureWaiter): unknown[] {
  return [
    POSTGRES_OWNER.database,
    POSTGRES_OWNER.writer,
    witness.pid,
    witness.backendStart,
    witness.queryStart,
    FAILURE_CHAIN_QUERY,
    witness.holder.transactionId,
    witness.holder.pid,
    witness.holder.backendStart,
    POSTGRES_OWNER.admin,
  ];
}
export function assertCancellationResult(
  rows: Record<string, any>[],
  witness: FailureWaiter,
): void {
  assert.deepEqual(rows, [
    {
      pid: witness.pid,
      backend_start: witness.backendStart,
      query_start: witness.queryStart,
      cancelled: true,
    },
  ]);
}
export function assertFailureDisposition(
  outcome: unknown,
  ackIds: string[],
  retryIds: string[],
) {
  assert.equal(
    new Set([...ackIds, ...retryIds]).size,
    ackIds.length + retryIds.length,
  );
  assert.deepEqual(outcome, {
    outcome: "ok",
    ackAll: false,
    retryBatch: { retry: false },
    explicitAcks: ackIds,
    retryMessages: retryIds.map((msgId) => ({ msgId })),
  });
}
export { QUEUE_HYPERDRIVE_URL };

export interface FailureCaseReceipt {
  scenario:
    | "auth-rejection"
    | "query-cancellation"
    | "decoder-refusal"
    | "auth-unfixed-control";
  phase: "uninstrumented" | "instrumented" | "unfixed-instrumented";
  modules: { sha256: string; bytes: number }[];
  lifecycle:
    "supplemental-passed" | "not-instrumented" | "negative-control-passed";
  negativeControl?: {
    clients: number;
    rejectedConnects: number;
    observedEndCalls: number;
    fixedLifecycleOracle: "rejected-missing-end";
  };
  productionMemory: "inconclusive";
  productionCpu: "inconclusive";
  bodySha256: string[];
  dispositions: { ack: string[]; retry: string[] }[];
  partialCounts: number[];
  partialSha256: string;
  finalCounts: number[];
  finalSha256: string;
  runtimes: {
    mappingSha256: string;
    serviceSha256: string;
    isolateSha256: string;
    runtimeSha256: string;
    guardedNativeLaunches: number;
    observedNativeExits: number;
    restarts: 0;
    blockedOutbound: 0;
    pending: 0;
    remainingWriterSessions: 0;
    stableZeroSamples: 2;
  }[];
  replay:
    | "separate-valid-runtime"
    | "byte-identical-same-isolate"
    | "same-isolate-subsequent-success"
    | "no-replay";
}
const FAILURE_CASE_ORDER = [
  "auth-rejection",
  "query-cancellation",
  "decoder-refusal",
] as const;
function exactKeys(value: any, keys: string[]) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
  }
}
function hash(value: unknown) {
  assert.equal(typeof value, "string");
  assert.match(value as string, /^[a-f0-9]{64}$/);
}
/** Closed receipt schema: local raw SQL, errors, rows and backend identities cannot pass. */
export function assertFailureReceipt(
  input: unknown,
): asserts input is {
  version: 1;
  phase: "uninstrumented" | "instrumented" | "unfixed-instrumented";
  cases: FailureCaseReceipt[];
} {
  const receipt = input as any;
  exactKeys(receipt, ["version", "phase", "cases"]);
  assert.equal(receipt.version, 1);
  assert.ok(
    receipt.phase === "uninstrumented" ||
      receipt.phase === "instrumented" ||
      receipt.phase === "unfixed-instrumented",
  );
  const negative = receipt.phase === "unfixed-instrumented";
  assert.ok(Array.isArray(receipt.cases));
  assert.equal(receipt.cases.length, negative ? 1 : 3);
  const plans = [
    {
      bodies: 2,
      partial: [0, 0, 0, 0],
      final: [1, 1, 1, 1],
      runtimes: 2,
      replay: "separate-valid-runtime",
      dispositions: [
        { ack: [], retry: ["failure-auth"] },
        { ack: ["control-auth"], retry: [] },
      ],
    },
    {
      bodies: 2,
      partial: [1, 2, 1, 2],
      final: [2, 2, 2, 2],
      runtimes: 1,
      replay: "byte-identical-same-isolate",
      dispositions: [
        { ack: ["neighbor-query"], retry: ["failure-query"] },
        { ack: ["failure-query"], retry: [] },
      ],
    },
    {
      bodies: 4,
      partial: [2, 2, 2, 2],
      final: [3, 3, 3, 3],
      runtimes: 1,
      replay: "same-isolate-subsequent-success",
      dispositions: [
        {
          ack: ["neighbor-before", "neighbor-after"],
          retry: ["failure-decoder"],
        },
        { ack: ["neighbor-later"], retry: [] },
      ],
    },
  ];
  if (negative)
    plans.splice(0, plans.length, {
      bodies: 1,
      partial: [0, 0, 0, 0],
      final: [0, 0, 0, 0],
      runtimes: 1,
      replay: "no-replay",
      dispositions: [{ ack: [], retry: ["failure-auth-unfixed"] }],
    });
  const allIsolates: string[] = [];
  receipt.cases.forEach((row: any, index: number) => {
    exactKeys(row, [
      "scenario",
      "phase",
      "modules",
      "lifecycle",
      "productionMemory",
      "productionCpu",
      "bodySha256",
      "dispositions",
      "partialCounts",
      "partialSha256",
      "finalCounts",
      "finalSha256",
      "runtimes",
      "replay",
      ...(negative ? ["negativeControl"] : []),
    ]);
    if (negative) {
      exactKeys(row.negativeControl, [
        "clients",
        "rejectedConnects",
        "observedEndCalls",
        "fixedLifecycleOracle",
      ]);
      assert.ok(
        Number.isSafeInteger(row.negativeControl.clients) &&
          row.negativeControl.clients >= 1 &&
          row.negativeControl.clients <= 128,
      );
      assert.equal(
        row.negativeControl.rejectedConnects,
        row.negativeControl.clients,
      );
      assert.equal(row.negativeControl.observedEndCalls, 0);
      assert.equal(
        row.negativeControl.fixedLifecycleOracle,
        "rejected-missing-end",
      );
    }
    const plan = plans[index]!;
    assert.equal(
      row.scenario,
      negative ? "auth-unfixed-control" : FAILURE_CASE_ORDER[index],
    );
    assert.equal(row.phase, receipt.phase);
    assert.equal(
      row.lifecycle,
      negative
        ? "negative-control-passed"
        : receipt.phase === "instrumented"
          ? "supplemental-passed"
          : "not-instrumented",
    );
    assert.equal(row.productionMemory, "inconclusive");
    assert.equal(row.productionCpu, "inconclusive");
    assert.ok(
      Array.isArray(row.modules) &&
        row.modules.length >= 1 &&
        row.modules.length <= 32,
    );
    for (const module of row.modules) {
      exactKeys(module, ["sha256", "bytes"]);
      hash(module.sha256);
      assert.ok(
        Number.isSafeInteger(module.bytes) &&
          module.bytes > 0 &&
          module.bytes <= 64 * 1024 * 1024,
      );
    }
    assert.ok(Array.isArray(row.bodySha256));
    assert.equal(row.bodySha256.length, plan.bodies);
    row.bodySha256.forEach(hash);
    assert.deepEqual(row.dispositions, plan.dispositions);
    assert.deepEqual(row.partialCounts, plan.partial);
    assert.deepEqual(row.finalCounts, plan.final);
    hash(row.partialSha256);
    hash(row.finalSha256);
    assert.equal(row.replay, plan.replay);
    assert.ok(Array.isArray(row.runtimes));
    assert.equal(row.runtimes.length, plan.runtimes);
    row.runtimes.forEach((runtime: any, runtimeIndex: number) => {
      exactKeys(runtime, [
        "mappingSha256",
        "serviceSha256",
        "isolateSha256",
        "runtimeSha256",
        "guardedNativeLaunches",
        "observedNativeExits",
        "restarts",
        "blockedOutbound",
        "pending",
        "remainingWriterSessions",
        "stableZeroSamples",
      ]);
      for (const key of [
        "mappingSha256",
        "serviceSha256",
        "isolateSha256",
        "runtimeSha256",
      ])
        hash(runtime[key]);
      const map =
        index === 0 && runtimeIndex === 0
          ? FAILURE_HYPERDRIVES
          : QUEUE_HYPERDRIVES;
      assert.equal(runtime.mappingSha256, sha256(JSON.stringify(map)));
      assert.equal(
        runtime.serviceSha256,
        sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
      );
      assert.equal(runtime.guardedNativeLaunches, 1);
      assert.equal(runtime.observedNativeExits, 1);
      for (const key of [
        "restarts",
        "blockedOutbound",
        "pending",
        "remainingWriterSessions",
      ])
        assert.equal(runtime[key], 0);
      assert.equal(runtime.stableZeroSamples, 2);
      allIsolates.push(runtime.isolateSha256);
    });
  });
  assert.equal(
    new Set(allIsolates).size,
    negative ? 1 : 4,
    "Require distinct owned runtimes; replay stays within the selected runtime",
  );
}
