// #9625: /api/v1/subnets/{netuid}/emission-pipeline/history -- one subnet's
// pipeline decomposition over time.
//
// The carried-forward-observation case is the one this route exists to get
// right, so it is asserted from both directions: that a repeated block is
// flagged and excluded from `distinct_observations`, and that an equal VALUE
// under a fresh block is NOT -- the flag must mean "not re-measured", never
// "did not change".
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildPipelineHistory,
  declinePipelineHistory,
  loadPipelineHistory,
  PIPELINE_HISTORY_FIRST_DAY,
  PIPELINE_HISTORY_TABLE,
} from "../src/emission-pipeline-history.ts";

const T = Date.UTC(2026, 7, 6, 12); // 2026-08-06T12:00:00Z

/** A table shaped like the real subnet_snapshots, columns this route reads. */
function db(
  rows: Array<{
    netuid: number;
    day: string;
    block: number | null;
    burn?: number | null;
    enabled?: number | null;
  }>,
) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE ${PIPELINE_HISTORY_TABLE} (
       netuid INTEGER NOT NULL, snapshot_date TEXT NOT NULL,
       pipeline_block INTEGER, pipeline_block_hash TEXT,
       emission_share REAL, tao_in_pool_tao REAL, tao_in_emission_tao REAL,
       excess_tao REAL, alpha_in_emission REAL, alpha_out_emission REAL,
       miner_burned_fraction REAL, emission_enabled INTEGER,
       first_emission_block INTEGER, alpha_price_tao REAL, captured_at INTEGER,
       PRIMARY KEY (netuid, snapshot_date)
     )`,
  );
  const ins = sqlite.prepare(
    `INSERT INTO ${PIPELINE_HISTORY_TABLE}
       (netuid, snapshot_date, pipeline_block, pipeline_block_hash,
        emission_share, tao_in_pool_tao, tao_in_emission_tao, excess_tao,
        alpha_in_emission, alpha_out_emission, miner_burned_fraction,
        emission_enabled, first_emission_block, alpha_price_tao, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    ins.run(
      r.netuid,
      r.day,
      r.block,
      r.block === null ? null : `0xhash${r.block}`,
      0.02,
      1000,
      12.5,
      3.25,
      500,
      480,
      r.burn ?? 0.42,
      r.enabled ?? 1,
      8000000,
      0.031,
      T,
    );
  }
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          return {
            all: async () => ({
              results: stmt.all(...(values as Array<string | number | null>)),
            }),
          };
        },
      };
    },
  };
}

describe("loadPipelineHistory", () => {
  it("returns one subnet's captured days, oldest first", async () => {
    const rows = await loadPipelineHistory(
      db([
        { netuid: 74, day: "2026-08-04", block: 8770315 },
        { netuid: 74, day: "2026-08-02", block: 8755519 },
        { netuid: 74, day: "2026-08-03", block: 8763157 },
        { netuid: 11, day: "2026-08-03", block: 8763157 },
      ]),
      74,
      { window: "30d", nowMs: T },
    );
    expect(rows?.map((r) => r.snapshot_date)).toEqual([
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
  });

  it("excludes rows predating the pipeline capture entirely", async () => {
    // 404 days of snapshots predate the columns. Filtering on pipeline_block
    // rather than a date floor is what stops them arriving as points made
    // entirely of nulls.
    const rows = await loadPipelineHistory(
      db([
        { netuid: 74, day: "2026-08-02", block: 8755519 },
        { netuid: 74, day: "2026-08-01", block: null },
      ]),
      74,
      { window: "30d", nowMs: T },
    );
    expect(rows).toHaveLength(1);
  });

  it("honours the window", async () => {
    const rows = await loadPipelineHistory(
      db([
        { netuid: 74, day: "2026-08-06", block: 8777280 },
        { netuid: 74, day: "2026-06-01", block: 8000000 },
      ]),
      74,
      { window: "7d", nowMs: T },
    );
    expect(rows).toHaveLength(1);
  });

  it("serves netuid 0, which is a real subnet", async () => {
    const rows = await loadPipelineHistory(
      db([{ netuid: 0, day: "2026-08-05", block: 8777280 }]),
      0,
      { window: "30d", nowMs: T },
    );
    expect(rows).toHaveLength(1);
  });

  it("returns null for a window the vocabulary does not define", async () => {
    expect(
      await loadPipelineHistory(db([]), 74, { window: "1h", nowMs: T }),
    ).toBeNull();
  });

  it("defaults to the 30d window", async () => {
    const rows = await loadPipelineHistory(
      db([{ netuid: 74, day: "2026-08-05", block: 8777280 }]),
      74,
      { nowMs: T },
    );
    expect(rows).toHaveLength(1);
  });

  it("returns null without a database and when the read throws", async () => {
    expect(await loadPipelineHistory(null, 74)).toBeNull();
    expect(await loadPipelineHistory(undefined, 74)).toBeNull();
    expect(await loadPipelineHistory({} as never, 74)).toBeNull();
    const throwing = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1_ERROR");
          },
        }),
      }),
    };
    expect(await loadPipelineHistory(throwing, 74)).toBeNull();
  });

  it("returns an empty list when all() is absent or answers nothing", async () => {
    const noAll = { prepare: () => ({ bind: () => ({}) }) };
    expect(await loadPipelineHistory(noAll as never, 74)).toEqual([]);
    const empty = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    };
    expect(await loadPipelineHistory(empty, 74)).toEqual([]);
  });
});

