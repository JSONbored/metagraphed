import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import worker from "../workers/data-api.ts";
import {
  coldkeyMaxCapturedAt,
  mirrorNominatorPositionsToNeon,
  POSITION_SOURCE_SELF_STAKE,
} from "../src/nominator-positions-neon-write.ts";
import {
  NOMINATOR_SCAN_RECEIPTS_RETENTION_MS,
  writeNominatorScanReceipts,
} from "../src/nominator-scan-receipts.ts";

const NOW = 1_785_800_000_000;
const COLDKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
const migrations = [
  "0005_remaining_d1_tables.sql",
  "0006_lane_health.sql",
  "0007_hand_created_tables.sql",
  "0025_nominator_positions_shares.sql",
  "0027_nominator_positions_source.sql",
  "0035_nominator_scan_receipts.sql",
];
let db: PGlite;
let failReceipts = false;
const sql = {
  async unsafe(text: string, values: unknown[] = []) {
    if (failReceipts && text.includes("INSERT INTO nominator_scan_receipts")) {
      throw new Error("receipt storage unavailable");
    }
    return (await db.query(text, values)).rows;
  },
};
const position = (coldkey = COLDKEY, capturedAt = NOW, hotkey = HOTKEY) => ({
  coldkey,
  hotkey,
  netuid: 1,
  share_fraction: 1,
  captured_at: capturedAt,
});
const mirror = (rows: ReturnType<typeof position>[], source?: string) =>
  mirrorNominatorPositionsToNeon(
    {},
    null,
    { rows, coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows), source },
    { sql, now: () => NOW },
  );
const receipts = async () =>
  (
    await db.query<{ captured_at: number; coldkey: string; row_count: number }>(
      "SELECT * FROM nominator_scan_receipts ORDER BY captured_at, coldkey",
    )
  ).rows;

beforeAll(async () => {
  db = new PGlite();
  for (const file of migrations) {
    await db.exec(fs.readFileSync(`migrations/neon/${file}`, "utf8"));
  }
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.exec(
    "TRUNCATE nominator_positions, nominator_positions_passes, nominator_scan_receipts, lane_health",
  );
  failReceipts = false;
  pg.control.postgres = sql.unsafe;
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
  pg.control.onQuery = null;
});

