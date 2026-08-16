// A BUFFERED LANE'S PRODUCER MUST NOT READ THE TABLE BACK.
//
// The write-behind buffer defers a lane's statements by FLUSH_INTERVAL_MS (ten
// minutes). For a lane that only feeds READERS that is a freshness trade, and
// `table-freshness-watchdog` already bounds it. For a lane whose own producer
// SELECTs the row to decide what to do next, it is a correctness bug: the
// producer reads a value its earlier passes already moved past, and redoes the
// work.
//
// THIS IS NOT HYPOTHETICAL AND THE BOUND DID NOT CATCH IT. `raw-capture-state`
// holds `last_contiguous_block`, which is where the capture tick resumes.
// Buffered, every tick inside a flush window resumed at the same height and
// re-captured the same blocks; the R2 key is derived from the block range, so
// the re-writes were byte-identical and nothing threw. Measured on production
// 2026-08-16, the watermark advanced 10 blocks per 10-minute window against a
// chain producing 5 a minute, while every tick recorded `ok, 10 captured` and
// `neon:raw-capture-state` reported "41 statement(s) flushed" -- forty-one
// watermark writes collapsing into one effective value.
//
// The freshness bound said two hours and a ten-minute flush fits inside it,
// which is exactly why the lane looked safe: that bound answers "is this row
// too old for a READER", and asks nothing about the producer.
//
// WHY A DERIVED SWEEP RATHER THAN A LIST. Naming the one known lane would pin
// today's answer and nothing else. This pairs each Neon write lane with the
// table it writes, then asks which modules IMPORT that lane's writer and also
// SELECT that table -- so the next producer that grows a resume point is
// caught by construction, whoever adds it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "vitest";

import { NEVER_BUFFER_LANES } from "../src/neon-write-buffer.ts";

const SRC = new URL("../src/", import.meta.url);

/**
 * Lanes whose table is NOT their own name with underscores.
 *
 * Both are real, and both are checked below rather than trusted: the guard on
 * this list is that each entry's like-named table must genuinely not exist, so
 * an override cannot be used to point a lane away from a table it does write.
 */
const LANE_TABLES: Readonly<Record<string, readonly string[]>> = {
  // One lane, four tables -- a block's detail is written as a unit.
  "chain-detail": [
    "chain_detail_blocks",
    "chain_detail_extrinsics",
    "chain_detail_chain_events",
    "chain_detail_account_events",
  ],
  // Shares `nominator_positions` with the nominator-positions lane, separated
  // by a `source` column rather than by a table of its own (#10845).
  "self-stake": ["nominator_positions"],
};

/** Every `<X>_NEON_LANE = "..."` declaration, by the module that owns it. */
function writerModules(): { module: string; lanes: string[] }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && f.includes("neon-write"))
    .map((f) => ({
      module: f.slice(0, -3),
      lanes: [
        ...readFileSync(new URL(f, SRC), "utf8").matchAll(
          /export const \w*_NEON_LANE = "([a-z0-9-]+)"/g,
        ),
      ].map((m) => m[1]!),
    }))
    .filter((entry) => entry.lanes.length > 0);
}

const tablesFor = (lane: string): readonly string[] =>
  LANE_TABLES[lane] ?? [lane.replace(/-/g, "_")];

/** `FROM <table>`, as a direct read of that table's rows. */
const readsTable = (source: string, table: string): boolean =>
  new RegExp(`FROM\\s+${table}\\b`).test(source);

const SCHEMA = readFileSync(
  new URL("../db/schema.sql", import.meta.url),
  "utf8",
);
const schemaHasTable = (table: string): boolean =>
  new RegExp(`CREATE TABLE (?:public\\.)?"?${table}"?\\b`).test(SCHEMA);

