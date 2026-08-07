// The revived validator-nominator-counts sync lane (#9146), exercised END TO
// END against a REAL SQLite database through the real Worker fetch handler --
// same harness and rationale as tests/data-api-nominator-positions-d1.test.ts.
//
// This route answered `503 hyperdrive binding unavailable` from the box wipe
// (#9193) until migration 0012 gave it a Cloudflare-native store. Its producer
// never went away: metagraphed-infra's poller Container already runs the full
// SubtensorModule::Alpha scan this table is derived from, and was disabled only
// because it wrote to a Postgres that no longer exists.
//
// What matters here is the write CONTRACT. A full scan is ~113k rows, past any
// single request body, so it arrives across SEVERAL requests -- which is why
// there is no prune on this lane at all, and why the staleness guard rather
// than request ordering is what keeps a replay safe.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");
const { QUEUE_MESSAGE_MAX_BYTES } = await import("../src/sync-batch-queue.ts");

const SCHEMA =
  fs.readFileSync(
    path.join(
      process.cwd(),
      "migrations/d1/0012_validator_nominator_counts.sql",
    ),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(
      process.cwd(),
      "migrations/d1/0029_nominator_positions_passes.sql",
    ),
    "utf8",
  );

const passes = () =>
  db
    .prepare(
      "SELECT * FROM validator_nominator_counts_passes ORDER BY captured_at",
    )
    .all() as Row[];

const PATH = "/api/v1/internal/validator-nominator-counts-sync";
const SECRET = "test-validator-nominator-counts-sync-secret";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

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
    VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function post(body: unknown, token: string | null = SECRET, envOverride?: Env) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== null)
    headers["x-validator-nominator-counts-sync-token"] = token;
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

