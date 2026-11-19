import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertQueueHyperdriveMap,
  QUEUE_FIRST_QUERY,
  QUEUE_HYPERDRIVES,
  QUEUE_HYPERDRIVE_URL,
  queueSchemaStatements,
  validateQueueWaiters,
} from "./postgres-owner-fixture.ts";

const holders = [
  { block: 1100001, pid: 51, transactionId: "201" },
  { block: 2200001, pid: 52, transactionId: "202" },
];
function waiting() {
  return holders.map((holder, index) => ({
    pid: 61 + index,
    query: QUEUE_FIRST_QUERY,
    state: "active",
    wait_event_type: "Lock",
    wait_event: "transactionid",
    transaction_id: holder.transactionId,
    blocker_pid: holder.pid,
    blockers: [holder.pid],
  }));
}

test("accepts only the complete literal numeric-loopback Hyperdrive map", () => {
  assert.doesNotThrow(() => assertQueueHyperdriveMap(QUEUE_HYPERDRIVES));
  for (const url of [
    QUEUE_HYPERDRIVE_URL.replace("127.0.0.1", "localhost"),
    QUEUE_HYPERDRIVE_URL.replace("127.0.0.1", "127.0.0.2"),
    QUEUE_HYPERDRIVE_URL.replace(":55432", ":5432"),
    QUEUE_HYPERDRIVE_URL.replace("postgresql:", "postgres:"),
    QUEUE_HYPERDRIVE_URL.replace("disable", "require"),
    QUEUE_HYPERDRIVE_URL.replace("?sslmode=disable", ""),
    QUEUE_HYPERDRIVE_URL + "&sslmode=disable",
    QUEUE_HYPERDRIVE_URL + "&application_name=extra",
    QUEUE_HYPERDRIVE_URL + "#extra",
  ])
    assert.throws(() => assertQueueHyperdriveMap({ HYPERDRIVE: url }));
  assert.throws(() =>
    assertQueueHyperdriveMap({
      ...QUEUE_HYPERDRIVES,
      SECOND: QUEUE_HYPERDRIVE_URL,
    }),
  );
  const hidden = { ...QUEUE_HYPERDRIVES };
  Object.defineProperty(hidden, "SECOND", { value: QUEUE_HYPERDRIVE_URL });
  assert.throws(() => assertQueueHyperdriveMap(hidden));
  assert.throws(() =>
    assertQueueHyperdriveMap({
      get HYPERDRIVE() {
        throw new Error("Getter must not be read");
      },
    }),
  );
});

test("accepts two distinct first upserts blocked on their distinct owned key transactions", () => {
  const evidence = validateQueueWaiters(waiting(), holders);
  assert.deepEqual(
    evidence.map((row) => row.owner),
    ["event-a", "event-b"],
  );
  assert.deepEqual(
    evidence.map((row) => row.blockNumber),
    [1100001, 2200001],
  );
  assert.deepEqual(
    evidence.map((row) => row.pid),
    [61, 62],
  );
  assert.ok(evidence.every((row) => /^[a-f0-9]{64}$/.test(row.querySha256)));
});

test("missing, duplicate, extra and sequential waiters cannot open the barrier", () => {
  assert.throws(() => validateQueueWaiters([], holders));
  assert.throws(() => validateQueueWaiters(waiting().slice(0, 1), holders));
  assert.throws(() =>
    validateQueueWaiters([waiting()[0]!, waiting()[0]!], holders),
  );
  assert.throws(() =>
    validateQueueWaiters([...waiting(), waiting()[0]!], holders),
  );
  const sequential = waiting();
  sequential[0]!.state = "idle";
  assert.throws(() => validateQueueWaiters(sequential, holders));
});

test("wrong query, key transaction, blocker or wait kind is rejected", () => {
  for (const patch of [
    { query: "INSERT INTO lane_health (lane) VALUES ($1)" },
    { query: QUEUE_FIRST_QUERY + " -- changed writer" },
    { transaction_id: "999" },
    { blocker_pid: 999 },
    { blockers: [51, 52] },
    { wait_event_type: "Client" },
    { wait_event: "tuple" },
    { pid: 51 },
    { pid: 62 },
  ]) {
    const rows = waiting();
    Object.assign(rows[0]!, patch);
    assert.throws(() => validateQueueWaiters(rows, holders));
  }
  assert.throws(() =>
    validateQueueWaiters(waiting(), [holders[0]!, holders[0]!]),
  );
  assert.throws(() =>
    validateQueueWaiters(waiting(), [
      holders[0]!,
      { ...holders[1]!, block: holders[0]!.block },
    ]),
  );
});

test("schema drift cannot produce a source-owned fixture", () => {
  assert.throws(() =>
    queueSchemaStatements(
      "CREATE TABLE public.chain_detail_extrinsics (block_number integer);",
    ),
  );
});

test("actual service observer forwards exact this/context/result and restores", async () => {
  const {
    observeActualQueueTransport,
    QUEUE_HYPERDRIVE_URL,
    QUEUE_EXTERNAL_SERVICE,
  } = await import("./postgres-owner-fixture.ts");
  const context = {
    options: { hyperdrives: { HYPERDRIVE: new URL(QUEUE_HYPERDRIVE_URL) } },
  };
  const result = [QUEUE_EXTERNAL_SERVICE];
  let received: unknown;
  const plugin = {
    async getServices(this: unknown, arg: unknown) {
      assert.equal(this, plugin);
      received = arg;
      return result;
    },
  };
  const original = plugin.getServices;
  const observer = observeActualQueueTransport(plugin);
  assert.equal(await plugin.getServices(context), result);
  assert.equal(received, context);
  assert.equal(observer.assertObserved().calls, 1);
  observer.restore();
  assert.equal(plugin.getServices, original);
});
test("actual service observer refuses external native mapping and latches", async () => {
  const { observeActualQueueTransport, QUEUE_HYPERDRIVE_URL } =
    await import("./postgres-owner-fixture.ts");
  const plugin = {
    async getServices(_context?: unknown) {
      return [
        {
          name: "hyperdrive:HYPERDRIVE",
          external: { address: "203.0.113.1:5432", tcp: {} },
        },
      ];
    },
  };
  const observer = observeActualQueueTransport(plugin);
  await assert.rejects(() =>
    plugin.getServices({
      options: { hyperdrives: { HYPERDRIVE: new URL(QUEUE_HYPERDRIVE_URL) } },
    }),
  );
  observer.restore();
  assert.throws(() => observer.assertObserved());
});
test("actual service observer refuses missing invocation and alternate input before original", async () => {
  const { observeActualQueueTransport } =
    await import("./postgres-owner-fixture.ts");
  let calls = 0;
  const plugin = {
    async getServices(_context?: unknown) {
      calls++;
      return [];
    },
  };
  const observer = observeActualQueueTransport(plugin);
  assert.throws(() => observer.assertObserved());
  await assert.rejects(() =>
    plugin.getServices({
      options: {
        hyperdrives: {
          HYPERDRIVE: new URL(
            "postgresql://synthetic:synthetic@203.0.113.1:5432/fixture?sslmode=disable",
          ),
        },
      },
    }),
  );
  assert.equal(calls, 0);
  observer.restore();
  assert.throws(() => observer.assertObserved());
});
