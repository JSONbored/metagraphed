import { z } from "zod";
import { LEGACY_EMISSION_SHARE_DESCRIPTION } from "../legacy-emission-share.ts";
import { UnavailableDegradedSchema } from "./event-stream-honesty.ts";
import {
  PRICE_SHARE_COMPOSITION_DAYS,
  PRICE_SHARE_COMPOSITION_SERIES,
  PRICE_SHARE_COMPOSITION_ROWS,
} from "../../src/route-limits.ts";

export const SubnetPriceShareCompositionSeriesSchema = z.object({
  netuid: z.int().min(0).max(65535).describe("A netuid, not a project identity across netuid reuse."),
}).strict();

export const SubnetPriceShareCompositionPointSchema = z.object({
  day: z.iso.date(),
  captured_at: z.iso.datetime().describe("Persisted writer timestamp shared by the day's numeric shares; not an immutable source-pass ID or proof of complete chain coverage."),
  shares: z.array(z.number().min(0).max(1)).max(PRICE_SHARE_COMPOSITION_SERIES)
    .describe("Recorded six-decimal shares in the fixed series order. " + LEGACY_EMISSION_SHARE_DESCRIPTION),
  other_share: z.number().min(0).max(1).describe("Exact six-decimal residual of one after selected shares; not a stored bucket, sum of unselected rows, or network total."),
}).strict();

export const SubnetPriceShareCompositionArtifactSchema = z.object({
  schema_version: z.literal(1),
  quality: z.literal("estimated_observed_price_set"),
  window_days: z.literal(PRICE_SHARE_COMPOSITION_DAYS),
  cohort_limit: z.literal(PRICE_SHARE_COMPOSITION_SERIES),
  row_limit: z.literal(PRICE_SHARE_COMPOSITION_ROWS),
  other_label: z.literal("Other artifact-normalized price share"),
  series: z.array(SubnetPriceShareCompositionSeriesSchema).max(PRICE_SHARE_COMPOSITION_SERIES),
  point_count: z.int().min(0).max(PRICE_SHARE_COMPOSITION_DAYS).nullable(),
  oldest_day: z.iso.date().nullable(),
  newest_day: z.iso.date().nullable(),
  points: z.array(SubnetPriceShareCompositionPointSchema).max(PRICE_SHARE_COMPOSITION_DAYS),
  degraded: UnavailableDegradedSchema.optional(),
}).strict();

export type SubnetPriceShareCompositionArtifact = z.infer<typeof SubnetPriceShareCompositionArtifactSchema>;
