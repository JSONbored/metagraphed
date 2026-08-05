// The revived account-balances sync lane (#9478), exercised END TO END against
// a REAL SQLite database through the real Worker fetch handler -- same harness
// and rationale as tests/data-api-validator-nominator-counts-d1.test.ts.
//
// This route answered `503 hyperdrive binding unavailable` from the box wipe
// (#9193) until migration 0017 gave it a Cloudflare-native store, and it came
// out of that decommission worse off than either lane 0011/0012 revived: those
// had a frozen lakehouse export to fall back on, while `account_balances` had
// no D1 table at all. Its producer never went away -- metagraphed-infra's
// poller Container still walks System::Account exactly as it always did, and
// was writing into a Postgres that no longer exists.
//
// What matters here is the write CONTRACT. A full pass is 542,618 entries, past
// any single request body, so it arrives across ~22 requests -- which is why
// there is no prune on this lane at all, and why the staleness guard rather
// than request ordering is what keeps a replay safe. The prune's absence is
// load-bearing for a second reason the sibling lanes do not share: the producer
// SKIPS an account whose free and reserved are both zero, so "absent from the
// scan" would mean "delete every wallet that emptied" if this lane ever pruned.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0017_account_balances.sql"),
  "utf8",
);

const PATH = "/api/v1/internal/account-balances-sync";
const SECRET = "test-account-balances-sync-secret";
const SS58 = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const SS58_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            text,
            values,
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
    async batch(statements: { text: string; values: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({
          results: db
            .prepare(statement.text)
            .all(...(statement.values as never[])),
        }));
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    ACCOUNT_BALANCES_SYNC_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function post(body: unknown, token: string | null = SECRET, envOverride?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-account-balances-sync-token"] = token;
  return worker.fetch(
    new Request(`https://d${PATH}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envOverride ?? env(),
    {} as unknown as ExecutionContext,
  );
}

function balanceRow(overrides: Row = {}): Row {
  return {
    ss58: SS58,
    free_tao: 1000.5,
    reserved_tao: 25.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rows = () =>
  db.prepare("SELECT * FROM account_balances ORDER BY ss58").all() as Row[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("POST /api/v1/internal/account-balances-sync", () => {
  test("writes a batch to D1 and reports what it did", async () => {
    const response = await post({
      rows: [
        balanceRow(),
        balanceRow({ ss58: SS58_B, free_tao: 0, reserved_tao: 7 }),
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      account_balances_written: 2,
      stores: ["d1"],
      d1_statements: 1,
    });
    assert.equal(rows().length, 2);
    // A zero free_tao IS stored: the producer only skips an account whose free
    // AND reserved are both zero, so "nothing liquid, some reserved" is a real
    // balance and not a placeholder.
    assert.equal(rows()[1]!.free_tao, 0);
    assert.equal(rows()[1]!.reserved_tao, 7);
  });

  test("accepts a bare array as well as {rows:[...]}", async () => {
    // Every other sync route here speaks {rows:[...]}; a producer that posts a
    // bare array must not cost a whole six-hour cycle.
    const response = await post([balanceRow()]);
    assert.equal(response.status, 200);
    assert.equal(rows().length, 1);
  });

  test("a later capture wins and an older one is a no-op", async () => {
    // The staleness guard is what makes a replayed or out-of-order batch safe.
    // It matters more on this lane than most: the producer chunks one pass
    // across ~22 requests and re-sends on failure.
    await post({ rows: [balanceRow({ free_tao: 1000.5 })] });
    await post({
      rows: [balanceRow({ free_tao: 2000.75, captured_at: 1_780_000_100_000 })],
    });
    assert.equal(rows()[0]!.free_tao, 2000.75);

    await post({
      rows: [balanceRow({ free_tao: 1, captured_at: 1_779_000_000_000 })],
    });
    assert.equal(
      rows()[0]!.free_tao,
      2000.75,
      "an older capture must never walk a balance backwards",
    );
  });

  test("an account absent from a later batch is KEPT, never pruned", async () => {
    // The one behaviour this lane must not borrow from nominator-positions.
    // The producer skips an account whose free and reserved are both zero, so a
    // wallet that emptied simply stops appearing -- pruning on absence would
    // delete exactly those accounts, and this table has always been "every
    // account that has ever held a balance".
    await post({ rows: [balanceRow(), balanceRow({ ss58: SS58_B })] });
    assert.equal(rows().length, 2);

    await post({
      rows: [balanceRow({ captured_at: 1_780_000_100_000 })],
    });
    assert.equal(rows().length, 2, "the absent account survived the batch");
    assert.equal(rows().find((r) => r.ss58 === SS58_B)!.free_tao, 1000.5);
  });

  test("rejects a missing or wrong token (401)", async () => {
    assert.equal((await post({ rows: [balanceRow()] }, null)).status, 401);
    assert.equal((await post({ rows: [balanceRow()] }, "nope")).status, 401);
    assert.equal(rows().length, 0);
  });

  test("is disabled (503) when the secret is not configured", async () => {
    const response = await post(
      { rows: [balanceRow()] },
      SECRET,
      env({ ACCOUNT_BALANCES_SYNC_SECRET: undefined }),
    );
    assert.equal(response.status, 503);
  });

  test("answers 503 when D1 is not bound -- but only after validating (400 wins)", async () => {
    // A malformed body is a 400 whether or not a store happens to be bound;
    // answering 503 would blame the infrastructure for the caller's payload.
    const unbound = env({ METAGRAPH_HEALTH_DB: undefined });
    assert.equal(
      (await post({ rows: [balanceRow()] }, SECRET, unbound)).status,
      503,
    );
    assert.equal(
      (await post({ rows: [balanceRow({ ss58: 1 })] }, SECRET, unbound)).status,
      400,
      "validation runs before the binding check",
    );
  });

  test("rejects a body that is not JSON, or not a row array", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ rows: "nope" })).status, 400);
    assert.equal((await post({ rows: [] })).status, 400);
  });

  test("rejects rows that do not match the column shape", async () => {
    const bad: Row[] = [
      { ...balanceRow(), unexpected: 1 },
      balanceRow({ ss58: "" }),
      balanceRow({ ss58: 5 }),
      balanceRow({ ss58: "x".repeat(200) }),
      // A negative balance is not a thing System::Account can hold, and
      // src/top-holders.ts's numberOrZero would silently rewrite it to 0.
      balanceRow({ free_tao: -1 }),
      balanceRow({ reserved_tao: -0.5 }),
      // A string balance would bind fine and then sort as text on the one
      // query shape this column exists for.
      balanceRow({ free_tao: "1000.5" }),
      balanceRow({ reserved_tao: null }),
      // NaN/Infinity arrive as null over JSON and would bind NULL against a
      // NOT NULL column, failing the whole 25,000-row batch at the database.
      balanceRow({ free_tao: Number.NaN }),
      balanceRow({ free_tao: Number.POSITIVE_INFINITY }),
      balanceRow({ captured_at: 0 }),
      balanceRow({ captured_at: 1.5 }),
      "not an object" as unknown as Row,
      null as unknown as Row,
      [] as unknown as Row,
    ];
    for (const row of bad) {
      const response = await post({ rows: [row] });
      assert.equal(
        response.status,
        400,
        `expected 400 for ${JSON.stringify(row)}`,
      );
    }
    assert.equal(rows().length, 0, "no partial write from a rejected batch");
  });

  test("rejects an oversized batch (413) by rows and by bytes", async () => {
    const tooMany = Array.from({ length: 25_001 }, (_unused, i) =>
      balanceRow({ ss58: `acct-${i}` }),
    );
    assert.equal((await post({ rows: tooMany })).status, 413);

    // Body bound is checked before a row count exists -- a handful of enormous
    // strings passes the row bound and must still be refused.
    const huge = JSON.stringify({ rows: [balanceRow()] }).padEnd(
      8_000_001,
      " ",
    );
    assert.equal((await post(huge)).status, 413);
    assert.equal(rows().length, 0);
  });

  test("chunks a batch under the binding's 100-parameter limit", async () => {
    // Four columns puts 25 rows in a statement, so this is the wall #9157 hit
    // in production -- a full pass is ~21,700 statements and a hand-rolled
    // batch would fail on the first request.
    const many = Array.from({ length: 60 }, (_unused, i) =>
      balanceRow({ ss58: `acct-${i}` }),
    );
    const response = await post({ rows: many });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      account_balances_written: 60,
      stores: ["d1"],
      d1_statements: 3,
    });
    assert.equal(rows().length, 60);
  });

  test("a D1 failure is a 502, not a silent success", async () => {
    db.exec("DROP TABLE account_balances");
    const response = await post({ rows: [balanceRow()] });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "d1 write failed" });
  });
});
