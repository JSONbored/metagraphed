import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import {
  loadSubnetSnapshotCards,
  loadValidatorDetailsFromStore,
} from "../workers/data-api.ts";
import { buildConcentration } from "../src/concentration.ts";
import { buildSubnetPerformance } from "../src/subnet-performance.ts";
import {
  buildSubnetValidators,
  NEURON_COLUMNS,
} from "../src/metagraph-neurons.ts";
import { FEATURED_HOTKEY_SET } from "../generated/featured-validators.ts";
import { loadValidatorDetailBatchTier } from "../src/validator-detail-batch-tier.ts";
import { loadSubnetSnapshotCardsTier } from "../src/subnet-snapshot-cards-tier.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { Row } from "./row-type.ts";
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const at = Date.now();
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
  const rows = Array.from({ length: 16 }, (_, uid) => ({
    netuid: 7,
    uid,
    hotkey: `validator${uid}`,
    coldkey: `owner${uid}`,
    validator_permit: uid !== 15,
    active: uid % 2 === 0,
    stake_tao: uid === 14 ? null : uid,
    emission_tao: uid / 100,
    incentive: uid / 100,
    dividends: 0.01,
    trust: 0.5,
    consensus: 0.4,
    validator_trust: 0.3,
    captured_at: at,
    block_number: 9000000,
    take: 0.1,
  }));
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, at + 1),
    dailyRows: [],
    positionRows: [],
  });
  await db
    .prepare(
      "INSERT INTO validator_nominator_counts(hotkey,nominator_count,captured_at) VALUES('validator0',3,?)",
    )
    .bind(at)
    .run();
});
afterAll(() => runtime.dispose());
function counted() {
  const queries: string[] = [];
  const binding = {
    prepare(sql: string) {
      queries.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  return { queries, binding };
}

test("sixteen comparisons use five native SQL reads with single-detail parity and bounded ordering", async () => {
  const env = dataApiEnv({});
  const keys = Array.from({ length: 16 }, (_, i) => `validator${15 - i}`);
  const f = counted();
  const batch = await loadValidatorDetailsFromStore(
    createD1Sql(f.binding),
    env,
    keys,
  );
  assert.equal(f.queries.length, 5);
  assert.deepEqual(
    batch.map((r) => r.hotkey),
    keys,
  );
  for (let i = 0; i < keys.length; i++)
    assert.deepEqual(
      batch[i],
      (await loadValidatorDetailsFromStore(createD1Sql(db), env, [keys[i]]))[0],
    );
  assert.equal(batch.at(-1)?.nominator_count, 3);
  assert.equal(batch[1].nominator_count, 0);
  const duplicates = await loadValidatorDetailsFromStore(createD1Sql(db), env, [
    keys[0],
    keys[0],
  ]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  await assert.rejects(
    () => loadValidatorDetailsFromStore(createD1Sql(db), env, []),
    /bound/,
  );
  await assert.rejects(
    () =>
      loadValidatorDetailsFromStore(createD1Sql(db), env, Array(17).fill("x")),
    /bound/,
  );
  await db.prepare("UPDATE validator_nominator_counts SET captured_at=1").run();
  assert.equal(
    (await loadValidatorDetailsFromStore(createD1Sql(db), env, ["missing"]))[0]
      .nominator_count,
    null,
  );
});

test("compound cards read one accepted population and preserve standalone full/miner/validator scopes", async () => {
  const f = counted();
  const env = dataApiEnv({ D1_STATE: f.binding, D1_STATE_TABLES: "neurons" });
  const cards = await loadSubnetSnapshotCards(createD1Sql(db), env, 7);
  assert.equal(f.queries.length, 1);
  const rows = (
    await db
      .prepare(`SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid=7`)
      .all<Row>()
  ).results;
  const validators = (
    await db
      .prepare(
        `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid=7 AND validator_permit=TRUE ORDER BY stake_tao DESC,uid ASC`,
      )
      .all<Row>()
  ).results;
  assert.deepEqual(cards.concentration, buildConcentration(rows, 7));
  assert.deepEqual(cards.performance, buildSubnetPerformance(rows, 7));
  assert.deepEqual(
    cards.validators,
    buildSubnetValidators(validators, 7, {
      featuredHotkeys: FEATURED_HOTKEY_SET,
    }),
  );
  assert.equal(cards.validators.validators.length, 15);
  assert.equal(cards.validators.validators[0].hotkey, "validator13");
  assert.deepEqual(await loadSubnetSnapshotCards(createD1Sql(db), env, 999), {
    concentration: buildConcentration([], 999),
    performance: buildSubnetPerformance([], 999),
    validators: buildSubnetValidators([], 999, {
      featuredHotkeys: FEATURED_HOTKEY_SET,
    }),
  });
});

test("service batches cost one call while malformed/old owners preserve bounded per-card and per-key failures", async () => {
  const calls: string[] = [];
  let shared = true;
  const env = {
    METAGRAPH_NEURONS_SOURCE: "postgres",
    DATA_API: {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path.endsWith("validator-details"))
          return Response.json(
            shared
              ? { details: [{ hotkey: "a" }, { hotkey: "b" }] }
              : { details: [] },
          );
        if (path.endsWith("snapshot-cards"))
          return shared
            ? Response.json({
                concentration: { netuid: 7 },
                performance: { netuid: 7 },
                validators: { netuid: 7 },
              })
            : new Response("old", { status: 404 });
        if (path.endsWith("/b") || path.endsWith("/performance"))
          return new Response("failed", { status: 502 });
        return Response.json(
          path.endsWith("/a")
            ? { hotkey: "a", marker: "kept" }
            : { netuid: 7, marker: "kept" },
        );
      }),
    },
  } as unknown as Env;
  assert.equal((await loadValidatorDetailBatchTier(env, ["a", "b"])).length, 2);
  assert.equal(calls.length, 1);
  calls.length = 0;
  assert.equal(
    (await loadSubnetSnapshotCardsTier(env, 7)).concentration.netuid,
    7,
  );
  assert.equal(calls.length, 1);
  calls.length = 0;
  shared = false;
  const details = await loadValidatorDetailBatchTier(env, ["a", "b"]);
  assert.equal(calls.length, 4);
  assert.equal(details[0].marker, "kept");
  assert.equal(details[1].hotkey, "b");
  calls.length = 0;
  const cards = await loadSubnetSnapshotCardsTier(env, 7);
  assert.equal(calls.length, 5);
  assert.equal(cards.concentration.marker, "kept");
  assert.equal(cards.performance.netuid, 7);
});
