import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { gzipSync } from "node:zlib";
import { preserveSyncDeadLetter } from "../src/sync-dead-letter-store.ts";
import { handleDeadLetterBatch } from "../src/dead-letter.ts";
import { syncDeadLetterDb } from "./helpers/sync-dead-letter-db.ts";
import {
  laneAlarmIssueBody,
  laneAlarmLossComment,
  laneAlarmPlan,
} from "../src/lane-alarm.ts";
import type { LaneHealthRecord } from "../src/lane-health.ts";

const fixtures: ReturnType<typeof syncDeadLetterDb>[] = [];
function fixture() {
  const f = syncDeadLetterDb();
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

test("JSON and compressed transport bytes remain replayable after acknowledgment", async () => {
  const f = fixture(),
    body = {
      lane: "nominator-positions",
      rows: [{ coldkey: "界", amount: "12345678901234567890" }],
    };
  const compressed = gzipSync(JSON.stringify(body));
  for (const [id, value] of [
    ["json", body],
    ["bytes", compressed],
    ["buffer", Uint8Array.from(compressed).buffer],
    ["slice", Uint8Array.from([0, ...compressed, 0]).subarray(1, -1)],
  ] as const) {
    let acked = false;
    await handleDeadLetterBatch(
      {
        queue: "sync-batches-dlq",
        messages: [
          {
            id,
            body: value,
            ack() {
              assert.ok(
                f.sql
                  .prepare("SELECT 1 FROM sync_dead_letters WHERE message_id=?")
                  .get(id),
              );
              acked = true;
            },
          },
        ],
      },
      undefined,
      123,
      f.db,
    );
    assert.ok(acked);
    const row = f.sql
      .prepare("SELECT * FROM sync_dead_letters WHERE message_id=?")
      .get(id)!;
    assert.equal(row.received_at, 123);
    if (id === "json") assert.deepEqual(JSON.parse(String(row.payload)), body);
    else
      assert.deepEqual(Buffer.from(String(row.payload), "base64"), compressed);
  }
});

test("redelivery is idempotent; identity conflicts preserve the first payload", async () => {
  const f = fixture(),
    m = { id: "same", body: { value: 1 } };
  await preserveSyncDeadLetter(f.db, m, 10);
  await preserveSyncDeadLetter(f.db, m, 20);
  assert.equal(
    f.sql.prepare("SELECT COUNT(*) n FROM sync_dead_letters").get()!.n,
    1,
  );
  assert.equal(
    f.sql.prepare("SELECT received_at FROM sync_dead_letters").get()!
      .received_at,
    10,
  );
  await assert.rejects(
    preserveSyncDeadLetter(f.db, { ...m, body: { value: 2 } }, 30),
    /readback differs/,
  );
  assert.equal(
    f.sql.prepare("SELECT payload FROM sync_dead_letters").get()!.payload,
    '{"value":1}',
  );
});

test("a transient quarantine failure never acknowledges the failed message", async () => {
  const f = fixture(),
    acks: string[] = [];
  const messages = ["a", "b"].map((id) => ({
    id,
    body: { lane: "neurons" },
    ack: () => acks.push(id),
  }));
  f.sql.exec(
    "CREATE TRIGGER fail_second BEFORE INSERT ON sync_dead_letters WHEN NEW.message_id='b' BEGIN SELECT RAISE(FAIL,'store unavailable'); END",
  );
  await assert.rejects(
    handleDeadLetterBatch(
      { queue: "sync-batches-dlq", messages },
      undefined,
      1,
      f.db,
    ),
    /store unavailable/,
  );
  assert.deepEqual(acks, ["a"]);
  f.sql.exec("DROP TRIGGER fail_second");
  await handleDeadLetterBatch(
    { queue: "sync-batches-dlq", messages: [messages[1]!] },
    undefined,
    2,
    f.db,
  );
  assert.deepEqual(acks, ["a", "b"]);
});

test("failed preservation, partial retry and duplicate delivery remain observations on the existing incident", async () => {
  const f = fixture();
  const observed: LaneHealthRecord[] = [];
  const health = {
    async query() {
      return [];
    },
    async run(text: string, values: unknown[] = []) {
      if (text.startsWith("INSERT INTO lane_health"))
        observed.push({
          lane: String(values[0]),
          verdict: "stale",
          age_ms: null,
          detail: String(values[3]),
          checked_at: Number(values[4]),
        });
      return { changes: 1 };
    },
  };
  const acks: string[] = [];
  const messages = ["a", "b"].map((id) => ({
    id,
    body: { lane: "hotkey-alpha", rows: [] },
    ack: () => acks.push(id),
  }));
  const lane = "sync-batches-dlq";
  const now = 1_792_022_480_362;
  f.sql.exec(
    "CREATE TRIGGER fail_preservation BEFORE INSERT ON sync_dead_letters WHEN NEW.message_id='b' BEGIN SELECT RAISE(FAIL,'store unavailable'); END",
  );
  await assert.rejects(
    handleDeadLetterBatch({ queue: lane, messages }, health, now - 2000, f.db),
    /store unavailable/,
  );
  assert.equal(observed.length, 1, "the observation predates preservation");
  assert.deepEqual(acks, ["a"]);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM sync_dead_letters").get()!.n,
    1,
  );
  f.sql.exec("DROP TRIGGER fail_preservation");
  await handleDeadLetterBatch(
    { queue: lane, messages: [messages[1]!] },
    health,
    now - 1000,
    f.db,
  );
  await handleDeadLetterBatch({ queue: lane, messages }, health, now, f.db);
  assert.deepEqual(acks, ["a", "b", "a", "b"]);
  assert.equal(observed.length, 3);
  assert.equal(
    f.sql.prepare("SELECT count(*) n FROM sync_dead_letters").get()!.n,
    2,
  );
  assert.deepEqual(
    f.sql
      .prepare(
        "SELECT message_id,received_at FROM sync_dead_letters ORDER BY message_id",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { message_id: "a", received_at: now - 2000 },
      { message_id: "b", received_at: now - 1000 },
    ],
  );
  const latest = observed[2]!;
  const plan = laneAlarmPlan({
    latest: { [lane]: latest },
    runs: {
      [lane]: { since: observed[0]!.checked_at, ticks: observed.length },
    },
    unknownRuns: {},
    observedMaxGap: {},
    openAlarms: { [lane]: { issue: 12640, updatedAt: now - 500 } },
    nowMs: now,
    minStaleMs: 0,
  });
  assert.deepEqual(plan.open, []);
  assert.deepEqual(plan.close, []);
  assert.deepEqual(
    plan.update.map((entry) => entry.issue),
    [12640],
  );
  const body = laneAlarmIssueBody(
    {
      lane,
      kind: "stale",
      since: observed[0]!.checked_at,
      ticks: observed.length,
      detail: latest.detail,
      age_ms: null,
      cadence_ms: null,
    },
    now,
  );
  assert.match(body, /3 retained dead-letter observation\(s\)/);
  assert.match(body, /not unique messages or confirmed permanent losses/);
  const comment = laneAlarmLossComment(lane, latest);
  assert.ok(comment.includes(latest.detail!));
  assert.match(comment, /may repeat previously seen messages/);
  assert.match(
    comment,
    /does not establish unique-message counts, durable preservation or confirmed permanent loss/,
  );
  assert.doesNotMatch(body + comment, /lost more|were acked|count of losses/);
});

