// The emission pipeline series (#10300).
//
// One property carries the panel: A REPEATED DAY IS NOT A MEASUREMENT. The
// route marks each day with `repeats_previous_observation`, and a flat stretch
// of carried-forward readings looks exactly like a pipeline that held steady.
// Counting them wrong in either direction breaks the warning: over-report and
// readers learn to ignore it, under-report and it never fires.
import { describe, expect, it } from "vitest";
import { countCarriedForward } from "./subnet-emission-pipeline-history";
import type {
  SubnetEmissionPipelineHistory,
  SubnetEmissionPipelinePoint,
} from "@/lib/metagraphed/types";

const point = (
  day: string,
  repeats: boolean | null,
): SubnetEmissionPipelinePoint => ({
  day,
  pipeline_block: 1,
  repeats_previous_observation: repeats,
  captured_at: null,
  emission_share: 0.06,
  alpha_price_tao: 0.08,
  tao_in_pool_tao: 1,
  tao_in_emission_tao: 1,
  miner_burned_fraction: 0,
  emission_enabled: true,
});

const history = (points: SubnetEmissionPipelinePoint[]): SubnetEmissionPipelineHistory => ({
  netuid: 64,
  window: "30d",
  point_count: points.length,
  distinct_observations: null,
  oldest_day: points[0]?.day ?? null,
  newest_day: points[points.length - 1]?.day ?? null,
  first_captured_day: null,
  points,
});

describe("counting carried-forward days", () => {
  it("counts the days that say they repeat", () => {
    const h = history([
      point("2026-08-01", false),
      point("2026-08-02", true),
      point("2026-08-03", true),
    ]);
    expect(countCarriedForward(h)).toBe(2);
  });

  it("a NULL flag is not counted as a repeat", () => {
    // The API declining to say is not the same as saying no. Counting unknowns
    // as repeats would inflate the warning, and a warning that over-reports is
    // one readers learn to ignore — which loses the case it exists for.
    const h = history([point("2026-08-01", null), point("2026-08-02", null)]);
    expect(countCarriedForward(h)).toBe(0);
  });

  it("a fully measured window warns about nothing", () => {
    const h = history([point("2026-08-01", false), point("2026-08-02", false)]);
    expect(countCarriedForward(h)).toBe(0);
  });

  it("an empty series is zero, not a crash", () => {
    expect(countCarriedForward(history([]))).toBe(0);
  });
});
