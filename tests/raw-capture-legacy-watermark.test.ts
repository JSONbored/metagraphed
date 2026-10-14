// Wiring tests for src/raw-capture-sync.ts. The capture guarantee itself is
// proven in tests/raw-chain-capture.test.ts; what matters here is that the
// lane REFUSES to run when it could not honour that guarantee — an unbound
// store or watermark must be a loud no-op, never a quiet one, because a lane
// that silently does nothing looks exactly like a healthy one.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import { mirrorRawCaptureStateToNeon } from "../src/capture-state-neon-write.ts";

// The watermark's store is Postgres now (#10179): both halves of it --
// neonWatermark's read and mirrorRawCaptureStateToNeon's write -- build their
// own `new Client(...)`, so there is no handle a caller can inject. Mocking the
// module is the seam, and the real SQLite fixture below is attached to the
// controller so the watermark SQL is EXECUTED rather than merely recorded --
// which is the whole point of this file's fixture: the one thing that can break
// here is a column name, and a fake that records SQL never parses it.
//
// See tests/helpers/pg-mock.ts for why the controller has to be built inside
// vi.hoisted: vi.mock is hoisted above every import, so a plain `const` is read
// before initialisation.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { watermarkRead } from "../src/raw-capture-sync.ts";
/**
 * The raw-capture migrations, IN ORDER — 0006 creates the table, 0013 rebuilds
 * it with a network dimension (#8700), and 0014 persists lane verdicts.
 *
 * Applied as a chain rather than as a single final schema on purpose. D1
 * migrations in this repo are applied BY HAND to production, so the thing worth
 * proving is not "the end state parses" but "0013 applies cleanly on top of a
 * live 0006 table and carries its row across" — 0013 drops and recreates the
 * table, and a mistake there silently resets the mainnet watermark to the
 * floor, which would re-capture ~3,000 blocks and briefly report a gap that
 * does not exist.
 */
const MIGRATIONS = [
  "0006_raw_capture.sql",
  "0013_raw_capture_network.sql",
  "0014_lane_health.sql",
].map((name) =>
  fs.readFileSync(
    path.join(process.cwd(), "tests/fixtures/sqlite-schema", name),
    "utf8",
  ),
);

function applyMigrations(target: InstanceType<typeof DatabaseSync>) {
  for (const sql of MIGRATIONS) target.exec(sql);
}

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
  pg.control.db = db;
  pg.control.queries.length = 0;
});

/** A `first()/run()/query()` facade over the same real SQLite database.
 *
 * Still hand-built rather than taken from the mock, because `watermarkRead` is
 * a READ-ONLY helper that takes a handle -- the lakehouse-seam watchdog passes
 * it one from `readStore` -- so its tests exercise the function directly rather
 * than through a store the lane resolves for itself. */
function runner() {
  return {
    first: async (sql: string, values: unknown[] = []) =>
      (db.prepare(sql).get(...(values as never[])) ?? null) as Record<
        string,
        unknown
      > | null,
    run: async (sql: string, values: unknown[] = []) => {
      db.prepare(sql).run(...(values as never[]));
      return { changes: 1 };
    },
    query: async (sql: string, values: unknown[] = []) =>
      db.prepare(sql).all(...(values as never[])) as Record<string, unknown>[],
  };
}

afterEach(() => db.close());
const CTX = { waitUntil: () => {} };
function envWith() {
  return { env: pgMockEnv() };
}
describe("watermarkRead", () => {
  test("returns null when no row exists yet", async () => {
    assert.equal(await watermarkRead(runner() as never)(), null);
  });

  test("reads back the row the capture lane writes, per network", async () => {
    db.prepare(
      `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
       VALUES (?, ?, ?)`,
    ).run("mainnet", 42, 7);
    db.prepare(
      `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
       VALUES (?, ?, ?)`,
    ).run("testnet", 99, 7);
    assert.equal(await watermarkRead(runner() as never, "mainnet")(), 42);
    assert.equal(await watermarkRead(runner() as never, "testnet")(), 99);
  });

  // THE MONOTONIC GUARANTEE, executed rather than pattern-matched.
  //
  // Run against the real engine on purpose: the guard is a CASE inside the
  // upsert, and a test that greps the statement text proves the string exists,
  // not that the database honours it. Formatting alone would satisfy a regex.
  test("a late, LOWER write cannot rewind the watermark", async () => {
    // Measured in production 2026-08-16, minutes after #11406 removed the
    // buffer that had been serialising these writes: the lane drained a steady
    // 395 blocks/min for eight ticks, then jumped BACKWARDS ~2,795 blocks in
    // one tick (5,683 behind -> 8,478 behind). A tick reads the watermark once
    // at its start and writes once per chunk, so a tick that overruns the
    // one-minute cron overlaps the next one and its late, lower writes clobber
    // the newer tick's progress. Idempotent R2 keys meant no corruption -- just
    // the lane spending its whole budget re-reading what it already had.
    // Driven through the PRODUCTION writer, not a copy of its SQL: a test that
    // re-types the statement proves SQLite honours the statement in the test,
    // which is true no matter what mirrorRawCaptureStateToNeon actually sends.
    const { env } = envWith();
    const write = (block: number, at: number) =>
      mirrorRawCaptureStateToNeon(env as never, CTX, "mainnet", block, at, {
        laneHealthDb: null,
      });
    await write(8_850_529, 100);
    // The overlapping tick, finishing late with the height it started from.
    await write(8_847_734, 200);
    assert.equal(
      await watermarkRead(runner() as never, "mainnet")(),
      8_850_529,
      "the higher, already-durable height must survive the stale writer",
    );
    // ...and a genuinely NEW height still advances it, or the guard would have
    // frozen the lane instead of protecting it.
    await write(8_851_000, 300);
    assert.equal(
      await watermarkRead(runner() as never, "mainnet")(),
      8_851_000,
      "forward progress is unaffected",
    );
  });

  // A value that is not a number is not a watermark of zero: the capture
  // treats null as "start at the floor" and 0 as a real position, so
  // conflating them would re-capture from block 0.
  //
  // ASSERTED AGAINST A STUB, not the fixture, and deliberately so: 0013
  // declares `last_contiguous_block INTEGER NOT NULL`, and SQLite enforces it
  // -- the row this guard is about cannot be inserted at all. What CAN reach
  // the guard is a non-number from the driver: `pg` returns int8 as a STRING
  // unless a type parser is installed, and `typeof "8756635"` is not "number".
  // So the shapes below are the ones the store can actually hand back, which
  // is what the type guard is for.
  test("a non-numeric reading is null, never 0", async () => {
    for (const value of [null, undefined, "8756635", {}]) {
      const stub = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ last_contiguous_block: value }),
          }),
        }),
      };
      assert.equal(
        await watermarkRead(stub as never, "mainnet")(),
        null,
        JSON.stringify(value ?? null),
      );
    }
  });
});
