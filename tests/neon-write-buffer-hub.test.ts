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
  BUFFER_ROUTE,
  countPending,
  FLUSH_LIST_LIMIT,
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
    async list<T>({ prefix, limit }: { prefix: string; limit?: number }) {
      // Sorted, exactly as the platform returns it -- an unsorted fake would
      // hide the ordering bug this module's padding exists to prevent.
      //
      // AND BOUNDED, which this fake did NOT model until #10722. Durable Object
      // storage caps what list() returns; the fake returned everything, so the
      // truncation path was invisible to every test here and the production
      // stall was the first thing to exercise it. A double that is more capable
      // than the thing it stands in for does not simplify a test, it deletes a
      // case.
      const out = new Map<string, T>();
      for (const key of [...map.keys()].sort()) {
        if (limit !== undefined && out.size >= limit) break;
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
    // Seed the COUNTER, not the keys. Fullness is O(1) now (#10755) precisely
    // because counting keys per enqueue is what burned 2.4s of CPU and got the
    // object reset -- so a test that seeds keys would no longer be testing the
    // policy that exists.
    storage.map.set("pending", MAX_BUFFERED_STATEMENTS);
    const out = await enqueueStatement(storage, stmt("l", "A"), NOW);
    assert.equal(out.accepted, false);
    assert.match(String(out.reason), /buffer full/);
  });
});

describe("flushBuffer", () => {
  test("an empty buffer is a clean no-op", async () => {
    const out = await flushBuffer(fakeStorage(), {}, CTX, { sql: null });
    assert.deepEqual(out, {
      drained: 0,
      undecodable: 0,
      ok: true,
      remaining: false,
    });
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
    h.storage.map.set("pending", MAX_BUFFERED_STATEMENTS);
    const res = await h.do.fetch(post(stmt("l", "A")));
    assert.equal(res.status, 503);
  });

  test("an alarm whose flush THROWS still pages and still re-arms", async () => {
    // flushBuffer is written not to throw, so this is storage itself breaking.
    // Without the catch the alarm dies silently: no verdict, no capture, and
    // no rescheduled alarm -- the buffer stops draining and nothing says why.
    const h = hub();
    await h.do.fetch(post(stmt("neurons", "A")));
    const broken = Object.create(h.storage) as typeof h.storage;
    broken.list = async () => {
      throw new Error("storage unavailable");
    };
    (h.do as unknown as { state: { storage: unknown } }).state = {
      ...h.do.state,
      storage: broken,
    } as never;
    await h.do.alarm();
    assert.notEqual(await broken.getAlarm(), null, "must re-arm");
  });

  test("and survives a non-Error throw from storage", async () => {
    const h = hub();
    const broken = Object.create(h.storage) as typeof h.storage;
    broken.list = async () => {
      throw "storage unavailable";
    };
    (h.do as unknown as { state: { storage: unknown } }).state = {
      ...h.do.state,
      storage: broken,
    } as never;
    await h.do.alarm();
    assert.notEqual(await broken.getAlarm(), null, "must re-arm");
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

describe("PostHog capture (#10694)", () => {
  /** Collects what would have been sent to the $exception inbox. */
  function captureSpy() {
    const events: { errorCode?: string; route?: string; message: string }[] =
      [];
    return {
      events,
      capture: async (
        _env: unknown,
        e: { error: unknown; route?: string; errorCode?: string },
      ) => {
        events.push({
          errorCode: e.errorCode,
          route: e.route,
          message: String((e.error as Error)?.message ?? e.error),
        });
        return true;
      },
    };
  }

  test("a failed flush pages, and names the lane it stopped on", async () => {
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    const spy = captureSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      captureException: spy.capture as never,
      sql: {
        async unsafe() {
          throw new Error("connection reset");
        },
      },
    });
    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].errorCode, "flush_failed");
    assert.equal(spy.events[0].route, BUFFER_ROUTE);
    assert.match(spy.events[0].message, /connection reset/);
  });

  test("an unbound Hyperdrive pages -- the backlog grows with nothing else saying so", async () => {
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    const spy = captureSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      captureException: spy.capture as never,
    });
    assert.equal(spy.events[0].errorCode, "flush_hyperdrive_unbound");
    assert.match(spy.events[0].message, /1 statement\(s\) held/);
  });

  test("a DISCARDED statement pages -- it is the only data loss this can cause", async () => {
    const storage = fakeStorage();
    storage.map.set("seq", 1);
    storage.map.set(chunkKey(1, 0), new TextEncoder().encode("{not json"));
    const spy = captureSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      captureException: spy.capture as never,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(spy.events[0].errorCode, "flush_undecodable_statement");
    assert.match(spy.events[0].message, /seq 1/);
  });

  test("a clean flush pages nothing", async () => {
    // The inbox is only useful if a healthy drain is silent.
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    const spy = captureSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      captureException: spy.capture as never,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.deepEqual(spy.events, []);
  });

  test("every capture carries the same route, so one incident is one issue", async () => {
    // PostHog groups an inbox by (route, error type). A second spelling would
    // split one incident into two that each look half as urgent.
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    const spy = captureSpy();
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      captureException: spy.capture as never,
    });
    assert.ok(spy.events.length > 0);
    assert.ok(spy.events.every((e) => e.route === BUFFER_ROUTE));
  });
});

