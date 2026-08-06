// #9620: /api/v1/chain/indexer-lag -- how long after a block is produced it
// becomes queryable here.
//
// The percentile SQL is asserted against a REAL SQLite engine rather than a
// mocked `first()`, because the whole card comes out of one statement and a
// hand-written expectation would only prove the string matches itself. The
// nearest-rank arithmetic -- integer division that must round UP -- is exactly
// the kind of thing that passes a mock and fails a database.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildIndexerLag,
  INDEXER_LAG_SQL,
  INDEXER_LAG_TABLE,
  loadIndexerLag,
} from "../src/indexer-lag.ts";

/** A real table shaped like 0010's, so the SQL runs against SQLite semantics. */
function db(rows: Array<[number, number, number]>) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE ${INDEXER_LAG_TABLE} (
       block_number INTEGER PRIMARY KEY,
       observed_at INTEGER NOT NULL,
       synced_at INTEGER NOT NULL
     )`,
  );
  const insert = sqlite.prepare(
    `INSERT INTO ${INDEXER_LAG_TABLE} (block_number, observed_at, synced_at) VALUES (?, ?, ?)`,
  );
  for (const [block, observed, synced] of rows)
    insert.run(block, observed, synced);
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind() {
          return { first: async () => stmt.get() ?? null };
        },
      };
    },
  };
}

/** n blocks 12s apart, each landing `lagMs` after its own timestamp. */
function blocks(n: number, lagMs: (i: number) => number) {
  const t0 = 1_785_970_632_000;
  return Array.from({ length: n }, (_, i): [number, number, number] => [
    8_781_166 + i,
    t0 + i * 12_000,
    t0 + i * 12_000 + lagMs(i),
  ]);
}

describe("loadIndexerLag", () => {
  it("computes nearest-rank percentiles over the retained window", async () => {
    // 100 blocks with lags 1..100ms, so every quantile has an unambiguous
    // nearest-rank answer and an off-by-one in the integer arithmetic shows.
    const row = await loadIndexerLag(db(blocks(100, (i) => i + 1)));
    expect(row).not.toBeNull();
    expect(row?.block_count).toBe(100);
    expect(row?.min_ms).toBe(1);
    expect(row?.max_ms).toBe(100);
    expect(row?.mean_ms).toBeCloseTo(50.5, 6);
    expect(row?.p50_ms).toBe(50);
    expect(row?.p95_ms).toBe(95);
    expect(row?.p99_ms).toBe(99);
  });

  it("reports the window bounds it measured", async () => {
    const rows = blocks(10, () => 30_000);
    const row = await loadIndexerLag(db(rows));
    expect(row?.oldest_block).toBe(rows[0][0]);
    expect(row?.newest_block).toBe(rows[9][0]);
    expect(row?.oldest_observed_at).toBe(rows[0][1]);
    expect(row?.newest_observed_at).toBe(rows[9][1]);
  });

  it("rounds a percentile UP so a short window names a real row", async () => {
    // 3 blocks: p95 must land on the LARGEST, not truncate toward the middle.
    // (3*95+99)/100 = 3 in integer arithmetic; a plain (3*95)/100 would give 2.
    const row = await loadIndexerLag(db(blocks(3, (i) => (i + 1) * 10)));
    expect(row?.p95_ms).toBe(30);
    expect(row?.p99_ms).toBe(30);
    expect(row?.p50_ms).toBe(20);
  });

  it("answers a single-block window with that block at every quantile", async () => {
    const row = await loadIndexerLag(db(blocks(1, () => 42)));
    expect(row?.block_count).toBe(1);
    expect(row?.p50_ms).toBe(42);
    expect(row?.p95_ms).toBe(42);
    expect(row?.p99_ms).toBe(42);
  });

  it("returns null on an empty table, which GROUP BY n yields no row for", async () => {
    expect(await loadIndexerLag(db([]))).toBeNull();
  });

  it("returns null without a database rather than throwing", async () => {
    expect(await loadIndexerLag(null)).toBeNull();
    expect(await loadIndexerLag(undefined)).toBeNull();
    expect(await loadIndexerLag({} as never)).toBeNull();
  });

  it("returns null when the read throws", async () => {
    const throwing = {
      prepare() {
        return {
          bind() {
            return {
              first: async () => {
                throw new Error("D1_ERROR");
              },
            };
          },
        };
      },
    };
    expect(await loadIndexerLag(throwing)).toBeNull();
  });

  it("returns null when first() is absent or answers a non-row", async () => {
    const noFirst = { prepare: () => ({ bind: () => ({}) }) };
    expect(await loadIndexerLag(noFirst as never)).toBeNull();
    const scalar = {
      prepare: () => ({ bind: () => ({ first: async () => 7 }) }),
    };
    expect(await loadIndexerLag(scalar as never)).toBeNull();
  });

  it("runs the exported statement, so the constant cannot drift from it", () => {
    let seen = "";
    const spy = {
      prepare(sql: string) {
        seen = sql;
        return { bind: () => ({ first: async () => null }) };
      },
    };
    void loadIndexerLag(spy);
    expect(seen).toBe(INDEXER_LAG_SQL);
    // No lower bound anywhere in the statement: a negative lag is evidence of
    // clock skew, and this route is where that evidence belongs.
    expect(INDEXER_LAG_SQL).not.toMatch(/l\s*>=?\s*0/);
  });

  it("measures a NEGATIVE lag rather than refusing it", async () => {
    // A block author's clock running ahead of ours. The SQL must not filter it
    // out -- see the module header: this route is where that evidence belongs.
    const row = await loadIndexerLag(
      db(blocks(4, (i) => (i === 0 ? -500 : 30))),
    );
    expect(row?.min_ms).toBe(-500);
  });
});

describe("buildIndexerLag", () => {
  const NOW = 1_785_992_964_000;

  const measured = {
    block_count: 1862,
    min_ms: 28277,
    max_ms: 102700,
    mean_ms: 35817.76366559485,
    p50_ms: 34137,
    p95_ms: 43570,
    p99_ms: 57579,
    oldest_block: 8781166,
    newest_block: 8783027,
    oldest_observed_at: 1785970632000,
    newest_observed_at: 1785992964000,
  };

  it("publishes the latency distribution and the window it came from", () => {
    const card = buildIndexerLag(measured, NOW);
    expect(card.schema_version).toBe(1);
    expect(card.block_count).toBe(1862);
    expect(card.write_latency_ms).toEqual({
      min: 28277,
      p50: 34137,
      p95: 43570,
      p99: 57579,
      max: 102700,
      // Rounded: a full float64 of millisecond averages publishes precision the
      // two source clocks do not have.
      mean: 35818,
    });
    expect(card.window).toEqual({
      oldest_block: 8781166,
      newest_block: 8783027,
      oldest_observed_at: "2026-08-05T22:57:12.000Z",
      newest_observed_at: "2026-08-06T05:09:24.000Z",
    });
    expect(card.degraded).toBeUndefined();
  });

  it("computes head age from the injected clock, not its own", () => {
    // The whole subject of this module is two clocks; a third introduced here
    // would make the number untestable and the module impure.
    const card = buildIndexerLag(measured, NOW + 90_000);
    expect(card.head_age_ms).toBe(90_000);
    expect(card.measured_at).toBe(new Date(NOW + 90_000).toISOString());
  });

  it("keeps head age SEPARATE from write latency when the lane stalls", () => {
    // The case the two names exist for: every block this lane wrote, it wrote
    // promptly, and it has written nothing for six hours. A card reporting only
    // the distribution would call that healthy.
    const card = buildIndexerLag(measured, NOW + 6 * 3_600_000);
    expect(card.head_age_ms).toBe(21_600_000);
    expect((card.write_latency_ms as { p50: number }).p50).toBe(34137);
  });

  it("declines on an empty window instead of reporting zero lag", () => {
    const card = buildIndexerLag(null, NOW);
    expect((card.degraded as { reason: string }).reason).toBe(
      "no_retained_blocks",
    );
    expect(card.block_count).toBeNull();
    expect(card.write_latency_ms).toBeNull();
    expect(card.window).toBeNull();
    expect(card.head_age_ms).toBeNull();
    // The decline still carries a timestamp: a caller must be able to tell a
    // fresh decline from a cached one.
    expect(card.measured_at).toBe(new Date(NOW).toISOString());
  });

  it("declines on a row whose block_count is zero or unreadable", () => {
    for (const count of [0, null, "many", undefined]) {
      const card = buildIndexerLag({ ...measured, block_count: count }, NOW);
      expect((card.degraded as { reason: string }).reason).toBe(
        "no_retained_blocks",
      );
    }
  });

  it("publishes a negative latency as measured, never clamped to zero", () => {
    const card = buildIndexerLag({ ...measured, min_ms: -1200 }, NOW);
    expect((card.write_latency_ms as { min: number }).min).toBe(-1200);
  });

  it("nulls an unreadable measurement rather than substituting zero", () => {
    const card = buildIndexerLag(
      { ...measured, p95_ms: "n/a", mean_ms: null, max_ms: Infinity },
      NOW,
    );
    expect(card.write_latency_ms).toMatchObject({
      p95: null,
      mean: null,
      max: null,
      min: 28277,
    });
  });

  it("nulls head age when the newest timestamp is unreadable", () => {
    // Zero would assert the lane is exactly current, which is the one thing an
    // unreadable timestamp cannot support.
    const card = buildIndexerLag(
      { ...measured, newest_observed_at: "not-a-time" },
      NOW,
    );
    expect(card.head_age_ms).toBeNull();
    expect(
      (card.window as { newest_observed_at: string | null }).newest_observed_at,
    ).toBeNull();
  });

  it("nulls a timestamp past the Date range instead of emitting Invalid Date", () => {
    // 1e16 ms is finite and positive but beyond what Date can represent, so the
    // finiteness check on the parsed number is not the last guard needed.
    const card = buildIndexerLag(
      { ...measured, oldest_observed_at: 1e16 },
      NOW,
    );
    expect(
      (card.window as { oldest_observed_at: string | null }).oldest_observed_at,
    ).toBeNull();
  });

  it("nulls a non-positive or non-integer window bound", () => {
    const card = buildIndexerLag(
      { ...measured, oldest_observed_at: 0, oldest_block: 1.5 },
      NOW,
    );
    expect(card.window).toMatchObject({
      oldest_observed_at: null,
      oldest_block: null,
    });
  });
});
