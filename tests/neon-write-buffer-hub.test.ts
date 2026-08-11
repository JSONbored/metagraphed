// The buffer's storage and drain (workers/neon-write-buffer-hub.ts).
//
// What must not go wrong, in the order it would hurt:
//
//   1. A FAILED FLUSH MUST KEEP ITS BACKLOG. These are capture rows -- a block
//      header, a decoded event -- and nothing re-derives them once the chain
//      has moved on. Deleting on failure is unrecoverable data loss.
//   2. A FLUSH MUST NOT CLAIM ROWS LANDED WHEN THEY DID NOT. The enqueue-time
//      verdict only means "buffered"; this drain owns the honest one.
//   3. THE BUFFER MUST NOT GROW FOREVER. A stalled flush behind an unbounded
//      queue is an outage with no symptom until the DO itself fails.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BUFFER_FLUSH_LANE,
  countPending,
  enqueueStatement,
  flushBuffer,
  NeonWriteBufferHub,
  type BufferStorage,
} from "../workers/neon-write-buffer-hub.ts";
import {
  chunkKey,
  createBufferedPgSql,
  FLUSH_INTERVAL_MS,
  MAX_BUFFERED_STATEMENTS,
} from "../src/neon-write-buffer.ts";

const NOW = 1_785_800_000_000;

/** An in-memory stand-in for DurableObjectState.storage. */
function fakeStorage(): BufferStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    map,
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>) {
      for (const [key, value] of Object.entries(entries)) map.set(key, value);
    },
    async list<T>({ prefix }: { prefix: string }) {
      // Sorted, exactly as the platform returns it -- an unsorted fake would
      // hide the ordering bug this module's padding exists to prevent.
      const out = new Map<string, T>();
      for (const key of [...map.keys()].sort()) {
        if (key.startsWith(prefix)) out.set(key, map.get(key) as T);
      }
      return out;
    },
    async delete(keys: string[]) {
      let n = 0;
      for (const key of keys) if (map.delete(key)) n += 1;
      return n;
    },
    async setAlarm(when: number) {
      alarm = when;
    },
    async getAlarm() {
      return alarm;
    },
  };
}

function laneSpy() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    db: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                if (sql.startsWith("INSERT"))
                  rows.push({
                    lane: values[0],
                    verdict: values[1],
                    detail: values[3],
                  });
              },
            };
          },
        };
      },
    },
  };
}

const CTX = { waitUntil() {} };
const stmt = (lane: string, text: string) => ({ lane, text, values: [1] });

describe("enqueueStatement", () => {
  test("accepts a statement and arms the alarm", async () => {
    const storage = fakeStorage();
    const out = await enqueueStatement(storage, stmt("blocks-head", "A"), NOW);
    assert.equal(out.accepted, true);
    assert.equal(out.seq, 1);
    assert.equal(await storage.getAlarm(), NOW + FLUSH_INTERVAL_MS);
    assert.equal(await countPending(storage), 1);
  });

  test("does NOT push the alarm out on every enqueue", async () => {
    // Re-arming per write would move the flush further away with each one,
    // which at these cadences means it never fires at all.
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("a", "A"), NOW);
    await enqueueStatement(storage, stmt("b", "B"), NOW + 60_000);
    assert.equal(await storage.getAlarm(), NOW + FLUSH_INTERVAL_MS);
  });

  test("sequences monotonically, so replay order is write order", async () => {
    const storage = fakeStorage();
    for (const t of ["A", "B", "C"])
      await enqueueStatement(storage, stmt("l", t), NOW);
    assert.equal(await storage.get("seq"), 3);
    assert.equal(await countPending(storage), 3);
  });

  test("REFUSES at the ceiling rather than growing", async () => {
    const storage = fakeStorage();
    // Seed the ceiling directly; enqueuing 5,000 real statements would test
    // the fake's speed, not the policy.
    for (let i = 1; i <= MAX_BUFFERED_STATEMENTS; i += 1) {
      storage.map.set(chunkKey(i, 0), new Uint8Array(0));
    }
    const out = await enqueueStatement(storage, stmt("l", "A"), NOW);
    assert.equal(out.accepted, false);
    assert.match(String(out.reason), /buffer full/);
  });
});

