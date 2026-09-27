import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
  AXON_REMOVAL_PROJECTION_KEY,
  AXON_REMOVAL_PROJECTION_MAX_AGE_MS,
  readAxonRemovalProjection,
  writeAxonRemovalProjection,
} from "../src/axon-removals-projection.ts";
import {
  deriveAxonRemovals,
  type NeuronAxonDayRow,
} from "../src/axon-removal-derivation.ts";
import { refreshAxonRemovalProjection } from "../src/axon-removals-loader.ts";

const generatedAt = Date.parse("2026-08-10T23:59:00Z");
function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    "CREATE TABLE generated_artifacts(key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)",
  );
  const reads: string[] = [];
  const db = {
    prepare(text: string) {
      const statement = (values: (string | number)[] = []) => ({
        bind: (...bound: (string | number)[]) => statement(bound),
        async all() {
          reads.push(text);
          return { results: sql.prepare(text).all(...values) };
        },
        async run() {
          return {
            meta: { changes: Number(sql.prepare(text).run(...values).changes) },
          };
        },
      });
      return statement();
    },
    async batch() {
      throw new Error("Unexpected batch");
    },
  };
  const env = { D1_STATE: db, D1_STATE_TABLES: "neuron_daily" };
  return { sql, reads, env };
}
function series(
  uid: number,
  date: number,
  tail: "removed" | "reused" | "pending" = "removed",
): NeuronAxonDayRow[] {
  return [
    {
      netuid: 7,
      uid,
      hotkey: "a",
      snapshot_date: `2026-08-0${date - 1}`,
      axon: "1.2.3.4:8091",
    },
    {
      netuid: 7,
      uid,
      hotkey: tail === "reused" ? "b" : "a",
      snapshot_date: `2026-08-0${date}`,
      axon: null,
    },
    ...(tail === "pending"
      ? []
      : [
          {
            netuid: 7,
            uid,
            hotkey: tail === "reused" ? "b" : "a",
            snapshot_date: `2026-08-0${date + 1}`,
            axon: null,
          },
        ]),
  ];
}

test("compact transitions keep exact window counts across midnight with one storage read", async () => {
  const { sql, reads, env } = fixture();
  try {
    const rows = [
      ...series(1, 3),
      ...series(2, 4),
      ...series(3, 3, "reused"),
      ...series(4, 4, "pending"),
    ];
    await writeAxonRemovalProjection(env, rows, generatedAt);
    for (const [now, since] of [
      [generatedAt, "2026-08-03"],
      [generatedAt + 120000, "2026-08-04"],
    ] as const) {
      reads.length = 0;
      assert.deepEqual(
        await readAxonRemovalProjection(env, 7, now),
        deriveAxonRemovals(rows, { lookbackDays: 31, sinceDate: since }),
      );
      assert.equal(reads.length, 1);
      assert.match(
        reads[0],
        /^SELECT payload FROM generated_artifacts WHERE key=\?$/,
      );
    }
    await writeAxonRemovalProjection(env, [], generatedAt + 120000);
    assert.equal(
      sql.prepare("SELECT COUNT(*) AS n FROM generated_artifacts").get()!.n,
      1,
    );
    assert.deepEqual(
      (await readAxonRemovalProjection(env, 30, generatedAt + 120000))
        ?.removals,
      [],
    );
  } finally {
    sql.close();
  }
});

test("missing, corrupt, future and expired projections decline without replacing the source", async () => {
  const { sql, env } = fixture();
  try {
    assert.equal(await readAxonRemovalProjection({}, 7, generatedAt), null);
    assert.equal(await readAxonRemovalProjection(env, 90, generatedAt), null);
    assert.equal(await readAxonRemovalProjection(env, 7, generatedAt), null);
    await writeAxonRemovalProjection({}, [], generatedAt);
    await refreshAxonRemovalProjection({});
    for (const payload of ["{", "{}"]) {
      sql
        .prepare("INSERT OR REPLACE INTO generated_artifacts VALUES(?,?,?)")
        .run(AXON_REMOVAL_PROJECTION_KEY, payload, "now");
      assert.equal(await readAxonRemovalProjection(env, 7, generatedAt), null);
    }
    await writeAxonRemovalProjection(env, series(1, 4), generatedAt);
    assert.equal(
      await readAxonRemovalProjection(env, 7, generatedAt - 1),
      null,
    );
    assert.equal(
      await readAxonRemovalProjection(
        env,
        7,
        generatedAt + AXON_REMOVAL_PROJECTION_MAX_AGE_MS + 1,
      ),
      null,
    );
    sql.exec("DROP TABLE generated_artifacts");
    assert.equal(await readAxonRemovalProjection(env, 7, generatedAt), null);
    await assert.rejects(writeAxonRemovalProjection(env, [], generatedAt));
  } finally {
    sql.close();
  }
});

test("oversized replacements preserve the previously published scorecard", async () => {
  const { sql, env } = fixture();
  try {
    await writeAxonRemovalProjection(env, series(1, 4), generatedAt);
    const before = await readAxonRemovalProjection(env, 7, generatedAt);
    const rows = series(2, 4).map((row) => ({
      ...row,
      hotkey: "a".repeat(1_500_001),
    }));
    await assert.rejects(
      writeAxonRemovalProjection(env, rows, generatedAt),
      /storage budget/,
    );
    assert.deepEqual(
      await readAxonRemovalProjection(env, 7, generatedAt),
      before,
    );
  } finally {
    sql.close();
  }
});
