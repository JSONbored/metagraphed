// #9628: /api/v1/chain/concentration/history -- is the NETWORK getting more
// concentrated?
//
// The rollup is asserted against a REAL SQLite engine because its correctness
// is entirely about which days it picks: it must skip days that already have a
// card, skip TODAY (which `neuron_daily` is still filling), and leave a day
// with no rows PENDING rather than storing a card for it. None of those are
// visible through a mocked prepare().
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  CHAIN_CONCENTRATION_DAILY_TABLE,
  pendingDaysSql,
  rollupChainConcentration,
} from "../src/chain-concentration-rollup.ts";
import {
  buildChainConcentrationHistory,
  declineChainConcentrationHistory,
  loadChainConcentrationHistory,
} from "../src/chain-concentration-history.ts";

const T = Date.UTC(2026, 7, 6, 12); // 2026-08-06T12:00:00Z

function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `CREATE TABLE ${CHAIN_CONCENTRATION_DAILY_TABLE} (
       day TEXT NOT NULL PRIMARY KEY, neuron_count INTEGER NOT NULL,
       card TEXT NOT NULL, source_captured_at INTEGER,
       computed_at INTEGER NOT NULL, builder_version INTEGER NOT NULL
     )`,
  );
  sqlite.exec(
    `CREATE TABLE neuron_daily (
       netuid INTEGER NOT NULL, uid INTEGER NOT NULL, coldkey TEXT,
       validator_permit INTEGER, emission_tao REAL, stake_tao REAL,
       captured_at INTEGER NOT NULL, snapshot_date TEXT NOT NULL,
       PRIMARY KEY (netuid, uid, snapshot_date)
     )`,
  );
  return sqlite;
}

