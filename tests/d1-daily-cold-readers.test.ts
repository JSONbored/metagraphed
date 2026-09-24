import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store, createD1Sql } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronPositionRows } from "../src/neurons-neon-write.ts";
import { readSubnetDailyHistory } from "../src/neuron-snapshot-read.ts";
import {
  loadSubnetHistoryColdTier,
  loadNeuronHistoryColdTier,
  loadAccountPositionHistoryColdTier,
  loadValidatorHistoryColdTier,
} from "../src/neuron-daily-cold-tier.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const account = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const days = ["2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"];
const statements: { text: string; values: unknown[] }[] = [];
const env = () => ({
  NATIVE_PROJECTIONS: "enabled",
  NATIVE_HISTORY_FIXTURE: "cfut_test",
  D1_STATE_TABLES: "neuron_daily,account_position_daily,subnet_snapshots",
  D1_STATE: {
    prepare(text: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ text, values });
          return db.prepare(text).bind(...values);
        },
      };
    },
    batch: db.batch.bind(db),
  },
});
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0007_neuron_documents.sql",
    "0008_observations.sql",
    "0012_neuron_daily_join_index.sql",
  ]) {
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  }
  const rows = days.flatMap((snapshot_date, day) =>
    [0, 7, 8].flatMap((netuid) =>
      [1, 2, 3].map((uid) => ({
        netuid,
        uid,
        snapshot_date,
        hotkey: uid === 1 ? account : `other-${uid}`,
        coldkey: uid === 1 ? "cold" : null,
        active: uid !== 2,
        validator_permit: uid === 1,
        rank: 0.1,
        trust: 0.2,
        validator_trust: 0.3,
        consensus: 0.4,
        incentive: 0.5,
        dividends: 0.6,
        emission_tao: netuid === 8 ? null : uid / 8,
        stake_tao: netuid === 8 ? null : uid / 4,
        registered_at_block: 9000000,
        is_immunity_period: false,
        axon: '{"ip":"127.0.0.1"}',
        block_number: 9000000 + day,
        captured_at: 1783684800000 + day * 86400000,
        take: 0.1,
      })),
    ),
  );
  await writeNeuronDocuments(createD1Store(db), {
    rows: [],
    dailyRows: rows,
    positionRows: neuronPositionRows(rows),
  });
  for (const day of days)
    for (const netuid of [0, 7])
      await db
        .prepare(
          "INSERT INTO subnet_snapshots(netuid,snapshot_date,total_stake_tao,tao_in_pool_tao,alpha_in_pool) VALUES(?,?,100,3,2)",
        )
        .bind(netuid, day)
        .run();
  // Orphans and wrong shards must not become historical rows.
  await db.prepare("DELETE FROM neuron_daily_members WHERE uid=2").run();
  await db
    .prepare("UPDATE neuron_daily_members SET shard=99 WHERE uid=3")
    .run();
}, 30000);
afterAll(() => runtime.dispose());
afterEach(() => vi.unstubAllGlobals());
function forbidSql() {
  const fetch = vi.fn(async () => {
    throw Error("SQL archive forbidden");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("retained daily histories preserve inclusive start, strict seam, limits, metrics and empty ranges", async () => {
  const fetch = forbidSql();
  for (const start of [null, days[1]])
    for (const seam of [null, days[3]])
      for (const limit of [1, 100]) {
        const selected = days
          .filter(
            (day) =>
              (start === null || day >= start) && (seam === null || day < seam),
          )
          .reverse()
          .slice(0, limit);
        const sub = await loadSubnetHistoryColdTier(
          env(),
          7,
          start,
          seam,
          limit,
        );
        assert.deepEqual(
          sub,
          selected.map((snapshot_date) => ({
            snapshot_date,
            neuron_count: 1,
            validator_count: 1,
            total_stake_tao: 0.25,
            total_emission_tao: 0.125,
          })),
        );
        const neuron = await loadNeuronHistoryColdTier(
          env(),
          7,
          1,
          start,
          seam,
          limit,
        );
        assert.deepEqual(
          neuron?.map((row) => row.snapshot_date),
          selected,
        );
        assert.ok(
          neuron?.every(
            (row) =>
              row.hotkey === account &&
              row.stake_tao === 0.25 &&
              row.axon === '{"ip":"127.0.0.1"}',
          ),
        );
        const position = await loadAccountPositionHistoryColdTier(
          env(),
          account,
          7,
          start,
          seam,
          limit,
        );
        assert.deepEqual(
          position?.map((row) => row.snapshot_date),
          selected,
        );
        assert.ok(
          position?.every(
            (row) =>
              row.uid === 1 && row.coldkey === "cold" && row.stake_tao === 0.25,
          ),
        );
      }
  assert.deepEqual(
    await loadSubnetHistoryColdTier(env(), 999, null, null, 10),
    [],
  );
  assert.deepEqual(
    await loadNeuronHistoryColdTier(env(), 7, 2, null, null, 10),
    [],
  );
  assert.deepEqual(
    await loadNeuronHistoryColdTier(env(), 7, 3, null, null, 10),
    [],
  );
  assert.equal(
    (await loadSubnetHistoryColdTier(env(), 8, null, null, 10))?.[0]
      ?.total_stake_tao,
    null,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("validator history keeps root pricing, subnet joins, null prices, filters and strict dates", async () => {
  const fetch = forbidSql();
  for (const start of [null, days[1]])
    for (const seam of [null, days[3]])
      for (const netuid of [null, 0, 7, 8]) {
        const rows = await loadValidatorHistoryColdTier(
          env(),
          account,
          netuid,
          start,
          seam,
          100,
        );
        const selected = days.filter(
          (day) =>
            (start === null || day >= start) && (seam === null || day < seam),
        );
        assert.equal(rows?.length, selected.length * (netuid === null ? 3 : 1));
        assert.ok(
          rows?.every(
            (row) =>
              selected.includes(String(row.snapshot_date)) &&
              (netuid === null || row.netuid === netuid),
          ),
        );
        for (const row of rows ?? []) {
          assert.equal(
            row.total_stake_tao,
            row.netuid === 0 ? 0.25 : row.netuid === 7 ? 0.375 : null,
          );
          assert.equal(
            row.total_emission_tao,
            row.netuid === 0 ? 0.125 : row.netuid === 7 ? 0.1875 : null,
          );
          assert.equal(row.subnet_total_stake, row.netuid === 8 ? null : 100);
        }
      }
  assert.equal(
    (await loadValidatorHistoryColdTier(env(), account, null, null, null, 1))
      ?.length,
    1,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("history reads seek membership indexes and subnet rollups expand only the selected documents", async () => {
  const queries = [
    statements.find((q) => q.text.includes("d.netuid=?"))!,
    statements.find((q) => q.text.includes("FROM neuron_daily WHERE"))!,
    statements.find((q) =>
      q.text.includes("FROM account_position_daily WHERE"),
    )!,
    statements.find((q) => q.text.includes("WHERE nd.hotkey=?"))!,
  ];
  const plans = [];
  for (const query of queries)
    plans.push(
      (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${query.text}`)
          .bind(...query.values)
          .all<{ detail: string }>()
      ).results
        .map((row) => row.detail)
        .join("\n"),
    );
  assert.match(plans[0], /SEARCH d USING PRIMARY KEY/);
  assert.match(plans[0], /SCAN j VIRTUAL TABLE/);
  assert.match(plans[1], /SEARCH m USING PRIMARY KEY/);
  assert.match(plans[2], /SEARCH m USING PRIMARY KEY/);
  assert.match(
    plans[3],
    /SEARCH m USING INDEX neuron_daily_members_hotkey_idx/,
  );
});
test("selected missing, partial and failed owners cannot fall back to archive scans", async () => {
  const fetch = forbidSql();
  for (const e of [
    { ...env(), D1_STATE: undefined },
    {
      ...env(),
      D1_STATE: {
        prepare() {
          throw Error("unavailable");
        },
        batch: db.batch.bind(db),
      },
    },
  ]) {
    assert.equal(await loadSubnetHistoryColdTier(e, 7, null, null, 1), null);
    assert.equal(await loadNeuronHistoryColdTier(e, 7, 1, null, null, 1), null);
    assert.equal(
      await loadAccountPositionHistoryColdTier(e, account, 7, null, null, 1),
      null,
    );
    assert.equal(
      await loadValidatorHistoryColdTier(e, account, null, null, null, 1),
      null,
    );
  }
  const partial = { ...env(), D1_STATE_TABLES: "neuron_daily" };
  assert.equal(
    await loadValidatorHistoryColdTier(partial, account, null, null, null, 1),
    null,
  );
  await assert.rejects(
    readSubnetDailyHistory(
      createD1Sql(createD1Store(db)),
      {},
      7,
      null,
      1,
      days[3],
    ),
    /ceiling requires/,
  );
  assert.equal(fetch.mock.calls.length, 0);
});
