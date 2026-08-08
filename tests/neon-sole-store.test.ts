// Which tables Neon SOLELY owns, and what that changes.
//
// The flag outlived the migration it was built for: D1 is gone (#10170), so
// there is no longer a second store to fall back to. What it still decides is
// whether a group of tables may be READ AT ALL, and that is the property this
// file guards.
//
// The rule is ALL-OR-NOTHING. userStateRunner picks one runner for a whole
// callback, so a group whose tables are only half-listed must get no runner --
// running the listed statements and failing the rest would leave the callback
// half-applied, and the failure of the missing half is a schema-stable empty
// rather than an error. Every test below is a way for that to happen.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { neonOwnsTable, neonSoleStoreTables } from "../src/neon-write.ts";
import {
  ACCOUNT_STATE_TABLES,
  ALERT_TRIGGER_TABLES,
  NEURONS_SNAPSHOT_TABLES,
  neonOwnsNeuronsSnapshot,
  userStateRunner,
} from "../workers/data-api.ts";

const HYPERDRIVE = { connectionString: "postgresql://example/db" };

function envWith(owned: string[], opts: { hyperdrive?: boolean } = {}) {
  return {
    env: {
      NEON_SOLE_STORE_TABLES: owned.join(","),
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
  test("a fully-owned group gets a runner", () => {
    const { env } = envWith([...ACCOUNT_STATE_TABLES]);
    assert.ok(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES));
  });

  test("ONE unlisted table refuses the whole group", () => {
    // The failure this exists to stop. api_quota_daily left out means the
    // quota statement would run against a store the declaration does not cover
    // -- and the group's other six would silently go with it.
    const partial = ACCOUNT_STATE_TABLES.filter((t) => t !== "api_quota_daily");
    const { env } = envWith(partial);
    assert.equal(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES), null);
  });

  test("the two groups move independently", () => {
    // Alert tables declared, account tables not: the alert group gets a
    // runner, the account group does not.
    const { env } = envWith([...ALERT_TRIGGER_TABLES]);
    assert.ok(userStateRunner(env, ctx, ALERT_TRIGGER_TABLES));
    assert.equal(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES), null);
  });

  test("an owned group with no Hyperdrive binding gets no runner", () => {
    // Flag set on a deployment that cannot reach Neon. Sole-store is a claim
    // about the DATA, not about this isolate, so the flag alone is not enough
    // -- and answering a 503 beats answering from a store this Worker cannot
    // actually open.
    const { env } = envWith([...ACCOUNT_STATE_TABLES], { hyperdrive: false });
    assert.equal(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES), null);
  });

  test("no store available is null, which callers turn into a 503", () => {
    const { env } = envWith([], { hyperdrive: false });
    assert.equal(userStateRunner(env, ctx, ACCOUNT_STATE_TABLES), null);
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
      // The five web-push handlers (#8385) share withAlertTriggersSql, so
      // this table moves with the alert pair whether or not anyone remembers
      // it. It was missing from the group on the first cut of this change,
      // which is precisely the under-declaration the all-or-nothing rule
      // exists to make harmless -- and this assertion is what caught it.
      "watch_push_subscriptions",
    ]);
  });
});

describe("neonOwnsNeuronsSnapshot (the write-path inversion)", () => {
  const ALL = ["neurons", "neuron_daily", "account_position_daily"];

  function env(owned: string[], hyperdrive = true) {
    return {
      NEON_SOLE_STORE_TABLES: owned.join(","),
      HYPERDRIVE: hyperdrive
        ? { connectionString: "postgresql://example/db" }
        : undefined,
    } as never;
  }

  test("all three owned and Hyperdrive bound", () => {
    assert.equal(neonOwnsNeuronsSnapshot(env(ALL)), true);
  });

  test("ONE table left out disowns the whole snapshot", () => {
    // The pass writes all three from one derivation, so the group has to move
    // as a unit. A half-listed group would claim two of the three, and no read
    // gate would notice -- each table answers fine on its own.
    for (const missing of ALL) {
      const partial = ALL.filter((t) => t !== missing);
      assert.equal(
        neonOwnsNeuronsSnapshot(env(partial)),
        false,
        `${missing} missing should disown the snapshot`,
      );
    }
  });

  test("declared but no Hyperdrive binding is not ownership", () => {
    // Claiming the tables with nowhere to put the rows would drop a whole pass
    // silently. The binding is a precondition, not an optimisation.
    assert.equal(neonOwnsNeuronsSnapshot(env(ALL, false)), false);
  });

  test("the declared group is exactly what one snapshot writes", () => {
    assert.deepEqual([...NEURONS_SNAPSHOT_TABLES].sort(), [
      "account_position_daily",
      "neuron_daily",
      "neurons",
    ]);
  });
});
