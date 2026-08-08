// The freshness sweep spans both stores, so it must not batch across them.
//
// This is the one reader that touches the whole estate -- ~47 tables -- and
// they do not all live in the same place. readStore is all-or-nothing per call,
// deliberately: a call naming one owned table and one unowned one falls back to
// D1. For every other reader that is the safe answer, because every table it
// names belongs to one lane. Here it is not: a batch mixing the two would run
// its UNION against D1 and every Neon-only table in it would throw "relation
// does not exist".
//
// And the loss is not one table. The sweep is a single UNION per batch, so one
// wrong store condemns the batch; the per-table retry then walks it one at a
// time and fails on each. That is exactly the shape of the #9866 incident this
// watchdog's own comments describe, arrived at from the other direction --
// there 12 bad entries blinded 58% of the estate.
//
// Nothing here needs a database. What is asserted is which store each SQL
// statement was handed to, which is the whole property.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { runTableFreshnessWatchdog } from "../src/table-freshness-watchdog.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

/** A store that records the SQL it was asked for and answers nothing. */
function recorder() {
  const seen: string[] = [];
  return {
    seen,
    binding: {
      prepare(text: string) {
        seen.push(text);
        return { all: async () => ({ results: [] }) };
      },
    } as never,
  };
}

/** Two tables that exist on opposite sides, and a spec naming only those. */
const NEON_TABLE = "surface_checks";
const D1_TABLE = "surfaces";
const SPEC = {
  [NEON_TABLE]: { column: "checked_at", maxAgeMs: 60_000, label: "neon side" },
  [D1_TABLE]: { column: "updated_at", maxAgeMs: 60_000, label: "d1 side" },
} as never;

describe("the freshness sweep", () => {
  test("never asks D1 for a table Neon owns", async () => {
    const d1 = recorder();
    await runTableFreshnessWatchdog(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE,
        // Only one of the two tables is Neon's, which is the mixed estate this
        // watchdog actually runs against.
        NEON_SOLE_STORE_TABLES: NEON_TABLE,
        // The verdict goes to lane_health; keep it off the recorded store so
        // the assertion below is about the sweep and not about bookkeeping.
        laneHealthDb: undefined,
      } as never,
      {
        spec: SPEC,
        laneHealthDb: {
          prepare: () => ({
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
            }),
          }),
        } as never,
      },
    );
    const askedD1For = d1.seen.join(" ");
    assert.ok(
      !askedD1For.includes(NEON_TABLE),
      `the sweep asked D1 for ${NEON_TABLE}, which Neon owns -- a batch ` +
        `spanning both stores falls back to D1 and every Neon-only table in ` +
        `it throws. Statements seen: ${JSON.stringify(d1.seen)}`,
    );
  });

  test("still asks D1 for the tables Neon does not own", async () => {
    // The other half. Without it the assertion above would pass against a
    // sweep that stopped reading D1 entirely -- which would blind every table
    // still living there rather than fixing the mixed batch.
    const d1 = recorder();
    await runTableFreshnessWatchdog(
      {
        METAGRAPH_HEALTH_DB: d1.binding,
        HYPERDRIVE,
        NEON_SOLE_STORE_TABLES: NEON_TABLE,
      } as never,
      {
        spec: SPEC,
        laneHealthDb: {
          prepare: () => ({
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
            }),
          }),
        } as never,
      },
    );
    assert.ok(
      d1.seen.join(" ").includes(D1_TABLE),
      `the sweep never asked D1 for ${D1_TABLE}, which still lives there`,
    );
  });

  test("an injected db still takes everything, so existing suites are unchanged", async () => {
    // deps.db is how every other test in this family drives the sweep. It must
    // keep bypassing the partition, or the partitioning would silently change
    // what those suites are testing.
    const injected = recorder();
    const result = await runTableFreshnessWatchdog(
      {
        HYPERDRIVE,
        NEON_SOLE_STORE_TABLES: NEON_TABLE,
      } as never,
      {
        db: injected.binding,
        spec: SPEC,
        laneHealthDb: {
          prepare: () => ({
            bind: () => ({
              run: async () => ({}),
              all: async () => ({ results: [] }),
            }),
          }),
        } as never,
      },
    );
    const asked = injected.seen.join(" ");
    assert.ok(asked.includes(NEON_TABLE) && asked.includes(D1_TABLE));
    assert.equal(result.attempted, true);
  });
});