describe("flushBuffer", () => {
  test("an empty buffer is a clean no-op", async () => {
    const out = await flushBuffer(fakeStorage(), {}, CTX, { sql: null });
    assert.deepEqual(out, { drained: 0, undecodable: 0, ok: true });
  });

  test("drains every statement through ONE runner, in order", async () => {
    // The whole economy of the change: scattered writes become one wake.
    const storage = fakeStorage();
    for (const t of ["A", "B", "C"])
      await enqueueStatement(storage, stmt("blocks-head", t), NOW);
    const seen: string[] = [];
    const spy = laneSpy();
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: spy.db,
      now: () => NOW,
      sql: {
        async unsafe(text: string) {
          seen.push(text);
          return [];
        },
      },
    });
    assert.deepEqual(seen, ["A", "B", "C"]);
    assert.equal(out.drained, 3);
    assert.equal(out.ok, true);
    assert.equal(await countPending(storage), 0);
  });

  test("survives a statement large enough to be chunked", async () => {
    // Bulk upserts are thousands of rows wide, so chunking is the normal path
    // here rather than an edge case.
    const storage = fakeStorage();
    const big = "x".repeat(300_000);
    await enqueueStatement(storage, { lane: "l", text: big, values: [] }, NOW);
    let got = "";
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe(text: string) {
          got = text;
          return [];
        },
      },
    });
    assert.equal(got, big);
    assert.equal(await countPending(storage), 0);
  });

  test("a FAILED flush keeps the failing statement and everything after it", async () => {
    // The one that must never regress. Losing these rows is unrecoverable.
    const storage = fakeStorage();
    for (const t of ["A", "B", "C"])
      await enqueueStatement(storage, stmt("l", t), NOW);
    const spy = laneSpy();
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: spy.db,
      now: () => NOW,
      sql: {
        async unsafe(text: string) {
          if (text === "B") throw new Error("connection reset");
          return [];
        },
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.drained, 1);
    // B and C survive; A is gone because it landed.
    assert.equal(await countPending(storage), 2);
    const flush = spy.rows.find((r) => r.lane === BUFFER_FLUSH_LANE);
    assert.equal(flush?.verdict, "stale");
    assert.match(String(flush?.detail), /connection reset/);
  });

  test("records a per-lane verdict that means the rows LANDED", async () => {
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("blocks-head", "A"), NOW);
    await enqueueStatement(storage, stmt("chain-detail", "B"), NOW);
    const spy = laneSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: spy.db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    const byLane = Object.fromEntries(spy.rows.map((r) => [r.lane, r.verdict]));
    assert.equal(byLane["blocks-head"], "ok");
    assert.equal(byLane["chain-detail"], "ok");
    assert.equal(byLane[BUFFER_FLUSH_LANE], "ok");
  });

  test("an unreadable entry is discarded, never left to wedge the backlog", async () => {
    const storage = fakeStorage();
    // Seed the bad entry AND the sequence, so the enqueue below takes seq 2
    // rather than allocating seq 1 and overwriting what we just planted.
    storage.map.set("seq", 1);
    storage.map.set(chunkKey(1, 0), new TextEncoder().encode("{not json"));
    await enqueueStatement(storage, stmt("l", "B"), NOW);
    const seen: string[] = [];
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe(text: string) {
          seen.push(text);
          return [];
        },
      },
    });
    assert.equal(out.undecodable, 1);
    assert.deepEqual(seen, ["B"]);
    assert.equal(await countPending(storage), 0);
  });

  test("an unbound Hyperdrive is a MISCONFIGURATION that keeps the backlog", async () => {
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("l", "A"), NOW);
    const spy = laneSpy();
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: spy.db,
      now: () => NOW,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "hyperdrive unbound");
    assert.equal(await countPending(storage), 1, "backlog must survive");
    assert.equal(
      spy.rows.find((r) => r.lane === BUFFER_FLUSH_LANE)?.verdict,
      "stale",
    );
  });
});

describe("createBufferedPgSql", () => {
  function namespace(status: number) {
    const sent: unknown[] = [];
    return {
      sent,
      ns: {
        idFromName: (name: string) => name,
        get: () => ({
          async fetch(request: Request) {
            sent.push(await request.json());
            return new Response("{}", { status });
          },
        }),
      },
    };
  }

  test("enqueues the statement under its lane and returns an empty row set", async () => {
    // Every buffered call site awaits the result bare and no statement carries
    // a RETURNING, so [] is indistinguishable from a real write's result.
    const n = namespace(200);
    const sql = createBufferedPgSql(n.ns, "blocks-head");
    assert.deepEqual(await sql.unsafe("INSERT INTO t VALUES ($1)", [7]), []);
    assert.deepEqual(n.sent, [
      { lane: "blocks-head", text: "INSERT INTO t VALUES ($1)", values: [7] },
    ]);
  });

  test("defaults missing values to an empty array", async () => {
    const n = namespace(200);
    await createBufferedPgSql(n.ns, "l").unsafe("DELETE FROM t");
    assert.deepEqual((n.sent[0] as { values: unknown[] }).values, []);
  });

  test("THROWS when the buffer refuses, so the lane records stale", async () => {
    // Backpressure has to be visible. Swallowing a 503 here would let the
    // buffer fill while every lane reported ok.
    const n = namespace(503);
    await assert.rejects(
      () => createBufferedPgSql(n.ns, "l").unsafe("INSERT INTO t VALUES (1)"),
      /neon write buffer refused/,
    );
  });
});