/** Seed one day of neurons: `holders` UIDs on one subnet, stake 1..holders. */
function seedDay(
  sqlite: DatabaseSync,
  day: string,
  holders: number,
  {
    netuid = 74,
    capturedAt = T,
  }: { netuid?: number; capturedAt?: number } = {},
) {
  const ins = sqlite.prepare(
    `INSERT INTO neuron_daily
       (netuid, uid, coldkey, validator_permit, emission_tao, stake_tao,
        captured_at, snapshot_date)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < holders; i += 1) {
    ins.run(
      netuid,
      i,
      `ck${i}`,
      i === 0 ? 1 : 0,
      i + 1,
      i + 1,
      capturedAt,
      day,
    );
  }
}

function asDb(sqlite: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const v = values as Array<string | number | null>;
          return {
            all: async () => ({ results: stmt.all(...v) }),
            run: async () => stmt.run(...v),
          };
        },
      };
    },
  };
}

describe("rollupChainConcentration", () => {
  it("computes a card per pending day and stores its shape alongside", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-04", 5);
    seedDay(sqlite, "2026-08-05", 5);
    const out = await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    expect(out.rolled).toBe(true);
    expect(out.days_rolled).toEqual(["2026-08-05", "2026-08-04"]);
    const rows = sqlite
      .prepare(
        `SELECT day, neuron_count, builder_version, source_captured_at
           FROM ${CHAIN_CONCENTRATION_DAILY_TABLE} ORDER BY day`,
      )
      .all();
    expect(rows).toEqual([
      {
        day: "2026-08-04",
        neuron_count: 5,
        builder_version: 1,
        source_captured_at: T,
      },
      {
        day: "2026-08-05",
        neuron_count: 5,
        builder_version: 1,
        source_captured_at: T,
      },
    ]);
  });

  it("stores a card the serving builder produced, not a reimplementation", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 4);
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    const stored = JSON.parse(
      (
        sqlite
          .prepare(`SELECT card FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`)
          .get() as { card: string }
      ).card,
    );
    // The five lenses /chain/concentration serves, with real ratios behind
    // them -- the whole reason this runs the builder rather than SQL.
    expect(stored.stake.holders).toBe(4);
    expect(stored.stake.gini).toBeGreaterThan(0);
    expect(stored.stake.nakamoto_coefficient).toBeGreaterThan(0);
    expect(stored.emission.holders).toBe(4);
    expect(stored.entity_stake.holders).toBe(4);
    expect(stored.validator_stake.holders).toBe(1);
  });

  it("NEVER rolls up today, which neuron_daily is still filling", async () => {
    // A mid-day card would be computed over a partial network and then never
    // revisited -- a point that looks like a real measurement of a much
    // smaller network.
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-06", 5);
    const out = await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    expect(out.rolled).toBe(false);
    expect(out.days_pending).toBe(0);
  });

  it("skips a day that already has a card", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-04", 5);
    seedDay(sqlite, "2026-08-05", 5);
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    const second = await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    expect(second.rolled).toBe(false);
    expect(second.days_pending).toBe(0);
  });

  it("processes the NEWEST pending days first, bounded per tick", async () => {
    // Newest first because a fresh gap matters more than an old one: after an
    // outage the days a caller asks for are the recent ones.
    const sqlite = sqliteDb();
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]) {
      seedDay(sqlite, d, 3);
    }
    const out = await rollupChainConcentration(asDb(sqlite), {
      nowMs: T,
      maxDays: 2,
    });
    expect(out.days_rolled).toEqual(["2026-08-04", "2026-08-03"]);
    // Reported BEFORE this tick's work, so a reader of the cron summary can
    // see the backfill draining rather than only its last step.
    expect(out.days_pending).toBe(2);
  });

  it("drains a backfill across ticks", async () => {
    const sqlite = sqliteDb();
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]) {
      seedDay(sqlite, d, 3);
    }
    for (let i = 0; i < 3; i += 1) {
      await rollupChainConcentration(asDb(sqlite), { nowMs: T, maxDays: 2 });
    }
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`)
        .get(),
    ).toEqual({ n: 4 });
  });

  it("is idempotent: re-rolling a day replaces rather than duplicates", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 3);
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    // Force a re-roll by clearing the card's day from the anti-join's view.
    sqlite.exec(`DELETE FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`);
    seedDay(sqlite, "2026-08-05", 3, { netuid: 11 });
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    const rows = sqlite
      .prepare(`SELECT day, card FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`)
      .all() as Array<{ day: string; card: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-08-05");
    // Replaced, not duplicated: the re-roll saw both subnets.
    expect(JSON.parse(rows[0].card).subnet_count).toBe(2);
  });

  it("leaves a day with no rows PENDING instead of storing a zero card", async () => {
    // A day with no rows is not a day of zero concentration -- it is a day the
    // capture did not run, and a card for it would manufacture a point.
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 2);
    const db = asDb(sqlite);
    // Delete the rows between the scan and the read, so the day is pending but
    // unreadable -- the shape of a capture that vanished mid-tick.
    const original = db.prepare.bind(db);
    let scanned = false;
    const racy = {
      prepare(sql: string) {
        const stmt = original(sql);
        if (!scanned && sql.includes("LEFT JOIN")) {
          scanned = true;
          return stmt;
        }
        if (sql.includes("FROM neuron_daily WHERE snapshot_date")) {
          sqlite.exec("DELETE FROM neuron_daily");
        }
        return stmt;
      },
    };
    const out = await rollupChainConcentration(racy, { nowMs: T });
    expect(out.rolled).toBe(false);
    expect(out.days_failed).toEqual(["2026-08-05"]);
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it("keeps going when ONE day fails, so the rest of the backfill lands", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-04", 3);
    seedDay(sqlite, "2026-08-05", 3);
    const original = asDb(sqlite);
    const flaky = {
      prepare(sql: string) {
        const stmt = original.prepare(sql);
        return {
          bind(...values: unknown[]) {
            const bound = stmt.bind(...values);
            if (values[0] === "2026-08-05" && sql.includes("neuron_daily")) {
              return {
                all: async () => {
                  throw new Error("D1_ERROR");
                },
              };
            }
            return bound;
          },
        };
      },
    };
    const out = await rollupChainConcentration(flaky, { nowMs: T });
    expect(out.days_rolled).toEqual(["2026-08-04"]);
    expect(out.days_failed).toEqual(["2026-08-05"]);
  });

  it("reports unavailable without a database and scan_failed on a bad scan", async () => {
    expect(await rollupChainConcentration(null)).toEqual({
      rolled: false,
      reason: "unavailable",
    });
    expect(await rollupChainConcentration({} as never)).toEqual({
      rolled: false,
      reason: "unavailable",
    });
    const broken = {
      prepare() {
        throw new Error("no such table: chain_concentration_daily");
      },
    } as never;
    expect(await rollupChainConcentration(broken)).toEqual({
      rolled: false,
      reason: "scan_failed",
    });
  });

  it("ignores a scan row that cannot name a day", async () => {
    const noDays = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ day: null }, { day: "" }, {}] }),
        }),
      }),
    };
    const out = await rollupChainConcentration(noDays, { nowMs: T });
    expect(out.rolled).toBe(false);
    expect(out.days_pending).toBe(0);
  });

  it("survives a scan or read whose all() is absent or answers nothing", async () => {
    // The optional-call and nullish-coalescing guards on both reads: a driver
    // that answers nothing must leave the day pending, not crash the tick.
    const noAll = { prepare: () => ({ bind: () => ({}) }) } as never;
    expect(await rollupChainConcentration(noAll, { nowMs: T })).toMatchObject({
      rolled: false,
      days_pending: 0,
    });
    const nullResult = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    } as never;
    expect(
      await rollupChainConcentration(nullResult, { nowMs: T }),
    ).toMatchObject({ rolled: false, days_pending: 0 });
  });

  it("stores a null source_captured_at when no row carries a usable one", async () => {
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 2, { capturedAt: 0 });
    await rollupChainConcentration(asDb(sqlite), { nowMs: T });
    expect(
      sqlite
        .prepare(
          `SELECT source_captured_at FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`,
        )
        .get(),
    ).toEqual({ source_captured_at: null });
  });

  it("leaves a day pending when the per-day read answers nothing at all", async () => {
    // Covers both the optional call and the nullish fallback on the per-day
    // read, and asserts the same contract either way: no card is stored.
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 2);
    const base = asDb(sqlite);
    for (const perDay of [{}, { all: async () => null }]) {
      const partial = {
        prepare(sql: string) {
          if (sql.includes("FROM neuron_daily WHERE snapshot_date")) {
            return { bind: () => perDay };
          }
          return base.prepare(sql);
        },
      } as never;
      const out = await rollupChainConcentration(partial, { nowMs: T });
      expect(out.days_failed).toEqual(["2026-08-05"]);
    }
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`)
        .get(),
    ).toEqual({ n: 0 });
  });

  it("stores version 1 when the card cannot state its own schema_version", async () => {
    // The column is NOT NULL, and a card whose version is unreadable must not
    // take the whole day down -- it stores the floor, and the reader publishes
    // what it finds rather than guessing.
    const sqlite = sqliteDb();
    seedDay(sqlite, "2026-08-05", 2);
    const base = asDb(sqlite);
    const noVersion = {
      prepare(sql: string) {
        if (sql.includes("FROM neuron_daily WHERE snapshot_date")) {
          return {
            bind: () => ({
              // No captured_at either, so the builder's schema_version is the
              // only thing distinguishing this from a normal day.
              all: async () => ({
                results: [{ stake_tao: 1, emission_tao: 1, coldkey: "a" }],
              }),
            }),
          };
        }
        return base.prepare(sql);
      },
    } as never;
    await rollupChainConcentration(noVersion, { nowMs: T });
    expect(
      sqlite
        .prepare(
          `SELECT builder_version, source_captured_at
             FROM ${CHAIN_CONCENTRATION_DAILY_TABLE}`,
        )
        .get(),
    ).toEqual({ builder_version: 1, source_captured_at: null });
  });

  it("scans with an anti-join that excludes today", () => {
    const sql = pendingDaysSql();
    expect(sql).toContain("LEFT JOIN");
    expect(sql).toContain("c.day IS NULL");
    expect(sql).toContain("nd.snapshot_date < ?");
    expect(sql).toContain("ORDER BY nd.snapshot_date DESC");
  });
});

describe("loadChainConcentrationHistory", () => {
  function seeded() {
    const sqlite = sqliteDb();
    const ins = sqlite.prepare(
      `INSERT INTO ${CHAIN_CONCENTRATION_DAILY_TABLE}
         (day, neuron_count, card, source_captured_at, computed_at,
          builder_version)
       VALUES (?,?,?,?,?,?)`,
    );
    const card = JSON.stringify({
      schema_version: 1,
      uids_per_entity: 1.2,
      stake: { holders: 10, gini: 0.6 },
      emission: { holders: 10, gini: 0.5 },
      entity_stake: null,
      entity_emission: null,
      validator_stake: { holders: 3, gini: 0.2 },
    });
    ins.run("2026-08-05", 30000, card, T, T, 1);
    ins.run("2026-08-04", 30000, card, T, T, 1);
    ins.run("2026-06-01", 29000, card, T, T, 1);
    return sqlite;
  }

  it("returns the window's days, oldest first", async () => {
    const rows = await loadChainConcentrationHistory(asDb(seeded()), {
      window: "7d",
      nowMs: T,
    });
    expect(rows?.map((r) => r.day)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("reaches further back on a wider window", async () => {
    const rows = await loadChainConcentrationHistory(asDb(seeded()), {
      window: "90d",
      nowMs: T,
    });
    expect(rows).toHaveLength(3);
  });

  it("returns null for a window the vocabulary does not define", async () => {
    expect(
      await loadChainConcentrationHistory(asDb(seeded()), {
        window: "180d",
        nowMs: T,
      }),
    ).toBeNull();
  });

  it("defaults to the 30d window", async () => {
    const rows = await loadChainConcentrationHistory(asDb(seeded()), {
      nowMs: T,
    });
    expect(rows).toHaveLength(2);
  });

  it("returns null without a database and when the read throws", async () => {
    expect(await loadChainConcentrationHistory(null)).toBeNull();
    expect(await loadChainConcentrationHistory(undefined)).toBeNull();
    expect(await loadChainConcentrationHistory({} as never)).toBeNull();
    const throwing = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error("D1_ERROR");
          },
        }),
      }),
    };
    expect(await loadChainConcentrationHistory(throwing)).toBeNull();
  });

  it("returns an empty list when all() is absent or answers nothing", async () => {
    const noAll = { prepare: () => ({ bind: () => ({}) }) };
    expect(await loadChainConcentrationHistory(noAll as never)).toEqual([]);
    const empty = {
      prepare: () => ({ bind: () => ({ all: async () => null }) }),
    };
    expect(await loadChainConcentrationHistory(empty)).toEqual([]);
  });
});

describe("buildChainConcentrationHistory", () => {
  const card = JSON.stringify({
    schema_version: 1,
    subnet_count: 129,
    entity_count: 24000,
    uids_per_entity: 1.25,
    stake: { holders: 10, gini: 0.6 },
    emission: { holders: 10, gini: 0.5 },
    entity_stake: { holders: 8, gini: 0.55 },
    entity_emission: null,
    validator_stake: { holders: 3, gini: 0.2 },
  });
  const row = (day: string, version = 1) => ({
    day,
    neuron_count: 30104,
    card,
    source_captured_at: T,
    builder_version: version,
  });

  it("shapes the series with the five lenses and the day's shape", () => {
    const out = buildChainConcentrationHistory([row("2026-08-05")], {
      window: "30d",
    });
    expect(out).toMatchObject({
      schema_version: 1,
      window: "30d",
      point_count: 1,
      oldest_day: "2026-08-05",
      newest_day: "2026-08-05",
      builder_versions: [1],
    });
    expect((out.points as Row[])[0]).toEqual({
      day: "2026-08-05",
      neuron_count: 30104,
      subnet_count: 129,
      entity_count: 24000,
      source_captured_at: new Date(T).toISOString(),
      builder_version: 1,
      uids_per_entity: 1.25,
      stake: { holders: 10, gini: 0.6 },
      emission: { holders: 10, gini: 0.5 },
      entity_stake: { holders: 8, gini: 0.55 },
      // NULL means no measurable distribution, NOT missing -- substituting
      // zeros would invent a perfectly equal one.
      entity_emission: null,
      validator_stake: { holders: 3, gini: 0.2 },
    });
  });

  it("REPORTS every builder version, because a mixed series changes definition", () => {
    const out = buildChainConcentrationHistory(
      [row("2026-08-03", 1), row("2026-08-04", 2), row("2026-08-05", 2)],
      {},
    );
    // A trend drawn across this boundary compares two definitions, not two
    // networks -- so the boundary has to be visible.
    expect(out.builder_versions).toEqual([1, 2]);
  });

  it("drops a point with no day or an unparseable card", () => {
    // An empty scorecard would read as a measured absence of concentration,
    // which is the opposite of "we could not read this".
    const out = buildChainConcentrationHistory(
      [
        row("2026-08-05"),
        { ...row("2026-08-04"), day: null },
        { ...row("2026-08-03"), card: "{not json" },
        { ...row("2026-08-02"), card: "" },
        { ...row("2026-08-01"), card: "[1,2,3]" },
        { ...row("2026-07-31"), card: 42 },
      ],
      {},
    );
    expect(out.point_count).toBe(1);
  });

  it("treats an empty window as a MEASUREMENT, not a decline", () => {
    const out = buildChainConcentrationHistory([], { window: "7d" });
    expect(out.degraded).toBeUndefined();
    expect(out.point_count).toBe(0);
    expect(out.oldest_day).toBeNull();
    expect(out.newest_day).toBeNull();
    expect(out.builder_versions).toEqual([]);
  });

  it("accepts a null or non-array row list without inventing an error", () => {
    expect(buildChainConcentrationHistory(null).point_count).toBe(0);
    expect(buildChainConcentrationHistory(undefined).point_count).toBe(0);
    expect(buildChainConcentrationHistory("nope" as never).point_count).toBe(0);
    expect(
      buildChainConcentrationHistory([row("2026-08-05")]).window,
    ).toBeNull();
  });

  it("nulls an unreadable count or timestamp rather than substituting zero", () => {
    const out = buildChainConcentrationHistory(
      [
        {
          ...row("2026-08-05"),
          neuron_count: 1.5,
          builder_version: "one",
          source_captured_at: 0,
        },
      ],
      {},
    );
    expect((out.points as Row[])[0]).toMatchObject({
      neuron_count: null,
      builder_version: null,
      source_captured_at: null,
      // Still readable: these come from the CARD, not the columns, so a bad
      // column cannot take them out.
      subnet_count: 129,
    });
    // A point whose version is unreadable contributes no version to the set.
    expect(out.builder_versions).toEqual([]);
  });

  it("nulls a source timestamp past the Date range", () => {
    const out = buildChainConcentrationHistory(
      [{ ...row("2026-08-05"), source_captured_at: 1e16 }],
      {},
    );
    expect((out.points as Row[])[0].source_captured_at).toBeNull();
  });

  it("nulls uids_per_entity when the stored card omits it entirely", () => {
    // `null` and `undefined` take a different path from an unparseable value,
    // and both must reach the payload as null rather than NaN.
    const out = buildChainConcentrationHistory(
      [
        { ...row("2026-08-05"), card: JSON.stringify({}) },
        {
          ...row("2026-08-04"),
          card: JSON.stringify({ uids_per_entity: null }),
        },
      ],
      {},
    );
    for (const p of out.points as Row[]) {
      expect(p.uids_per_entity).toBeNull();
      // A card with no lenses yields nulls, not empty scorecards.
      expect(p.stake).toBeNull();
    }
  });

  it("nulls uids_per_entity when the stored card's value is unreadable", () => {
    const out = buildChainConcentrationHistory(
      [
        {
          ...row("2026-08-05"),
          card: JSON.stringify({ uids_per_entity: "many" }),
        },
      ],
      {},
    );
    expect((out.points as Row[])[0].uids_per_entity).toBeNull();
  });
});

describe("declineChainConcentrationHistory", () => {
  it("nulls the count rather than asserting the network was never measured", () => {
    const out = declineChainConcentrationHistory("unavailable", {
      window: "30d",
    });
    expect((out.degraded as { reason: string }).reason).toBe("unavailable");
    expect(out.point_count).toBeNull();
    expect(out.oldest_day).toBeNull();
    expect(out.newest_day).toBeNull();
    expect(out.points).toEqual([]);
    expect(out.builder_versions).toEqual([]);
    expect(out.window).toBe("30d");
  });

  it("echoes a null window when it was given none", () => {
    expect(declineChainConcentrationHistory("unavailable").window).toBeNull();
  });
});

type Row = Record<string, unknown>;
