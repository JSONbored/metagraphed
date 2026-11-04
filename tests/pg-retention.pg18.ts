import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { before, after, beforeEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgRetentionStore } from "../src/pg-retention.ts";
import { NEON_PRUNE_PLANS } from "../src/neon-prune.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
let pools = 0;
const runtime = createPgStoreRuntime(
  {
    connectionString,
    maxConnections: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  },
  (config) => {
    pools++;
    return new Pool(config);
  },
);
const native = createPgRetentionStore({
  ...runtime,
  schema: "app",
  access: "read-write",
  relations: ["surface_checks", "subnet_burn_history"],
});
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let ownApp = false;
const tables: string[] = [];
const functions: string[] = [];
const now = Date.UTC(2026, 10, 4, 12);

describe("native rolling-window retention", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    ownApp = !(
      await control.query("SELECT 1 FROM pg_namespace WHERE nspname='app'")
    ).rows.length;
    for (const file of [
      "0007_registry_health.sql",
      "0012_economic_history.sql",
    ]) {
      const sql = readFileSync(
        new URL(`../migrations/postgres/${file}`, import.meta.url),
        "utf8",
      );
      const created = [
        ...sql.matchAll(/CREATE TABLE app\.([a-z_0-9]+)\s*\(/g),
      ].map((match) => match[1]!);
      for (const table of created)
        assert.equal(
          (
            await control.query("SELECT to_regclass($1) AS name", [
              `app.${table}`,
            ])
          ).rows[0].name,
          null,
        );
      await control.query(sql);
      tables.push(...created);
      functions.push(
        ...[...sql.matchAll(/CREATE FUNCTION app\.([a-z_0-9]+)\(/g)].map(
          (match) => match[1]!,
        ),
      );
    }
    db = await source.getD1Database("DB");
    const root = new URL("../migrations/d1/", import.meta.url);
    for (const file of readdirSync(root)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      for (const sql of readFileSync(new URL(file, root), "utf8").split(
        "-- statement-breakpoint",
      ))
        if (sql.trim()) await db.prepare(sql).run();
  });
  beforeEach(async () => {
    for (const table of ["surface_checks", "subnet_burn_history"]) {
      await control.query(`DELETE FROM app.${table}`);
      await db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  after(async () => {
    await runtime.close();
    await source.dispose();
    try {
      for (const table of tables.reverse())
        await control.query(`DROP TABLE app.${table}`);
      for (const name of functions.reverse())
        await control.query(`DROP FUNCTION app.${name}()`);
      if (ownApp) await control.query("DROP SCHEMA app");
    } finally {
      await control.end();
    }
    assert.equal(pools, 1);
  });

  async function seed(staleOnly = false) {
    for (const plan of Object.values(NEON_PRUNE_PLANS)) {
      const cutoff = now - plan.retentionMs;
      const times = staleOnly
        ? [Math.floor(cutoff / 1000)]
        : [cutoff - 2, cutoff - 1, cutoff, cutoff + 1];
      for (const at of times) {
        if (plan.table === "surface_checks") {
          await control.query(
            "INSERT INTO app.surface_checks(surface_id,checked_at) VALUES('fixture',$1)",
            [at],
          );
          await db
            .prepare(
              "INSERT INTO surface_checks(surface_id,checked_at) VALUES('fixture',?)",
            )
            .bind(at)
            .run();
        } else {
          await control.query(
            "INSERT INTO app.subnet_burn_history(netuid,observed_at,burn_tao) VALUES(7,$1,1)",
            [at],
          );
          await db
            .prepare(
              "INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao) VALUES(7,?,1)",
            )
            .bind(at)
            .run();
        }
      }
    }
  }

  it("keeps exact cutoff rows with the existing D1 millisecond boundary", async () => {
    await seed();
    assert.deepEqual(await native.prune(now), [
      { table: "surface_checks", deleted: 2 },
      { table: "subnet_burn_history", deleted: 2 },
    ]);
    for (const plan of Object.values(NEON_PRUNE_PLANS)) {
      const cutoff = now - plan.retentionMs;
      const deletion = await db
        .prepare(`DELETE FROM ${plan.table} WHERE ${plan.column}<?`)
        .bind(cutoff)
        .run();
      assert.equal(deletion.meta.changes, 2);
      const actual = (
        await control.query(
          `SELECT ${plan.column}::float8 at FROM app.${plan.table} ORDER BY ${plan.column}`,
        )
      ).rows;
      const expected = (
        await db
          .prepare(
            `SELECT ${plan.column} at FROM ${plan.table} ORDER BY ${plan.column}`,
          )
          .all()
      ).results;
      assert.deepEqual(actual, expected);
    }
    assert(
      (await native.prune(now)).every(
        (outcome) => outcome.deleted === 0 && !outcome.skipped,
      ),
    );
  });

  it("refuses seconds-as-milliseconds and isolates failed table deletes", async () => {
    await seed(true);
    assert(
      (await native.prune(now)).every((outcome) =>
        outcome.skipped?.startsWith("refused:"),
      ),
    );
    for (const plan of Object.values(NEON_PRUNE_PLANS))
      assert.equal(
        (await control.query(`SELECT count(*)::int n FROM app.${plan.table}`))
          .rows[0].n,
        1,
      );
    await control.query(
      "DELETE FROM app.surface_checks; DELETE FROM app.subnet_burn_history",
    );
    await seed();
    await control.query(
      "CREATE FUNCTION app.fixture_retention_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delete rejected'; END $$; CREATE TRIGGER fixture_retention_reject BEFORE DELETE ON app.surface_checks FOR EACH ROW EXECUTE FUNCTION app.fixture_retention_reject()",
    );
    try {
      const outcomes = await native.prune(now);
      assert.match(
        outcomes[0]!.skipped!,
        /delete not acknowledged: fixture delete rejected/,
      );
      assert.deepEqual(outcomes[1], {
        table: "subnet_burn_history",
        deleted: 2,
      });
      assert.equal(
        (await control.query("SELECT count(*)::int n FROM app.surface_checks"))
          .rows[0].n,
        4,
      );
    } finally {
      await control.query(
        "DROP TRIGGER fixture_retention_reject ON app.surface_checks; DROP FUNCTION app.fixture_retention_reject()",
      );
    }
  });

  it("reports a deferred commit rejection without an acknowledged deletion", async () => {
    await seed();
    await control.query(
      "CREATE FUNCTION app.fixture_retention_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture commit rejected'; END $$; CREATE CONSTRAINT TRIGGER fixture_retention_commit_reject AFTER DELETE ON app.surface_checks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.fixture_retention_commit_reject()",
    );
    try {
      const outcomes = await native.prune(now);
      assert.match(
        outcomes[0]!.skipped!,
        /delete not acknowledged: fixture commit rejected/,
      );
      assert.equal(outcomes[0]!.deleted, 0);
      assert.deepEqual(outcomes[1], {
        table: "subnet_burn_history",
        deleted: 2,
      });
      assert.equal(
        (await control.query("SELECT count(*)::int n FROM app.surface_checks"))
          .rows[0].n,
        4,
      );
    } finally {
      await control.query(
        "DROP TRIGGER fixture_retention_commit_reject ON app.surface_checks; DROP FUNCTION app.fixture_retention_commit_reject()",
      );
    }
  });

  it("holds concurrent writers outside the impact and deletion transaction", async () => {
    await seed();
    const writer = new Client({
      connectionString,
      application_name: "retention-fixture-writer",
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    await writer.connect();
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const guarded = createPgRetentionStore({
      schema: "app",
      access: "read-write",
      relations: ["surface_checks", "subnet_burn_history"],
      transaction: (operation, options) =>
        runtime.transaction(
          (scope) =>
            operation({
              ...scope,
              async run(text, values) {
                const result = await scope.run(text, values);
                if (text.startsWith("LOCK TABLE app.surface_checks")) {
                  reached();
                  await blocked;
                }
                return result;
              },
            }),
          options,
        ),
    });
    const pruning = guarded.prune(now);
    let writing: Promise<unknown> | undefined;
    try {
      await locked;
      const at = now - NEON_PRUNE_PLANS.surface_checks!.retentionMs - 3;
      writing = writer.query(
        "INSERT INTO app.surface_checks(surface_id,checked_at) VALUES('concurrent',$1)",
        [at],
      );
      const deadline = Date.now() + 2000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await control.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE application_name='retention-fixture-writer'",
        );
        waiting = result.rows[0]?.wait_event_type === "Lock";
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(waiting, "concurrent writer waits for the retention table lock");
      release();
      assert((await pruning).every((outcome) => outcome.deleted === 2));
      await writing;
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::int n FROM app.surface_checks WHERE surface_id='concurrent'",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      release();
      await Promise.allSettled([pruning, writing]);
      await writer.end();
    }
  });
});
