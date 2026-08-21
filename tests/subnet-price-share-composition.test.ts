import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetPriceShareComposition,
  loadSubnetPriceShareComposition,
  SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP,
} from "../src/subnet-price-share-composition.ts";
import { SubnetPriceShareCompositionArtifactSchema } from "../schemas-src/routes/subnet-price-share-composition.ts";

type Row = Record<string, unknown>;

const WRITER_CAPTURE_A = Date.parse("2026-08-20T12:00:00.000Z");
const WRITER_CAPTURE_B = Date.parse("2026-08-20T13:00:00.000Z");

function snapshot(
  day: string,
  shares: Record<number, number | null>,
  writerCapturedAt = WRITER_CAPTURE_A,
): Row[] {
  return Object.entries(shares).map(([netuid, emission_share]) => ({
    snapshot_date: day,
    netuid: Number(netuid),
    emission_share,
    captured_at: writerCapturedAt,
  }));
}

describe("buildSubnetPriceShareComposition", () => {
  test("keeps a latest-day cohort stable, emits chronological days, and derives a rounded residual", () => {
    const data = buildSubnetPriceShareComposition(
      [
        ...snapshot("2026-08-03", { 0: 0.2, 1: 0.4, 2: 0.3, 3: 0.1 }),
        ...snapshot("2026-08-02", { 0: 0.1, 1: 0.25, 2: 0.4, 3: 0.25 }),
        ...snapshot("2026-08-01", { 0: 0.15, 1: 0.2, 2: 0.35, 3: 0.3 }),
      ],
      { seriesLimit: 2 },
    );

    assert.equal(data.metric, "artifact_normalized_moving_price_share");
    assert.equal(data.observation_basis, "estimated_observed_price_set");
    assert.equal(data.reference_day, "2026-08-03");
    assert.equal(data.reference_writer_captured_at, "2026-08-20T12:00:00.000Z");
    assert.equal(data.point_count, 3);
    assert.deepEqual(
      data.series.map((series) => series.id),
      ["subnet:1", "subnet:2", "other"],
    );
    assert.equal(
      data.series[2]?.label,
      "Other artifact-normalized price share",
    );
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-01", "2026-08-02", "2026-08-03"],
    );
    assert.deepEqual(data.days[0], {
      snapshot_date: "2026-08-01",
      writer_captured_at: "2026-08-20T12:00:00.000Z",
      priced_subnet_count: 4,
      observed_price_share_total: 1,
      values: [
        { series_id: "subnet:1", price_share: 0.2, source: "recorded" },
        { series_id: "subnet:2", price_share: 0.35, source: "recorded" },
        { series_id: "other", price_share: 0.45, source: "derived" },
      ],
    });
    assert.equal(
      SubnetPriceShareCompositionArtifactSchema.safeParse(data).success,
      true,
    );
  });

  test("uses netuid ascending to break equal shares and keeps Root in the stored denominator", () => {
    const data = buildSubnetPriceShareComposition(
      snapshot("2026-08-03", { 0: 0.4, 2: 0.4, 4: 0.2 }),
      { seriesLimit: 2 },
    );
    assert.deepEqual(
      data.series.map((series) => series.id),
      ["subnet:0", "subnet:2", "other"],
    );
  });

  test("omits a date with a mixed writer timestamp instead of combining its rows", () => {
    const mixed = snapshot("2026-08-03", { 1: 0.6, 2: 0.4 });
    mixed[1]!.captured_at = WRITER_CAPTURE_B;
    const data = buildSubnetPriceShareComposition([
      ...mixed,
      ...snapshot("2026-08-02", { 1: 0.55, 2: 0.45 }),
    ]);
    assert.equal(data.reference_day, "2026-08-02");
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-02"],
    );
  });

  test("omits partial normalized sets, absent cohort rows, and malformed price data", () => {
    const malformed = snapshot("2026-08-02", { 1: 0.6, 2: 0.4 });
    malformed[1]!.emission_share = -0.4;
    const missingCapture = snapshot("2026-08-01", { 1: 0.6, 2: 0.4 });
    missingCapture[0]!.captured_at = 0;
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-05", { 1: 0.6, 2: 0.4 }),
      ...snapshot("2026-08-04", { 1: 0.2, 2: 0.2 }),
      ...snapshot("2026-08-03", { 1: 0.6, 2: null, 3: 0.4 }),
      ...malformed,
      ...missingCapture,
    ]);
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-05"],
    );
  });

  test("omits duplicate, invalid-netuid, and invalid-date source rows without fabricating a day", () => {
    const duplicate = snapshot("2026-08-04", { 1: 0.6, 2: 0.4 });
    duplicate.push({
      snapshot_date: "2026-08-04",
      netuid: 1,
      emission_share: 0.6,
      captured_at: WRITER_CAPTURE_A,
    });
    const invalidNetuid = snapshot("2026-08-03", { 1: 0.6, 2: 0.4 });
    invalidNetuid[0]!.netuid = " ";
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-05", { 1: 0.6, 2: 0.4 }),
      ...duplicate,
      ...invalidNetuid,
      {
        snapshot_date: "2026-02-30",
        netuid: 1,
        emission_share: 1,
        captured_at: WRITER_CAPTURE_A,
      },
      {
        snapshot_date: 42,
        netuid: 1,
        emission_share: 1,
        captured_at: WRITER_CAPTURE_A,
      },
    ]);
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-05"],
    );
  });

  test("accepts a source-null non-price row and a six-decimal rounded total", () => {
    const data = buildSubnetPriceShareComposition(
      snapshot("2026-08-03", {
        0: 0.333333,
        1: 0.333333,
        2: 0.333334,
        3: null,
      }),
      { seriesLimit: 3 },
    );
    assert.equal(data.point_count, 1);
    assert.equal(data.days[0]?.priced_subnet_count, 3);
  });

  test("treats a blank-string price as a source absence, not a zero share", () => {
    const rows = snapshot("2026-08-03", { 1: 0.5, 2: 0.5 });
    rows.push({
      snapshot_date: "2026-08-03",
      netuid: 3,
      emission_share: " ",
      captured_at: WRITER_CAPTURE_A,
    });
    const data = buildSubnetPriceShareComposition(rows);
    assert.equal(data.point_count, 1);
    assert.equal(data.days[0]?.priced_subnet_count, 2);
  });

  test("keeps exact six-decimal units when JavaScript cannot sum them exactly", () => {
    // These three integer-millionth shares total exactly 1.000000. Native
    // JavaScript addition instead produces 1.0000000000000002, so this proves
    // the chart's strict domain check is unit-based rather than float-based.
    const exactUnitSet = { 1: 0.588408, 2: 0.32468, 3: 0.086912 };
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-04", exactUnitSet),
      ...snapshot("2026-08-03", exactUnitSet),
    ]);
    assert.equal(data.reference_day, "2026-08-04");
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-03", "2026-08-04"],
    );
    assert.equal(
      data.days[0]?.values.find((value) => value.series_id === "other")
        ?.price_share,
      0,
    );
  });

  test("rejects a source share that is not on the six-decimal artifact grid", () => {
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-04", { 1: 0.5000001, 2: 0.4999999 }),
      ...snapshot("2026-08-03", { 1: 0.5, 2: 0.5 }),
    ]);
    assert.equal(data.reference_day, "2026-08-03");
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-03"],
    );
  });

  test("does not use an overflowing normalized source or cohort as a reference", () => {
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-05", { 1: 0.7, 2: 0.4 }),
      // This total is inside the source's independent six-decimal rounding
      // envelope but still exceeds the chart's strict 100% domain.
      ...snapshot("2026-08-04", { 1: 0.6, 2: 0.400001 }),
      ...snapshot("2026-08-03", { 1: 0.6, 2: 0.4 }),
    ]);
    assert.equal(data.reference_day, "2026-08-03");
    assert.equal(data.point_count, 1);
  });

  test("drops only the raw truncated oldest date rather than another valid date", () => {
    const rows = [
      ...snapshot("2026-08-04", { 1: 0.6, 2: 0.4 }),
      ...snapshot("2026-08-03", { 1: 0.55, 2: 0.45 }),
      ...snapshot("2026-08-02", { 1: 0.5, 2: 0.5 }),
    ];
    const data = buildSubnetPriceShareComposition(rows, {
      truncatedOldestDay: "2026-08-02",
    });
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-03", "2026-08-04"],
    );
  });

  test("returns a schema-stable empty history for all-null, malformed, or non-cohort inputs", () => {
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-03", { 1: null, 2: null }),
      {
        snapshot_date: "2026-08-02",
        netuid: -1,
        emission_share: Number.POSITIVE_INFINITY,
        captured_at: Number.MAX_SAFE_INTEGER,
      },
    ]);
    assert.equal(data.point_count, 0);
    assert.equal(data.reference_day, null);
    assert.deepEqual(data.series, []);
    assert.deepEqual(data.days, []);
  });

  test("returns a schema-stable empty history when no source rows exist", () => {
    const data = buildSubnetPriceShareComposition(null);
    assert.equal(data.point_count, 0);
    assert.equal(data.reference_day, null);
  });

  test("only emits writer timestamps accepted by the public ISO contract", () => {
    const latestIsoTimestamp = Date.parse("9999-12-31T23:59:59.999Z");
    const invalidExtendedYear = latestIsoTimestamp + 1;
    const data = buildSubnetPriceShareComposition([
      ...snapshot("2026-08-04", { 1: 0.6, 2: 0.4 }, latestIsoTimestamp),
      ...snapshot("2026-08-03", { 1: 0.6, 2: 0.4 }, invalidExtendedYear),
    ]);
    assert.equal(data.reference_day, "2026-08-04");
    assert.equal(data.reference_writer_captured_at, "9999-12-31T23:59:59.999Z");
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-04"],
    );
    assert.equal(
      SubnetPriceShareCompositionArtifactSchema.safeParse(data).success,
      true,
    );
    assert.equal(
      SubnetPriceShareCompositionArtifactSchema.safeParse({
        ...data,
        reference_day: "2026-02-30",
      }).success,
      false,
    );
  });
});