describe("full-scan receipts", () => {
  test("replaying a complete coldkey chunk does not inflate its receipt", async () => {
    const rows = [
      position(),
      position(COLDKEY, NOW, "another-hotkey"),
      position("other-coldkey"),
    ];
    assert.equal((await mirror(rows)).coverage?.ok, true);
    const first = await receipts();
    assert.deepEqual(
      first.map((r) => r.row_count),
      [2, 1],
    );
    assert.equal((await mirror(rows)).coverage?.ok, true);
    assert.deepEqual(await receipts(), first);
  });

  test("self-stake source takeover cannot erase or freshen full-scan evidence", async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      position(`coldkey-${i}`),
    );
    assert.equal((await mirror(rows)).coverage?.rows, 100);
    const original = await receipts();
    const topUp = rows
      .slice(0, 30)
      .map((row) => ({ ...row, captured_at: NOW + 1000 }));
    const out = await mirror(topUp, POSITION_SOURCE_SELF_STAKE);
    assert.equal(out.write?.ok, true);
    assert.equal(out.coverage, undefined);
    assert.deepEqual(await receipts(), original);
    const counts = (
      await db.query(
        "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE source = 'alpha') AS alpha FROM nominator_positions",
      )
    ).rows[0];
    assert.deepEqual(counts, { total: 100, alpha: 70 });
  });

  test("a delayed scan records its own capture without overwriting newer position data", async () => {
    await mirror([position(COLDKEY, NOW + 1000)], POSITION_SOURCE_SELF_STAKE);
    assert.equal((await mirror([position()])).coverage?.ok, true);
    assert.deepEqual(await receipts(), [
      { captured_at: NOW, coldkey: COLDKEY, row_count: 1 },
    ]);
    const row = (
      await db.query("SELECT captured_at, source FROM nominator_positions")
    ).rows[0];
    assert.deepEqual(row, {
      captured_at: NOW + 1000,
      source: POSITION_SOURCE_SELF_STAKE,
    });
  });

  test("keeps captures distinct and expires only receipts outside the history window", async () => {
    const cutoff = NOW - NOMINATOR_SCAN_RECEIPTS_RETENTION_MS;
    await writeNominatorScanReceipts(sql, [position(COLDKEY, cutoff - 1)]);
    await writeNominatorScanReceipts(sql, [position(COLDKEY, cutoff)]);
    await writeNominatorScanReceipts(sql, [position()]);
    assert.deepEqual(
      (await receipts()).map((r) => r.captured_at),
      [cutoff, NOW],
    );
    await writeNominatorScanReceipts(sql, [position(COLDKEY, NOW - 1000)]);
    assert.deepEqual(
      (await receipts()).map((r) => r.captured_at),
      [cutoff, NOW - 1000, NOW],
    );
  });

  test("an empty chunk does not access storage", async () => {
    const unsafe = vi.fn();
    assert.deepEqual(await writeNominatorScanReceipts({ unsafe }, []), {
      ok: true,
      rows: 0,
      statements: 0,
    });
    assert.equal(unsafe.mock.calls.length, 0);
  });

  test.each([new Error("unavailable"), "disconnected"])(
    "reports a receipt failure in band: %s",
    async (error) => {
      const out = await writeNominatorScanReceipts(
        {
          unsafe: async () => {
            throw error;
          },
        },
        [position()],
      );
      assert.equal(out.ok, false);
      assert.equal(out.reason, error instanceof Error ? error.message : error);
    },
  );

  test("a failed receipt withholds the pass tally after positions have landed", async () => {
    failReceipts = true;
    const rows = [position()];
    const out = await mirrorNominatorPositionsToNeon(
      {},
      null,
      {
        rows,
        coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(rows),
        pass: { capturedAt: NOW, expectedRows: 1, receivedRows: 1, nowMs: NOW },
      },
      { sql, now: () => NOW },
    );
    assert.equal(out.write?.ok, true);
    assert.equal(out.prune?.ok, true);
    assert.equal(out.coverage?.ok, false);
    assert.equal(out.pass, undefined);
    assert.deepEqual(
      (await db.query("SELECT * FROM nominator_positions_passes")).rows,
      [],
    );
  });

  test("the HTTP writer returns a retryable error when a receipt fails", async () => {
    failReceipts = true;
    const response = await worker.fetch(
      new Request(
        "https://example.test/api/v1/internal/nominator-positions-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nominator-positions-sync-token": "receipt-test-secret",
          },
          body: JSON.stringify({ rows: [position()], pass_total: 1 }),
        },
      ),
      {
        ...pgMockEnv(),
        NOMINATOR_POSITIONS_SYNC_SECRET: "receipt-test-secret",
      } as never,
      { waitUntil() {} } as never,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(
      (await db.query("SELECT * FROM nominator_positions_passes")).rows,
      [],
    );
  });

  test("the queue retries a receipt failure and acknowledges its successful replay", async () => {
    const calls: string[] = [];
    const message = {
      body: {
        lane: "nominator-positions",
        captured_at: NOW,
        key_complete: true,
        pass_total: 1,
        rows: [position()],
      },
      ack: () => calls.push("ack"),
      retry: () => calls.push("retry"),
    };
    failReceipts = true;
    await worker.queue!(
      { messages: [message] } as never,
      pgMockEnv() as never,
      { waitUntil() {} } as never,
    );
    assert.deepEqual(calls, ["retry"]);
    failReceipts = false;
    await worker.queue!(
      { messages: [message] } as never,
      pgMockEnv() as never,
      { waitUntil() {} } as never,
    );
    assert.deepEqual(calls, ["retry", "ack"]);
    assert.deepEqual(await receipts(), [
      { captured_at: NOW, coldkey: COLDKEY, row_count: 1 },
    ]);
  });
});
