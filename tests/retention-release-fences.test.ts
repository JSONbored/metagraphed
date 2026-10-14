import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { test } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import {
  LANE_HEALTH_RETENTION_MS,
  recordLaneVerdict,
} from "../src/lane-health.ts";
import { captureSubnetBurnHistory } from "../src/subnet-burn-history.ts";

const fences = JSON.parse(
  readFileSync(
    new URL("./fixtures/retention-release-fences.json", import.meta.url),
    "utf8",
  ),
) as { install: string[]; release: string[] };
const ddl = (name: string) =>
  readFileSync(
    new URL(`../migrations/d1/${name}`, import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint");

test("native release fences refuse old unbounded deletes, preserve honest writes through DDL and release only bounded new cleanup", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of [
      "0001_lane_health.sql",
      "0002_lane_health_current.sql",
      "0003_lane_health_history_indexes.sql",
    ])
      for (const sql of ddl(name)) await db.prepare(sql).run();
    for (const sql of ddl("0009_subnet_identity_state.sql"))
      if (
        /CREATE TABLE subnet_burn_history\(|CREATE INDEX idx_subnet_burn_history_observed/.test(
          sql,
        )
      )
        await db.prepare(sql).run();
    const now = 1790000000000,
      expired = now - LANE_HEALTH_RETENTION_MS - 1;
    await db
      .prepare(
        "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<40) INSERT INTO lane_health(lane,verdict,checked_at) SELECT 'fenced','ok',?-i FROM n",
      )
      .bind(expired)
      .run();
    await db
      .prepare("INSERT INTO subnet_burn_history VALUES(1,?,1),(2,?,1)")
      .bind(expired, expired)
      .run();
    await db.batch(fences.install.map((sql) => db.prepare(sql)));
    for (const table of ["lane_health", "subnet_burn_history"])
      await assert.rejects(
        db.prepare(`DELETE FROM ${table}`).run(),
        /Retention release fence/,
      );
    assert.equal(
      await db.prepare("SELECT count(*) AS n FROM lane_health").first("n"),
      40,
    );
    assert.equal(
      await db
        .prepare("SELECT count(*) AS n FROM subnet_burn_history")
        .first("n"),
      2,
    );
    for (const sql of ddl("0039_lane_health_retention_trigger_bounds.sql"))
      await db.prepare(sql).run();
    const store = laneHealthStore({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
    })!;
    assert.equal(
      await store.retentionReady!(),
      true,
      "exact repaired definitions do not bypass the independent operational fence",
    );
    const verdict = {
      lane: "fenced",
      verdict: "ok" as const,
      age_ms: null,
      detail: null,
      checked_at: now,
    };
    assert.equal(
      await recordLaneVerdict(store, verdict, { confirm: true }),
      true,
    );
    const capture = () =>
      captureSubnetBurnHistory({} as Env, {
        db: createD1Store(db),
        now: () => now,
        load: async () => ({ subnets: [{ netuid: 3, burn_tao: 1 }] }),
      });
    assert.deepEqual(await capture(), { ok: true, captured: 1, pruned: false });
    assert.equal(
      await db.prepare("SELECT count(*) AS n FROM lane_health").first("n"),
      41,
      "acknowledged insert survives its refused housekeeping",
    );
    assert.equal(
      await db
        .prepare("SELECT count(*) AS n FROM subnet_burn_history")
        .first("n"),
      3,
    );
    await db.batch(fences.release.map((sql) => db.prepare(sql)));
    assert.equal(
      await recordLaneVerdict(store, verdict, { confirm: true }),
      true,
    );
    assert.equal(
      await db.prepare("SELECT count(*) AS n FROM lane_health").first("n"),
      22,
      "the new writer deletes at most20 and preserves both latest ties",
    );
    assert.deepEqual(await capture(), { ok: true, captured: 1, pruned: true });
    assert.equal(
      await db
        .prepare("SELECT count(*) AS n FROM subnet_burn_history")
        .first("n"),
      1,
    );
    console.info(
      "retention_release_fences",
      JSON.stringify({
        installed: 2,
        old_unbounded_deletes_refused: 2,
        health_insert_ack_preserved: true,
        burn_insert_ack_preserved: true,
        released: 2,
        new_health_direct_deletions: 20,
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