describe("NeonWriteBufferHub", () => {
  function hub(env: Record<string, unknown> = {}) {
    const storage = fakeStorage();
    const state = {
      storage,
      waitUntil() {},
    } as unknown as DurableObjectState;
    return { storage, do: new NeonWriteBufferHub(state, env) };
  }

  const post = (body: unknown) =>
    new Request("https://neon-write-buffer/enqueue", {
      method: "POST",
      body: JSON.stringify(body),
    });

  test("accepts an enqueue and reports the sequence", async () => {
    const h = hub();
    const res = await h.do.fetch(post(stmt("blocks-head", "A")));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, seq: 1 });
    assert.equal(await countPending(h.storage), 1);
  });

  test("anything but POST /enqueue is a 404", async () => {
    const h = hub();
    assert.equal(
      (await h.do.fetch(new Request("https://x/other", { method: "POST" })))
        .status,
      404,
    );
    assert.equal(
      (await h.do.fetch(new Request("https://x/enqueue"))).status,
      404,
    );
  });

  test("a malformed body or statement is a 400, never a stored row", async () => {
    // Storing an entry the drain cannot decode would burn a flush cycle to
    // discard it. Refusing at the door keeps the buffer holding only replayable
    // statements.
    const h = hub();
    const bad = new Request("https://neon-write-buffer/enqueue", {
      method: "POST",
      body: "{not json",
    });
    assert.equal((await h.do.fetch(bad)).status, 400);
    assert.equal((await h.do.fetch(post({ lane: "l" }))).status, 400);
    assert.equal(await countPending(h.storage), 0);
  });

  test("a full buffer answers 503 -- backpressure, not a bug in the request", async () => {
    const h = hub();
    for (let i = 1; i <= MAX_BUFFERED_STATEMENTS; i += 1) {
      h.storage.map.set(chunkKey(i, 0), new Uint8Array(0));
    }
    const res = await h.do.fetch(post(stmt("l", "A")));
    assert.equal(res.status, 503);
  });

  test("an alarm with nothing buffered does NOT schedule another wake", async () => {
    // Re-arming after a clean drain would book a wake with no work, which is
    // the exact cost this whole file exists to remove.
    const h = hub();
    await h.do.alarm();
    assert.equal(await h.storage.getAlarm(), null);
  });

  test("the alarm drains, and re-arms only while work remains", async () => {
    const h = hub();
    await h.do.fetch(post(stmt("l", "A")));
    // No HYPERDRIVE, so the flush declines and the backlog survives -- the
    // alarm MUST come back or nothing would ever drain it again.
    await h.do.alarm();
    assert.equal(await countPending(h.storage), 1);
    assert.notEqual(await h.storage.getAlarm(), null);
  });
});

describe("flushBuffer, the defensive edges", () => {
  test("a thrown non-Error is still reported as a reason", async () => {
    // Postgres drivers reject with plain strings often enough that String()
    // here is the difference between a reason and "[object Object]".
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("l", "A"), NOW);
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          throw "connection string is invalid";
        },
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "connection string is invalid");
    assert.equal(await countPending(storage), 1, "backlog must survive");
  });

  test("a listed key with no value is treated as an empty chunk", async () => {
    // list() and get() disagreeing should cost the statement, not throw
    // partway through the drain and strand everything behind it.
    const storage = fakeStorage();
    storage.map.set(chunkKey(1, 0), undefined);
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(out.undecodable, 1);
    assert.equal(await countPending(storage), 0);
  });

  test("a bound Hyperdrive builds a real runner, and reports its failure", async () => {
    // Covers the branch that actually opens a connection. The connection
    // string is deliberately unusable: what matters is that the flush routes
    // through createPgSql and survives the failure with its backlog intact.
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("l", "A"), NOW);
    const out = await flushBuffer(
      storage,
      { HYPERDRIVE: { connectionString: "postgresql://nowhere.invalid/db" } },
      CTX,
      { laneHealthDb: laneSpy().db, now: () => NOW },
    );
    assert.equal(out.ok, false);
    assert.equal(await countPending(storage), 1, "backlog must survive");
  });
});
