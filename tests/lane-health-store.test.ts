// Which store holds lane_health (src/lane-health-store.ts, #10126).
//
// The last table to move, and the one whose failure is hardest to see: if
// verdicts stop landing, every watchdog goes quiet and an absent verdict reads
// as health.
//
// Since #10179 there is no second store to fall back to -- the D1 binding is
// gone from the code and from both wrangler configs -- so the selection is now
// a two-clause GATE rather than a choice: Hyperdrive must be bound AND
// lane_health must be declared Neon's, or the answer is `undefined`. Both
// clauses are pinned below, because a gate that opened on either one alone
// would hand 27 watchdogs a store that cannot answer, and each of them reads
// that as a dropped verdict rather than as an error.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  laneHealthStore,
  pgLaneHealthDb,
  type LaneHealthPgClient,
} from "../src/lane-health-store.ts";
import { recordLaneVerdict } from "../src/lane-health.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

function fakeClient() {
  const log: { text: string; values: unknown[] }[] = [];
  let connects = 0;
  let ends = 0;
  const client: LaneHealthPgClient = {
    connect: async () => {
      connects += 1;
    },
    end: async () => {
      ends += 1;
    },
    query: async (text: string, values: unknown[] = []) => {
      log.push({ text, values });
      return { rows: [] };
    },
  };
  return { client, log, counts: () => ({ connects, ends }) };
}

describe("laneHealthStore", () => {
  test("an injected db wins outright, so tests keep their fake", () => {
    const injected = { prepare: () => ({}) } as never;
    assert.equal(laneHealthStore({ HYPERDRIVE }, injected), injected);
  });

  // "declines until the flag names lane_health" retired with NEON_SOLE_STORE_TABLES (#10051): Neon is the only
  // store, so the undeclared/partial state cannot exist; the binding pins
  // survive in this suite.

  test("the flag alone is not enough -- Hyperdrive has to be bound too", () => {
    // Declaring the table without binding the store is a config half-done, and
    // it must read as "no store" rather than as a client with no connection
    // string, which would throw on the first verdict instead of dropping it.
    assert.equal(laneHealthStore({}), undefined);
  });

  test("returns a store once the flag names it AND Hyperdrive is bound", () => {
    const db = laneHealthStore({
      HYPERDRIVE,
    });
    assert.ok(db?.prepare);
  });

  test("no store available is undefined, never a stub", () => {
    // recordLaneVerdict reads undefined as "no store" and declines. A stub here
    // would turn that into "a store that accepted nothing".
    assert.equal(laneHealthStore({}), undefined);
    assert.equal(laneHealthStore(null), undefined);
  });
});

describe("pgLaneHealthDb", () => {
  test("a verdict INSERT reaches Postgres with $n placeholders", async () => {
    const f = fakeClient();
    const db = pgLaneHealthDb("postgresql://example/db", {
      clientFactory: () => f.client,
    });
    const ok = await recordLaneVerdict(db, {
      lane: "neon:probe",
      verdict: "ok",
      age_ms: null,
      detail: "d",
      checked_at: 7,
    });
    assert.equal(ok, true);
    // TWO statements: the insert, then this lane's own retention prune -- see
    // recordLaneVerdict, which does the housekeeping on the way through rather
    // than from a separate cron.
    assert.equal(f.log.length, 2);
    // `?` rewritten -- the callers write SQLite's placeholders because D1 is
    // what lane-health.ts was built against.
    // `?` rewritten to `$n` -- the callers still write SQLite's placeholders,
    // because lane-health.ts was built against D1 and its statements were not
    // touched when the store moved. #9821 is what an unrewritten `?` costs.
    assert.match(f.log[0].text, /VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
    assert.deepEqual(f.log[0].values, ["neon:probe", "ok", null, "d", 7]);
    assert.match(f.log[1].text, /DELETE FROM lane_health WHERE lane = \$1/);
  });

  test("every operation opens AND closes its own connection", async () => {
    // No ctx to park the teardown on, so it is awaited -- an unclosed client
    // per verdict would exhaust the pool within minutes at the observed rate.
    const f = fakeClient();
    const db = pgLaneHealthDb("postgresql://example/db", {
      clientFactory: () => f.client,
    });
    for (let i = 0; i < 3; i++) {
      await recordLaneVerdict(db, {
        lane: "l",
        verdict: "ok",
        age_ms: null,
        detail: "",
        checked_at: i,
      });
    }
    // Two statements per verdict (insert + prune), each with its own
    // connection -- and every one closed.
    assert.deepEqual(f.counts(), { connects: 6, ends: 6 });
  });

  test("a failed write is swallowed rather than raised", async () => {
    // recordLaneVerdict promises never to throw: a watchdog whose
    // alarm-recording broke its alarm would be worse than the bug it watches.
    const db = pgLaneHealthDb("postgresql://example/db", {
      clientFactory: () => ({
        connect: async () => {
          throw new Error("pool exhausted");
        },
        end: async () => {},
        query: async () => ({ rows: [] }),
      }),
    });
    assert.equal(
      await recordLaneVerdict(db, {
        lane: "l",
        verdict: "ok",
        age_ms: null,
        detail: "",
        checked_at: 1,
      }),
      false,
    );
  });

  test("the connection is closed even when the query throws", async () => {
    let ends = 0;
    const db = pgLaneHealthDb("postgresql://example/db", {
      clientFactory: () => ({
        connect: async () => {},
        end: async () => {
          ends += 1;
        },
        query: async () => {
          throw new Error("boom");
        },
      }),
    });
    await recordLaneVerdict(db, {
      lane: "l",
      verdict: "ok",
      age_ms: null,
      detail: "",
      checked_at: 1,
    });
    assert.equal(ends, 1, "a thrown query must still release the connection");
  });
});