describe("a truncated drain must come back (#10722)", () => {
  // THE BUG THIS PINS. storage.list() is bounded, so a backlog past the limit
  // comes back TRUNCATED -- and a flush that drained everything it LISTED still
  // left rows behind. The alarm handler read `if (!outcome.ok)` and skipped the
  // re-arm on that "success", while the only other path that could arm one (a
  // later enqueue) was failing because deploys were resetting the Durable
  // Object. The buffer stalled for 47 minutes with no alarm pending.

  test("a full page reports remaining, so the caller re-arms", async () => {
    const storage = fakeStorage();
    for (let i = 0; i < FLUSH_LIST_LIMIT + 20; i += 1) {
      await enqueueStatement(storage, stmt("neurons", `S${i}`), NOW);
    }
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(out.ok, true, "the drain itself succeeded");
    assert.equal(out.remaining, true, "but it did NOT drain everything");
    assert.ok((await countPending(storage)) > 0, "rows are still buffered");
  });

  test("a drain that fits reports nothing remaining", async () => {
    const storage = fakeStorage();
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(out.remaining, false);
    assert.equal(await countPending(storage), 0);
  });

  test("the alarm re-arms after a SUCCESSFUL but truncated drain", async () => {
    // The exact regression: ok === true, work left, and previously no alarm.
    const storage = fakeStorage();
    const state = { storage, waitUntil() {} } as unknown as DurableObjectState;
    const h = {
      storage,
      do: new NeonWriteBufferHub(state, {}),
    };
    for (let i = 0; i < FLUSH_LIST_LIMIT + 20; i += 1) {
      await h.do.fetch(
        new Request("https://neon-write-buffer/enqueue", {
          method: "POST",
          body: JSON.stringify(stmt("neurons", `S${i}`)),
        }),
      );
    }
    // Watch setAlarm rather than getAlarm: the enqueues already armed one, so
    // reading getAlarm afterwards cannot distinguish "the drain re-armed" from
    // "the enqueue's alarm is still there" -- and that ambiguity is exactly
    // what let the missing re-arm look fine.
    let reArmed = false;
    storage.setAlarm = async () => {
      reArmed = true;
    };
    await h.do.alarm();
    assert.equal(
      reArmed,
      true,
      "a drain that left work behind MUST schedule another",
    );
  });
});

describe("the enqueue is O(1) (#10755)", () => {
  // THE BUG. enqueueStatement called countPending(), which lists every chunk
  // in the buffer and sorts them -- on every enqueue. Cloudflare's logs:
  //
  //     POST /enqueue  outcome: exception  cpuTimeMs: 2424
  //     -> Internal error in Durable Object storage caused object to be reset
  //
  // 2.4s of CPU to append one row, worsening as the backlog grew, until the
  // platform reset the object mid-request -- before setAlarm, so nothing armed
  // the flush, so the backlog grew further.

  test("does NOT list storage -- the scan is what killed it", async () => {
    const storage = fakeStorage();
    let lists = 0;
    const realList = storage.list.bind(storage);
    storage.list = async (options) => {
      lists += 1;
      return realList(options);
    };
    for (let i = 0; i < 25; i += 1) {
      await enqueueStatement(storage, stmt("neurons", `S${i}`), NOW);
    }
    assert.equal(lists, 0, "an enqueue must never scan the backlog");
  });

  test("the pending counter tracks the enqueues", async () => {
    const storage = fakeStorage();
    for (let i = 0; i < 5; i += 1) {
      await enqueueStatement(storage, stmt("l", `S${i}`), NOW);
    }
    assert.equal(await storage.get("pending"), 5);
  });

  test("a clean drain RECONCILES the counter to zero, never just decrements", async () => {
    // A counter that can only be adjusted is a counter that eventually lies.
    const storage = fakeStorage();
    for (let i = 0; i < 3; i += 1) {
      await enqueueStatement(storage, stmt("l", `S${i}`), NOW);
    }
    // Drift it deliberately, the way a partial failure would.
    storage.map.set("pending", 99);
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(
      await storage.get("pending"),
      0,
      "reconciled, not decremented",
    );
  });

  test("the ceiling still refuses, now from the counter", async () => {
    const storage = fakeStorage();
    storage.map.set("pending", MAX_BUFFERED_STATEMENTS);
    const out = await enqueueStatement(storage, stmt("l", "A"), NOW);
    assert.equal(out.accepted, false);
    assert.match(String(out.reason), /buffer full/);
  });
});

