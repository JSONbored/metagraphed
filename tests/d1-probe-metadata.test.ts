import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { producerStore } from "../workers/api.ts";
import { readStore } from "../src/read-store.ts";
import { persistSweep, loadSweepRecord } from "../src/attribution-sweep.ts";
import {
  loadAttributionCandidates,
  loadAttributionCandidateTotals,
} from "../src/attribution-candidates-review.ts";
import {
  persistOriginCheck,
  loadDeadOrigins,
} from "../src/origin-reachability.ts";
import { persistComputeDeclaration } from "../src/compute-declarations-lane.ts";
import {
  buildSubnetCostToParticipate,
  type ComputeDeclarationRow,
} from "../src/cost-to-participate.ts";
import type { ProducerStore } from "../src/producer-store.ts";
import { mockEnv } from "./row-type.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const tables = [
  "attribution_candidates",
  "attribution_sweeps",
  "origin_reachability",
  "compute_declarations",
];
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const migration = readFileSync(
    new URL("../migrations/d1/0004_probe_metadata.sql", import.meta.url),
    "utf8",
  );
  for (const sql of migration.split("-- statement-breakpoint"))
    await db.prepare(sql).run();
});
afterAll(async () => {
  await runtime.dispose();
});
const stamp = 1790080000000;
function env() {
  return mockEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables.join(","),
    HYPERDRIVE: { connectionString: "postgresql://must-not-be-used/invalid" },
  });
}

test("selected producer and read paths share native D1 and retain first-seen attribution history", async () => {
  const owner = producerStore(env(), undefined, [
    "attribution_sweeps",
    "attribution_candidates",
  ]);
  const store = owner.db as ProducerStore;
  const candidate = {
    ss58: "public-address",
    source_url: "https://example.com/team",
  };
  for (const swept_at of [stamp, stamp + 1000])
    assert.deepEqual(
      await persistSweep(store, {
        netuid: 7,
        swept_at,
        sources_checked: 2,
        sources_read: 1,
        candidates: [candidate],
        verdict: "candidates-found",
      }),
      { ok: true },
    );
  owner.close();
  const reader = readStore(env(), [
    "attribution_sweeps",
    "attribution_candidates",
  ]);
  assert.equal((await loadSweepRecord(reader, 7))?.candidates, 1);
  const rows = await loadAttributionCandidates(reader, { netuid: 7 });
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0].first_seen, stamp);
  assert.equal(rows?.[0].last_seen, stamp + 1000);
  assert.equal((await loadAttributionCandidateTotals(reader))?.reviewable, 1);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM attribution_sweeps").first())
      ?.n,
    1,
  );
  assert.throws(
    () =>
      producerStore(mockEnv({ ...env(), D1_STATE: undefined }), undefined, [
        "attribution_sweeps",
      ]),
    /unbound/,
  );
  assert.throws(
    () => producerStore(env(), undefined, ["attribution_sweeps", "neurons"]),
    /spans D1 and Neon/,
  );
});

test("origin verdicts and JSON declarations preserve their served meaning", async () => {
  const store = createD1Store(db);
  await persistOriginCheck(store, {
    origin: "https://example.com",
    checked_at: stamp,
    samples: [{ url: "https://example.com/a", status: null, body_hash: null }],
    surface_ids: ["a", "b"],
    verdict: "unreachable",
  });
  assert.deepEqual(
    await loadDeadOrigins(readStore(env(), ["origin_reachability"])),
    [
      {
        origin: "https://example.com",
        checked_at: new Date(stamp).toISOString(),
        surface_count: 2,
        samples: 1,
        verdict: "unreachable",
      },
    ],
  );
  const declaration = {
    netuid: 7,
    source_url: "https://example.com/min_compute.yml",
    read_at_sha: "abc1234",
    observed_at: stamp,
    found: true,
    spec_version: "1",
    miner: { gpu: { required: false, min_vram: 8 } },
    validator: null,
    unscoped: null,
  };
  await persistComputeDeclaration(store, declaration);
  await persistComputeDeclaration(store, {
    ...declaration,
    observed_at: stamp + 1000,
    read_at_sha: "def5678",
  });
  const rows = await store.query<ComputeDeclarationRow>(
    "SELECT * FROM compute_declarations",
  );
  assert.equal(rows[0].first_seen, stamp);
  const body = buildSubnetCostToParticipate(rows, 7);
  assert.equal(body.declarations_read, 1);
  const expected = buildSubnetCostToParticipate(
    [
      {
        ...declaration,
        observed_at: stamp + 1000,
        first_seen: stamp,
        read_at_sha: "def5678",
      },
    ],
    7,
  );
  assert.deepEqual(body, expected);
  await persistComputeDeclaration(store, {
    ...declaration,
    found: false,
    observed_at: stamp + 2000,
  });
  const empty = await store.first(
    "SELECT found,miner,validator,unscoped FROM compute_declarations",
  );
  assert.deepEqual(empty, {
    found: 0,
    miner: null,
    validator: null,
    unscoped: null,
  });
});

test("native constraints reject invalid timestamps, verdicts, counts and JSON without changing stored data", async () => {
  const invalid = [
    "UPDATE attribution_sweeps SET swept_at=1",
    "UPDATE attribution_sweeps SET sources_read=9",
    "UPDATE attribution_sweeps SET verdict='unknown'",
    "UPDATE attribution_candidates SET first_seen=1",
    "UPDATE origin_reachability SET samples=-1",
    "UPDATE origin_reachability SET verdict='unknown'",
    "UPDATE compute_declarations SET found=2",
    "UPDATE compute_declarations SET found=1",
    "UPDATE compute_declarations SET miner='{}'",
    "UPDATE compute_declarations SET found=1, miner='[]'",
    "UPDATE compute_declarations SET found=1, miner='broken'",
  ];
  for (const sql of invalid) await assert.rejects(db.prepare(sql).run());
  assert.deepEqual(
    await db.prepare("SELECT found, miner FROM compute_declarations").first(),
    { found: 0, miner: null },
  );
});
