import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Sql, createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import {
  readNeuronDailyTotals,
  readSubnetDailyHistory,
} from "../src/neuron-snapshot-read.ts";
import type { PgSql } from "../src/pg-sql.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const statements: { text: string; values: unknown[] }[] = [];
const absent = (() => {
  throw new Error("Unexpected fallback");
}) as unknown as PgSql;
const days = ["2026-09-20", "2026-09-21", "2026-09-22"];
const environment = () => ({
  D1_STATE_TABLES: "neuron_daily",
  D1_STATE: {
    prepare(text: string) {
      const statement = db.prepare(text);
      return {
        bind(...values: unknown[]) {
          statements.push({ text, values });
          return statement.bind(...values);
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
    "0022_neuron_document_dates.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint"))
      if (statement.trim()) await db.prepare(statement).run();
  }
  const dailyRows = days.flatMap((snapshot_date, day) =>
    [0, 7, 128].flatMap((netuid) =>
      Array.from({ length: 258 }, (_, uid) => ({
        netuid,
        uid,
        snapshot_date,
        hotkey: `5H${uid}`,
        coldkey: null,
        captured_at: 1790090000000 + day,
        validator_permit: uid % 3 === 0,
        stake_tao: netuid === 128 ? null : uid / 1024,
        emission_tao: netuid === 128 ? null : uid % 2 ? 0 : uid / 2048,
      })),
    ),
  );
  await writeNeuronDocuments(createD1Store(db), {
    rows: [],
    dailyRows,
    positionRows: [],
  });
  await db.prepare("DELETE FROM neuron_daily_members WHERE uid=8").run();
  await db
    .prepare("UPDATE neuron_daily_members SET shard=99 WHERE uid=9")
    .run();
});
afterAll(() => runtime.dispose());
const sorted = (rows: Record<string, unknown>[]) =>
  rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
test("native boundary rollups preserve exact view results, null sums, missing memberships and dates", async () => {
  const portable = createD1Sql(createD1Store(db));
  for (const [start, end] of [
    [days[0], days[2]],
    [days[1], days[1]],
    ["1999-01-01", "1999-01-02"],
  ]) {
    const actual = await readNeuronDailyTotals(
      absent,
      environment(),
      start,
      end,
    );
    const expected = await readNeuronDailyTotals(portable, {}, start, end);
    assert.deepEqual(sorted(actual), sorted(expected));
    if (actual.length) {
      assert.ok(actual.every((row) => row.neuron_count === 256));
      assert.ok(
        actual.some(
          (row) =>
            row.total_stake_tao === null && row.total_emission_tao === null,
        ),
      );
    }
  }
  const query = statements[0];
  const plan = (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${query.text}`)
      .bind(...query.values)
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);
  assert.match(plan[0], /SEARCH d USING INDEX neuron_daily_documents_day_idx/);
  assert.match(plan[1], /SCAN j VIRTUAL TABLE/);
  assert.match(plan[2], /SEARCH m USING PRIMARY KEY/);
});
test("subnet history preserves inclusive cutoffs, descending dates, limit, and empty subnets", async () => {
  const portable = createD1Sql(createD1Store(db));
  for (const netuid of [0, 7, 128, 99])
    for (const cutoff of [null, days[1], "2099-01-01"])
      for (const limit of [1, 1000]) {
        assert.deepEqual(
          await readSubnetDailyHistory(
            absent,
            environment(),
            netuid,
            cutoff,
            limit,
          ),
          await readSubnetDailyHistory(portable, {}, netuid, cutoff, limit),
        );
      }
  const query = statements.find((q) => q.text.includes("d.netuid=?"))!;
  const plan = (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${query.text}`)
      .bind(...query.values)
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);
  assert.match(plan[0], /SEARCH d USING PRIMARY KEY/);
  assert.match(plan[1], /SCAN j VIRTUAL TABLE/);
  assert.match(plan[2], /SEARCH m USING PRIMARY KEY/);
});
test("selected storage errors cannot silently fall back", async () => {
  const unbound = { D1_STATE_TABLES: "neuron_daily" };
  await assert.rejects(
    readNeuronDailyTotals(absent, unbound, days[0], days[1]),
    /Selected D1 store is unbound/,
  );
  await assert.rejects(
    readSubnetDailyHistory(absent, unbound, 7, null, 30),
    /Selected D1 store is unbound/,
  );
});
