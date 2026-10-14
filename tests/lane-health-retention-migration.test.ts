import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
async function apply(name: string) {
  const sql = readFileSync(
    new URL(`../migrations/d1/${name}`, import.meta.url),
    "utf8",
  );
  for (const statement of sql.split("-- statement-breakpoint"))
    await db.prepare(statement).run();
}
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0003_lane_health_history_indexes.sql",
  ])
    await apply(name);
});
afterAll(() => runtime.dispose());
const rows = async (sql: string) => (await db.prepare(sql).all()).results;
async function assertProjections() {
  assert.deepEqual(
    await rows(
      "SELECT lane,checked_at,occurrences,previous_at,gap FROM lane_health_clocks ORDER BY lane,checked_at",
    ),
    await rows(`SELECT lane,checked_at,occurrences,previous_at,checked_at-previous_at AS gap FROM (
    SELECT lane,checked_at,count(*) AS occurrences,lag(checked_at) OVER(PARTITION BY lane ORDER BY checked_at) AS previous_at FROM lane_health GROUP BY lane,checked_at) ORDER BY lane,checked_at`),
  );
  assert.deepEqual(
    await rows(
      "SELECT lane,verdict,checked_at FROM lane_health_verdict_latest ORDER BY lane,verdict",
    ),
    await rows(
      "SELECT lane,verdict,max(checked_at) AS checked_at FROM lane_health GROUP BY lane,verdict ORDER BY lane,verdict",
    ),
  );
  assert.deepEqual(
    await rows(
      "SELECT lane,verdict,age_ms,detail,checked_at,_history_rowid FROM lane_health_current ORDER BY lane",
    ),
    await rows(`SELECT lane,verdict,age_ms,detail,checked_at,history_rowid AS _history_rowid FROM (
    SELECT *,rowid AS history_rowid,row_number() OVER(PARTITION BY lane ORDER BY checked_at DESC,CASE verdict WHEN 'stale' THEN 2 WHEN 'ok' THEN 0 ELSE 1 END DESC,rowid) AS n FROM lane_health) WHERE n=1 ORDER BY lane`),
  );
}

test("0043 preserves populated projections, then repairs ties, moves, middle and multirow deletions atomically", async () => {
  await db
    .prepare(
      `INSERT INTO lane_health(lane,verdict,age_ms,detail,checked_at) VALUES
    ('a','ok',1,'first',10),('a','stale',2,'middle tie',20),('a','stale',3,'middle tie 2',20),
    ('a','unknown',4,'middle successor',30),('a','ok',5,'newest',40),('a','stale',6,'newest stale',40),
    ('b','ok',7,'other lane',5),('b','stale',8,'other latest',15)`,
    )
    .run();
  await assertProjections();
  const before = await rows("SELECT * FROM lane_health ORDER BY rowid");
  const definitions = await rows(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
  );
  const statements = readFileSync(
    new URL(
      "../migrations/d1/0043_lane_health_retention_trigger_bounds.sql",
      import.meta.url,
    ),
    "utf8",
  ).split("-- statement-breakpoint");
  await assert.rejects(
    db.batch([
      ...statements.map((sql) => db.prepare(sql)),
      db.prepare(
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES(NULL,'ok',99)",
      ),
    ]),
    /NOT NULL/,
  );
  assert.deepEqual(
    await rows(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    ),
    definitions,
    "failed migration batches restore original triggers too",
  );
  await assertProjections();
  await apply("0043_lane_health_retention_trigger_bounds.sql");
  assert.deepEqual(
    await rows("SELECT * FROM lane_health ORDER BY rowid"),
    before,
  );
  await assertProjections();
  const operations = [
    "DELETE FROM lane_health WHERE detail='middle tie'",
    "DELETE FROM lane_health WHERE detail='middle tie 2'",
    "DELETE FROM lane_health WHERE detail='newest'",
    "UPDATE lane_health SET checked_at=25 WHERE detail='newest stale'",
    "UPDATE lane_health SET checked_at=50 WHERE detail='newest stale'",
    "UPDATE lane_health SET lane='b',checked_at=5,verdict='unknown' WHERE detail='middle successor'",
    "UPDATE lane_health SET verdict='stale' WHERE detail='other lane'",
    "UPDATE lane_health SET verdict='ok',checked_at=5 WHERE detail='other latest'",
    "UPDATE lane_health SET lane='c',checked_at=1 WHERE detail='other latest'",
    "DELETE FROM lane_health WHERE lane='b'",
    "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('a','unknown',35),('a','stale',35),('a','ok',45),('a','stale',45)",
    "DELETE FROM lane_health WHERE lane='a' AND checked_at>=35",
  ];
  for (const sql of operations) {
    await db.prepare(sql).run();
    await assertProjections();
  }
  const snapshot = await rows("SELECT * FROM lane_health ORDER BY rowid");
  await assert.rejects(
    db.batch([
      db.prepare("DELETE FROM lane_health"),
      db.prepare(
        "INSERT INTO lane_health(lane,verdict,checked_at) VALUES(NULL,'ok',99)",
      ),
    ]),
  );
  assert.deepEqual(
    await rows("SELECT * FROM lane_health ORDER BY rowid"),
    snapshot,
  );
  await assertProjections();
  await db.prepare("DELETE FROM lane_health").run();
  await assertProjections();
  for (const table of [
    "lane_health_current",
    "lane_health_clocks",
    "lane_health_verdict_latest",
  ])
    assert.equal((await rows(`SELECT count(*) AS n FROM ${table}`))[0].n, 0);
});

