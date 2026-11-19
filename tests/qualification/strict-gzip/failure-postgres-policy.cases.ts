import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FAILURE_HYPERDRIVES,
  FAILURE_HYPERDRIVE_URL,
  FAILURE_CHAIN_QUERY,
  assertFailureHyperdriveMap,
  failureBinding,
  observeFailureTransport,
  validateFailureWaiter,
  assertSameFailureWaiter,
  assertCancellationResult,
  cancelParameters,
  FAILURE_CANCEL_SQL,
  assertFailureDisposition,
  assertFailureReceipt,
} from "./failure-postgres-policy.ts";
import {
  POSTGRES_OWNER,
  QUEUE_HYPERDRIVES,
  QUEUE_EXTERNAL_SERVICE,
  sha256,
} from "./postgres-owner-fixture.ts";
import {
  assertFailureRows,
  failureFamilies,
  partialFailureFamilies,
  emptyFailureFamilies,
  combineFailureFamilies,
} from "./failure-postgres-fixture.ts";
const holder = {
  block: 9_300_001,
  pid: 51,
  backendStart: "2026-10-20 10:00:00.123456+00",
  transactionId: "201",
};
function waiting() {
  return [
    {
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
      transaction_id: holder.transactionId,
      blocker_pid: holder.pid,
      blocker_backend_start: holder.backendStart,
      blocker_database: POSTGRES_OWNER.database,
      blocker_username: POSTGRES_OWNER.admin,
      blocker_state: "idle in transaction",
      blockers: [holder.pid],
    },
  ];
}

test("immutable bad-auth fixture changes only the deliberately wrong synthetic password", () => {
  assertFailureHyperdriveMap(FAILURE_HYPERDRIVES, "wrong-password");
  assertFailureHyperdriveMap(QUEUE_HYPERDRIVES, "valid");
  const bad = new URL(FAILURE_HYPERDRIVE_URL),
    good = new URL(QUEUE_HYPERDRIVES.HYPERDRIVE);
  assert.notEqual(bad.password, good.password);
  bad.password = good.password;
  assert.equal(bad.href, good.href);
  assert.equal(Object.isFrozen(FAILURE_HYPERDRIVES), true);
  assert.throws(() =>
    assertFailureHyperdriveMap(QUEUE_HYPERDRIVES, "wrong-password"),
  );
  assert.throws(() => assertFailureHyperdriveMap(FAILURE_HYPERDRIVES, "valid"));
});
for (const [label, altered] of [
  ["DNS host", FAILURE_HYPERDRIVE_URL.replace("127.0.0.1", "localhost")],
  [
    "alternate numeric host",
    FAILURE_HYPERDRIVE_URL.replace("127.0.0.1", "127.0.0.2"),
  ],
  ["alternate port", FAILURE_HYPERDRIVE_URL.replace(":55432", ":5432")],
  ["missing port", FAILURE_HYPERDRIVE_URL.replace(":55432", "")],
  [
    "alternate role",
    FAILURE_HYPERDRIVE_URL.replace(
      "qualification_writer:",
      "qualification_admin:",
    ),
  ],
  [
    "alternate database",
    FAILURE_HYPERDRIVE_URL.replace("whole_owner_fixture?", "postgres?"),
  ],
  ["TLS", FAILURE_HYPERDRIVE_URL.replace("sslmode=disable", "sslmode=require")],
  [
    "missing auth",
    FAILURE_HYPERDRIVE_URL.replace(/qualification_writer:.*?@/, ""),
  ],
  ["duplicate query key", FAILURE_HYPERDRIVE_URL + "&sslmode=disable"],
  ["fragment", FAILURE_HYPERDRIVE_URL + "#outside"],
] as const)
  test(`rejects bad-auth ${label}`, () =>
    assert.throws(() =>
      assertFailureHyperdriveMap({ HYPERDRIVE: altered }, "wrong-password"),
    ));

test("bad-auth map refuses alternate mapping, getter, hidden key and prototype", () => {
  for (const value of [
    { ...FAILURE_HYPERDRIVES, SECOND: FAILURE_HYPERDRIVE_URL },
    Object.defineProperty({ ...FAILURE_HYPERDRIVES }, "hidden", { value: 1 }),
    {
      get HYPERDRIVE() {
        throw new Error("getter must not run");
      },
    },
    Object.assign(Object.create(null), FAILURE_HYPERDRIVES),
  ])
    assert.throws(() => assertFailureHyperdriveMap(value, "wrong-password"));
});

