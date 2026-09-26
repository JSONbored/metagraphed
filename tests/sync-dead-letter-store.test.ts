import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { gzipSync } from "node:zlib";
import { preserveSyncDeadLetter } from "../src/sync-dead-letter-store.ts";
import { handleDeadLetterBatch } from "../src/dead-letter.ts";
import { syncDeadLetterDb } from "./helpers/sync-dead-letter-db.ts";

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
