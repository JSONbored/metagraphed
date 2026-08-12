// readStore: which store a ctx-less READ goes to, and the handle it hands back.
//
// The tier readers all had the same shape -- `env.METAGRAPH_HEALTH_DB`, taken
// unconditionally -- and every table they read is now Neon's outright, so they
// were serving a frozen copy. What made them skip the earlier ports is that
// none has an ExecutionContext: createPgSql returns its connection through
// ctx.waitUntil, so moving them looked like threading a ctx through five
// modules and every caller of every one of them.
//
// This helper takes lane-health-store's way out instead -- open, run, close,
// awaiting the teardown -- so the swap is the binding expression and nothing
// else. What is asserted below is therefore mostly about the CHOICE (which
// store, and when it must refuse to be Neon) and the connection LIFETIME, since
// a per-operation connection that leaks is worse than the stale read it fixed.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  pgReadStore,
  readStore,
  type ReadStoreClient,
} from "../src/read-store.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

/** A pg client that records every call, so the lifetime is observable. */
function fakeClient(rows: unknown[] = [], failWith?: Error) {
  const calls: string[] = [];
  const client: ReadStoreClient & { calls: string[] } = {
    calls,
    async connect() {
      calls.push("connect");
    },
    async end() {
      calls.push("end");
    },
    async query(text: string, values?: unknown[]) {
      calls.push(`query:${text}:${JSON.stringify(values ?? [])}`);
      if (failWith) throw failWith;
      return { rows };
    },
  };
  return client;
}

describe("readStore chooses the store", () => {
  // "refuses until Neon is declared owner of every table it was handed"
  // retired with NEON_SOLE_STORE_TABLES (#10051): ownership is constant,
  // and the binding + the empty-list rule below are what remain decidable.

  test("goes to Neon when it owns all of them and Hyperdrive is bound", () => {
    const env = {
      HYPERDRIVE,
    };
    const store = readStore(env, ["blocks_head", "chain_detail_blocks"]);
    assert.equal(typeof store?.query, "function");
  });

  test("refuses when Hyperdrive is unbound, however the flag reads", () => {
    // The flag can say Neon owns the table while the binding to reach it is
    // missing -- a config half-applied, or a Worker whose wrangler file was not
    // updated. Sole-store is a claim about the data, not about this isolate.
    const env = {};
    assert.equal(readStore(env, ["neurons"]), undefined);
  });

  test("an empty table list is never 'Neon owns them all'", () => {
    // `every` on an empty array is true, so the natural implementation sends a
    // caller who forgot to declare its tables to Postgres unconditionally --
    // the one case where the all-or-nothing rule inverts into its opposite.
    const env = { HYPERDRIVE };
    assert.equal(readStore(env, []), undefined);
  });

  test("an injected store wins, and a missing binding is undefined not a throw", () => {
    const injected = { query: async () => [] } as never;
    assert.equal(readStore({}, ["neurons"], injected), injected);
    // Every caller already handles undefined -- an unbound store has always
    // been possible, and each one declines rather than failing the request.
    assert.equal(readStore({}, ["neurons"]), undefined);
    assert.equal(readStore(null, ["neurons"]), undefined);
  });
});

describe("the Postgres handle", () => {
  test("rewrites ? to $n and answers rows directly", async () => {
    const client = fakeClient([{ block_number: 5 }]);
    const db = pgReadStore("postgresql://x/y", { clientFactory: () => client });
    const res = await db.query(
      "SELECT block_number FROM chain_detail_blocks WHERE a = ? AND b = ?",
      [1, 2],
    );
    // Rows, not D1's { results } envelope -- that emulation retired with the
    // store it imitated (#10909).
    assert.deepEqual(res, [{ block_number: 5 }]);
    assert.deepEqual(client.calls, [
      "connect",
      "query:SELECT block_number FROM chain_detail_blocks WHERE a = $1 AND b = $2:[1,2]",
      "end",
    ]);
  });

  test("closes the connection even when the query throws", async () => {
    // The whole reason this handle can exist without a ctx is that it closes
    // its own connection. A throw that skips the close leaks one per failed
    // read, which on a serving path is worse than the stale read it replaced.
    const client = fakeClient([], new Error("boom"));
    const db = pgReadStore("postgresql://x/y", { clientFactory: () => client });
    await assert.rejects(() => db.query("SELECT 1"), /boom/);
    assert.deepEqual(client.calls.at(-1), "end");
  });

  test("opens one connection per operation, not one per handle", async () => {
    const clients: ReturnType<typeof fakeClient>[] = [];
    const db = pgReadStore("postgresql://x/y", {
      clientFactory: () => {
        const c = fakeClient([]);
        clients.push(c);
        return c;
      },
    });
    await db.query("SELECT 1");
    await db.query("SELECT 2");
    assert.equal(clients.length, 2);
    for (const c of clients) assert.deepEqual(c.calls.at(-1), "end");
  });

  test("serves a parameterless statement, which several readers use", async () => {
    // chain-detail-hot-tier's coverage read takes no parameters. Requiring a
    // values array would turn the read into a TypeError caught as "hot tier
    // unavailable" -- a silent decline.
    const client = fakeClient([{ head: 9 }]);
    const db = pgReadStore("postgresql://x/y", { clientFactory: () => client });
    assert.deepEqual(await db.query("SELECT MAX(x) AS head FROM t"), [
      { head: 9 },
    ]);
  });

  test("first() returns the row or null, never undefined", async () => {
    const withRow = pgReadStore("postgresql://x/y", {
      clientFactory: () => fakeClient([{ a: 1 }, { a: 2 }]),
    });
    assert.deepEqual(await withRow.first("SELECT a FROM t"), { a: 1 });
    const empty = pgReadStore("postgresql://x/y", {
      clientFactory: () => fakeClient([]),
    });
    assert.equal(await empty.first("SELECT a FROM t"), null);
  });
});