test("missing storage, identity, unserializable or oversized payloads stay unacknowledged", async () => {
  const f = fixture();
  for (const m of [
    { body: {} },
    { id: "", body: {} },
    { id: "a".repeat(257), body: {} },
    { id: "undefined", body: undefined },
    { id: "large", body: new Uint8Array(128 * 1024 + 1) },
    { id: "large-json", body: "界".repeat(50000) },
    { id: "bigint", body: 1n },
  ]) {
    let acked = false;
    await assert.rejects(
      handleDeadLetterBatch(
        {
          queue: "sync-batches-dlq",
          messages: [
            {
              ...m,
              ack() {
                acked = true;
              },
            },
          ],
        },
        undefined,
        1,
        f.db,
      ),
    );
    assert.equal(acked, false);
  }
  await assert.rejects(
    preserveSyncDeadLetter(undefined, { id: "a", body: {} }, 1),
    /needs a store/,
  );
  await preserveSyncDeadLetter(
    f.db,
    { id: "maximum", body: new Uint8Array(128 * 1024) },
    1,
  );
  assert.equal(
    f.sql
      .prepare(
        "SELECT length(payload) n FROM sync_dead_letters WHERE message_id='maximum'",
      )
      .get()!.n,
    174764,
  );
});

test("missing or mismatched stored identities cannot report persistence", async () => {
  const f = fixture();
  for (const result of [null, { body_sha256: "bad", encoding: "json" }]) {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return result;
              },
            };
          },
        };
      },
    } as unknown as Pick<D1Database, "prepare">;
    await assert.rejects(
      preserveSyncDeadLetter(db, { id: "a", body: {} }, 1),
      /readback differs/,
    );
  }
  await preserveSyncDeadLetter(f.db, { id: "encoding", body: {} }, 1);
  f.sql.exec(
    "UPDATE sync_dead_letters SET encoding='base64' WHERE message_id='encoding'",
  );
  await assert.rejects(
    preserveSyncDeadLetter(f.db, { id: "encoding", body: {} }, 1),
    /readback differs/,
  );
});
