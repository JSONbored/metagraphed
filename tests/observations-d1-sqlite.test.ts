// Executes src/observations-d1.ts's statements against a REAL SQLite database
// built from migrations/d1/0002_observations.sql -- same rationale as
// tests/registry-sync-d1-sqlite.test.ts: a fake records SQL but never parses
// it, and the riskiest constructs here (the double ON CONFLICT with a partial
// unique index, the rank CTE from health-sql.ts) only fail at execution.
// node:sqlite keeps this dependency-free.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, test } from "vitest";
import {
  persistProbesToD1,
  pruneChecksD1,
  rollupUptimeDailyToD1,
  runD1StatementBatches,
  upsertSubnetSnapshotsToD1,
  type ObservationsDb,
} from "../src/observations-d1.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0002_observations.sql"),
  "utf8",
);

// The #9634 repair, executed rather than eyeballed: it is a correlated UPDATE
// with a matching guard subquery, which is exactly the shape that silently
// no-ops or over-writes when it is only read.
const LAST_OK_REPAIR = fs.readFileSync(
  path.join(
    process.cwd(),
    "migrations/d1/0027_surface_status_last_ok_repair.sql",
  ),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;

function d1(): ObservationsDb {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    async batch(statements: unknown[]) {
      db.exec("BEGIN");
      try {
        for (const s of statements as { sql: string; values: unknown[] }[]) {
          db.prepare(s.sql).run(...(s.values as never[]));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return statements;
    },
  };
}

const probe = (over: Record<string, unknown> = {}) => ({
  surface_id: "sn8-docs",
  surface_key: "8|docs|https://example.com/docs",
  netuid: 8,
  kind: "docs",
  url: "https://example.com/docs",
  provider: "acme",
  status: "ok",
  classification: null,
  latency_ms: 120,
  status_code: 200,
  checked_at_ms: Date.parse("2026-08-02T10:00:00Z"),
  last_ok_ms: Date.parse("2026-08-02T10:00:00Z"),
  consecutive_failures: 0,
  ...over,
});

const count = (t: string) =>
  (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
});

test("a probe sweep lands one check row and one status row per surface", async () => {
  const res = await persistProbesToD1(d1(), [probe()], Date.now());
  assert.equal(res.ok, true);
  assert.equal(count("surface_checks"), 1);
  assert.equal(count("surface_status"), 1);
  const status = db
    .prepare("SELECT status, consecutive_failures FROM surface_status")
    .get() as Record<string, unknown>;
  assert.equal(status.status, "ok");
});

// The #1005 alias behaviour the double ON CONFLICT exists for: a re-probe of
// the same surface_key with a NEW display id must update the existing row in
// place, not grow a second one.
test("re-probing the same surface_key upserts in place across an id rename", async () => {
  await persistProbesToD1(d1(), [probe()], 1);
  const res = await persistProbesToD1(
    d1(),
    [
      probe({
        surface_id: "sn8-docs-renamed",
        status: "failed",
        latency_ms: null,
        consecutive_failures: 3,
      }),
    ],
    2,
  );
  assert.equal(res.ok, true);
  assert.equal(count("surface_status"), 1, "alias updated, not duplicated");
  const row = db
    .prepare(
      "SELECT surface_id, status, consecutive_failures FROM surface_status",
    )
    .get() as Record<string, unknown>;
  assert.equal(row.surface_id, "sn8-docs-renamed");
  assert.equal(row.status, "failed");
  assert.equal(row.consecutive_failures, 3);
  assert.equal(count("surface_checks"), 2, "raw history keeps both probes");
});

// #9634: `last_ok` is a high-water mark, so a run that did not observe the
// surface working must not be able to clear it. The prober passes
// `last_ok_ms: null` whenever its prior-status read came back empty --
// readLiveSurfaceStatus degrades to [] on a missing binding, a non-2xx or an
// unparseable body -- and a bare `last_ok=excluded.last_ok` turned that
// read-side degrade into permanent data loss for every non-ok surface.
// Exercised on BOTH conflict paths because they are separate SET lists.
test("a non-ok re-probe with no prior keeps last_ok on the surface_key path (#9634)", async () => {
  const firstOk = Date.parse("2026-08-02T10:00:00Z");
  await persistProbesToD1(d1(), [probe({ last_ok_ms: firstOk })], firstOk);
  const res = await persistProbesToD1(
    d1(),
    [
      probe({
        status: "degraded",
        latency_ms: null,
        // The prober's `ok ? runAt : (prior?.last_ok ?? null)` with no prior.
        last_ok_ms: null,
        consecutive_failures: 1,
      }),
    ],
    firstOk + 60_000,
  );
  assert.equal(res.ok, true);
  const row = db
    .prepare("SELECT status, last_ok FROM surface_status")
    .get() as Record<string, unknown>;
  assert.equal(row.status, "degraded", "this run's status still lands");
  assert.equal(row.last_ok, firstOk, "history survives a prior-read degrade");
});

test("a non-ok re-probe with no prior keeps last_ok on the surface_id path (#9634)", async () => {
  const firstOk = Date.parse("2026-08-02T10:00:00Z");
  // surface_key null routes the upsert through ON CONFLICT(surface_id).
  const keyless = { surface_key: null };
  await persistProbesToD1(
    d1(),
    [probe({ ...keyless, last_ok_ms: firstOk })],
    firstOk,
  );
  await persistProbesToD1(
    d1(),
    [probe({ ...keyless, status: "failed", last_ok_ms: null })],
    firstOk + 60_000,
  );
  const row = db
    .prepare("SELECT status, last_ok FROM surface_status")
    .get() as Record<string, unknown>;
  assert.equal(row.status, "failed");
  assert.equal(row.last_ok, firstOk, "history survives on the keyless path");
});

// The other half of COALESCE: a non-null excluded value is authoritative, so a
// surface that IS working must still advance its mark rather than pin the
// oldest success forever.
test("an ok re-probe advances last_ok rather than holding the first value (#9634)", async () => {
  const firstOk = Date.parse("2026-08-02T10:00:00Z");
  const laterOk = Date.parse("2026-08-02T11:00:00Z");
  await persistProbesToD1(d1(), [probe({ last_ok_ms: firstOk })], firstOk);
  await persistProbesToD1(d1(), [probe({ last_ok_ms: laterOk })], laterOk);
  const row = db.prepare("SELECT last_ok FROM surface_status").get() as Record<
    string,
    unknown
  >;
  assert.equal(row.last_ok, laterOk);
});

// A surface whose first-ever probe fails has no history to protect, and must
// read as "never seen working" rather than inheriting anything.
test("a first probe that fails still stores last_ok null (#9634)", async () => {
  await persistProbesToD1(
    d1(),
    [probe({ status: "failed", latency_ms: null, last_ok_ms: null })],
    1,
  );
  const row = db.prepare("SELECT last_ok FROM surface_status").get() as Record<
    string,
    unknown
  >;
  assert.equal(row.last_ok, null);
});

// Migration 0027 recovers the rows wiped BEFORE the COALESCE above existed.
// The prober is the only writer, so the repair is seeded through it and then
// the column is nulled by hand -- reproducing the wipe rather than asserting
// against a hand-built row that might not match what the prober writes.
test("migration 0027 restores last_ok from the surviving ok checks (#9634)", async () => {
  const okAt = Date.parse("2026-08-02T10:00:00Z");
  const laterAt = Date.parse("2026-08-02T11:00:00Z");
  await persistProbesToD1(
    d1(),
    [probe({ checked_at_ms: okAt, last_ok_ms: okAt })],
    okAt,
  );
  // A second success, so the repair has to pick the MOST RECENT one.
  await persistProbesToD1(
    d1(),
    [probe({ checked_at_ms: laterAt, last_ok_ms: laterAt })],
    laterAt,
  );
  // A LATER degraded probe: its check row is the newest of the three, so a
  // repair that forgot `ok = 1` would restore this timestamp instead.
  await persistProbesToD1(
    d1(),
    [
      probe({
        status: "degraded",
        latency_ms: null,
        checked_at_ms: laterAt + 60_000,
        last_ok_ms: laterAt,
      }),
    ],
    laterAt + 60_000,
  );
  db.exec("UPDATE surface_status SET last_ok = NULL");

  db.exec(LAST_OK_REPAIR);

  const row = db.prepare("SELECT last_ok FROM surface_status").get() as Record<
    string,
    unknown
  >;
  assert.equal(row.last_ok, laterAt, "restored to the newest ok check");
});

test("migration 0027 leaves a surface with no ok check null (#9634)", async () => {
  await persistProbesToD1(
    d1(),
    [probe({ status: "failed", latency_ms: null, last_ok_ms: null })],
    1,
  );
  db.exec(LAST_OK_REPAIR);
  const row = db.prepare("SELECT last_ok FROM surface_status").get() as Record<
    string,
    unknown
  >;
  assert.equal(row.last_ok, null, "no evidence means no claim");
});

// Re-running a repair against a live column is the way a one-shot fix becomes a
// recurring bug, so the guard is pinned: a value the prober has since written
// must survive a second application unchanged.
test("migration 0027 is idempotent and never overwrites a live last_ok (#9634)", async () => {
  const okAt = Date.parse("2026-08-02T10:00:00Z");
  const laterAt = Date.parse("2026-08-02T11:00:00Z");
  await persistProbesToD1(d1(), [probe({ last_ok_ms: okAt })], okAt);
  await persistProbesToD1(d1(), [probe({ last_ok_ms: laterAt })], laterAt);
  db.exec(LAST_OK_REPAIR);
  db.exec(LAST_OK_REPAIR);
  const row = db.prepare("SELECT last_ok FROM surface_status").get() as Record<
    string,
    unknown
  >;
  assert.equal(row.last_ok, laterAt, "live value untouched by the repair");
});

test("the day rollup aggregates checks into surface_uptime_daily with the clamped ratio", async () => {
  const dayStart = Date.parse("2026-08-02T00:00:00Z");
  const rows = [
    probe({ checked_at_ms: dayStart + 1_000 }),
    probe({ checked_at_ms: dayStart + 2_000 }),
    probe({
      checked_at_ms: dayStart + 3_000,
      status: "failed",
      latency_ms: null,
    }),
  ];
  await persistProbesToD1(d1(), rows, dayStart + 4_000);
  const res = await rollupUptimeDailyToD1(
    d1(),
    [{ date: "2026-08-02", start: dayStart, end: dayStart + 86_400_000 }],
    dayStart + 5_000,
  );
  assert.equal(res.rolled, true);
  const daily = db
    .prepare(
      "SELECT samples, ok_count, uptime_ratio, status, latency_samples, p50_latency_ms FROM surface_uptime_daily",
    )
    .get() as Record<string, number | string>;
  assert.equal(daily.samples, 3);
  assert.equal(daily.ok_count, 2);
  assert.equal(daily.uptime_ratio, 0.6667);
  assert.equal(daily.status, "degraded");
  // Latency stats are success-only: two ok probes at 120ms.
  assert.equal(daily.latency_samples, 2);
  assert.equal(daily.p50_latency_ms, 120);
});

test("a perfect day stores exactly 1.0 and status ok; re-rollup is idempotent", async () => {
  const dayStart = Date.parse("2026-08-02T00:00:00Z");
  await persistProbesToD1(
    d1(),
    [
      probe({ checked_at_ms: dayStart + 1_000 }),
      probe({ checked_at_ms: dayStart + 2_000 }),
    ],
    dayStart,
  );
  const days = [
    { date: "2026-08-02", start: dayStart, end: dayStart + 86_400_000 },
  ];
  await rollupUptimeDailyToD1(d1(), days, 1);
  await rollupUptimeDailyToD1(d1(), days, 2);
  assert.equal(count("surface_uptime_daily"), 1, "upsert, not append");
  const daily = db
    .prepare(
      "SELECT uptime_ratio, status, updated_at FROM surface_uptime_daily",
    )
    .get() as Record<string, number | string>;
  assert.equal(daily.uptime_ratio, 1);
  assert.equal(daily.status, "ok");
  assert.equal(daily.updated_at, 2, "second rollup refreshed the row");
});

test("the prune deletes only rows older than the cutoff", async () => {
  await persistProbesToD1(
    d1(),
    [probe({ checked_at_ms: 1_000 }), probe({ checked_at_ms: 2_000 })],
    3_000,
  );
  const res = await pruneChecksD1(d1(), 1_500);
  assert.equal(res.pruned, true);
  assert.equal(count("surface_checks"), 1);
});

test("snapshot rows upsert on (netuid, day) with booleans as 0/1", async () => {
  const row = {
    netuid: 8,
    snapshot_date: "2026-08-02",
    completeness_score: 82,
    validator_count: 64,
    emission_share: 0.031,
    emission_enabled: true,
    subtoken_enabled: false,
    pipeline_block: 8_754_276,
    pipeline_block_hash: "0xabc",
  };
  const first = await upsertSubnetSnapshotsToD1(d1(), [row]);
  assert.equal(first.ok, true);
  const second = await upsertSubnetSnapshotsToD1(d1(), [
    { ...row, completeness_score: 90, emission_enabled: false },
  ]);
  assert.equal(second.ok, true);
  assert.equal(count("subnet_snapshots"), 1, "same (netuid, day) upserted");
  const stored = db
    .prepare(
      "SELECT completeness_score, emission_enabled, subtoken_enabled, pipeline_block FROM subnet_snapshots",
    )
    .get() as Record<string, number>;
  assert.equal(stored.completeness_score, 90);
  assert.equal(stored.emission_enabled, 0);
  assert.equal(stored.subtoken_enabled, 0);
  assert.equal(stored.pipeline_block, 8_754_276);
});

// ---- degradation paths (the binding is optional everywhere) ----

test("every writer no-ops cleanly without a binding", async () => {
  assert.deepEqual(await persistProbesToD1(undefined, [probe()], 1), {
    ok: false,
    reason: "unavailable",
  });
  assert.deepEqual(await rollupUptimeDailyToD1(undefined, [], 1), {
    rolled: false,
  });
  assert.deepEqual(await pruneChecksD1(undefined, 1), { pruned: false });
  assert.deepEqual(await upsertSubnetSnapshotsToD1(undefined, [{}]), {
    ok: false,
    reason: "unavailable",
  });
});

test("empty inputs are reported, not written", async () => {
  assert.equal((await persistProbesToD1(d1(), [], 1)).reason, "no_rows");
  assert.equal((await upsertSubnetSnapshotsToD1(d1(), [])).reason, "no_rows");
});

test("a failing batch is contained and reported, never thrown", async () => {
  const exploding: ObservationsDb = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => {
      throw new Error("d1 down");
    },
  };
  assert.equal((await persistProbesToD1(exploding, [probe()], 1)).ok, false);
  assert.equal(
    (
      await rollupUptimeDailyToD1(
        exploding,
        [{ date: "d", start: 0, end: 1 }],
        1,
      )
    ).rolled,
    false,
  );
  assert.equal((await pruneChecksD1(exploding, 1)).pruned, false);
  assert.equal(
    (await upsertSubnetSnapshotsToD1(exploding, [{ netuid: 1 }])).ok,
    false,
  );
});

