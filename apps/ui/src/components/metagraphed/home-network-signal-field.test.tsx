import { describe, expect, it } from "vitest";
import {
  buildCompositionTimelineModel,
  compositionAxisLabel,
  compositionSeriesLabel,
} from "./home-network-signal-field";
import type { SubnetPriceShareCompositionArtifact } from "@/lib/metagraphed/types";

type Artifact = SubnetPriceShareCompositionArtifact;

/**
 * Shaped from the committed contract example for
 * GET /api/v1/chain/subnet-price-share-composition.
 */
function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    days: [
      {
        observed_price_share_total: 1,
        priced_subnet_count: 2,
        snapshot_date: "2026-06-01",
        values: [
          { price_share: 0.6, series_id: "subnet:1", source: "recorded" },
          { price_share: 0.4, series_id: "subnet:2", source: "recorded" },
          { price_share: 0, series_id: "other", source: "derived" },
        ],
        writer_captured_at: "2026-06-01T00:00:00.000Z",
      },
    ],
    metric: "artifact_normalized_moving_price_share",
    newest_day: "2026-06-01",
    observation_basis: "estimated_observed_price_set",
    oldest_day: "2026-06-01",
    point_count: 1,
    reference_day: "2026-06-01",
    reference_writer_captured_at: "2026-06-01T00:00:00.000Z",
    schema_version: 1,
    series: [
      {
        id: "subnet:1",
        kind: "subnet",
        label: null,
        netuid: 1,
        reference_price_share: 0.6,
      },
      {
        id: "subnet:2",
        kind: "subnet",
        label: null,
        netuid: 2,
        reference_price_share: 0.4,
      },
      {
        id: "other",
        kind: "other",
        label: "Other artifact-normalized price share",
        netuid: null,
        reference_price_share: 0,
      },
    ],
    series_limit: 6,
    target_day_count: 56,
    ...overrides,
  } as Artifact;
}

describe("buildCompositionTimelineModel", () => {
  it("spreads cohort tones across the ramp instead of walking it in order", () => {
    const { series } = buildCompositionTimelineModel(artifact());
    // chart-1 then chart-5, not chart-1 then chart-2: consecutive ramp entries
    // are near-neighbours in hue and blend where their segments touch.
    expect(series.map((entry) => entry.tone)).toEqual(["chart-1", "chart-5", undefined]);
  });

  it("gives the derived residual no categorical tone at all", () => {
    // The residual is whatever is left of the normalised unit, not a cohort
    // member, so it must never consume a ramp slot — doing so both implied a
    // category and shifted the real cohort's colours as the cohort resized.
    const small = buildCompositionTimelineModel(
      artifact({
        series: [
          {
            id: "subnet:9",
            kind: "subnet",
            label: null,
            netuid: 9,
            reference_price_share: 1,
          },
          {
            id: "other",
            kind: "other",
            label: "Other",
            netuid: null,
            reference_price_share: 0,
          },
        ],
      } as Partial<Artifact>),
    );
    expect(small.series.at(-1)).toMatchObject({ id: "other", residual: true });
    expect(small.series.at(-1)).not.toHaveProperty("tone");
    expect(small.series[0]).toMatchObject({ tone: "chart-1" });
  });

  it("carries each recorded share through without re-deriving it", () => {
    const { columns } = buildCompositionTimelineModel(artifact());
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({
      id: "2026-06-01",
      axisLabel: "06/01",
      caption: "2 priced subnets",
      shares: { "subnet:1": 0.6, "subnet:2": 0.4, other: 0 },
    });
  });

  it("returns an empty model for a cold or absent artifact", () => {
    expect(buildCompositionTimelineModel(null)).toEqual({
      series: [],
      columns: [],
    });
    expect(buildCompositionTimelineModel(undefined)).toEqual({
      series: [],
      columns: [],
    });
  });
});

describe("compositionSeriesLabel", () => {
  it("falls back to the netuid when the artifact carries no name", () => {
    expect(
      compositionSeriesLabel({
        id: "subnet:42",
        kind: "subnet",
        label: null,
        netuid: 42,
        reference_price_share: 0.1,
      }),
    ).toBe("SN42");
  });

  it("prefers a real published name", () => {
    expect(
      compositionSeriesLabel({
        id: "subnet:42",
        kind: "subnet",
        label: "  Targon  ",
        netuid: 42,
        reference_price_share: 0.1,
      }),
    ).toBe("Targon");
  });

  it("names the residual plainly rather than repeating its long artifact label", () => {
    expect(
      compositionSeriesLabel({
        id: "other",
        kind: "other",
        label: "Other artifact-normalized price share",
        netuid: null,
        reference_price_share: 0,
      }),
    ).toBe("Other");
  });
});

describe("compositionAxisLabel", () => {
  it("keeps the axis tick to month/day", () => {
    expect(compositionAxisLabel("2026-06-01")).toBe("06/01");
  });
});
