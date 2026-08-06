// The revived nominator-positions sync lane (#9273), exercised END TO END
// against a REAL SQLite database through the real Worker fetch handler --
// same harness and rationale as tests/data-api-hyperparams-identity-d1.test.ts.
//
// This route answered `503 hyperdrive binding unavailable` for the whole
// period the ledger was frozen. What matters here is the write CONTRACT, and
// specifically the two ways this lane differs from its siblings: a full Alpha
// scan arrives across SEVERAL requests, so one request must never prune
// another's rows; and share_fraction multiplies a whole hotkey's stake at
// serve time, so an out-of-range value is the one field whose garbage would
// read as a plausible number rather than as an error.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import { validSyncBatchMessage } from "../src/sync-batch-queue.ts";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0011_nominator_positions.sql"),
  "utf8",
);

const PATH = "/api/v1/internal/nominator-positions-sync";
const SECRET = "test-nominator-positions-sync-secret";
const COLDKEY_A = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const COLDKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";

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
    NOMINATOR_POSITIONS_SYNC_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function post(body: unknown, token: string | null = SECRET, envOverride?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null) headers["x-nominator-positions-sync-token"] = token;
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

function positionRow(overrides: Row = {}): Row {
  return {
    coldkey: COLDKEY_A,
    hotkey: HOTKEY,
    netuid: 18,
    share_fraction: 0.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rows = () =>
  db
    .prepare("SELECT * FROM nominator_positions ORDER BY coldkey, netuid")
    .all() as Row[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("POST /api/v1/internal/nominator-positions-sync", () => {
  test("writes a batch to D1 and reports what it did", async () => {
    const response = await post({
      rows: [
        positionRow(),
        positionRow({ netuid: 4, share_fraction: 0.5 }),
        positionRow({ coldkey: COLDKEY_B, netuid: 1 }),
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      nominator_positions_written: 3,
      coldkeys_pruned: 2,
      stores: ["d1"],
      d1_statements: 3,
    });
    assert.equal(rows().length, 3);
    assert.equal(rows()[0]!.share_fraction, 0.5);
  });

  test("a later capture wins and an older one is a no-op", async () => {
    // The staleness guard is what makes a replayed or out-of-order batch safe.
    await post({ rows: [positionRow({ share_fraction: 0.25 })] });
    await post({
      rows: [
        positionRow({ share_fraction: 0.9, captured_at: 1_780_000_100_000 }),
      ],
    });
    assert.equal(rows()[0]!.share_fraction, 0.9);

    await post({
      rows: [
        positionRow({ share_fraction: 0.1, captured_at: 1_779_000_000_000 }),
      ],
    });
    assert.equal(
      rows()[0]!.share_fraction,
      0.9,
      "an older capture must never overwrite a newer one",
    );
  });

  test("a coldkey's unstaked position is pruned, and ONLY that coldkey's", async () => {
    // This is the multi-request property: a full Alpha scan does not fit one
    // body, so a batch-wide prune would delete the rows a sibling request just
    // wrote. Request 2 covers only COLDKEY_A, at a later capture -- COLDKEY_B's
    // untouched rows must survive it.
    await post({
      rows: [
        positionRow({ netuid: 18 }),
        positionRow({ netuid: 4 }),
        positionRow({ coldkey: COLDKEY_B, netuid: 1 }),
      ],
    });
    assert.equal(rows().length, 3);

    await post({
      rows: [positionRow({ netuid: 18, captured_at: 1_780_000_100_000 })],
    });
    const after = rows();
    assert.deepEqual(
      after.map((r) => [r.coldkey, r.netuid]),
      [
        [COLDKEY_A, 18],
        [COLDKEY_B, 1],
      ],
      "netuid 4 unstaked and is gone; COLDKEY_B was never in this batch and stays",
    );
  });

  test("accepts a bare array as well as {rows:[...]}", async () => {
    const response = await post([positionRow()]);
    assert.equal(response.status, 200);
    assert.equal(rows().length, 1);
  });

  test("rejects an out-of-range share_fraction", async () => {
    // share_fraction multiplies the hotkey's WHOLE stake at serve time, so 12
    // would publish twelve times that hotkey's stake as this coldkey's
    // position -- garbage that reads as a plausible number.
    for (const share_fraction of [12, -0.1, Number.NaN, "0.5", null]) {
      const response = await post({ rows: [positionRow({ share_fraction })] });
      assert.equal(response.status, 400, `share_fraction ${share_fraction}`);
    }
    assert.equal(rows().length, 0);
  });

  test("rejects a row with a bad key, netuid, captured_at, or an unknown column", async () => {
    // #9564: each rejection now names the row index and the offending FIELD,
    // instead of one shape-level sentence for a whole batch. Asserting the
    // field is strictly stronger than the old message -- it would catch a rule
    // that still rejects but for the wrong reason, which the shape-level regex
    // could not distinguish.
    const bad: [Row, RegExp][] = [
      [positionRow({ coldkey: "" }), /^row 0: coldkey /],
      [positionRow({ coldkey: 42 }), /^row 0: coldkey /],
      [positionRow({ hotkey: "x".repeat(200) }), /^row 0: hotkey /],
      [positionRow({ netuid: -1 }), /^row 0: netuid /],
      [positionRow({ netuid: 70_000 }), /^row 0: netuid /],
      [positionRow({ netuid: 1.5 }), /^row 0: netuid /],
      [positionRow({ captured_at: 0 }), /^row 0: captured_at /],
      [positionRow({ captured_at: 1.5 }), /^row 0: captured_at /],
      [positionRow({ surprise: 1 }), /^row 0: surprise /],
    ];
    for (const [row, expected] of bad) {
      const response = await post({ rows: [row] });
      assert.equal(response.status, 400, JSON.stringify(row));
      assert.match(
        (await response.json<{ error: string }>()).error,
        expected,
        JSON.stringify(row),
      );
    }
    // A non-object row, and an empty batch, are the same 400.
    assert.equal((await post({ rows: [null] })).status, 400);
    assert.equal((await post({ rows: [[1]] })).status, 400);
    assert.equal((await post({ rows: [] })).status, 400);
  });

  test("rejects a non-array body and unparseable JSON", async () => {
    const notArray = await post({ nope: true });
    assert.equal(notArray.status, 400);
    assert.match(
      (await notArray.json<{ error: string }>()).error,
      /JSON array of nominator-position rows/,
    );
    const notJson = await post("{oops");
    assert.equal(notJson.status, 400);
    assert.match(
      (await notJson.json<{ error: string }>()).error,
      /must be JSON/,
    );
  });

  test("bounds the body and the row count", async () => {
    const huge = { rows: [positionRow({ hotkey: "h".repeat(9_000_000) })] };
    assert.equal((await post(huge)).status, 413);
    const many = { rows: Array.from({ length: 25_001 }, () => positionRow()) };
    assert.equal((await post(many)).status, 413);
  });

  test("an unprovisioned deployment and a bad token never reach the store", async () => {
    const unprovisioned = await post({ rows: [positionRow()] }, SECRET, {
      METAGRAPH_HEALTH_DB: d1(),
    } as unknown as Env);
    assert.equal(unprovisioned.status, 503);
    assert.match(
      (await unprovisioned.json<{ error: string }>()).error,
      /not provisioned/,
    );

    assert.equal((await post({ rows: [positionRow()] }, "wrong")).status, 401);
    assert.equal((await post({ rows: [positionRow()] }, null)).status, 401);
    assert.equal(rows().length, 0);
  });

  test("a malformed body is a 400 even with no store bound", async () => {
    // 400-before-503: a malformed body is a client error whether or not a
    // store happens to be bound.
    const noStore = {
      NOMINATOR_POSITIONS_SYNC_SECRET: SECRET,
    } as unknown as Env;
    assert.equal((await post({ nope: 1 }, SECRET, noStore)).status, 400);
    const unbound = await post({ rows: [positionRow()] }, SECRET, noStore);
    assert.equal(unbound.status, 503);
    assert.match(
      (await unbound.json<{ error: string }>()).error,
      /d1 binding unavailable/,
    );
  });

  test("a failing D1 write is a 502, not a silent success", async () => {
    const broken = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return { bind: () => ({}) };
        },
        async batch() {
          throw new Error("D1_ERROR: disk full");
        },
      },
      NOMINATOR_POSITIONS_SYNC_SECRET: SECRET,
    } as unknown as Env;
    const response = await post({ rows: [positionRow()] }, SECRET, broken);
    assert.equal(response.status, 502);
    assert.match(
      (await response.json<{ error: string }>()).error,
      /d1 write failed/,
    );
  });
});

describe("routed to the sync queue (metagraphed-infra#355)", () => {
  function queueEnv(send: (m: unknown) => Promise<void>) {
    return env({
      SYNC_BATCHES: { send },
      SYNC_QUEUE_LANES: "nominator-positions",
    });
  }

  test("enqueues instead of writing, and never both", async () => {
    // NO DUAL WRITE. Writing twice during the migration doubles the D1 load the
    // queue exists to relieve, and a duplicate arrival would double-count any
    // completeness tally. The flag SELECTS a path; it does not fan out.
    const sent: Record<string, unknown>[] = [];
    const response = await post(
      { rows: [positionRow(), positionRow({ coldkey: COLDKEY_B, netuid: 1 })] },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      nominator_positions_written: 2,
      stores: ["queue"],
    });
    assert.equal(sent.length, 1);
    assert.equal(rows().length, 0, "D1 must not also have been written");
  });

  test("asserts coldkey-completeness on the message it sends", async () => {
    // The consumer REFUSES a nominator-positions chunk without this flag,
    // because its write prunes. A producer that stopped setting it would
    // dead-letter loudly rather than silently deleting rows the chunk did not
    // carry -- which is the whole reason the flag exists rather than a comment.
    const sent: Record<string, unknown>[] = [];
    await post(
      { rows: [positionRow()] },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );
    assert.equal(sent[0]!.lane, "nominator-positions");
    assert.equal(sent[0]!.key_complete, true);
    assert.equal(sent[0]!.captured_at, 1_780_000_000_000);
    assert.equal(validSyncBatchMessage(sent[0]), true);
  });

  test("a failed enqueue is a 502, not a silent success", async () => {
    // The producer retries on a non-2xx. Reporting ok on a dropped chunk would
    // lose the rows outright, since nothing else is writing them now.
    const response = await post(
      { rows: [positionRow()] },
      SECRET,
      queueEnv(async () => {
        throw new Error("queue unavailable");
      }),
    );
    assert.equal(response.status, 502);
    assert.equal(rows().length, 0, "no fallback write -- the lane is cut over");
  });

  test("an un-opted deployment still writes D1", async () => {
    // Rollback has to be boring: these are latest-only upsert tables refreshed
    // on a tick, so unsetting the flag simply means the next pass writes the
    // old way. No backfill, no reconciliation.
    const response = await post(
      { rows: [positionRow()] },
      SECRET,
      env({ SYNC_BATCHES: { send: async () => {} } }),
    );
    assert.equal(response.status, 200);
    assert.equal(rows().length, 1);
  });
});
