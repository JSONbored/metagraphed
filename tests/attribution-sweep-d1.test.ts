import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store, type D1StoreBinding } from "../src/d1-store.ts";
import {
  handleSweepBatch,
  persistSweep,
  type SweepResult,
} from "../src/attribution-sweep.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
const NOW = Date.parse("2026-10-02T00:00:00Z");
const ADDRESS = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const TABLES = ["attribution_sweeps", "attribution_candidates"];
let db: D1Database;

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const name of [
    "0004_probe_metadata.sql",
    "0016_archive_export_revisions.sql",
  ]) {
    const migration = readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("-- statement-breakpoint")) {
      await db.prepare(statement).run();
    }
  }
});
afterAll(async () => {
  await runtime.dispose();
});

function sweep(netuid: number, count = 1, swept_at = NOW): SweepResult {
  return {
    netuid,
    swept_at,
    sources_checked: 8,
    sources_read: 8,
    candidates: Array.from({ length: count }, (_, index) => ({
      ss58: ADDRESS,
      source_url: `https://example.invalid/${netuid}/${index}`,
    })),
    verdict: count ? "candidates-found" : "none-published",
  };
}

async function revisions() {
  return (
    await db
      .prepare("SELECT * FROM archive_export_revisions ORDER BY table_name")
      .all<Record<string, unknown>>()
  ).results;
}

async function stored(netuid: number) {
  return {
    sweep: await db
      .prepare("SELECT * FROM attribution_sweeps WHERE netuid=?")
      .bind(netuid)
      .first<Record<string, unknown>>(),
    candidates: (
      await db
        .prepare(
          "SELECT * FROM attribution_candidates WHERE netuid=? ORDER BY source_url",
        )
        .bind(netuid)
        .all<Record<string, unknown>>()
    ).results,
  };
}