describe("buildPipelineHistory", () => {
  const row = (
    day: string,
    block: number,
    extra: Record<string, unknown> = {},
  ) => ({
    snapshot_date: day,
    pipeline_block: block,
    pipeline_block_hash: `0xhash${block}`,
    emission_share: 0.02,
    alpha_price_tao: 0.031,
    tao_in_pool_tao: 1000,
    tao_in_emission_tao: 12.5,
    excess_tao: 3.25,
    alpha_in_emission: 500,
    alpha_out_emission: 480,
    miner_burned_fraction: 0.42,
    emission_enabled: 1,
    first_emission_block: 8000000,
    captured_at: T,
    ...extra,
  });

  it("shapes the series with every pipeline field pinned to its block", () => {
    const card = buildPipelineHistory([row("2026-08-02", 8755519)], 74, {
      window: "30d",
    });
    expect(card).toMatchObject({
      schema_version: 1,
      netuid: 74,
      window: "30d",
      point_count: 1,
      distinct_observations: 1,
      oldest_day: "2026-08-02",
      newest_day: "2026-08-02",
      first_captured_day: PIPELINE_HISTORY_FIRST_DAY,
    });
    expect((card.points as Row[])[0]).toEqual({
      day: "2026-08-02",
      pipeline_block: 8755519,
      pipeline_block_hash: "0xhash8755519",
      repeats_previous_observation: false,
      captured_at: new Date(T).toISOString(),
      emission_share: 0.02,
      alpha_price_tao: 0.031,
      tao_in_pool_tao: 1000,
      tao_in_emission_tao: 12.5,
      excess_tao: 3.25,
      alpha_in_emission: 500,
      alpha_out_emission: 480,
      miner_burned_fraction: 0.42,
      emission_enabled: true,
      first_emission_block: 8000000,
    });
  });

  it("FLAGS a carried-forward day and excludes it from distinct_observations", () => {
    // Production, 2026-08-06: the 5th and 6th share block 8777280 because the
    // snapshot writer ran before a fresh capture landed.
    const card = buildPipelineHistory(
      [
        row("2026-08-04", 8770315),
        row("2026-08-05", 8777280),
        row("2026-08-06", 8777280),
      ],
      74,
    );
    const flags = (
      card.points as Array<{ repeats_previous_observation: boolean }>
    ).map((p) => p.repeats_previous_observation);
    expect(flags).toEqual([false, false, true]);
    expect(card.point_count).toBe(3);
    // Three rows, two readings. Any claim about how a value moved rests on the
    // second number.
    expect(card.distinct_observations).toBe(2);
  });

  it("does NOT flag an unchanged VALUE under a fresh block", () => {
    // The flag means "not re-measured", never "did not change" -- a genuinely
    // flat metric across two real captures is a finding, and suppressing it
    // would be the mirror-image error.
    const card = buildPipelineHistory(
      [
        row("2026-08-04", 8770315, { miner_burned_fraction: 0.42 }),
        row("2026-08-05", 8777280, { miner_burned_fraction: 0.42 }),
      ],
      74,
    );
    expect(
      (card.points as Array<{ repeats_previous_observation: boolean }>).every(
        (p) => !p.repeats_previous_observation,
      ),
    ).toBe(true);
    expect(card.distinct_observations).toBe(2);
  });

  it("does not flag the first point, which has nothing to repeat", () => {
    const card = buildPipelineHistory([row("2026-08-02", 8755519)], 74);
    expect(
      (card.points as Array<{ repeats_previous_observation: boolean }>)[0]
        .repeats_previous_observation,
    ).toBe(false);
    expect(card.distinct_observations).toBe(1);
  });

  it("counts a block that returns after a gap as a new observation", () => {
    // Only a run of IDENTICAL consecutive blocks is a carry-forward; a block
    // reappearing after a different one would be a reorg or a rewrite, not a
    // skipped capture, and collapsing them would hide it.
    const card = buildPipelineHistory(
      [row("2026-08-02", 100), row("2026-08-03", 200), row("2026-08-04", 100)],
      74,
    );
    expect(card.distinct_observations).toBe(3);
  });

  it("publishes the depth found, not the window asked for", () => {
    const card = buildPipelineHistory(
      [row("2026-08-02", 8755519), row("2026-08-06", 8777280)],
      74,
      { window: "180d" },
    );
    expect(card.oldest_day).toBe("2026-08-02");
    expect(card.newest_day).toBe("2026-08-06");
    expect(card.point_count).toBe(2);
    expect(card.first_captured_day).toBe(PIPELINE_HISTORY_FIRST_DAY);
  });

  it("treats an empty series as a MEASUREMENT, not a decline", () => {
    // A subnet registered after the capture began returns one legitimately.
    const card = buildPipelineHistory([], 74, { window: "7d" });
    expect(card.degraded).toBeUndefined();
    expect(card.point_count).toBe(0);
    expect(card.distinct_observations).toBe(0);
    expect(card.oldest_day).toBeNull();
    expect(card.newest_day).toBeNull();
    // Still published, so the caller can tell "the series starts later than
    // your window" from "this subnet has no pipeline".
    expect(card.first_captured_day).toBe(PIPELINE_HISTORY_FIRST_DAY);
  });

  it("accepts a null or non-array row list without inventing an error", () => {
    expect(buildPipelineHistory(null, 74).point_count).toBe(0);
    expect(buildPipelineHistory(undefined, 74).point_count).toBe(0);
    expect(buildPipelineHistory("nope" as never, 74).point_count).toBe(0);
    expect(buildPipelineHistory([row("2026-08-02", 1)], 74).window).toBeNull();
  });

  it("drops a point that cannot say its day or its block", () => {
    const card = buildPipelineHistory(
      [
        row("2026-08-02", 8755519),
        { ...row("2026-08-03", 8763157), snapshot_date: null },
        { ...row("2026-08-04", 8770315), pipeline_block: null },
        { ...row("2026-08-05", 8777280), pipeline_block: 1.5 },
      ],
      74,
    );
    expect(card.point_count).toBe(1);
  });

  it("nulls an unreadable measurement rather than substituting zero", () => {
    const card = buildPipelineHistory(
      [
        row("2026-08-02", 8755519, {
          miner_burned_fraction: "n/a",
          excess_tao: null,
          tao_in_emission_tao: Infinity,
          pipeline_block_hash: "",
          captured_at: 0,
        }),
      ],
      74,
    );
    expect((card.points as Row[])[0]).toMatchObject({
      miner_burned_fraction: null,
      excess_tao: null,
      tao_in_emission_tao: null,
      pipeline_block_hash: null,
      captured_at: null,
    });
  });

  it("nulls a captured_at past the Date range instead of Invalid Date", () => {
    // 1e16 ms is finite and positive but beyond what Date can represent, so
    // the finiteness check on the parsed number is not the last guard needed.
    const card = buildPipelineHistory(
      [row("2026-08-02", 8755519, { captured_at: 1e16 })],
      74,
    );
    expect((card.points as Row[])[0].captured_at).toBeNull();
  });

  it("nulls emission_enabled when it is neither 0 nor 1", () => {
    // `false` would assert the subnet's emission was switched OFF, which an
    // unreadable value cannot support.
    for (const [value, expected] of [
      [1, true],
      [0, false],
      [null, null],
      ["yes", null],
    ] as const) {
      const card = buildPipelineHistory(
        [row("2026-08-02", 8755519, { emission_enabled: value })],
        74,
      );
      expect((card.points as Row[])[0].emission_enabled).toBe(expected);
    }
  });
});

describe("declinePipelineHistory", () => {
  it("nulls every count rather than asserting a subnet has no pipeline", () => {
    const card = declinePipelineHistory("unavailable", 74, { window: "30d" });
    expect((card.degraded as { reason: string }).reason).toBe("unavailable");
    expect(card.point_count).toBeNull();
    expect(card.distinct_observations).toBeNull();
    expect(card.oldest_day).toBeNull();
    expect(card.newest_day).toBeNull();
    expect(card.points).toEqual([]);
    expect(card).toMatchObject({ netuid: 74, window: "30d" });
    expect(card.first_captured_day).toBe(PIPELINE_HISTORY_FIRST_DAY);
  });

  it("echoes a null window when it was given none", () => {
    expect(declinePipelineHistory("unavailable", 0).window).toBeNull();
  });
});

type Row = Record<string, unknown>;
