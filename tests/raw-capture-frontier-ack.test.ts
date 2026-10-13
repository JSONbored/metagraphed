import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, test } from "vitest";
import { neonWatermark } from "../src/raw-capture-sync.ts";

let db: DatabaseSync;
const failures = { reads: false, writes: false };

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const name of ["0006_raw_capture.sql", "0013_raw_capture_network.sql"])
    db.exec(
      readFileSync(
        new URL(`./fixtures/sqlite-schema/${name}`, import.meta.url),
        "utf8",
      ),
    );
  failures.reads = false;
  failures.writes = false;
});
afterEach(() => db.close());

function store() {
  const env = {
    D1_STATE_TABLES: "raw_capture_state",
    D1_STATE: {
      prepare: (text: string) => ({
        bind: (...values: SQLInputValue[]) => ({
          all: async () => {
            const reading = /^\s*SELECT/.test(text);
            if (reading && failures.reads)
              throw new Error("readback unavailable");
            if (!reading && failures.writes)
              throw new Error("write unavailable");
            const statement = db.prepare(text);
            if (reading)
              return {
                success: true,
                results: statement.all(...values),
                meta: {},
              };
            const result = statement.run(...values);
            return {
              success: true,
              results: [],
              meta: { changes: Number(result.changes) },
            };
          },
        }),
      }),
      batch: async () => {
        throw new Error("unexpected batch");
      },
    },
  };
  return neonWatermark(env, undefined, "mainnet", () => 1000);
}

test("native watermark refuses failed writes and resumes after store recovery", async () => {
  const watermark = store();
  failures.writes = true;
  await assert.rejects(watermark.write(43), /write was not acknowledged/);
  assert.equal(await watermark.read(), null);
  failures.writes = false;
  await watermark.write(43);
  assert.equal(await watermark.read(), 43);
  await watermark.write(42);
  assert.equal(
    await watermark.read(),
    43,
    "a newer writer's committed frontier is retained",
  );
});

test("SQL completion alone cannot acknowledge an absent frontier", async () => {
  // SQLite can complete a statement that a trigger declines. Execute the
  // production SQL, rather than mocking its promise as evidence of a row.
  db.exec(`CREATE TRIGGER decline_raw_frontier BEFORE INSERT ON raw_capture_state
    BEGIN SELECT RAISE(IGNORE); END`);
  const watermark = store();
  await assert.rejects(watermark.write(43), /was not committed/);
  assert.equal(await watermark.read(), null);
  db.exec("DROP TRIGGER decline_raw_frontier");
  await watermark.write(42);
  db.exec(`CREATE TRIGGER decline_raw_frontier BEFORE INSERT ON raw_capture_state
    BEGIN SELECT RAISE(IGNORE); END`);
  await assert.rejects(watermark.write(43), /was not committed/);
  assert.equal(await watermark.read(), 42);
  db.exec("DROP TRIGGER decline_raw_frontier");
  await watermark.write(43);
  assert.equal(await watermark.read(), 43);
});

test("an unreadable readback does not erase the committed row or report success", async () => {
  const watermark = store();
  failures.reads = true;
  await assert.rejects(watermark.write(43), /readback unavailable/);
  failures.reads = false;
  assert.equal(await watermark.read(), 43);
  await watermark.write(43);
});

test("an unbound watermark writer refuses acknowledgment", async () => {
  await assert.rejects(
    neonWatermark({}, undefined, "mainnet", () => 1000).write(43),
    /store is unbound/,
  );
});

test("a non-finite SQLite value cannot certify an integer frontier", async () => {
  // INTEGER affinity alone does not forbid a REAL infinity in a non-STRICT
  // SQLite table. The frontier contract must reject it rather than accept >=.
  db.exec(`INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at)
    VALUES ('mainnet',1e400,1000)`);
  await assert.rejects(store().write(43), /was not committed/);
});