function countRow(overrides: Row = {}): Row {
  return {
    hotkey: HOTKEY,
    nominator_count: 12,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

const rows = () =>
  db
    .prepare("SELECT * FROM validator_nominator_counts ORDER BY hotkey")
    .all() as Row[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("POST /api/v1/internal/validator-nominator-counts-sync", () => {
  test("writes a batch to D1 and reports what it did", async () => {
    const response = await post({
      rows: [countRow(), countRow({ hotkey: HOTKEY_B, nominator_count: 0 })],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      nominator_counts_written: 2,
      stores: ["d1"],
      d1_statements: 1,

      pass_total: null,
    });
    assert.equal(rows().length, 2);
    // A zero IS stored -- the producer's scan is exhaustive, so "this hotkey
    // has no nominators" is an answer it can legitimately report.
    assert.equal(rows()[1]!.nominator_count, 0);
  });

  test("accepts a bare array as well as {rows:[...]}", async () => {
    // The producer posts a bare array; every other sync route here speaks
    // {rows:[...]}. A mismatch must not cost a whole 24h cycle.
    const response = await post([countRow()]);
    assert.equal(response.status, 200);
    assert.equal(rows().length, 1);
  });

  test("a later capture wins and an older one is a no-op", async () => {
    // The staleness guard is what makes a replayed or out-of-order batch safe.
    // It matters more on this lane than most: the producer chunks one scan
    // across several requests and re-sends on failure.
    await post({ rows: [countRow({ nominator_count: 12 })] });
    await post({
      rows: [countRow({ nominator_count: 30, captured_at: 1_780_000_100_000 })],
    });
    assert.equal(rows()[0]!.nominator_count, 30);

    await post({
      rows: [countRow({ nominator_count: 1, captured_at: 1_779_000_000_000 })],
    });
    assert.equal(
      rows()[0]!.nominator_count,
      30,
      "an older capture must never walk a count backwards",
    );
  });

  test("rejects a missing or wrong token (401)", async () => {
    assert.equal((await post({ rows: [countRow()] }, null)).status, 401);
    assert.equal((await post({ rows: [countRow()] }, "nope")).status, 401);
    assert.equal(rows().length, 0);
  });

  test("is disabled (503) when the secret is not configured", async () => {
    const response = await post(
      { rows: [countRow()] },
      SECRET,
      env({ VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: undefined }),
    );
    assert.equal(response.status, 503);
  });

  test("answers 503 when D1 is not bound -- but only after validating (400 wins)", async () => {
    // A malformed body is a 400 whether or not a store happens to be bound;
    // answering 503 would blame the infrastructure for the caller's payload.
    const unbound = env({ METAGRAPH_HEALTH_DB: undefined });
    assert.equal(
      (await post({ rows: [countRow()] }, SECRET, unbound)).status,
      503,
    );
    assert.equal(
      (await post({ rows: [countRow({ hotkey: 1 })] }, SECRET, unbound)).status,
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
      { ...countRow(), unexpected: 1 },
      countRow({ hotkey: "" }),
      countRow({ hotkey: 5 }),
      countRow({ hotkey: "x".repeat(200) }),
      countRow({ nominator_count: -1 }),
      countRow({ nominator_count: 1.5 }),
      countRow({ nominator_count: "12" }),
      countRow({ captured_at: 0 }),
      countRow({ captured_at: 1.5 }),
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
    const tooMany = Array.from({ length: 50_001 }, (_unused, i) =>
      countRow({ hotkey: `hk-${i}` }),
    );
    assert.equal((await post({ rows: tooMany })).status, 413);

    // Body bound is checked before a row count exists -- a handful of enormous
    // strings passes the row bound and must still be refused.
    const huge = JSON.stringify({ rows: [countRow()] }).padEnd(8_000_001, " ");
    assert.equal((await post(huge)).status, 413);
    assert.equal(rows().length, 0);
  });

  test("a D1 failure is a 502, not a silent success", async () => {
    db.exec("DROP TABLE validator_nominator_counts");
    const response = await post({ rows: [countRow()] });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "d1 write failed" });
  });
});

describe("routed to the sync queue (metagraphed-infra#355)", () => {
  function queueEnv(send: (m: unknown) => Promise<void>) {
    return env({
      SYNC_BATCHES: { send },
      SYNC_QUEUE_LANES: "validator-nominator-counts",
    });
  }

  test("enqueues instead of writing, and never both", async () => {
    const sent: Record<string, unknown>[] = [];
    const response = await post(
      { rows: [countRow(), countRow({ hotkey: HOTKEY_B })] },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    // This lane declares no pass, so the message must not invent one --
    // a fabricated total would mark an unproven load complete.
    assert.equal("pass_total" in sent[0]!, false);
    assert.equal(rows().length, 0, "D1 must not also have been written");
  });

  test("a chunk too large for one message is split, not dropped", async () => {
    // metagraphed-infra#360: this lane's producer ceiling is 50,000 rows, which
    // is ~49x the 128 KB transport cap.
    const big = Array.from({ length: 4_000 }, (_, i) =>
      countRow({ hotkey: `5${String(i).padStart(47, "N")}` }),
    );
    const sent: Record<string, unknown>[] = [];
    const response = await post(
      { rows: big },
      SECRET,
      queueEnv(async (m) => {
        sent.push(m as Record<string, unknown>);
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(sent.length > 1, true, "one message could not have held it");
    for (const m of sent) {
      assert.equal(JSON.stringify(m).length <= QUEUE_MESSAGE_MAX_BYTES, true);
    }
    assert.equal(
      sent.flatMap((m) => m.rows as Row[]).length,
      big.length,
      "fanning out must not lose rows",
    );
  });

  test("502s when the enqueue fails, so the producer retries the chunk", async () => {
    const response = await post(
      { rows: [countRow()] },
      SECRET,
      queueEnv(async () => Promise.reject(new Error("over capacity"))),
    );
    assert.equal(response.status, 502);
    assert.equal(rows().length, 0);
  });
});

describe("pass completeness (metagraphed#9783)", () => {
  test("a declared pass is tallied and completes when the rows land", async () => {
    // A count cannot prove completeness: 100,000 well-formed rows look exactly
    // like 222,000 of them, only fewer. A short pass here under-reports how
    // many delegators a validator has, which reads as a validator losing
    // support rather than as a load that did not finish.
    const first = await post({ pass_total: 2, rows: [countRow()] });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as Row).pass_total, 2);
    assert.equal(passes()[0]!.received_rows, 1);
    assert.equal(passes()[0]!.completed_at, null);

    await post({ pass_total: 2, rows: [countRow({ hotkey: HOTKEY_B })] });
    assert.equal(passes()[0]!.received_rows, 2);
    assert.ok(
      passes()[0]!.completed_at,
      "the write that closed the gap stamps it",
    );
  });

  test("the queue path carries the declaration too", async () => {
    // A queue knows a message was DELIVERED; it does not know whether the whole
    // scan arrived. The declaration has to survive the transport or the tally
    // means nothing on the path the lane actually takes.
    const sent: Row[] = [];
    const res = await post(
      { pass_total: 9, rows: [countRow()] },
      SECRET,
      env({
        SYNC_BATCHES: { send: async (m: Row) => void sent.push(m) },
        SYNC_QUEUE_LANES: "validator-nominator-counts",
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Row).pass_total, 9);
    assert.equal(sent[0]!.pass_total, 9);
    assert.equal(rows().length, 0, "enqueued, not written -- never both");
  });

  test("omitting pass_total writes no tally", async () => {
    await post({ rows: [countRow()] });
    assert.equal(passes().length, 0);
  });

  test("rejects a declaration the request contradicts", async () => {
    assert.equal(
      (
        await post({
          pass_total: 5,
          rows: [
            countRow(),
            countRow({ hotkey: HOTKEY_B, captured_at: 1_780_000_000_001 }),
          ],
        })
      ).status,
      400,
      "two captured_at stamps under one declaration",
    );
    assert.equal(
      (
        await post({
          pass_total: 1,
          rows: [countRow(), countRow({ hotkey: HOTKEY_B })],
        })
      ).status,
      400,
      "a total smaller than this request's own rows",
    );
    for (const bad of [0, -3, 2.5, "lots"]) {
      assert.equal(
        (await post({ pass_total: bad, rows: [countRow()] })).status,
        400,
        String(bad),
      );
    }
    assert.equal(passes().length, 0, "none of them wrote a tally");
  });
});