describe("the lane -> table pairing this sweep rests on", () => {
  test("every lane's table exists in the schema", () => {
    // Without this the sweep degrades silently: a lane whose derived table
    // name stopped matching would simply match no reader and pass.
    for (const { lanes } of writerModules()) {
      for (const lane of lanes) {
        for (const table of tablesFor(lane)) {
          assert.ok(
            schemaHasTable(table),
            `lane ${lane} maps to ${table}, which db/schema.sql does not declare`,
          );
        }
      }
    }
  });

  test("an override is only allowed where the like-named table is absent", () => {
    // The guard on the override list. Without it, a lane that DOES write a
    // like-named table could be pointed elsewhere and quietly leave the sweep.
    for (const lane of Object.keys(LANE_TABLES)) {
      assert.equal(
        schemaHasTable(lane.replace(/-/g, "_")),
        false,
        `${lane} has a like-named table, so it must not be overridden`,
      );
    }
  });

  test("the schema probe can tell present from absent", () => {
    // Guards the guard: a regex matching nothing would make both tests above
    // pass on an empty search.
    assert.equal(schemaHasTable("raw_capture_state"), true);
    assert.equal(schemaHasTable("a_table_that_does_not_exist"), false);
  });
});

describe("a lane whose producer reads it back must never be buffered", () => {
  test("every producer that SELECTs its own lane's table is exempt", () => {
    const offenders: string[] = [];
    const checked: string[] = [];
    for (const { module, lanes } of writerModules()) {
      for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
        const source = readFileSync(new URL(file, SRC), "utf8");
        // Importing the writer is what makes a module a PRODUCER of the lane.
        // Every other module reading the table is a consumer, for whom the
        // deferral is the freshness trade the buffer exists to make.
        if (!source.includes(`from "./${module}.ts"`)) continue;
        for (const lane of lanes) {
          for (const table of tablesFor(lane)) {
            checked.push(`${file}:${lane}`);
            if (!readsTable(source, table)) continue;
            if (NEVER_BUFFER_LANES.has(lane)) continue;
            offenders.push(
              `src/${file} produces lane "${lane}" and SELECTs ${table}`,
            );
          }
        }
      }
    }
    assert.ok(
      checked.length > 0,
      "the sweep found no producer at all, so it proved nothing",
    );
    assert.deepEqual(
      offenders,
      [],
      "A producer that reads its own lane's table resumes from a value the " +
        "buffer has not flushed yet, and redoes the work. Add the lane to " +
        "NEVER_BUFFER_LANES, or stop reading the table back.\n" +
        offenders.join("\n"),
    );
  });

  test("raw-capture-state is the case this was built from, and is exempt", () => {
    // Named explicitly as well as swept, because the sweep passing tells you
    // nothing about WHICH lane it was protecting.
    const capture = readFileSync(new URL("raw-capture-sync.ts", SRC), "utf8");
    assert.ok(
      capture.includes('from "./capture-state-neon-write.ts"'),
      "the capture lane still produces raw-capture-state",
    );
    assert.ok(
      readsTable(capture, "raw_capture_state"),
      "the capture lane still reads its own watermark back",
    );
    assert.ok(NEVER_BUFFER_LANES.has("raw-capture-state"));
  });

  test("the detector fires on a producer that is NOT exempt", () => {
    // PROVE IT CAN FAIL. The sweep above is an emptiness assertion, and an
    // emptiness assertion over a broken matcher passes on everything.
    const pretendSource =
      'import { mirrorX } from "./x-neon-write.ts";\n' +
      'const q = "SELECT cursor FROM some_lane WHERE id = ?";\n';
    assert.ok(pretendSource.includes('from "./x-neon-write.ts"'));
    assert.equal(readsTable(pretendSource, "some_lane"), true);
    assert.equal(NEVER_BUFFER_LANES.has("some-lane"), false);
    // ...which is the exact conjunction the sweep reports, so a real one would
    // have landed in `offenders`.
    assert.equal(readsTable(pretendSource, "another_lane"), false);
  });
});
