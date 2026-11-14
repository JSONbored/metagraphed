// The Hyperdrive-selected store bindings against a real PostgreSQL 18 (#13171).
//
// This is the seam's contract test: the SAME wrapper the Worker entry applies
// (src/hyperdrive-state-bindings.ts) is pointed at the suite's disposable
// fixture database through a fake HYPERDRIVE binding, and the bindings it
// fills must actually reach that database — a lane-health write read back
// through the same store AND through an independent control connection, a
// producer-lane write, and the scoped NATIVE_READ_STORE. The dark path (no
// selector) must return the very same env object, untouched.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { withHyperdriveStateBindings } from "../src/hyperdrive-state-bindings.ts";
import {
  loadLatestLaneHealth,
  recordLaneVerdict,
  type LaneHealthDb,
} from "../src/lane-health.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

interface ReadStoreBinding {
  tables: readonly string[];
  store: { query<Row>(text: string, values?: unknown[]): Promise<Row[]> };
}
interface ProducerBinding {
  tables: readonly string[];
  store: {
    run(text: string, values?: unknown[]): Promise<{ changes: number }>;
  };
}

const url = pg18FixtureUrl();
const database = "hyperdrive_state_" + randomUUID().replaceAll("-", "");
const target = new URL(url);
target.pathname = "/" + database;
const admin = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const control = new Client({
  connectionString: target.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let created = false;

describe(
  "hyperdrive-selected state bindings on PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await admin.connect();
      assert.equal(
        (await admin.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await admin.query(`CREATE DATABASE ${database}`);
      created = true;
      await control.connect();
      const root = new URL("../migrations/postgres/", import.meta.url);
      for (const file of readdirSync(root)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await control.query("BEGIN");
        try {
          if (file === "0019_raw_capture_activate.sql")
            await control.query(
              "INSERT INTO app.raw_capture_budget(id) VALUES(1)",
            );
          await control.query(readFileSync(new URL(file, root), "utf8"));
          await control.query("COMMIT");
        } catch (error) {
          await control.query("ROLLBACK");
          throw error;
        }
      }
    });
    after(async () => {
      try {
        await control.end();
        // The wrapper's pooled runtime is isolate-owned and exposes no close;
        // its idle connections (idleTimeoutMillis 2000) must drain before the
        // fixture database can drop without force-terminating them.
        await delay(2500);
        if (created)
          await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });

    it("returns an unselected env object unchanged", () => {
      const dark = { HYPERDRIVE: { connectionString: target.toString() } };
      assert.equal(withHyperdriveStateBindings(dark), dark);
      const wrong = {
        METAGRAPH_STATE_SOURCE: "d1",
        HYPERDRIVE: { connectionString: target.toString() },
      };
      assert.equal(withHyperdriveStateBindings(wrong), wrong);
    });

    it("fills the store keys and round-trips writes through the fixture database", async () => {
      const env = Object.freeze({
        METAGRAPH_STATE_SOURCE: "hyperdrive",
        HYPERDRIVE: { connectionString: target.toString() },
      });
      const wrapped = withHyperdriveStateBindings(env) as typeof env &
        Record<string, unknown>;
      assert.notEqual(wrapped, env);
      assert.equal("LANE_HEALTH_STORE" in env, false);
      assert.equal(wrapped.RAW_CAPTURE_STORAGE, "postgresql");

      // Read store write + read: the lane-health adapter over the wrapper's
      // scoped app source, confirmed by an independent control connection.
      const laneHealth = wrapped.LANE_HEALTH_STORE as LaneHealthDb;
      assert.equal(
        await recordLaneVerdict(
          laneHealth,
          {
            lane: "hyperdrive-fixture",
            verdict: "ok",
            age_ms: 5,
            detail: "written through the wrapped env",
            checked_at: 1000,
          },
          { confirm: true },
        ),
        true,
      );
      const latest = await loadLatestLaneHealth(laneHealth);
      assert.equal(latest["hyperdrive-fixture"]?.verdict, "ok");
      assert.equal(latest["hyperdrive-fixture"]?.checked_at, 1000);
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int AS n FROM app.lane_health WHERE lane='hyperdrive-fixture'",
          )
        ).rows[0].n,
        1,
      );

      // Producer lane write through the same scoped source.
      const producer = wrapped.NATIVE_PRODUCER_STORE as ProducerBinding;
      assert.equal(producer.tables.includes("surface_status"), true);
      assert.deepEqual(
        await producer.store.run(
          "INSERT INTO surface_status(surface_id,netuid,last_checked) VALUES($1,$2,$3)",
          ["hyperdrive-fixture", 7, 12345],
        ),
        { changes: 1 },
      );

      // NATIVE_READ_STORE sees both writes inside the app schema scope.
      const read = wrapped.NATIVE_READ_STORE as ReadStoreBinding;
      assert.equal(read.tables.includes("lane_health"), true);
      assert.deepEqual(
        await read.store.query(
          "SELECT surface_id, netuid FROM surface_status WHERE surface_id=$1",
          ["hyperdrive-fixture"],
        ),
        [{ surface_id: "hyperdrive-fixture", netuid: 7 }],
      );

      // Memoized per connection string: a second env object shares the stores.
      const second = withHyperdriveStateBindings({
        METAGRAPH_STATE_SOURCE: "hyperdrive",
        HYPERDRIVE: { connectionString: target.toString() },
      }) as Record<string, unknown>;
      assert.equal(second.LANE_HEALTH_STORE, laneHealth);
      assert.equal(second.NATIVE_READ_STORE, read);
    });
  },
);