test("actual transport observes original binding/service receivers, objects and promise identity", async () => {
  const options = {
      hyperdrives: { HYPERDRIVE: new URL(FAILURE_HYPERDRIVE_URL) },
    },
    context = { options };
  const binding = failureBinding("wrong-password"),
    result = [QUEUE_EXTERNAL_SERVICE],
    promise = Promise.resolve(result);
  const plugin = {
    getBindings(this: unknown, received: unknown) {
      assert.equal(this, plugin);
      assert.equal(received, options);
      return binding;
    },
    getServices(this: unknown, received: unknown) {
      assert.equal(this, plugin);
      assert.equal(received, context);
      return promise;
    },
  };
  const original = { ...plugin },
    observation = observeFailureTransport(plugin, "wrong-password");
  assert.equal(plugin.getBindings(options), binding);
  assert.equal(plugin.getServices(context), promise);
  assert.equal(await promise, result);
  observation.assertObserved();
  observation.restore();
  assert.deepEqual(plugin, original);
});
for (const problem of [
  "unobserved",
  "valid-password",
  "wrong-binding",
  "wrong-native-address",
  "service-rejection",
  "duplicate",
] as const) {
  test(`actual transport latches ${problem}`, async () => {
    const options = {
      hyperdrives: {
        HYPERDRIVE: new URL(
          problem === "valid-password"
            ? QUEUE_HYPERDRIVES.HYPERDRIVE
            : FAILURE_HYPERDRIVE_URL,
        ),
      },
    };
    const plugin = {
      getBindings() {
        return failureBinding(
          problem === "wrong-binding" ? "valid" : "wrong-password",
        );
      },
      getServices() {
        return problem === "service-rejection"
          ? Promise.reject(new Error("refused"))
          : Promise.resolve(
              problem === "wrong-native-address"
                ? [
                    {
                      name: "hyperdrive:HYPERDRIVE",
                      external: { address: "203.0.113.1:55432", tcp: {} },
                    },
                  ]
                : [QUEUE_EXTERNAL_SERVICE],
            );
      },
    };
    const observation = observeFailureTransport(plugin, "wrong-password");
    if (problem !== "unobserved") {
      try {
        (plugin.getBindings as any)(options);
        await (plugin.getServices as any)({ options });
        if (problem === "duplicate") (plugin.getBindings as any)(options);
      } catch {
        /* only the latching assertion below may establish refusal */
      }
    }
    assert.throws(() => observation.assertObserved());
    observation.restore();
    assert.throws(() => observation.assertObserved());
  });
}

test("selected waiter authenticates exact query/session/controller transaction identity", () => {
  const witness = validateFailureWaiter(waiting(), holder);
  assert.equal(witness.pid, 61);
  assert.equal(witness.querySha256.length, 64);
  assert.deepEqual(witness.holder, holder);
  assertSameFailureWaiter(witness, validateFailureWaiter(waiting(), holder));
  assert.equal(cancelParameters(witness).length, 10);
  assert.ok(FAILURE_CANCEL_SQL.includes("a.backend_start::text = $4"));
  assert.ok(FAILURE_CANCEL_SQL.includes("a.query_start::text = $5"));
  assert.ok(FAILURE_CANCEL_SQL.includes("c.backend_start::text = $9"));
});
for (const [key, value] of Object.entries({
  pid: holder.pid,
  database: "other",
  username: "other",
  query: FAILURE_CHAIN_QUERY + " ",
  backend_start: "invalid",
  query_start: "invalid",
  query_age_ms: 10_000,
  state: "idle",
  wait_event_type: "Client",
  wait_event: "tuple",
  transaction_id: "999",
  blocker_pid: 99,
  blocker_backend_start: "2026-10-20 10:00:01.123456+00",
  blocker_database: "other",
  blocker_username: "other",
  blocker_state: "active",
  blockers: [51, 52],
}))
  test(`refuses selected waiter mismatched ${key}`, () => {
    const rows = waiting();
    Object.assign(rows[0]!, { [key]: value });
    assert.throws(() => validateFailureWaiter(rows, holder));
  });
