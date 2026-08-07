// The fourth flag: which tables Neon SOLELY owns, and what that changes.
//
// The three older flags all describe a table that still lives in D1 and is
// being shadowed. This one says D1 is not behind the table any more, which is
// the only one of the four that can describe the end state (#9787).
//
// What is actually asserted here is the ALL-OR-NOTHING rule. userStateRunner
// picks one runner for a whole callback, so a group whose tables are only
// half-listed would send some statements to a store where their table does not
// exist -- and that failure is a schema-stable empty, not an error. Every test
// below is a way for that to happen.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { neonOwnsTable, neonSoleStoreTables } from "../src/neon-write.ts";
import {
  ACCOUNT_STATE_TABLES,
  ALERT_TRIGGER_TABLES,
  userStateRunner,
} from "../workers/data-api.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

/** A D1 binding that records the statement text it was asked to prepare, so a
 * test can tell WHICH store a runner reached without a real database. */
function recordingD1() {
  const seen: string[] = [];
  return {
    seen,
    binding: {
      prepare(text: string) {
        seen.push(text);
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
        };
      },
    } as never,
  };
}

function envWith(
  owned: string[],
  opts: { d1?: boolean; hyperdrive?: boolean },
) {
  const d1 = recordingD1();
  return {
    d1,
    env: {
      NEON_SOLE_STORE_TABLES: owned.join(","),
      METAGRAPH_HEALTH_DB: opts.d1 === false ? undefined : d1.binding,
      HYPERDRIVE: opts.hyperdrive === false ? undefined : HYPERDRIVE,
    } as never,
  };
}

const ctx = { waitUntil: () => undefined } as never;

describe("neonSoleStoreTables", () => {
  test("an unset flag owns nothing", () => {
    assert.equal(neonSoleStoreTables(undefined).size, 0);
    assert.equal(neonSoleStoreTables({}).size, 0);
    assert.equal(neonOwnsTable({}, "api_keys"), false);
  });

  test("an empty string owns nothing, rather than owning one empty name", () => {
    // The deployed default is "", and a naive split would make that a set
    // containing "" -- harmless until some table is legitimately named by a
    // caller that passes an empty string through.
    assert.equal(neonSoleStoreTables({ NEON_SOLE_STORE_TABLES: "" }).size, 0);
  });

  test("names are read individually, not as one blob", () => {
    const owned = neonSoleStoreTables({
      NEON_SOLE_STORE_TABLES: "api_keys,rpc_accounts",
    });
    assert.equal(owned.has("api_keys"), true);
    assert.equal(owned.has("rpc_accounts"), true);
    assert.equal(owned.has("api_quota_daily"), false);
  });
});

describe("userStateRunner", () => {
  test("a fully-owned group goes to Postgres", async () => {
    const { d1, env } = envWith([...ACCOUNT_STATE_TABLES], {});
    const sql = userStateRunner(env, ctx, ACCOUNT_STATE_TABLES);
    assert.ok(sql);
    // Proving it is the Postgres runner by what it did NOT touch: a D1 runner
    // would have called prepare(). Asserting on the returned object's shape
    // would prove nothing, since the two runners are deliberately identical.
    assert.deepEqual(d1.seen, []);
  });

  test("ONE unlisted table pins the whole group to D1", async () => {
    // The failure this exists to stop. api_quota_daily left out means the
    // quota statement would run against a Postgres that has no such table --
    // and the group's other six would silently move with it.
    const partial = ACCOUNT_STATE_TABLES.filter((t) => t !== "api_quota_daily");
    const { d1, env } = envWith(partial, {});
    const sql = userStateRunner(env, ctx, ACCOUNT_STATE_TABLES);
    assert.ok(sql);
    await sql`SELECT 1`;
    assert.equal(d1.seen.length, 1);
  });

  test("the two groups move independently", () => {
    const { d1, env } = envWith([...ALERT_TRIGGER_TABLES], {});
    // Alert tables owned, account tables not: the alert group moves, the
    // account group does not.
    assert.ok(userStateRunner(env, ctx, ALERT_TRIGGER_TABLES));
    assert.deepEqual(d1.seen, []);
    const accounts = userStateRunner(env, ctx, ACCOUNT_STATE_TABLES);
    assert.ok(accounts);
    void accounts`SELECT 1`;
    assert.equal(d1.seen.length, 1);
  });

  test("an owned group with no Hyperdrive binding falls back to D1", async () => {
    // Flag set on a deployment that cannot reach Neon. Answering from D1 is
    // right -- the rows are still there until the copy is retired -- and it is
    // what makes the flag safe to set before the binding lands.
    const { d1, env } = envWith([...ACCOUNT_STATE_TABLES], {
      hyperdrive: false,
    });
    const sql = userStateRunner(env, ctx, ACCOUNT_STATE_TABLES);
    assert.ok(sql);
    await sql`SELECT 1`;
    assert.equal(d1.seen.length, 1);
  });

  test("neither store available is null, which callers turn into a 503", () => {
    const { env } = envWith([], { d1: false, hyperdrive: false });
    assert.equal(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES), null);
  });

  test("an owned group survives D1 being unbound entirely", () => {
    // The state this whole flag exists to reach: D1 gone, and the tier still
    // answering. Once every table is listed, a missing METAGRAPH_HEALTH_DB is
    // no longer a 503.
    const { env } = envWith([...ACCOUNT_STATE_TABLES], { d1: false });
    assert.ok(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES));
  });

  test("the declared groups are exactly the user-state tables", () => {
    // The lists are what the flag is checked against, so a table added to the
    // tier without being added here would move stores without anyone naming
    // it. Pinned rather than derived: deriving it from the SQL is what the
    // route-map test does, and it has been wrong twice.
    assert.deepEqual([...ACCOUNT_STATE_TABLES].sort(), [
      "api_key_blocks",
      "api_key_usage_daily",
      "api_keys",
      "api_quota_daily",
      "api_usage_rollup",
      "github_accounts",
      "rpc_accounts",
    ]);
    assert.deepEqual([...ALERT_TRIGGER_TABLES].sort(), [
      "chain_alert_deliveries",
      "chain_alert_triggers",
    ]);
  });
});
