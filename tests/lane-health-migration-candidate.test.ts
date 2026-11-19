import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import {
  normalizeSchema,
  schemaChanges,
  snapshotD1Schema,
  type SchemaObject,
} from "../scripts/snapshot-d1-schema.ts";
import {
  LANE_HEALTH_RETENTION_TRIGGER_HASHES,
  laneHealthRetentionReady,
} from "../src/lane-health-retention-ready.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import {
  LANE_HEALTH_RETENTION_MS,
  recordLaneVerdict,
} from "../src/lane-health.ts";
import {
  HEALTH_RETENTION_MIGRATION,
  healthRetentionTestSql,
} from "./helpers/lane-health-retention-fixture.ts";

const freshRuntime = () =>
  new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
const statements = (sql: string) =>
  sql.split("-- statement-breakpoint").filter((part) => part.trim());
const repairedNames = [
  "lane_health_clocks_delete",
  "lane_health_clocks_update",
  "lane_health_verdict_delete",
  "lane_health_verdict_update",
  "lane_health_verdict_update_new",
];

test("the tracked successor applies to all 38 historical migrations and alone enables zero-eligible housekeeping", async () => {
  const files = readdirSync(new URL("../migrations/d1/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const healthIndex = files.indexOf(HEALTH_RETENTION_MIGRATION);
  assert.notEqual(healthIndex, -1);
  const history = files.slice(0, healthIndex);
  assert.equal(history.length, 38);
  assert.equal(history.at(-1), "0038_raw_capture_publications.sql");
  const runtime = freshRuntime();
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of history)
      await db.batch(
        statements(healthRetentionTestSql(name)).map((sql) => db.prepare(sql)),
      );
    const query = async (sql: string) => (await db.prepare(sql).all()).results;
    assert.equal(await laneHealthRetentionReady(query), false);
    const definitions = await query(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'lane_health_%' ORDER BY name",
    );
    const status = { missing: 0, different: 0, matching: 0 };
    for (const [name, expected] of Object.entries(
      LANE_HEALTH_RETENTION_TRIGGER_HASHES,
    )) {
      const row = definitions.find((value) => value.name === name);
      if (!row) status.missing++;
      else {
        const normalized = normalizeSchema([
          { ...row, type: "trigger", tbl_name: "lane_health" },
        ])[0]!.sql;
        const actual = createHash("sha256").update(normalized).digest("hex");
        status[actual === expected ? "matching" : "different"]++;
      }
    }
    assert.deepEqual(status, { missing: 2, different: 3, matching: 1 });
    const now = 1790000000000;
    const cutoff = now - LANE_HEALTH_RETENTION_MS;
    await db
      .prepare(
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('zero','ok',?),('zero','stale',?),('latest-ties','ok',?),('latest-ties','stale',?)",
      )
      .bind(cutoff, cutoff + 1, cutoff - 1, cutoff - 1)
      .run();
    const env = { D1_STATE: db, D1_STATE_TABLES: "lane_health" };
    const old = laneHealthStore(env)!;
    assert.equal(await old.retentionReady!(), false);
    const before = await query("SELECT * FROM lane_health ORDER BY rowid");
    const repair = statements(
      healthRetentionTestSql("retention-trigger-repair.sql"),
    );
    await assert.rejects(
      db.batch([
        ...repair.map((sql) => db.prepare(sql)),
        db.prepare(
          "INSERT INTO lane_health(lane,verdict,checked_at) VALUES(NULL,'ok',1)",
        ),
      ]),
      /NOT NULL/,
    );
    assert.deepEqual(
      await query(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'lane_health_%' ORDER BY name",
      ),
      definitions,
    );
    assert.equal(await laneHealthRetentionReady(query), false);
    await db.batch(repair.map((sql) => db.prepare(sql)));
    assert.deepEqual(
      await query("SELECT * FROM lane_health ORDER BY rowid"),
      before,
    );
    assert.equal(await old.retentionReady!(), false);
    const fresh = laneHealthStore(env)!;
    assert.equal(await fresh.retentionReady!(), true);
    const deletions: { sql: string; changes: number }[] = [];
    const run = fresh.run!;
    fresh.run = async (sql, values) => {
      const result = await run(sql, values);
      if (sql.startsWith("DELETE FROM lane_health"))
        deletions.push({ sql, changes: result.changes });
      return result;
    };
    assert.equal(
      await recordLaneVerdict(fresh, {
        lane: "zero",
        verdict: "ok",
        age_ms: null,
        detail: null,
        checked_at: now,
      }),
      true,
    );
    assert.equal(deletions.length, 1);
    assert.match(deletions[0]!.sql, /checked_at < \(/);
    assert.match(deletions[0]!.sql, /LIMIT 20/);
    assert.equal(deletions[0]!.changes, 0);
    assert.deepEqual(
      (await query("SELECT * FROM lane_health ORDER BY rowid")).slice(
        0,
        before.length,
      ),
      before,
    );
  } finally {
    await runtime.dispose();
  }
});

test("native candidate schema changes only the five repaired definitions and reproduces both committed snapshots", async () => {
  const expected = JSON.parse(
    readFileSync(
      new URL("../generated/db/d1-schema.json", import.meta.url),
      "utf8",
    ),
  ) as SchemaObject[];
  const oldTriggers = [
    ...healthRetentionTestSql("0003_lane_health_history_indexes.sql").matchAll(
      /CREATE TRIGGER (\w+)\b[\s\S]*?END;/g,
    ),
  ]
    .filter((match) => repairedNames.includes(match[1]!))
    .map((match) => ({
      type: "trigger",
      name: match[1]!,
      tbl_name: "lane_health",
      sql: match[0],
    }));
  assert.equal(oldTriggers.length, 3);
  const baseline = normalizeSchema([
    ...expected
      .filter((row) => !repairedNames.includes(row.name))
      .map((row) => ({ ...row })),
    ...oldTriggers,
  ]);
  const runtime = freshRuntime();
  try {
    const db = await runtime.getD1Database("DB");
    for (const type of ["table", "index", "view", "trigger"])
      for (const row of baseline.filter((value) => value.type === type))
        await db.prepare(row.sql).run();
    const batch = async () => [
      {
        results: (
          await db
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
            )
            .all()
        ).results,
      },
    ];
    assert.deepEqual(normalizeSchema((await batch())[0]!.results), baseline);
    await db.batch(
      statements(healthRetentionTestSql("retention-trigger-repair.sql")).map(
        (sql) => db.prepare(sql),
      ),
    );
    const after = normalizeSchema((await batch())[0]!.results);
    assert.deepEqual(schemaChanges(baseline, after), repairedNames);
    assert.equal(
      await laneHealthRetentionReady(
        async (sql) => (await db.prepare(sql).all()).results,
      ),
      true,
    );
    const output = process.env.LANE_HEALTH_SCHEMA_OUTPUT;
    if (output) await snapshotD1Schema(true, batch, output);
    else {
      assert.deepEqual(after, expected);
      await snapshotD1Schema(false, batch);
    }
  } finally {
    await runtime.dispose();
  }
});