test("runD1StatementBatches splits work into bounded batches", async () => {
  const sizes: number[] = [];
  const recording: ObservationsDb = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async (statements) => {
      sizes.push(statements.length);
    },
  };
  const res = await runD1StatementBatches(
    recording,
    new Array(120).fill({}),
    50,
  );
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.deepEqual(res, { ok: true, batches: 3 });
  assert.deepEqual(await runD1StatementBatches(recording, []), {
    ok: true,
    batches: 0,
  });
});

test("a failing write lands one $exception per writer, each with its own route", async () => {
  const exploding: ObservationsDb = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => {
      throw new Error("d1 down");
    },
  };
  const captures: {
    event?: string;
    properties?: { route?: string; $exception_fingerprint?: string };
  }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    captures.push(JSON.parse(init?.body ?? "{}"));
    return { ok: true } as Response;
  }) as typeof fetch;
  const env = { POSTHOG_PROJECT_TOKEN: "phc_test" } as never;
  try {
    await persistProbesToD1(exploding, [probe()], 1, env);
    await rollupUptimeDailyToD1(
      exploding,
      [{ date: "d", start: 0, end: 1 }],
      1,
      env,
    );
    await pruneChecksD1(exploding, 1, env);
    await upsertSubnetSnapshotsToD1(exploding, [{ netuid: 1 }], env);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    captures.map((c) => c.properties?.route),
    [
      "observations-d1-persist",
      "observations-d1-rollup",
      "observations-d1-prune",
      "observations-d1-snapshots",
    ],
  );
  for (const c of captures) {
    assert.equal(c.event, "$exception");
    assert.equal(
      c.properties?.$exception_fingerprint?.endsWith(":Error"),
      true,
    );
  }
});
