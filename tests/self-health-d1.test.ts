import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { runSelfHealthProbe } from "../src/self-health-prober.ts";
import { selfHealthSql } from "../src/self-health-store.ts";
import { loadSelfHealthNeon } from "../src/self-health-neon.ts";
import { loadSelfHealth } from "../src/self-health-mcp.ts";
import { handleSelfHealth } from "../workers/request-handlers/entities.ts";
import { apiEnv } from "./helpers/worker-env.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const stamp = Date.now();
const env = () =>
  apiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: "self_health_checks,self_health_daily,lane_health",
    HYPERDRIVE: undefined,
  });
const deps = {
  now: () => stamp,
  fetch: async () => new Response(null, { status: 200 }),
  wait: () => new Promise<void>(() => {}),
};
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    for (const sql of readFileSync(new URL(file, root), "utf8").split(
      "-- statement-breakpoint",
    ))
      if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  for (const t of ["self_health_checks", "self_health_daily", "lane_health"])
    await db.prepare(`DELETE FROM ${t}`).run();
});
test("native probe retries keep tick and daily counts atomic", async () => {
  await runSelfHealthProbe(env(), null, deps);
  await runSelfHealthProbe(env(), null, {
    ...deps,
    fetch: async () => new Response(null, { status: 503 }),
  });
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM self_health_checks").first("n"),
    3,
  );
  assert.deepEqual(
    (await db.prepare("SELECT checks,ok_count FROM self_health_daily").all())
      .results,
    [
      { checks: 1, ok_count: 1 },
      { checks: 1, ok_count: 1 },
      { checks: 1, ok_count: 1 },
    ],
  );
  await runSelfHealthProbe(env(), null, {
    ...deps,
    now: () => stamp + 60000,
    fetch: async () => new Response(null, { status: 503 }),
  });
  const card = await loadSelfHealthNeon(selfHealthSql(env()));
  assert.equal(card?.verdict, "outage");
  assert.equal(card?.measured_component_count, 3);
  for (const c of card!.components) {
    assert.equal(c.current_ok, false);
    assert.equal(c.days[0].checks, 2);
    assert.equal(c.days[0].ok_count, 1);
  }
});
test("a failed tick rolls back its daily contribution and reports stale capture", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_tick BEFORE INSERT ON self_health_checks WHEN NEW.component='api' BEGIN SELECT RAISE(ABORT,'injected'); END",
    )
    .run();
  try {
    await runSelfHealthProbe(env(), null, deps);
    assert.equal(
      await db
        .prepare(
          "SELECT COUNT(*) n FROM self_health_daily WHERE component='api'",
        )
        .first("n"),
      0,
    );
    assert.equal(
      await db
        .prepare(
          "SELECT verdict FROM lane_health_current WHERE lane='self-health-probe'",
        )
        .first("verdict"),
      "stale",
    );
  } finally {
    await db.prepare("DROP TRIGGER reject_tick").run();
  }
});
test("REST and agent health return the same native observations without PostgreSQL or a waitUntil context", async () => {
  await runSelfHealthProbe(env(), null, deps);
  const environment = env();
  const response = await handleSelfHealth(
    new Request("https://example.com/api/v1/self-health"),
    environment,
  );
  assert.equal(response.status, 200);
  const rest = await response.json<{ data: unknown }>();
  const agent = await loadSelfHealth({
    env: environment,
    readArtifact: async () => {
      throw new Error("Unexpected fallback");
    },
  });
  assert.deepEqual(agent, rest.data);
});
test("missing stores and partially selected health state cannot masquerade as available", () => {
  assert.equal(selfHealthSql(undefined), null);
  assert.throws(
    () =>
      selfHealthSql(
        apiEnv({ D1_STATE: db, D1_STATE_TABLES: "self_health_checks" }),
      ),
    /spans D1/,
  );
  assert.throws(
    () =>
      selfHealthSql(
        apiEnv({
          D1_STATE: undefined,
          D1_STATE_TABLES: "self_health_checks,self_health_daily",
        }),
      ),
    /unbound/,
  );
});
test("a malformed latest-row result retains measured daily history without inventing current status", async () => {
  await runSelfHealthProbe(env(), null, deps);
  const sql = selfHealthSql(env())!;
  const query = sql.unsafe;
  sql.unsafe = async <Row>(text: string, values?: unknown[]) =>
    text.includes("self_health_checks")
      ? (null as never)
      : query<Row>(text, values);
  const card = await loadSelfHealthNeon(sql);
  assert.ok(card);
  assert.equal(card.measured_component_count, 0);
  for (const component of card.components) {
    assert.equal(component.current_ok, null);
    assert.equal(component.days[0].checks, 1);
  }
});
