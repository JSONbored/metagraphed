import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { before, after, beforeEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgRegistrySyncStore } from "../src/pg-registry-sync.ts";
import { createPgGeneratedArtifactStore } from "../src/pg-generated-artifacts.ts";
import { createPgSelfHealthStore } from "../src/pg-self-health.ts";
import { generatedArtifactStore } from "../src/generated-artifact-store.ts";
import { createD1Store } from "../src/d1-store.ts";
import { applyRegistrySyncToD1 } from "../src/registry-sync-d1.ts";
import { runSelfHealthProbe } from "../src/self-health-prober.ts";
import { selfHealthSql } from "../src/self-health-store.ts";
import { loadSelfHealthNeon } from "../src/self-health-neon.ts";
import type { RegistrySyncPayload } from "../src/registry-sync-neon.ts";
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
const registry = createPgRegistrySyncStore(runtime, () => "fixture-surface");
const generated = createPgGeneratedArtifactStore(runtime);
const health = createPgSelfHealthStore(runtime);
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
const stamp = Date.UTC(2026, 10, 4, 12);
const empty: RegistrySyncPayload = {
  providers: [],
  subnets: [],
  surfaces: [],
  pruneSurfaces: [],
  deleteSubnets: [],
};

describe(
  "native registry, snapshots and self-health",
  { concurrency: false },
  () => {
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
        "0006_generated_artifacts.sql",
        "0007_registry_health.sql",
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
      for (const table of [
        "surface_history",
        "surfaces",
        "subnets",
        "providers",
        "generated_artifacts",
        "self_health_checks",
        "self_health_daily",
      ]) {
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

    it("preserves repeated registry overlays, provenance and prune summaries", async () => {
      const surface = {
        subnet_netuid: 7,
        provider_id: "fixture",
        surface_key: "fixture",
        kind: "subnet-api",
        url: "https://example.com/api",
        overlay: { version: 1 },
        source_commit: "one",
      };
      const payload: RegistrySyncPayload = {
        ...empty,
        providers: [
          { id: "fixture", overlay: { name: "fixture" }, source_commit: "one" },
        ],
        subnets: [
          {
            netuid: 7,
            slug: "fixture",
            name: "Fixture",
            overlay: { version: 1 },
            source_commit: "one",
          },
        ],
        surfaces: [
          surface,
          { ...surface, overlay: { version: 2 }, source_commit: "two" },
          { ...surface, source_commit: "three" },
        ],
      };
      const original = createD1Store(db);
      assert.deepEqual(
        await registry.apply(payload),
        await applyRegistrySyncToD1(original, payload, {
          newId: () => "fixture-surface",
          now: () => stamp,
        }),
      );
      const pg = (
        await control.query(
          "SELECT id,overlay,probe_eligible::int,public_safe::int FROM app.surfaces ORDER BY id",
        )
      ).rows;
      assert.deepEqual(
        pg,
        await original.query(
          "SELECT id,overlay,probe_eligible,public_safe FROM surfaces ORDER BY id",
        ),
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT surface_id,action,overlay,source_commit FROM app.surface_history ORDER BY id",
          )
        ).rows,
        await original.query(
          "SELECT surface_id,action,overlay,source_commit FROM surface_history ORDER BY id",
        ),
      );
      const prune = {
        ...empty,
        pruneSurfaces: [
          { subnet_netuid: 7, current_surfaces: [], source_commit: "prune" },
        ],
      };
      assert.deepEqual(
        await registry.apply(prune),
        await applyRegistrySyncToD1(original, prune),
      );
      assert.equal(
        (await control.query("SELECT COUNT(*)::int n FROM app.surfaces"))
          .rows[0].n,
        0,
      );
      const failed = {
        ...payload,
        providers: [{ ...payload.providers[0]!, overlay: { name: "changed" } }],
        surfaces: [{ ...surface, source_commit: "reject" }],
      };
      await control.query(
        "ALTER TABLE app.surface_history ADD CONSTRAINT fixture_reject CHECK(source_commit <> 'reject')",
      );
      try {
        await assert.rejects(registry.apply(failed), /fixture_reject/);
        assert.equal(
          (
            await control.query(
              "SELECT overlay FROM app.providers WHERE id='fixture'",
            )
          ).rows[0].overlay,
          '{"name":"fixture"}',
        );
        assert.equal(
          (await control.query("SELECT COUNT(*)::int n FROM app.surfaces"))
            .rows[0].n,
          0,
        );
      } finally {
        await control.query(
          "ALTER TABLE app.surface_history DROP CONSTRAINT fixture_reject",
        );
      }
      const concurrent = createPgRegistrySyncStore(runtime);
      for (let round = 0; round < 5; round++) {
        await control.query("DELETE FROM app.surfaces");
        await Promise.all(
          ["a", "b"].map((side) =>
            concurrent.apply({
              ...empty,
              surfaces: [
                {
                  ...surface,
                  overlay: { round, side },
                  source_commit: `race-${round}-${side}`,
                },
              ],
            }),
          ),
        );
        const stored = (await control.query("SELECT id FROM app.surfaces"))
          .rows[0].id;
        const history = (
          await control.query(
            "SELECT surface_id FROM app.surface_history WHERE source_commit LIKE $1",
            [`race-${round}-%`],
          )
        ).rows;
        assert.equal(history.length, 2);
        assert(history.every((row) => row.surface_id === stored));
      }
    });

    it("preserves generated snapshot reads, replacement and invalid JSON handling", async () => {
      const original = generatedArtifactStore(db)!;
      for (const store of [original, generated]) {
        assert.equal(await store.get("absent"), null);
        await store.put("fixture", '{"version":1}');
        assert.deepEqual(await store.get("fixture"), { version: 1 });
        await store.put("fixture", '{"version":2}');
        assert.deepEqual(await store.get("fixture"), { version: 2 });
        await assert.rejects(store.put("invalid", "{"));
        assert.equal(await store.get("invalid"), null);
      }
      await generated.put("bounded", JSON.stringify({ text: "a".repeat(100) }));
      assert.equal(await generated.get("bounded", 64), null);
      assert.deepEqual(await generated.get("bounded", 1024), {
        text: "a".repeat(100),
      });
    });

    it("retains atomic duplicate ticks, daily counters and self-health reader bytes", async () => {
      const original = {
        D1_STATE: db,
        D1_STATE_TABLES: "self_health_checks,self_health_daily",
      };
      const native = { SELF_HEALTH_STORE: health, HYPERDRIVE: undefined };
      const laneHealthDb = {
        async query() {
          return [];
        },
        async run() {
          return { changes: 1 };
        },
      };
      for (const env of [original, native]) {
        for (const [time, status] of [
          [stamp, 200],
          [stamp, 503],
          [stamp + 60000, 503],
        ]) {
          await runSelfHealthProbe(env, null, {
            now: () => time!,
            fetch: async () => new Response(null, { status }),
            wait: () => new Promise<void>(() => {}),
            laneHealthDb,
          });
        }
      }
      assert.deepEqual(
        (
          await control.query(
            "SELECT day,component,checks::int,ok_count::int FROM app.self_health_daily ORDER BY component",
          )
        ).rows,
        await createD1Store(db).query(
          "SELECT day,component,checks,ok_count FROM self_health_daily ORDER BY component",
        ),
      );
      assert.deepEqual(
        await loadSelfHealthNeon(selfHealthSql(native), () => stamp + 60000),
        await loadSelfHealthNeon(selfHealthSql(original), () => stamp + 60000),
      );
      await control.query(
        "ALTER TABLE app.self_health_daily ADD CONSTRAINT fixture_daily CHECK(checks<3)",
      );
      try {
        await assert.rejects(
          health.record({
            component: "api",
            day: "2026-11-04",
            checkedAt: stamp + 120000,
            ok: true,
            http_status: 200,
            latency_ms: 1,
          }),
          /fixture_daily/,
        );
        assert.equal(
          (
            await control.query(
              "SELECT COUNT(*)::int n FROM app.self_health_checks WHERE checked_at_ms=$1",
              [stamp + 120000],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await control.query(
          "ALTER TABLE app.self_health_daily DROP CONSTRAINT fixture_daily",
        );
      }
      const tick = {
        component: "api",
        day: "2026-11-04",
        checkedAt: stamp + 120000,
        ok: true,
        http_status: 200,
        latency_ms: 1,
      };
      await Promise.all([health.record(tick), health.record(tick)]);
      assert.equal(
        (
          await control.query(
            "SELECT checks::int FROM app.self_health_daily WHERE component='api'",
          )
        ).rows[0].checks,
        3,
      );
    });
  },
);
