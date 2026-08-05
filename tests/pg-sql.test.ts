// The Postgres tagged-template runner (metagraphed-infra#336).
//
// THE BUG THIS FILE EXISTS FOR is not a crash. `createD1Sql` builds its
// statement with `strings.join("?")` because SQLite placeholders carry no
// index; Postgres placeholders are `$1, $2, ...` and the numbering must line up
// with the value order exactly. An off-by-one there does not throw -- it binds
// values to the WRONG COLUMNS and returns a confident wrong answer, which is
// the failure mode this repo's column-order tests keep guarding against.
//
// So the assertions are about the built TEXT and the value order, not merely
// that a query ran.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createPgSql, pgStatementText } from "../src/pg-sql.ts";

/** A `pg` Client stand-in that records what it was asked to do. */
function fakeClient(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const life: string[] = [];
  const client = {
    async connect() {
      life.push("connect");
    },
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows };
    },
    async end() {
      life.push("end");
      return undefined;
    },
  };
  return { client, calls, life };
}

function ctxSpy() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
    },
    pending,
  };
}

describe("pgStatementText", () => {
  test("numbers placeholders from $1, interleaved with the literals", () => {
    // The tagged template `SELECT ${a} WHERE b = ${c}` arrives as three chunks
    // and two values; the placeholders belong BETWEEN them, 1-based.
    assert.equal(
      pgStatementText(["SELECT * FROM t WHERE a = ", " AND b = ", ""]),
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  test("a statement with no values is unchanged", () => {
    assert.equal(pgStatementText(["SELECT 1"]), "SELECT 1");
  });

  test("placeholder count matches value count, at width", () => {
    // Three placeholders for three values -- the property that actually has to
    // hold, asserted rather than eyeballed at one size.
    const chunks = ["a ", " b ", " c ", " d"];
    const text = pgStatementText(chunks);
    assert.deepEqual(text.match(/\$\d+/g), ["$1", "$2", "$3"]);
  });

  test("does NOT emit SQLite's placeholder", () => {
    // The whole point of this function: `strings.join("?")` is correct for D1
    // and silently wrong here.
    assert.equal(pgStatementText(["x = ", ""]).includes("?"), false);
  });
});

describe("createPgSql", () => {
  test("passes values positionally, in template order", async () => {
    const { client, calls } = fakeClient([{ n: 1 }]);
    const { ctx } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );
    const rows =
      await sql`SELECT * FROM t WHERE account = ${"5A"} AND netuid = ${64}`;
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.equal(
      calls[0]!.text,
      "SELECT * FROM t WHERE account = $1 AND netuid = $2",
    );
    // Order is the contract: swapped values here would query a netuid named
    // "5A" and an account named 64, and Postgres would happily return nothing.
    assert.deepEqual(calls[0]!.values, ["5A", 64]);
  });

  test("returns the connection via waitUntil, not on the response path", async () => {
    // Hyperdrive holds the real pool; this handle must go back to it. Awaiting
    // the teardown would add its latency to every read, and leaking it would
    // exhaust the origin's connection limit -- the one way to turn a pooled
    // setup back into an unpooled one.
    //
    // The property is that the READ RESOLVES WITHOUT THE TEARDOWN HAVING
    // SETTLED -- not that end() is uncalled. It is called immediately; only
    // awaiting it is deferred, which an earlier version of this test got
    // backwards and asserted the opposite of.
    let release!: () => void;
    const ended = new Promise<void>((r) => {
      release = r;
    });
    let settled = false;
    const { client } = fakeClient();
    client.end = async () => {
      await ended;
      settled = true;
      return undefined;
    };
    const { ctx, pending } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );

    await sql`SELECT 1`;
    assert.equal(settled, false, "the read must not wait on the teardown");
    assert.equal(pending.length, 1, "the teardown is handed to waitUntil");

    release();
    await Promise.all(pending);
    assert.equal(settled, true, "and it does complete, in the background");
  });

  test("a failed teardown never fails the read", async () => {
    const { client } = fakeClient([{ ok: true }]);
    client.end = async () => {
      throw new Error("pool gone");
    };
    const { ctx, pending } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );
    assert.deepEqual(await sql`SELECT 1`, [{ ok: true }]);
    await Promise.all(pending); // must not reject
  });

  test("a query failure still returns the connection", async () => {
    // Otherwise one bad statement leaks a connection, and a route that errors
    // under load takes the pool down with it.
    const { client, life } = fakeClient();
    client.query = async () => {
      throw new Error("syntax error");
    };
    const { ctx, pending } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );
    await assert.rejects(() => sql`SELECT bad`);
    await Promise.all(pending);
    assert.deepEqual(life, ["connect", "end"]);
  });

  test("unsafe() takes prebuilt text, matching createD1Sql's escape hatch", async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );
    await sql.unsafe("SELECT * FROM t WHERE id = $1", [7]);
    assert.equal(calls[0]!.text, "SELECT * FROM t WHERE id = $1");
    assert.deepEqual(calls[0]!.values, [7]);
  });

  test("an empty result set is [] rather than undefined", async () => {
    // Callers destructure `rows[0]`; undefined here would throw inside a read
    // path instead of shaping an empty response.
    const { client } = fakeClient();
    client.query = async () => ({ rows: undefined }) as never;
    const { ctx } = ctxSpy();
    const sql = createPgSql(
      { connectionString: "postgres://x" },
      ctx,
      () => client as never,
    );
    assert.deepEqual(await sql`SELECT 1`, []);
  });
});