test("verdict refresh is independent of update-trigger installation order", async () => {
  const triggers = await rows(
    "SELECT name,sql FROM sqlite_master WHERE name IN ('lane_health_verdict_update','lane_health_verdict_update_new') ORDER BY name DESC",
  );
  for (const trigger of triggers)
    await db.prepare(`DROP TRIGGER ${trigger.name}`).run();
  for (const trigger of triggers) await db.prepare(String(trigger.sql)).run();
  await db
    .prepare(
      "INSERT INTO lane_health(lane,verdict,checked_at) VALUES ('order','ok',10),('order','stale',20),('order','stale',20),('order','stale',30)",
    )
    .run();
  await assertProjections();
  for (const sql of [
    "UPDATE lane_health SET checked_at=15 WHERE lane='order' AND checked_at=30",
    "UPDATE lane_health SET checked_at=40 WHERE lane='order' AND checked_at=15",
    "UPDATE lane_health SET lane='moved',verdict='unknown',checked_at=1 WHERE lane='order' AND checked_at=40",
    "UPDATE lane_health SET verdict='future-verdict' WHERE lane='order' AND checked_at=20",
    "UPDATE lane_health SET age_ms=99,detail='detail only',checked_at=checked_at WHERE lane='moved'",
    "DELETE FROM lane_health",
  ]) {
    await db.prepare(sql).run();
    await assertProjections();
  }
});

test("native successor and latest-verdict plans use timestamp keys without grouped refresh scans", async () => {
  const successor = `UPDATE lane_health_clocks SET previous_at=(SELECT max(checked_at) FROM lane_health_clocks WHERE lane=? AND checked_at<?)
    WHERE lane=? AND checked_at=(SELECT min(checked_at) FROM lane_health_clocks WHERE lane=? AND checked_at>?) AND previous_at=?`;
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${successor}`)
    .bind("a", 20, "a", "a", 20, 20)
    .all<{ detail: string }>();
  const detail = plan.results.map((r) => r.detail).join("\n");
  assert.match(
    detail,
    /SEARCH lane_health_clocks USING PRIMARY KEY \(lane=\? AND checked_at=\?\)/,
  );
  assert.doesNotMatch(detail, /SCAN lane_health_clocks|USE TEMP B-TREE/);
  const latest = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT lane,verdict,checked_at FROM lane_health WHERE lane=? AND verdict=? ORDER BY checked_at DESC LIMIT 1",
    )
    .bind("a", "stale")
    .all<{ detail: string }>();
  assert.match(
    latest.results.map((r) => r.detail).join("\n"),
    /idx_lane_health_verdict/,
  );
  assert.doesNotMatch(
    latest.results.map((r) => r.detail).join("\n"),
    /SCAN lane_health|USE TEMP B-TREE/,
  );
  const sql = (
    await rows(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('lane_health_clocks_delete','lane_health_clocks_update','lane_health_verdict_delete','lane_health_verdict_update')",
    )
  )
    .map((r) => String(r.sql))
    .join("\n");
  assert.doesNotMatch(sql, /GROUP BY/);
  assert.match(sql, /WHEN EXISTS/);
});