test("missing, duplicate, extra and reused waiter identity cannot authorize cancellation", () => {
  for (const rows of [[], [...waiting(), ...waiting()]])
    assert.throws(() => validateFailureWaiter(rows, holder));
  const witness = validateFailureWaiter(waiting(), holder);
  for (const patch of [
    { pid: 62 },
    { backendStart: "2026-10-20 10:01:01.123456+00" },
    { queryStart: "2026-10-20 10:02:01.123456+00" },
    { holder: { ...holder, transactionId: "202" } },
  ])
    assert.throws(() =>
      assertSameFailureWaiter({ ...witness, ...patch }, witness),
    );
});
test("false/no-op/wrong-session cancellation cannot establish signal delivery", () => {
  const witness = validateFailureWaiter(waiting(), holder);
  const row = {
    pid: witness.pid,
    backend_start: witness.backendStart,
    query_start: witness.queryStart,
    cancelled: true,
  };
  assertCancellationResult([row], witness);
  for (const rows of [
    [],
    [row, row],
    [{ ...row, cancelled: false }],
    [{ ...row, pid: 62 }],
    [{ ...row, query_start: "2026-10-20 11:00:00+00" }],
  ])
    assert.throws(() => assertCancellationResult(rows, witness));
});

test("exact partial-state oracle accepts extrinsic/account and refuses premature chain/coverage", () => {
  const partial = partialFailureFamilies(holder.block);
  assert.deepEqual(assertFailureRows(partial, partial).rowCounts, [0, 1, 0, 1]);
  const full = failureFamilies(holder.block);
  for (const wrong of [
    emptyFailureFamilies(),
    full,
    { ...partial, chainEventRows: full.chainEventRows },
    { ...partial, blockRows: full.blockRows },
    { ...partial, accountEventRows: [] },
    {
      ...partial,
      extrinsicRows: [full.extrinsicRows[0]!, full.extrinsicRows[0]!],
    },
    {
      ...partial,
      accountEventRows: [{ ...full.accountEventRows[0], amount_tao: "2.0" }],
    },
  ])
    assert.throws(() => assertFailureRows(wrong, partial));
  assert.deepEqual(
    assertFailureRows(
      combineFailureFamilies(partial, failureFamilies(holder.block + 1)),
      combineFailureFamilies(partial, failureFamilies(holder.block + 1)),
    ).rowCounts,
    [1, 2, 1, 2],
  );
});
test("manual replay exact rows reject duplicates, omissions and wrong values", () => {
  const full = failureFamilies(holder.block);
  assert.deepEqual(assertFailureRows(full, full).rowCounts, [1, 1, 1, 1]);
  for (const family of Object.keys(full) as (keyof typeof full)[]) {
    assert.throws(() => assertFailureRows({ ...full, [family]: [] }, full));
    assert.throws(() =>
      assertFailureRows(
        { ...full, [family]: [...full[family], ...full[family]] },
        full,
      ),
    );
  }
});
test("failure disposition rejects hidden batch retry, ACK/retry overlap, missing/duplicate retries", () => {
  const valid = {
    outcome: "ok",
    ackAll: false,
    retryBatch: { retry: false },
    explicitAcks: ["good"],
    retryMessages: [{ msgId: "bad" }],
  };
  assertFailureDisposition(valid, ["good"], ["bad"]);
  for (const patch of [
    { ackAll: true },
    { retryBatch: { retry: true } },
    { explicitAcks: ["good", "bad"] },
    { retryMessages: [] },
    { retryMessages: [{ msgId: "bad" }, { msgId: "bad" }] },
    { retryMessages: [{ msgId: "other" }] },
  ])
    assert.throws(() =>
      assertFailureDisposition({ ...valid, ...patch }, ["good"], ["bad"]),
    );
  assert.throws(() => assertFailureDisposition(valid, ["bad"], ["bad"]));
});

test("public failure receipts require all phases/scenarios and reject unbounded details", async () => {
  for (const value of [
    null,
    {},
    { version: 1, phase: "uninstrumented", cases: [] },
    { version: 1, phase: "instrumented", cases: [], error: "raw failure" },
    { version: 1, phase: "unknown", cases: [] },
  ])
    assert.throws(() => assertFailureReceipt(value));
});

