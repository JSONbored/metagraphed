// GET /api/v1/health (types-epic A pilot route #3 of 5, #7859) — the
// live-tier envelope variant: never a static artifact (workers/api.ts's
// handleApiRequest special-cases matched.id === "health" to read live-only
// from KV/Postgres via loadGlobalOperationalHealth, degrading to an explicit
// "unknown" global when the live store is cold — there is no stored summary
// fallback). Data shape derived from public/metagraph/openapi.json's
// HealthSummaryArtifact/HealthSubnetSummary components (built from
// src/contracts.ts), cross-checked against real handler output including the
// cold-store degraded case — see tests/zod-schemas.test.ts.
import { z } from "zod";
import { HealthStatusSchema } from "../shared.ts";

export const HealthSubnetSummarySchema = z
  .object({
    avg_latency_ms: z.int().min(0).nullable().optional(),
    degraded_count: z.int().min(0),
    failed_count: z.int().min(0),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    latency_sample_count: z.int().min(0).optional(),
    name: z.string().optional(),
    netuid: z.int().min(0).optional(),
    ok_count: z.int().min(0),
    slug: z.string().optional(),
    status: HealthStatusSchema,
    surface_count: z.int().min(0),
    unknown_count: z.int().min(0),
  })
  .strict();
export type HealthSubnetSummary = z.infer<typeof HealthSubnetSummarySchema>;

export const HealthSummaryArtifactSchema = z
  .object({
    contract_version: z.string().optional(),
    generated_at: z.string().nullable().optional(),
    // Open counters keyed by status (ok/degraded/failed/unknown) plus
    // surface_count -- src/contracts.ts documents this as an open shape
    // (additionalProperties: true), matching the incident by_kind pattern
    // the issue calls out.
    // #9800. Was `z.record(z.string(), z.unknown())` -- a record whose value
    // schema is `unknown`, which declares no more than a bare open object. This
    // is the network-wide health rollup; `status_counts` is a typed record
    // because its keys ARE the verdict vocabulary.
    global: z
      .object({
        surface_count: z.int().min(0).optional(),
        status_counts: z.record(z.string(), z.int().min(0)).optional(),
      })
      .strict(),
    health_source: z.string().optional(),
    operational_observed_at: z.string().nullable().optional(),
    schema_version: z.int(),
    scope: z.string().optional(),
    source: z.string().optional(),
    subnets: z.array(HealthSubnetSummarySchema),
  })
  // Live-computed, not a static artifact -- ArtifactBaseSchema (which
  // requires generated_at as a plain string) doesn't apply; this shape
  // allows generated_at: null for the cold-store case.
  .strict();
export type HealthSummaryArtifact = z.infer<typeof HealthSummaryArtifactSchema>;
