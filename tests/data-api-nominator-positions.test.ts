// The revived nominator-positions sync lane (#9273), exercised END TO END
// against a REAL SQLite database through the real Worker fetch handler --
// same harness and rationale as tests/data-api-hyperparams-identity.test.ts.
//
// This route answered the dispatcher's no-handler 503 -- worded `hyperdrive
// binding unavailable` at the time -- for the whole period the ledger was
// frozen. What matters here is the write CONTRACT, and
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
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { DataApiWorkerEnv } from "../workers/types.ts";

const { default: worker } = await import("../workers/data-api.ts");

const SCHEMA =
  fs.readFileSync(
    path.join(
      process.cwd(),
      "tests/fixtures/sqlite-schema/0011_nominator_positions.sql",
    ),
    "utf8",
  ) +
  fs.readFileSync(
    path.join(
      process.cwd(),
      "tests/fixtures/sqlite-schema/0029_nominator_positions_passes.sql",
    ),
    "utf8",
  );

const PATH = "/api/v1/internal/nominator-positions-sync";
const SECRET = "test-nominator-positions-sync-secret";
const COLDKEY_A = "5Df7xwEPkZm4itD3PfSzHsV9extvnQpTFBiNCSgBCJtxEP9e";
const COLDKEY_B = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const HOTKEY_B = "5CXRfP2ekFhYQ6BCwEy5V8YyxgLmUmTNzHZTKAfTHKhKPBqE";

let db: InstanceType<typeof DatabaseSync>;

function env(overrides: Record<string, unknown> = {}): DataApiWorkerEnv {
  return dataApiEnv({
    NOMINATOR_POSITIONS_SYNC_SECRET: SECRET,
    ...overrides,
  });
}

function post(
  body: unknown,
  token: string | null = SECRET,
  envOverride?: DataApiWorkerEnv,
) {
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

const passes = () =>
  db
    .prepare("SELECT * FROM nominator_positions_passes ORDER BY captured_at")
    .all() as Row[];

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

describe("POST /api/v1/internal/nominator-positions-sync", () => {
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
    const unprovisioned = await post(
      { rows: [positionRow()] },
      SECRET,
      dataApiEnv({}),
    );
    assert.equal(unprovisioned.status, 503);
    assert.match(
      (await unprovisioned.json<{ error: string }>()).error,
      /not provisioned/,
    );

    assert.equal((await post({ rows: [positionRow()] }, "wrong")).status, 401);
    assert.equal((await post({ rows: [positionRow()] }, null)).status, 401);
    assert.equal(rows().length, 0);
  });
});

describe("pass completeness (metagraphed-infra#346)", () => {
  test("the queue path carries the declaration too", async () => {
    // The path this lane actually takes. A queue knows a message was
    // DELIVERED; it does not know whether the producer's whole scan arrived,
    // and only the second fact catches a load that stopped halfway.
    const sent: Row[] = [];
    const res = await post(
      { pass_total: 7, rows: [positionRow()] },
      SECRET,
      env({
        SYNC_BATCHES: { send: async (m: Row) => void sent.push(m) },
        SYNC_QUEUE_LANES: "nominator-positions",
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Row).pass_total, 7);
    assert.equal(sent[0]!.pass_total, 7);
    assert.equal(rows().length, 0, "enqueued, not written -- never both");
    assert.equal(
      passes().length,
      0,
      "and the tally is the consumer's to write",
    );
  });

  test("rejects a declaration the request contradicts", async () => {
    // Two stamps in one request would credit rows to whichever one the code
    // happened to pick, and a reader would trust a total never delivered under
    // that key.
    const twoStamps = await post({
      pass_total: 5,
      rows: [positionRow(), positionRow({ captured_at: 1_780_000_000_001 })],
    });
    assert.equal(twoStamps.status, 400);
    // And a total under this request's own row count is incoherent.
    const tooSmall = await post({
      pass_total: 1,
      rows: [positionRow(), positionRow({ hotkey: HOTKEY_B })],
    });
    assert.equal(tooSmall.status, 400);
    assert.equal(passes().length, 0, "neither wrote a tally");
  });

  test("rejects an absurd, negative or fractional pass_total", async () => {
    for (const bad of [0, -1, 1.5, "many"]) {
      const res = await post({ pass_total: bad, rows: [positionRow()] });
      assert.equal(res.status, 400, String(bad));
    }
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

      pass_total: null,
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
});
