import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { readNeuronDailyMetricRows } from "../src/neuron-snapshot-read.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const statement of readFileSync(
    new URL("../migrations/d1/0007_neuron_documents.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (statement.trim()) await db.prepare(statement).run();
  for (const netuid of [7, 8])
    for (const day of ["2026-09-20", "2026-09-21"])
      for (const shard of [0, 1]) {
        const payload = Object.fromEntries(
          Array.from({ length: 64 }, (_, offset) => {
            const uid = shard * 64 + offset;
            return [
              String(uid),
              {
                hotkey: "stale-document-identity",
                stake_tao: uid % 5 ? uid / 100 : null,
                validator_permit: uid % 3 === 0,
                active: uid % 2 === 0,
                dividends: uid / 1000,
                emission_tao: uid / 10000,
                incentive: uid / 200,
                axon: { port: 80 },
              },
            ];
          }),
        );
        await db
          .prepare(
            "INSERT INTO neuron_daily_documents VALUES(?,?,?,?,jsonb(?))",
          )
          .bind(netuid, day, shard, 1790090000000, JSON.stringify(payload))
          .run();
        await db.batch(
          Array.from({ length: 64 }, (_, offset) => {
            const uid = shard * 64 + offset;
            return db
              .prepare("INSERT INTO neuron_daily_members VALUES(?,?,?,?,?,?)")
              .bind(netuid, uid, day, `member-${uid}`, null, shard);
          }),
        );
      }
  await db.prepare("DELETE FROM neuron_daily_members WHERE uid=5").run();
  await db
    .prepare("UPDATE neuron_daily_members SET shard=99 WHERE uid=6")
    .run();
  await db
    .prepare(
      `UPDATE neuron_daily_documents SET payload=jsonb_set(
       jsonb_remove(payload,'$."2"'),'$."02"',jsonb('{"stake_tao":999}'))
       WHERE shard=0`,
    )
    .run();
});
afterAll(() => runtime.dispose());

const projections = [
  "snapshot_date, hotkey, stake_tao, validator_permit, dividends, active",
  "snapshot_date, validator_permit, stake_tao, emission_tao",
  "snapshot_date, incentive, dividends, trust, consensus, validator_trust, active, validator_permit",
  "snapshot_date, uid, coldkey, axon",
];

test("bounded shard expansion preserves every selected view row and scalar type", async () => {
  const store = createD1Store(db);
  const env = { D1_STATE: db, D1_STATE_TABLES: "neuron_daily" };
  for (const netuid of [7, 99])
    for (const cutoff of ["2026-09-20", "2026-09-21", "2099-01-01", null])
      for (const limit of [1, 200, 1000])
        for (const columns of projections) {
          const expected = await store.query(
            `SELECT ${columns} FROM neuron_daily WHERE netuid=? AND snapshot_date>=?
             ORDER BY snapshot_date DESC,uid LIMIT ?`,
            [netuid, cutoff, limit],
          );
          const actual = await readNeuronDailyMetricRows(
            store,
            env,
            netuid,
            cutoff,
            columns,
            limit,
          );
          assert.deepEqual(actual, expected);
        }
  const missing = await readNeuronDailyMetricRows<Record<string, unknown>>(
    store,
    env,
    7,
    "2026-09-21",
    "uid, hotkey, stake_tao",
    10,
  );
  assert.deepEqual(
    missing.find((row) => row.uid === 2),
    {
      uid: 2,
      hotkey: "member-2",
      stake_tao: null,
    },
  );
});

test("history reads materialize each required shard expansion without correlated scans", async () => {
  let captured = "";
  let parameters: unknown[] = [];
  const binding = {
    batch: db.batch.bind(db),
    prepare(text: string) {
      captured = text;
      return {
        bind(...values: unknown[]) {
          parameters = values;
          return db.prepare(text).bind(...values);
        },
      };
    },
  };
  await readNeuronDailyMetricRows(
    createD1Store(db),
    { D1_STATE: binding, D1_STATE_TABLES: "neuron_daily" },
    7,
    "2026-09-20",
    projections[0]!,
    200,
  );
  const plan = (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${captured}`)
      .bind(...parameters)
      .all<{ detail: string }>()
  ).results
    .map((row) => row.detail)
    .join("\n");
  assert.match(plan, /MATERIALIZE selected/);
  assert.match(plan, /MATERIALIZE metric_rows/);
  assert.match(plan, /SCAN j VIRTUAL TABLE/);
  assert.doesNotMatch(plan, /CORRELATED/);
});

test("fallback preserves the bounded query and malformed projections never reach storage", async () => {
  const store = createD1Store(db);
  const args = [7, "2026-09-20", projections[0]!, 3] as const;
  assert.deepEqual(
    await readNeuronDailyMetricRows(store, {}, ...args),
    await readNeuronDailyMetricRows(
      store,
      { D1_STATE: db, D1_STATE_TABLES: "neuron_daily" },
      ...args,
    ),
  );
  for (const columns of ["", "uid, uid", "uid FROM neurons", "secret"])
    await assert.rejects(
      readNeuronDailyMetricRows(store, {}, 7, "2026-09-20", columns, 3),
      /Invalid bounded neuron history projection/,
    );
  for (const limit of [0, -1, 0.5, Infinity])
    await assert.rejects(
      readNeuronDailyMetricRows(store, {}, 7, "2026-09-20", "uid", limit),
      /Invalid bounded neuron history projection/,
    );
  await assert.rejects(
    readNeuronDailyMetricRows(
      store,
      { D1_STATE_TABLES: "neuron_daily" },
      ...args,
    ),
    /Selected D1 store is unbound/,
  );
});
