// GET /api/v1/internal/health-status-live (#9522), exercised END TO END
// against a REAL SQLite database through the real Worker fetch handler --
// same harness and rationale as tests/data-api-hotkey-alpha-d1.test.ts.
//
// This route is the prober's own continuity read, and it did not exist. Two
// callers in the main Worker have always requested it -- src/health-prober.ts
// with since=0 for the last known row per surface, src/health-serving.ts with
// a freshness cutoff for its KV-cold serving fallback -- and both got null on
// every call, because nothing answered the path AND the flag that gates the
// forward was not in DATA_API_D1_FLAGS.
//
// The consequence was not a missing field but a broken invariant: with an
// empty prior map the prober rewrote last_ok to null for every surface that
// was not ok this run, and restarted consecutive_failures at 1 -- capping it
// under the pool breaker's threshold of 2, so `sustained-down` eviction could
// never fire. Measured in production D1 before the fix: 0 of 109
// degraded/failed rows carried a last_ok while 85 had ok=1 rows in
// surface_checks, and consecutive_failures was 0 or 1 across all 635 rows.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import type { Row } from "./row-type.ts";

const { default: worker } = await import("../workers/data-api.ts");

// surface_status lives in the observations migration, alongside surface_checks.
const OBSERVATIONS_SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0002_observations.sql"),
  "utf8",
);

const PATH = "/api/v1/internal/health-status-live";

let db: InstanceType<typeof DatabaseSync>;

function d1() {
  return {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          return {
            text,
            values,
            async all() {
              return { results: db.prepare(text).all(...(values as never[])) };
            },
          };
        },
      };
    },
  };
}

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_HEALTH_DB: d1(),
    // What production runs. "postgres" would forward through the legacy tier;
    // "d1" is the value that was silently not forwarding.
    METAGRAPH_HEALTH_SOURCE: "d1",
    ...overrides,
  } as unknown as Env;
}

function get(query = "", envOverride?: Env) {
  return worker.fetch(
    new Request(`https://d${PATH}${query}`),
    envOverride ?? env(),
    {} as unknown as ExecutionContext,
  );
}

function insertStatus(overrides: Row = {}) {
  const row: Row = {
    surface_id: "sn7-api",
    surface_key: "srf-sn7apikey000000",
    netuid: 7,
    kind: "subnet-api",
    url: "https://example.com/api",
    provider: "example",
    status: "failed",
    classification: "dead",
    latency_ms: null,
    status_code: null,
    last_checked: 50_000,
    last_ok: 1_000,
    consecutive_failures: 2,
    updated_at: 50_000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO surface_status (surface_id, surface_key, netuid, kind, url,
       provider, status, classification, latency_ms, status_code, last_checked,
       last_ok, consecutive_failures, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...([
      row.surface_id,
      row.surface_key,
      row.netuid,
      row.kind,
      row.url,
      row.provider,
      row.status,
      row.classification,
      row.latency_ms,
      row.status_code,
      row.last_checked,
      row.last_ok,
      row.consecutive_failures,
      row.updated_at,
    ] as never[]),
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(OBSERVATIONS_SCHEMA);
});

test("serves the columns both callers read, including last_ok and the failure streak", async () => {
  insertStatus();
  const res = await get("?since=0");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rows: Row[] };
  assert.equal(body.rows.length, 1);
  const row = body.rows[0];
  // The two the prober needs for continuity -- the whole reason for the route.
  assert.equal(row.last_ok, 1_000);
  assert.equal(row.consecutive_failures, 2);
  // The rest is what liveFromStatusRows projects for the serving overlay; a
  // column dropped here silently degrades that fallback instead of failing it.
  assert.equal(row.surface_id, "sn7-api");
  assert.equal(row.surface_key, "srf-sn7apikey000000");
  assert.equal(row.netuid, 7);
  assert.equal(row.kind, "subnet-api");
  assert.equal(row.provider, "example");
  assert.equal(row.url, "https://example.com/api");
  assert.equal(row.status, "failed");
  assert.equal(row.classification, "dead");
  assert.equal(row.last_checked, 50_000);
});

// since=0 is the prober's call: it wants the last known row per surface even
// when that row is stale, because staleness is exactly what continuity spans.
test("since=0 returns every tracked surface regardless of age", async () => {
  insertStatus({
    surface_id: "fresh",
    surface_key: "k-fresh",
    last_checked: 9_000_000,
  });
  insertStatus({
    surface_id: "ancient",
    surface_key: "k-ancient",
    last_checked: 1,
  });
  const body = (await (await get("?since=0")).json()) as { rows: Row[] };
  assert.deepEqual(
    body.rows.map((r) => r.surface_id),
    ["ancient", "fresh"],
    "ordered by surface_id so the response is stable run to run",
  );
});

// A freshness cutoff is health-serving.ts's call: it deliberately wants only
// rows recent enough to serve, unlike the prober.
test("since filters on last_checked", async () => {
  insertStatus({
    surface_id: "fresh",
    surface_key: "k-fresh",
    last_checked: 9_000_000,
  });
  insertStatus({
    surface_id: "stale",
    surface_key: "k-stale",
    last_checked: 1,
  });
  const body = (await (await get("?since=100000")).json()) as { rows: Row[] };
  assert.deepEqual(
    body.rows.map((r) => r.surface_id),
    ["fresh"],
  );
});

// An absent or unparseable `since` must not become NaN in the comparison --
// that would filter everything out and silently reproduce the empty prior map
// this route exists to fix.
test("a missing or unparseable since is treated as 0, not NaN", async () => {
  insertStatus({ last_checked: 5 });
  assert.equal(
    ((await (await get()).json()) as { rows: Row[] }).rows.length,
    1,
    "no since param",
  );
  assert.equal(
    ((await (await get("?since=not-a-number")).json()) as { rows: Row[] }).rows
      .length,
    1,
    "unparseable since",
  );
});

test("an empty table is an empty row set, not an error", async () => {
  const res = await get("?since=0");
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { rows: [] });
});

test("declines with 503 when the D1 binding is absent", async () => {
  const res = await get("?since=0", {
    METAGRAPH_HEALTH_SOURCE: "d1",
  } as unknown as Env);
  assert.equal(res.status, 503);
});

// Under "postgres" this route is the legacy tier's to answer, so the D1
// matcher must decline rather than shadow it.
test("does not claim the route when the flag says postgres", async () => {
  insertStatus();
  const res = await get(
    "?since=0",
    env({ METAGRAPH_HEALTH_SOURCE: "postgres" }),
  );
  assert.notEqual(res.status, 200);
});

// A failing query answers an opaque 502 that leaks no DB detail -- the same
// envelope the neurons and hyperparams D1 blocks use. It matters here because
// the caller reads a non-2xx as "this tier declines" and carries on with an
// empty prior map, which is the pre-fix behaviour: degraded, not broken.
test("a failing query is an opaque 502, never a leaked DB error", async () => {
  const exploding = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        throw new Error("no such table: surface_status");
      },
    },
    METAGRAPH_HEALTH_SOURCE: "d1",
  } as unknown as Env;
  const res = await get("?since=0", exploding);
  assert.equal(res.status, 502);
  const body = (await res.json()) as Row;
  assert.equal(body.error, "data query failed");
  assert.equal(
    JSON.stringify(body).includes("surface_status"),
    false,
    "the underlying DB error must not reach the response",
  );
});