describe("an orphaned alarm must not block the buffer forever (#10763)", () => {
  test("a STALE alarm is replaced", async () => {
    // The last fault standing after #10755. An alarm whose time has passed
    // without the handler running is orphaned -- the object was reset
    // mid-flight often enough to leave one behind -- and `=== null` read that
    // as "pending, nothing to do". Nothing fired it, nothing replaced it, and
    // the buffer had no path to a first drain: enqueues succeeded, storage was
    // healthy, and no flush ran for thirteen minutes.
    const storage = fakeStorage();
    await storage.setAlarm(NOW - 60_000);
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    assert.equal(
      await storage.getAlarm(),
      NOW + FLUSH_INTERVAL_MS,
      "a past alarm must be replaced, not respected",
    );
  });

  test("a LIVE alarm is left alone", async () => {
    // The property the original guard was protecting, and it still holds: a
    // steady stream of enqueues must not push the flush further away with
    // every write.
    const storage = fakeStorage();
    const live = NOW + 5 * 60_000;
    await storage.setAlarm(live);
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    assert.equal(await storage.getAlarm(), live);
  });

  test("an alarm exactly at now counts as stale", async () => {
    // The boundary. `<= now` rather than `< now`: an alarm due this instant
    // that has not run is the same orphan one second later.
    const storage = fakeStorage();
    await storage.setAlarm(NOW);
    await enqueueStatement(storage, stmt("neurons", "A"), NOW);
    assert.equal(await storage.getAlarm(), NOW + FLUSH_INTERVAL_MS);
  });

  test("an EMPTY drain records a verdict rather than returning silently", async () => {
    // Why three incidents were hard to tell apart: no verdict meant both "the
    // alarm never fired" and "it fired and found nothing".
    const spy = laneSpy();
    const out = await flushBuffer(fakeStorage(), {}, CTX, {
      laneHealthDb: spy.db,
      now: () => NOW,
      sql: null,
    });
    assert.equal(out.drained, 0);
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0].lane, BUFFER_FLUSH_LANE);
    assert.match(String(spy.rows[0].detail), /nothing buffered/);
  });
});

describe("the flush never scans either (#10775)", () => {
  test("a TRUNCATED drain does not list the remaining backlog", async () => {
    // The same O(n) that #10755 removed from the enqueue, reintroduced in the
    // alarm's reconcile. Measured in production: the flush at 13:23:12 drained
    // its 500 and never came back for the rest, because the scan outran the
    // handler and the re-arm never ran.
    const storage = fakeStorage();
    for (let i = 0; i < FLUSH_LIST_LIMIT + 30; i += 1) {
      await enqueueStatement(storage, stmt("neurons", `S${i}`), NOW);
    }
    let listsAfterDrain = 0;
    const realList = storage.list.bind(storage);
    let draining = false;
    storage.list = async (options) => {
      if (draining) listsAfterDrain += 1;
      return realList(options);
    };
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          draining = true;
          return [];
        },
      },
    });
    assert.equal(out.remaining, true, "it must report work left");
    assert.equal(listsAfterDrain, 0, "and must not scan to work that out");
  });

  test("a clean drain still reconciles the counter to exactly zero", async () => {
    // Drift correction lives here: an untruncated flush emptied the buffer by
    // definition, so 0 is exact and free.
    const storage = fakeStorage();
    for (let i = 0; i < 3; i += 1) {
      await enqueueStatement(storage, stmt("l", `S${i}`), NOW);
    }
    storage.map.set("pending", 4242);
    await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(await storage.get("pending"), 0);
  });

  test("a truncated drain decrements by what it settled", async () => {
    const storage = fakeStorage();
    for (let i = 0; i < FLUSH_LIST_LIMIT + 10; i += 1) {
      await enqueueStatement(storage, stmt("l", `S${i}`), NOW);
    }
    const before = (await storage.get<number>("pending")) ?? 0;
    const out = await flushBuffer(storage, {}, CTX, {
      laneHealthDb: laneSpy().db,
      now: () => NOW,
      sql: {
        async unsafe() {
          return [];
        },
      },
    });
    assert.equal(await storage.get("pending"), before - out.drained);
  });
});
