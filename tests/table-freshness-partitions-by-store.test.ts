// The freshness sweep spans the whole estate, so it must not batch a table it
// can read together with one it cannot.
//
// This is the one reader that touches everything -- ~47 tables -- and readStore
// is all-or-nothing per call, deliberately: it hands back a store only when
// EVERY table named in the call is declared Neon's, and `undefined` otherwise.
// For every other reader that is the safe answer, because every table it names
// belongs to one lane. Here it is not. A batch mixing a declared table with an
// undeclared one gets `undefined` for the whole batch, and since #10170 there
// is no second store to fall back to -- so the declared table is not read
// either.
//
// And the loss is not one table. The sweep is a single UNION per batch, so one
// undeclared table condemns the batch; the per-table retry then walks it one at
// a time against the same `undefined` store and fails on each. That is exactly
// the shape of the #9866 incident this watchdog's own comments describe,
// arrived at from the other direction -- there 12 bad entries blinded 58% of
// the estate. Partitioning by owner FIRST is what keeps a table with nowhere to
// live from blinding its neighbours.
//
// The pg double is here only so the readable half has something to answer with;
// what is asserted is WHICH statements were issued and what the sweep concluded
// about the table it could not read.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The store is Postgres now (#10170), reached through `new Client(...)` inside
// src/read-store.ts -- which this watchdog cannot be handed, because it selects
// its own store per partition from `env`. Mocking the module is the seam; see
// tests/helpers/pg-mock.ts for why it is a module mock and why the controller
// has to be built inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { runTableFreshnessWatchdog } from "../src/table-freshness-watchdog.ts";

const NOW = 1_785_800_000_000;

/** Two tables on opposite sides of the declaration, and a spec naming only
 * those: one Neon owns and can therefore be read, one nothing owns. */
const OWNED = "surface_checks";
const UNOWNED = "surfaces";
const SPEC = {
  [OWNED]: { column: "checked_at", maxAgeMs: 60_000, label: "declared" },
  [UNOWNED]: { column: "updated_at", maxAgeMs: 60_000, label: "undeclared" },
} as never;

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

/** A lane_health sink that keeps every verdict, so the sweep's own conclusion
 * is inspectable -- an unreadable table has to reach the VERDICT and not just
 * the prose (#9866). */
function verdicts() {
  const written: { sql: string; values: unknown[] }[] = [];
  return {
    written,
    db: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          written.push({ sql, values });
          return {
            run: async () => ({}),
            all: async () => ({ results: [] }),
          };
        },
      }),
    } as never,
  };
}

/** The pg log, reset per test and subscribed rather than read back -- see the
 * gotcha in tests/helpers/pg-mock.ts. */
function sql() {
  const seen: string[] = [];
  pg.control.queries.length = 0;
  pg.control.onQuery = (q) => seen.push(q.text.replace(/\s+/g, " ").trim());
  return seen;
}

beforeEach(() => {
  pg.control.answers = [];
  pg.control.rows = null;
  pg.control.failNext = null;
});

describe("the freshness sweep", () => {
  test("a table with no store cannot blind the tables that have one", async () => {
    // The partition's whole job. Batched together, readStore would answer
    // `undefined` for the pair and NEITHER table would be measured; split by
    // owner, the declared one is read normally.
    const seen = sql();
    pg.control.answers = [
      { match: `FROM ${OWNED}`, rows: [{ t: OWNED, mx: NOW - 1_000 }] },
    ];
    const lane = verdicts();
    const result = await runTableFreshnessWatchdog(
      {
        ...pgMockEnv([OWNED]),
        // Only one of the two tables is declared, which is the mixed estate
        // this watchdog actually runs against.
      } as never,
      { spec: SPEC, now: () => NOW, laneHealthDb: lane.db },
    );
    assert.ok(
      seen.some((statement) => statement.includes(`FROM ${OWNED}`)),
      `the sweep never read ${OWNED}, which Neon owns. Statements seen: ` +
        JSON.stringify(seen),
    );
    assert.ok(
      !seen.some((statement) => statement.includes(`FROM ${UNOWNED}`)),
      `the sweep asked the Neon store for ${UNOWNED}, which is not declared ` +
        `there -- the statement would throw "relation does not exist" and ` +
        `take its batch with it. Statements seen: ${JSON.stringify(seen)}`,
    );
    // Measured, not merely attempted: a sweep that read nothing would satisfy
    // the "never asked" half above while blinding the whole estate.
    assert.equal(result.checked, 1, "the declared table was actually measured");
  });

  test("the table it could not read is named in the verdict, not dropped", async () => {
    // The other half. Without it the assertion above would pass against a sweep
    // that silently skipped every undeclared table -- which is #9866 exactly:
    // an unreadable table that reaches only the prose still publishes `ok`, and
    // lane-alarm keys on the verdict, so nothing fires.
    sql();
    pg.control.answers = [
      { match: `FROM ${OWNED}`, rows: [{ t: OWNED, mx: NOW - 1_000 }] },
    ];
    const lane = verdicts();
    await runTableFreshnessWatchdog({ ...pgMockEnv([OWNED]) } as never, {
      spec: SPEC,
      now: () => NOW,
      laneHealthDb: lane.db,
    });
    const insert = lane.written.find((call) =>
      call.sql.startsWith("INSERT INTO lane_health"),
    );
    assert.ok(insert, "the sweep recorded no verdict at all");
    const [, verdict, , detail] = insert.values as [
      string,
      string,
      unknown,
      string,
    ];
    assert.equal(
      verdict,
      "unknown",
      "one unreadable table means the sweep did not establish freshness",
    );
    assert.match(detail, new RegExp(`unreadable: ${UNOWNED}`));
  });

  test("an injected db still takes everything, so existing suites are unchanged", async () => {
    // deps.db is how every other test in this family drives the sweep. It must
    // keep bypassing the partition, or the partitioning would silently change
    // what those suites are testing.
    const injected = recorder();
    const lane = verdicts();
    const result = await runTableFreshnessWatchdog(
      { ...pgMockEnv([OWNED]) } as never,
      { db: injected.binding, spec: SPEC, laneHealthDb: lane.db },
    );
    const asked = injected.seen.join(" ");
    assert.ok(asked.includes(OWNED) && asked.includes(UNOWNED));
    assert.equal(result.attempted, true);
  });
});