function safeReceipt(
  phase: "uninstrumented" | "instrumented" = "uninstrumented",
) {
  const sha = "a".repeat(64);
  let identity = 0;
  const runtime = (wrong = false) => ({
    mappingSha256: sha256(
      JSON.stringify(wrong ? FAILURE_HYPERDRIVES : QUEUE_HYPERDRIVES),
    ),
    serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
    isolateSha256: (++identity).toString(16).padStart(64, "0"),
    runtimeSha256: sha,
    guardedNativeLaunches: 1,
    observedNativeExits: 1,
    restarts: 0,
    blockedOutbound: 0,
    pending: 0,
    remainingWriterSessions: 0,
    stableZeroSamples: 2,
  });
  const common = {
    phase,
    modules: [{ sha256: sha, bytes: 100 }],
    lifecycle:
      phase === "instrumented" ? "supplemental-passed" : "not-instrumented",
    productionMemory: "inconclusive",
    productionCpu: "inconclusive",
    partialSha256: sha,
    finalSha256: sha,
  };
  return {
    version: 1,
    phase,
    cases: [
      {
        ...common,
        scenario: "auth-rejection",
        bodySha256: [sha, sha],
        dispositions: [
          { ack: [], retry: ["failure-auth"] },
          { ack: ["control-auth"], retry: [] },
        ],
        partialCounts: [0, 0, 0, 0],
        finalCounts: [1, 1, 1, 1],
        runtimes: [runtime(true), runtime()],
        replay: "separate-valid-runtime",
      },
      {
        ...common,
        scenario: "query-cancellation",
        bodySha256: [sha, sha],
        dispositions: [
          { ack: ["neighbor-query"], retry: ["failure-query"] },
          { ack: ["failure-query"], retry: [] },
        ],
        partialCounts: [1, 2, 1, 2],
        finalCounts: [2, 2, 2, 2],
        runtimes: [runtime()],
        replay: "byte-identical-same-isolate",
      },
      {
        ...common,
        scenario: "decoder-refusal",
        bodySha256: [sha, sha, sha, sha],
        dispositions: [
          {
            ack: ["neighbor-before", "neighbor-after"],
            retry: ["failure-decoder"],
          },
          { ack: ["neighbor-later"], retry: [] },
        ],
        partialCounts: [2, 2, 2, 2],
        finalCounts: [3, 3, 3, 3],
        runtimes: [runtime()],
        replay: "same-isolate-subsequent-success",
      },
    ],
  };
}
test("closed receipts accept bounded complete functional and supplemental evidence separately", async () => {
  assertFailureReceipt(safeReceipt());
  assertFailureReceipt(safeReceipt("instrumented"));
});
for (const key of [
  "error",
  "query",
  "rows",
  "backendPid",
  "password",
  "unexpected",
])
  test(`closed receipts reject raw ${key} at each publication object`, async () => {
    for (const locate of [
      (value: any) => value,
      (value: any) => value.cases[0],
      (value: any) => value.cases[0].runtimes[0],
      (value: any) => value.cases[0].modules[0],
    ]) {
      const receipt = safeReceipt();
      locate(receipt)[key] = "private-value";
      assert.throws(() => assertFailureReceipt(receipt));
    }
  });
for (const [label, edit] of [
  ["missing case", (r: any) => r.cases.pop()],
  ["changed case", (r: any) => (r.cases[0].scenario = "invented")],
  [
    "lifecycle promotion",
    (r: any) => (r.cases[0].lifecycle = "supplemental-passed"),
  ],
  ["wrong phase", (r: any) => (r.cases[0].phase = "instrumented")],
  [
    "premature chain event",
    (r: any) => (r.cases[1].partialCounts = [1, 2, 2, 2]),
  ],
  [
    "promoted production memory",
    (r: any) => (r.cases[0].productionMemory = "pass"),
  ],
  ["promoted production CPU", (r: any) => (r.cases[0].productionCpu = "pass")],
  [
    "same-isolate auth claim",
    (r: any) => (r.cases[0].replay = "byte-identical-same-isolate"),
  ],
  [
    "changed mapping",
    (r: any) => (r.cases[0].runtimes[0].mappingSha256 = "f".repeat(64)),
  ],
  ["hidden restart", (r: any) => (r.cases[1].runtimes[0].restarts = 1)],
  [
    "missing exit",
    (r: any) => (r.cases[1].runtimes[0].observedNativeExits = 0),
  ],
  ["unfinished operation", (r: any) => (r.cases[2].runtimes[0].pending = 1)],
  [
    "leftover session",
    (r: any) => (r.cases[2].runtimes[0].remainingWriterSessions = 1),
  ],
  [
    "same runtime auth control",
    (r: any) =>
      (r.cases[0].runtimes[1].isolateSha256 =
        r.cases[0].runtimes[0].isolateSha256),
  ],
  [
    "wrong retry",
    (r: any) => (r.cases[0].dispositions[0].retry = ["neighbor-query"]),
  ],
] as const)
  test(`closed receipt refuses ${label}`, async () => {
    const receipt = safeReceipt();
    edit(receipt);
    assert.throws(() => assertFailureReceipt(receipt));
  });

