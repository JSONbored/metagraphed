import { healthRetentionTestSql } from "./helpers/lane-health-retention-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import {
  LANE_HEALTH_RETENTION_TRIGGER_HASHES,
  laneHealthRetentionReady,
} from "../src/lane-health-retention-ready.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import { recordLaneVerdict } from "../src/lane-health.ts";

const ddl = healthRetentionTestSql;
const names = Object.keys(LANE_HEALTH_RETENTION_TRIGGER_HASHES);
const definitions = [
  ...ddl("0002_lane_health_current.sql").matchAll(
    /CREATE TRIGGER (\w+)\b[\s\S]*?END;/g,
  ),
  ...ddl("retention-trigger-repair.sql").matchAll(
    /CREATE TRIGGER (\w+)\b[\s\S]*?END;/g,
  ),
]
  .filter((match) => names.includes(match[1]))
  .map((match) => ({ name: match[1], sql: match[0] }));

test("readiness hashes pin all six exact source definitions and permit SQLite's missing final semicolon", async () => {
  assert.equal(definitions.length, 6);
  for (const row of definitions) {
    assert.equal(
      createHash("sha256").update(row.sql.replace(/;$/, "")).digest("hex"),
      LANE_HEALTH_RETENTION_TRIGGER_HASHES[row.name],
    );
  }
  let query = "";
  assert.equal(
    await laneHealthRetentionReady(async (sql) => {
      query = sql;
      return [...definitions].reverse();
    }),
    true,
  );
  assert.match(query, /FROM sqlite_master WHERE type='trigger'/);
  assert.match(query, /LIMIT 7$/);
  assert.equal(
    await laneHealthRetentionReady(async () =>
      definitions.map((row) => ({
        ...row,
        sql:
          "\n" +
          row.sql
            .split("\n")
            .map((line) => line + "  ")
            .join("\n") +
          "\n",
      })),
    ),
    true,
  );
  assert.equal(
    await laneHealthRetentionReady(async () =>
      definitions.map((row) => ({ ...row, sql: row.sql.slice(0, -1) })),
    ),
    true,
  );
});

test("missing, duplicate, malformed, unexpected and changed physical definitions fail closed", async () => {
  const invalid: unknown[][] = [
    [],
    [...definitions, definitions[0]],
    [null, ...definitions.slice(1)],
    [42, ...definitions.slice(1)],
    [{ name: 1, sql: "trigger" }, ...definitions.slice(1)],
    [{ name: names[0], sql: null }, ...definitions.slice(1)],
    [{ name: "unrecognized", sql: "trigger" }, ...definitions.slice(1)],
    [definitions[0], definitions[0], ...definitions.slice(2)],
    [
      {
        ...definitions[0],
        sql: definitions[0].sql.replace("AFTER DELETE", "BEFORE DELETE"),
      },
      ...definitions.slice(1),
    ],
  ];
  for (const rows of invalid)
    assert.equal(await laneHealthRetentionReady(async () => rows), false);
  assert.equal(
    await laneHealthRetentionReady(async () => {
      throw new Error("metadata unavailable");
    }),
    false,
  );
});

test("a throwing readiness dependency cannot override either insertion acknowledgement", async () => {
  for (const rejected of [false, true]) {
    const calls: string[] = [];
    const ok = await recordLaneVerdict(
      {
        query: async () => [],
        run: async (sql) => {
          calls.push(sql);
          if (rejected) throw new Error("SQLITE_FULL");
          return { changes: 1 };
        },
        retentionReady: async () => {
          throw new Error("not readable");
        },
      },
      {
        lane: "ready",
        verdict: "ok",
        age_ms: null,
        detail: null,
        checked_at: 1790000000000,
      },
    );
    assert.equal(ok, !rejected);
    assert.equal(calls.length, 1, "no cleanup or insertion replay");
  }
});

test("native D1 metadata gates cleanup, caches once per store and refreshes on the next request", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    const apply = async (name: string) => {
      for (const sql of ddl(name).split("-- statement-breakpoint"))
        await db.prepare(sql).run();
    };
    for (const name of [
      "0001_lane_health.sql",
      "0002_lane_health_current.sql",
      "0003_lane_health_history_indexes.sql",
    ])
      await apply(name);
    let queries = 0;
    const measured = {
      prepare(sql: string) {
        if (sql.includes("FROM sqlite_master")) queries++;
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const old = laneHealthStore({
      D1_STATE: measured,
      D1_STATE_TABLES: "lane_health",
    })!;
    assert.equal(await old.retentionReady!(), false);
    assert.equal(await old.retentionReady!(), false);
    assert.equal(queries, 1);
    await apply("retention-trigger-repair.sql");
    assert.equal(
      await old.retentionReady!(),
      false,
      "the in-flight request remains conservatively disabled",
    );
    assert.equal(queries, 1);
    const fresh = laneHealthStore({
      D1_STATE: measured,
      D1_STATE_TABLES: "lane_health",
    })!;
    assert.equal(
      await fresh.retentionReady!(),
      true,
      "real SQLite SQL must match all six independently pinned hashes",
    );
    assert.equal(await fresh.retentionReady!(), true);
    assert.equal(queries, 2);
    await db.prepare("DROP TRIGGER lane_health_verdict_delete").run();
    const missing = laneHealthStore({
      D1_STATE: measured,
      D1_STATE_TABLES: "lane_health",
    })!;
    assert.equal(
      await missing.retentionReady!(),
      false,
      "a different request rechecks actual schema; no isolate-global readiness cache",
    );
    assert.equal(queries, 3);
  } finally {
    await runtime.dispose();
  }
});
