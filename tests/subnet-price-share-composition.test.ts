import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  buildSubnetPriceShareComposition as build,
  loadSubnetPriceShareComposition as load,
  PRICE_SHARE_COMPOSITION_SQL,
} from "../src/subnet-price-share-composition.ts";
import {
  PRICE_SHARE_COMPOSITION_DAYS,
  PRICE_SHARE_COMPOSITION_ROWS,
} from "../src/route-limits.ts";
import { SubnetPriceShareCompositionArtifactSchema } from "../schemas-src/routes/subnet-price-share-composition.ts";

const nowMs = Date.UTC(2026, 9, 18, 12);
const options = { nowMs };
type Row = Record<string, unknown>;
const row = (netuid = 0, emission_share: unknown = 1, snapshot_date = "2026-10-17", captured_at: unknown = nowMs - 86_400_000): Row =>
  ({ netuid, emission_share, snapshot_date, captured_at });
const day = (date: string, shares = [0.4, 0.2, 0.1, 0.1, 0.08, 0.07, 0.05]) =>
  shares.map((share, netuid) => row(netuid, share, date));

describe("estimated price-share composition", () => {
  it("uses the current clock by default without synthesizing a current-day point", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      expect(build([row()]).points).toHaveLength(1);
      expect(await load({ async query<T>() { return [] as T[]; } })).toEqual([]);
      expect(await load({ async query<T>() { return [] as T[]; } }, {})).toEqual([]);
      expect(build([row()], {}).points).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
  it("fixes a cohort from the newest date, keeps Root and emits exact residuals in chronological order", () => {
    const result = build([...day("2026-10-17"), ...day("2026-10-15", [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.4])], options);
    expect(result.series.map((series) => series.netuid)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.points.map((point) => point.day)).toEqual(["2026-10-15", "2026-10-17"]);
    expect(result.points[0].shares).toEqual([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
    expect(result.points.map((point) => point.other_share)).toEqual([0.4, 0.05]);
    expect(result.oldest_day).toBe("2026-10-15");
    expect(result.newest_day).toBe("2026-10-17");
    expect(SubnetPriceShareCompositionArtifactSchema.parse(result)).toEqual(result);
  });

  it("breaks share ties by netuid and never reorders the cohort on older dates", () => {
    const latest = [6, 5, 4, 3, 2, 1, 0].map((netuid) => row(netuid, netuid === 6 ? 0.4 : 0.1));
    const result = build(latest, options);
    expect(result.series.map((series) => series.netuid)).toEqual([6, 0, 1, 2, 3, 4]);
    expect(result.points[0].other_share).toBe(0.1);
  });

  it("does not replace missing selected observations with zeroes or unpriced rows", () => {
    const older = day("2026-10-16").filter((entry) => entry.netuid !== 1);
    older.push(row(7, 0.2, "2026-10-16"), row(1, null, "2026-10-16"));
    expect(build([...day("2026-10-17"), ...older], options).points).toHaveLength(1);
    const unpriced = row(42, null);
    unpriced.captured_at = null;
    expect(build([row(), unpriced], options).points[0].shares).toEqual([1]);
  });

  it("accepts legitimate source rounding on either side of one without re-normalizing", () => {
    const shares = [0.142857, 0.142857, 0.142857, 0.142857, 0.142857, 0.142857, 0.142857];
    const result = build(day("2026-10-17", shares), options);
    expect(result.points[0].shares).toEqual(shares.slice(0, 6));
    expect(result.points[0].other_share).toBe(0.142858);
    const high = build(day("2026-10-17", [0.142858, 0.142858, ...shares.slice(2)]), options);
    expect(high.points).toHaveLength(1);
  });

  it("keeps the newest eligible cohort while omitting its over-unit point", () => {
    const latest = [0.333333, 0.333333, 0.333335].map((share, index) => row(index + 8, share));
    const older = [0.3, 0.3, 0.4].map((share, index) => row(index + 8, share, "2026-10-16"));
    const result = build([...latest, ...older], options);
    expect(result.series).toEqual([{ netuid: 10 }, { netuid: 8 }, { netuid: 9 }]);
    expect(result.points.map((point) => point.day)).toEqual(["2026-10-16"]);
    expect(result.points[0].shares).toEqual([0.4, 0.3, 0.3]);
    expect(build(latest, options)).toMatchObject({ point_count: 0, points: [] });
  });

  it("keeps older points whose fixed cohort fits even if a different local top six exceeds one", () => {
    const latest = [1, 2, 3, 4, 5, 6].map((netuid) => row(netuid, netuid === 1 ? 1 : 0));
    const older = [1, 2, 3, 4, 5, 6, 7].map((netuid) => row(netuid,
      netuid === 1 ? 0.5 : netuid === 7 ? 0.500001 : 0, "2026-10-16"));
    const result = build([...latest, ...older], options);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({ shares: [0.5, 0, 0, 0, 0, 0], other_share: 0.5 });
  });

  it("omits an older selected total above one rather than clamping it", () => {
    const latest = day("2026-10-17", [0.4, 0.3, 0.3]);
    const old = day("2026-10-16", [0.4, 0.3, 0.300001]);
    expect(build([...latest, ...old], options).points.map((point) => point.day)).toEqual(["2026-10-17"]);
  });

  it.each([undefined, "0.5", true, {}, NaN, Infinity, -0.1, 1.1, 0.1234567, Number.MIN_VALUE, 1e-20])("omits malformed/off-grid share %s", (value) => {
    expect(build([{ ...row(), emission_share: value }], options).points).toEqual([]);
  });
  it.each([null, undefined, "123", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, nowMs + 1])("omits uncaptured timestamp %s", (value) => {
    expect(build([{ ...row(), captured_at: value }], options).points).toEqual([]);
  });
  it.each([undefined, null, "1", -1, 65536, 0.5, NaN, Infinity])("omits invalid netuid %s", (value) => {
    expect(build([{ ...row(), netuid: value }], options).points).toEqual([]);
  });
  it("omits duplicate netuids, mixed captures, empty numeric sets and partial normalization", () => {
    for (const rows of [
      [row(), row()],
      [row(0, 0.5), row(1, 0.5, "2026-10-17", nowMs - 1)],
      [row(0, null)],
      [row(0, 0.9)],
      [row(0, 0.5), row(1, 0.499998)],
    ]) expect(build(rows, options).points).toEqual([]);
  });

  it.each([undefined, null, "", "2026-02-30", "2026-13-01", "0000-00-00", "2026-10-17T00:00:00Z", "2026-10-18", "2026-10-19", "2026-08-22"])("omits malformed, open, future or out-of-window date %s", (value) => {
    expect(build([{ ...row(), snapshot_date: value }], options).points).toEqual([]);
  });

  it("retains 56 closed UTC dates including the oldest boundary", () => {
    const rows = Array.from({ length: PRICE_SHARE_COMPOSITION_DAYS }, (_, index) =>
      row(0, 1, new Date(Date.UTC(2026, 9, 18) - (index + 1) * 86_400_000).toISOString().slice(0, 10)));
    expect(build(rows, options).points).toHaveLength(56);
    expect(build(rows, options).oldest_day).toBe("2026-08-23");
  });

  it("distinguishes unavailable reads from a successful empty window", () => {
    const unavailable = build(null, options);
    expect(unavailable).toMatchObject({ point_count: null, degraded: { reason: "unavailable" }, points: [], series: [] });
    expect(SubnetPriceShareCompositionArtifactSchema.parse(unavailable)).toEqual(unavailable);
    const empty = build([], options);
    expect(empty).toMatchObject({ point_count: 0, oldest_day: null, newest_day: null, points: [], series: [] });
    expect(empty).not.toHaveProperty("degraded");
  });
});

describe("bounded snapshot query on a disposable SQLite fixture", () => {
  const schema = readFileSync(new URL("../db/d1-schema.sql", import.meta.url), "utf8");
  function fixture() {
    const sqlite = new DatabaseSync(":memory:");
    const table = schema.match(/CREATE TABLE subnet_snapshots\([\s\S]*?\) WITHOUT ROWID;/)?.[0];
    const index = schema.match(/CREATE INDEX idx_subnet_snapshots_date_netuid[^;]+;/)?.[0];
    if (!table || !index) throw new Error("Canonical snapshot table/index missing");
    sqlite.exec(table);
    sqlite.exec(index);
    const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> =>
      sqlite.prepare(sql).all(...values as SQLInputValue[]) as T[];
    return { sqlite, query };
  }

  it("uses the canonical date/netuid range index without a table scan or temp sort", async () => {
    const { sqlite, query } = fixture();
    try {
      const bindings = ["2026-08-23", "2026-10-18", PRICE_SHARE_COMPOSITION_ROWS + 1];
      const plan = sqlite.prepare("EXPLAIN QUERY PLAN " + PRICE_SHARE_COMPOSITION_SQL).all(...bindings);
      const text = plan.map((entry) => entry.detail).join("\n");
      expect(text).toMatch(/SEARCH subnet_snapshots USING INDEX idx_subnet_snapshots_date_netuid/);
      expect(text).not.toMatch(/SCAN subnet_snapshots|TEMP B-TREE/);
      let calls = 0;
      const result = await load({ async query<T>(sql: string, values?: unknown[]) {
        calls += 1;
        expect(sql).toBe(PRICE_SHARE_COMPOSITION_SQL);
        expect(values).toEqual(bindings);
        return query<T>(sql, values);
      } }, options);
      expect(calls).toBe(1);
      expect(result).toEqual([]);
      console.info("#11550 fixture query plan", { bindings, plan });
    } finally { sqlite.close(); }
  });

  it("limits raw rows plus one sentinel and omits a partly read boundary date", async () => {
    const { sqlite, query } = fixture();
    try {
      const insert = sqlite.prepare("INSERT INTO subnet_snapshots(netuid,snapshot_date,captured_at,emission_share) VALUES(?,?,?,?)");
      sqlite.exec("BEGIN");
      for (let netuid = 0; netuid < PRICE_SHARE_COMPOSITION_ROWS + 2; netuid += 1) {
        insert.run(netuid, "2026-10-17", nowMs - 1000, netuid === PRICE_SHARE_COMPOSITION_ROWS + 1 ? 1 : 0);
      }
      sqlite.exec("COMMIT");
      const rows = await load({ query }, options);
      expect(rows).toHaveLength(PRICE_SHARE_COMPOSITION_ROWS + 1);
      expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThan(2 * 1024 * 1024);
      expect(build(rows!, options).points).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("keeps a wholly read boundary day when the sentinel starts an older date", () => {
    const rows = Array.from({ length: PRICE_SHARE_COMPOSITION_ROWS }, (_, netuid) =>
      row(netuid, netuid === 0 ? 1 : 0));
    rows.push(row(0, 1, "2026-10-16"));
    expect(build(rows, options).points.map((point) => point.day)).toEqual(["2026-10-17"]);
    expect(build(rows.slice(0, PRICE_SHARE_COMPOSITION_ROWS), options).points).toHaveLength(1);
  });

  it("queries only closed dates, ordered by date and netuid descending", async () => {
    const { sqlite, query } = fixture();
    try {
      const insert = sqlite.prepare("INSERT INTO subnet_snapshots(netuid,snapshot_date,captured_at,emission_share) VALUES(?,?,?,?)");
      for (const entry of [row(0), row(1), row(2, 1, "2026-10-16"), row(0, 1, "2026-10-18"), row(0, 1, "2026-08-22")]) {
        insert.run(entry.netuid as number, entry.snapshot_date as string, entry.captured_at as number, entry.emission_share as number);
      }
      expect((await load({ query }, options))?.map((entry) => [entry.snapshot_date, entry.netuid])).toEqual([
        ["2026-10-17", 1], ["2026-10-17", 0], ["2026-10-16", 2],
      ]);
    } finally { sqlite.close(); }
  });

  it("declines absent bindings, absent query capability and transport failures", async () => {
    expect(await load(undefined, options)).toBeNull();
    expect(await load(null, options)).toBeNull();
    expect(await load({}, options)).toBeNull();
    expect(await load({ async query() { throw new Error("fixture transport failure"); } }, options)).toBeNull();
  });
});