test("transport invocation without settled native service validation cannot qualify", async () => {
  const options = {
    hyperdrives: { HYPERDRIVE: new URL(FAILURE_HYPERDRIVE_URL) },
  };
  let resolve!: (value: unknown) => void;
  const pending = new Promise((value) => {
    resolve = value;
  });
  const plugin = {
    getBindings: () => failureBinding("wrong-password"),
    getServices: () => pending,
  };
  const observation = observeFailureTransport(plugin, "wrong-password");
  (plugin.getBindings as any)(options);
  assert.equal((plugin.getServices as any)({ options }), pending);
  assert.throws(() => observation.assertObserved());
  resolve([QUEUE_EXTERNAL_SERVICE]);
  await pending;
  observation.assertObserved();
  observation.restore();
});

function negativeReceipt() {
  const positive = safeReceipt(),
    first = positive.cases[0]!;
  return {
    version: 1,
    phase: "unfixed-instrumented",
    cases: [
      {
        ...first,
        phase: "unfixed-instrumented",
        scenario: "auth-unfixed-control",
        lifecycle: "negative-control-passed",
        negativeControl: {
          clients: 4,
          rejectedConnects: 4,
          observedEndCalls: 0,
          fixedLifecycleOracle: "rejected-missing-end",
        },
        bodySha256: [first.bodySha256[0]],
        dispositions: [{ ack: [], retry: ["failure-auth-unfixed"] }],
        finalCounts: [0, 0, 0, 0],
        runtimes: [first.runtimes[0]],
        replay: "no-replay",
      },
    ],
  };
}
test("unfixed native control receipt requires specifically missing end after real auth rejection", () => {
  assertFailureReceipt(negativeReceipt());
  for (const patch of [
    { clients: 0 },
    { rejectedConnects: 0 },
    { observedEndCalls: 1 },
    { fixedLifecycleOracle: "generic-error" },
  ]) {
    const receipt = negativeReceipt();
    Object.assign(receipt.cases[0]!.negativeControl, patch);
    assert.throws(() => assertFailureReceipt(receipt));
  }
  const promoted = negativeReceipt();
  promoted.cases[0]!.lifecycle = "supplemental-passed";
  assert.throws(() => assertFailureReceipt(promoted));
});
test("unfixed native phase cannot include positive writers or generic failed test evidence", () => {
  for (const edit of [
    (r: any) => (r.cases[0].finalCounts = [1, 1, 1, 1]),
    (r: any) =>
      (r.cases[0].dispositions = [{ ack: ["control-auth"], retry: [] }]),
    (r: any) => delete r.cases[0].negativeControl,
    (r: any) => r.cases.push(r.cases[0]),
  ]) {
    const receipt = negativeReceipt();
    edit(receipt);
    assert.throws(() => assertFailureReceipt(receipt));
  }
});

for (const age of [-1, 10_000, 15_000, 20_000, Infinity, NaN, "42"])
  test(`refuses cancellation query age ${age}`, () => {
    const rows = waiting();
    Object.assign(rows[0]!, { query_age_ms: age });
    assert.throws(() => validateFailureWaiter(rows, holder));
  });
test("signal-bearing query enforces server-side age below both fixed role timeouts", () => {
  assert.ok(
    FAILURE_CANCEL_SQL.includes(
      "a.query_start > clock_timestamp() - interval '10 seconds'",
    ),
  );
  assert.ok(FAILURE_CANCEL_SQL.includes("a.query_start <= clock_timestamp()"));
});