describe("attribution passes use real native D1 transactions", () => {
  test("a full 96-candidate pass uses one D1 call and preserves retained evidence", async () => {
    const prior = sweep(2000, 1, NOW - 1000);
    prior.candidates[0].source_url = "https://example.invalid/retained";
    await persistSweep(createD1Store(db, TABLES), prior);
    const before = await revisions();
    let batches = 0;
    let statementCount = 0;
    const binding: D1StoreBinding = {
      prepare: (text: string) => db.prepare(text),
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        batches++;
        statementCount = statements.length;
        return db.batch<T>(statements);
      },
    };
    assert.deepEqual(
      await persistSweep(createD1Store(binding, TABLES), sweep(2000, 96)),
      { ok: true },
    );
    assert.equal(batches, 1);
    // Sweep + five bounded candidate INSERTs + both revisions in one statement.
    assert.equal(statementCount, 7);
    const after = await stored(2000);
    assert.equal(after.sweep!.candidates, 96);
    assert.equal(after.sweep!.swept_at, NOW);
    assert.equal(after.candidates.length, 97);
    assert.deepEqual(
      after.candidates.find(
        (row) => row.source_url === prior.candidates[0].source_url,
      ),
      {
        netuid: 2000,
        ss58: ADDRESS,
        source_url: prior.candidates[0].source_url,
        first_seen: NOW - 1000,
        last_seen: NOW - 1000,
      },
    );
    assert.deepEqual(
      await revisions(),
      before.map((row) => ({ ...row, revision: Number(row.revision) + 1 })),
    );
  });

  test("a late candidate failure rolls back the sweep, earlier chunks and export revisions", async () => {
    const store = createD1Store(db, TABLES);
    assert.deepEqual(await persistSweep(store, sweep(2001, 1, NOW - 1000)), {
      ok: true,
    });
    const before = await stored(2001);
    const beforeRevisions = await revisions();
    await db
      .prepare(
        `CREATE TRIGGER fail_late_candidate BEFORE INSERT ON attribution_candidates
      WHEN NEW.source_url = 'https://example.invalid/failure'
      BEGIN SELECT RAISE(ABORT, 'candidate failed'); END`,
      )
      .run();
    const next = sweep(2001, 41);
    next.candidates[40].source_url = "https://example.invalid/failure";
    const result = await persistSweep(store, next);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /candidate failed/);
    assert.deepEqual(await stored(2001), before);
    assert.deepEqual(await revisions(), beforeRevisions);
  });

  test("a delayed older pass preserves current facts and still retains unseen historical candidates", async () => {
    const store = createD1Store(db);
    const original = sweep(2002, 1, NOW - 1000);
    await persistSweep(store, original);
    await persistSweep(store, sweep(2002, 2, NOW));
    const older = sweep(2002, 1, NOW - 500);
    older.candidates.push({
      ss58: ADDRESS,
      source_url: "https://example.invalid/older-evidence",
    });
    older.sources_read = 0;
    older.verdict = "unreachable";
    assert.deepEqual(await persistSweep(store, older), { ok: true });
    const after = await stored(2002);
    assert.equal(after.sweep!.swept_at, NOW);
    assert.equal(after.sweep!.verdict, "candidates-found");
    assert.equal(after.sweep!.sources_read, 8);
    assert.equal(after.candidates.length, 3);
    const current = after.candidates.find(
      (row) => row.source_url === original.candidates[0].source_url,
    )!;
    assert.equal(current.first_seen, NOW - 1000);
    assert.equal(current.last_seen, NOW);
    assert.equal(
      after.candidates.find(
        (row) => row.source_url === older.candidates[1].source_url,
      )!.first_seen,
      NOW - 500,
    );
  });

  test("a zero-candidate observation keeps older candidates and publishes an honest complete sweep", async () => {
    const store = createD1Store(db);
    await persistSweep(store, sweep(2003, 1, NOW - 1000));
    assert.deepEqual(await persistSweep(store, sweep(2003, 0)), { ok: true });
    const after = await stored(2003);
    assert.equal(after.sweep!.candidates, 0);
    assert.equal(after.sweep!.verdict, "none-published");
    assert.equal(after.candidates.length, 1);
    assert.equal(after.candidates[0].first_seen, NOW - 1000);
  });

  test("repeated conflict keys retain all observations in portable separate INSERTs", async () => {
    const pass = sweep(2004, 2);
    pass.candidates.splice(1, 0, { ...pass.candidates[0] });
    const batchSizes: number[] = [];
    const binding: D1StoreBinding = {
      prepare: (text: string) => db.prepare(text),
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        batchSizes.push(statements.length);
        return db.batch<T>(statements);
      },
    };
    assert.deepEqual(await persistSweep(createD1Store(binding), pass), {
      ok: true,
    });
    assert.deepEqual(batchSizes, [3]);
    const after = await stored(2004);
    assert.equal(after.sweep!.candidates, 3);
    assert.equal(after.candidates.length, 2);
  });

  test("lost acknowledgment stays a visible failure and an identical redelivery preserves history", async () => {
    const pass = sweep(2005, 21);
    const binding: D1StoreBinding = {
      prepare: (text: string) => db.prepare(text),
      batch: async (statements: D1PreparedStatement[]) => {
        await db.batch(statements);
        throw new Error("D1_ERROR: Network connection lost.");
      },
    };
    const result = await persistSweep(createD1Store(binding), pass);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /Network connection lost/);
    const committed = await stored(2005);
    assert.equal(committed.candidates.length, 21);
    assert.deepEqual(await persistSweep(createD1Store(db), pass), { ok: true });
    assert.deepEqual(await stored(2005), committed);
  });

  test("the queue retries an aborted transaction and never acknowledges partial success", async () => {
    await db
      .prepare(
        `CREATE TRIGGER fail_queue_candidate BEFORE INSERT ON attribution_candidates
      WHEN NEW.netuid = 2006 BEGIN SELECT RAISE(ABORT, 'queue candidate failed'); END`,
      )
      .run();
    let acked = 0;
    let retried = 0;
    const result = await handleSweepBatch(
      [
        {
          body: { netuid: 2006 },
          ack: () => {
            acked++;
          },
          retry: () => {
            retried++;
          },
        },
      ],
      createD1Store(db, TABLES),
      {
        now: () => NOW,
        recordFor: async () => ({
          surfaces: [{ kind: "website", url: "https://example.invalid/team" }],
        }),
        fetchText: async () => ADDRESS,
      },
    );
    assert.equal(result.done, 0);
    assert.equal(result.retried, 1);
    assert.match(result.firstFailure!, /queue candidate failed/);
    assert.equal(acked, 0);
    assert.equal(retried, 1);
    assert.deepEqual(await stored(2006), { sweep: null, candidates: [] });
  });
});