describe("loadSubnetPriceShareComposition", () => {
  test("reads one bounded interval of closed UTC days, excludes today, and reads one cap sentinel row", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async <T = Record<string, unknown>>(
        sql: string,
        params: unknown[],
      ): Promise<T[]> => {
        calls.push({ sql, params });
        return snapshot("2026-08-20", { 1: 0.6, 2: 0.4 }) as T[];
      },
    };
    const { data } = await loadSubnetPriceShareComposition({
      db,
      now: Date.parse("2026-08-21T14:00:00.000Z"),
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /snapshot_date < \?/);
    assert.match(calls[0]!.sql, /emission_share, captured_at/);
    assert.doesNotMatch(calls[0]!.sql, /alpha_stake/i);
    assert.deepEqual(calls[0]!.params, [
      "2026-05-23",
      "2026-08-21",
      SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP + 1,
    ]);
    assert.equal(data.reference_day, "2026-08-20");
  });

  test("marks only the sentinel row's valid day truncated", async () => {
    const rows = [
      ...snapshot("2026-08-20", { 1: 0.6, 2: 0.4 }),
      ...snapshot("2026-08-19", { 1: 0.55, 2: 0.45 }),
    ];
    while (rows.length <= SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP) {
      rows.push({
        snapshot_date: "2026-08-19",
        netuid: rows.length + 10,
        emission_share: null,
        captured_at: WRITER_CAPTURE_A,
      });
    }
    const db = {
      query: async <T = Record<string, unknown>>(): Promise<T[]> => rows as T[],
    };
    const { data } = await loadSubnetPriceShareComposition({
      db,
      now: Date.parse("2026-08-21T14:00:00.000Z"),
    });
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-20"],
    );
  });

  test("keeps the terminal date when the bounded read is exactly at its cap", async () => {
    const rows = [
      ...snapshot("2026-08-20", { 1: 0.6, 2: 0.4 }),
      ...snapshot("2026-08-19", { 1: 0.55, 2: 0.45 }),
    ];
    while (rows.length < SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP) {
      rows.push({
        snapshot_date: "2026-08-19",
        netuid: rows.length + 10,
        emission_share: null,
        captured_at: WRITER_CAPTURE_A,
      });
    }
    const db = {
      query: async <T = Record<string, unknown>>(): Promise<T[]> => rows as T[],
    };
    const { data } = await loadSubnetPriceShareComposition({
      db,
      now: Date.parse("2026-08-21T14:00:00.000Z"),
    });
    assert.deepEqual(
      data.days.map((day) => day.snapshot_date),
      ["2026-08-19", "2026-08-20"],
    );
  });

  test("is schema-stable without a read binding", async () => {
    const { data, rows } = await loadSubnetPriceShareComposition({
      now: Date.parse("2026-08-21T00:00:00.000Z"),
    });
    assert.deepEqual(rows, []);
    assert.equal(data.point_count, 0);
  });
});
