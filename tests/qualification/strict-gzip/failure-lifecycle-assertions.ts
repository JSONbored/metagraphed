// Host-side oracles. Success here is supplemental only: source/build custody,
// functional queue outcomes, database rows and controller identity are separate.
import assert from "node:assert/strict";
import type {
  FailureLifecycleSnapshot,
  PgObservation,
  ReaderObservation,
} from "./failure-lifecycle-observer.ts";
const MAX_DECODED = 79_393_024;
function base(value: FailureLifecycleSnapshot, scenario: string) {
  assert.equal(value.kind, "supplemental-source-bound-lifecycle-v1");
  assert.equal(value.scenario, scenario);
  assert.deepEqual(value.violations, []);
  assert.ok(value.dispatches.length >= 1 && value.dispatches.length <= 4);
  for (const [index, dispatch] of value.dispatches.entries()) {
    assert.equal(dispatch.ordinal, index + 1);
    assert.equal(
      dispatch.finished,
      true,
      "Real owner handler remains unsettled",
    );
    assert.ok(dispatch.messages.length <= 10);
    assert.equal(
      new Set(dispatch.messages.map((row) => row.id)).size,
      dispatch.messages.length,
    );
  }
  assert.ok(value.clients.length <= 128 && value.readers.length <= 40);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 0);
  const sequence = new Set<number>();
  for (const [index, client] of value.clients.entries()) {
    assert.equal(client.id, index + 1);
    assert.equal(
      client.messageId,
      null,
      "Unproven asynchronous message attribution",
    );
    assert.equal(
      client.dispatch,
      null,
      "Unproven asynchronous dispatch attribution",
    );
    assert.ok(
      ["createPgSql", "pgReadStore", "pgLaneHealthDb"].includes(client.helper),
    );
    assert.ok(client.operations.length > 0 && client.operations.length <= 32);
    for (const op of client.operations) {
      assert.ok(["connect", "query", "end"].includes(op.method));
      assert.ok(
        ["fulfilled", "rejected"].includes(op.status),
        "Missing real Promise settlement",
      );
      for (const at of [op.call, op.settlement]) {
        assert.ok(Number.isSafeInteger(at) && at! > 0 && at! <= value.sequence);
        assert.ok(!sequence.has(at!));
        sequence.add(at!);
      }
      assert.ok(op.settlement! > op.call);
      assert.ok(op.sqlstate === null || /^[0-9A-Z]{5}$/.test(op.sqlstate));
      assert.ok(
        op.cancellationCause === null ||
          ["user-request", "statement-timeout", "other"].includes(
            op.cancellationCause,
          ),
      );
      assert.ok(
        op.querySha256 === null || /^[a-f0-9]{64}$/.test(op.querySha256),
      );
    }
  }
}
function teardown(client: PgObservation) {
  const ends = client.operations.filter((op) => op.method === "end");
  assert.equal(
    ends.length,
    1,
    "Each actual constructed client must receive exactly one end call",
  );
  assert.equal(
    ends[0]!.status,
    "fulfilled",
    "Hidden end rejection cannot qualify teardown",
  );
  assert.equal(ends[0]!.sqlstate, null);
  assert.equal(
    client.clientEnded,
    true,
    "Actual pg connection end has not settled",
  );
  // pg-cloudflare end() closes its native Socket without setting destroyed.
  // Require its real close event; destroyed alone is neither necessary nor enough.
  assert.equal(
    client.streamCloseEvents,
    1,
    "Actual native transport close missing or duplicated",
  );
  assert.equal(
    client.endEvents,
    1,
    "Actual pg end event missing or duplicated",
  );
  return ends[0]!;
}
export function assertFailureAuthLifecycle(
  snapshot: FailureLifecycleSnapshot,
  requiredHelpers: readonly string[] = ["createPgSql"],
) {
  base(snapshot, "auth-rejection");
  assert.equal(
    snapshot.dispatches.length,
    1,
    "Bad authentication is immutable per isolate",
  );
  assert.ok(snapshot.clients.length > 0, "Missing real authentication witness");
  for (const helper of requiredHelpers)
    assert.ok(snapshot.clients.some((client) => client.helper === helper));
  for (const client of snapshot.clients) {
    const connects = client.operations.filter((op) => op.method === "connect");
    assert.equal(connects.length, 1);
    assert.equal(connects[0]!.status, "rejected");
    assert.equal(
      connects[0]!.sqlstate,
      "28P01",
      "Wrong or absent real driver authentication SQLSTATE",
    );
    assert.equal(
      client.operations.filter((op) => op.method === "query").length,
      0,
      "Query after failed connect",
    );
    assert.ok(teardown(client).call > connects[0]!.settlement!);
  }
  return {
    clients: snapshot.clients.length,
    rejectedConnects: snapshot.clients.length,
    settledEnds: snapshot.clients.length,
  };
}
// Only for the independently pinned pre-fix source root. The native case must
// bind those original/derived bytes separately; caller-supplied snapshots alone
// can never establish that source identity.
export function assertFailureUnfixedAuthControl(
  snapshot: FailureLifecycleSnapshot,
) {
  base(snapshot, "auth-rejection");
  assert.equal(snapshot.dispatches.length, 1);
  assert.ok(snapshot.clients.length > 0);
  assert.ok(snapshot.clients.some((client) => client.helper === "createPgSql"));
  for (const client of snapshot.clients) {
    assert.equal(
      client.operations.length,
      1,
      "Unfixed control requires zero query and zero end calls",
    );
    const connect = client.operations[0]!;
    assert.equal(connect.method, "connect");
    assert.equal(connect.status, "rejected");
    assert.equal(connect.sqlstate, "28P01");
    assert.equal(client.clientEnded, true);
    assert.equal(client.endEvents, 1);
    assert.equal(client.streamCloseEvents, 1);
  }
  assert.throws(
    () => assertFailureAuthLifecycle(snapshot),
    /Each actual constructed client must receive exactly one end call/,
  );
  return {
    clients: snapshot.clients.length,
    rejectedConnects: snapshot.clients.length,
    observedEndCalls: 0,
    fixedLifecycleOracle: "rejected-missing-end" as const,
  };
}
export function assertFailureQueryLifecycle(
  snapshot: FailureLifecycleSnapshot,
  target: { querySha256: string; backendPid: number },
) {
  base(snapshot, "query-cancellation");
  assert.match(target.querySha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(target.backendPid) && target.backendPid > 0);
  assert.ok(snapshot.clients.length > 0);
  const rejected = snapshot.clients.flatMap((client) =>
    client.operations
      .filter((op) => op.method === "query" && op.status === "rejected")
      .map((operation) => ({ client, operation })),
  );
  assert.equal(
    rejected.length,
    1,
    "Exactly one actual query rejection is required",
  );
  const { client: targetClient, operation } = rejected[0]!;
  assert.equal(
    operation.sqlstate,
    "57014",
    "Signal delivery alone is insufficient",
  );
  assert.equal(
    operation.cancellationCause,
    "user-request",
    "A natural timeout cannot qualify requested cancellation",
  );
  assert.equal(operation.querySha256, target.querySha256);
  assert.equal(
    operation.backendPid,
    target.backendPid,
    "Actual pg client PID must match controller witness",
  );
  for (const client of snapshot.clients) {
    const connects = client.operations.filter((op) => op.method === "connect");
    assert.equal(connects.length, 1);
    assert.equal(connects[0]!.status, "fulfilled");
    const end = teardown(client);
    for (const query of client.operations.filter(
      (op) => op.method === "query",
    )) {
      assert.ok(query.call > connects[0]!.settlement!);
      assert.ok(end.call > query.settlement!);
      if (query !== operation) assert.equal(query.status, "fulfilled");
    }
  }
  assert.ok(teardown(targetClient).call > operation.settlement!);
  return {
    clients: snapshot.clients.length,
    targetedQueryRejections: 1,
    settledEnds: snapshot.clients.length,
  };
}
export function assertFailureSuccessfulLifecycle(
  snapshot: FailureLifecycleSnapshot,
  scenario = "auth-rejection",
) {
  base(snapshot, scenario);
  assert.ok(
    snapshot.clients.length > 0,
    "Missing actual successful-client control",
  );
  assert.ok(
    snapshot.dispatches.some((dispatch) =>
      dispatch.messages.some((message) => message.writerCalls === 1),
    ),
    "Missing actual successful writer boundary",
  );
  let queryCount = 0;
  for (const client of snapshot.clients) {
    const connects = client.operations.filter((op) => op.method === "connect");
    assert.equal(connects.length, 1);
    assert.equal(connects[0]!.status, "fulfilled");
    const queries = client.operations.filter((op) => op.method === "query");
    assert.ok(queries.length > 0);
    queryCount += queries.length;
    const end = teardown(client);
    for (const operation of client.operations) {
      assert.equal(operation.status, "fulfilled");
      assert.equal(operation.sqlstate, null);
      assert.equal(operation.cancellationCause, null);
    }
    for (const query of queries) {
      assert.ok(query.call > connects[0]!.settlement!);
      assert.ok(end.call > query.settlement!);
    }
  }
  return {
    clients: snapshot.clients.length,
    successfulQueries: queryCount,
    settledEnds: snapshot.clients.length,
  };
}
function stopped(reader: ReaderObservation) {
  assert.ok(reader.cancel, "Missing actual reader cancellation call");
  assert.ok(reader.cancel.after, "Cancellation never returned");
  assert.equal(
    reader.cancel.before.destroyed,
    false,
    "An already destroyed inflater cannot qualify refusal cancellation",
  );
  assert.equal(
    reader.cancel.after.destroyed,
    true,
    "Cancellation did not synchronously destroy the actual inflater",
  );
  assert.ok(reader.cancel.after.destroys > reader.cancel.before.destroys);
  assert.equal(reader.current.destroyed, true);
  assert.equal(reader.closes, 1, "Actual inflater close missing or duplicated");
  assert.equal(reader.pendingNext, 0, "A real next Promise remains pending");
  assert.equal(reader.nextSettled, reader.nextCalls);
  assert.equal(reader.nextRejected, 0);
  assert.equal(reader.advancementsAfterCancel, 0);
  for (const later of [reader.cancel.after, reader.current])
    for (const key of [
      "submitted",
      "consumed",
      "produced",
      "drained",
      "writes",
      "reads",
      "ends",
    ] as const)
      assert.equal(
        later[key],
        reader.cancel.before[key],
        `Inflater ${key} advanced after cancellation`,
      );
}
export function assertFailureDecoderLifecycle(
  snapshot: FailureLifecycleSnapshot,
) {
  base(snapshot, "decoder-refusal");
  assertFailureSuccessfulLifecycle(snapshot, "decoder-refusal");
  const candidates = snapshot.readers.filter((reader) => {
    const dispatch = snapshot.dispatches[reader.dispatch - 1];
    const message = dispatch?.messages.find(
      (row) => row.id === reader.messageId,
    );
    return message?.writerCalls === 0;
  });
  assert.equal(
    candidates.length,
    1,
    "One explicit message-scoped refused reader is required",
  );
  const refused = candidates[0]!;
  const dispatch = snapshot.dispatches[refused.dispatch - 1]!;
  const message = dispatch.messages.find(
    (row) => row.id === refused.messageId,
  )!;
  assert.ok(refused.messageId && message.wireSha256 === refused.wireSha256);
  assert.equal(
    message.writerCalls,
    0,
    "Refused message crossed the real writer boundary",
  );
  assert.ok(refused.cancelCalls > 0);
  stopped(refused);
  assert.ok(refused.cancel!.before.drained > MAX_DECODED);
  assert.ok(refused.cancel!.before.drained <= MAX_DECODED + 8192);
  assert.equal(
    refused.nativeEnds,
    0,
    "Refusal must precede native completion and bad-trailer validation",
  );
  assert.ok(
    refused.current.consumed + refused.headerBytes < refused.wireBytes - 8,
    "No unread compressed tail witness",
  );
  assert.ok(
    dispatch.messages.filter((row) => row.writerCalls === 1).length >= 2,
    "Missing real good-neighbor writer calls",
  );
  return {
    readers: snapshot.readers.length,
    refusedReaders: 1,
    refusedWriterCalls: 0,
    settledPendingReads: refused.nextSettled,
  };
}
