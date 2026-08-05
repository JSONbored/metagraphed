// GET /api/v1/freshness, /api/v1/source-health, /api/v1/source-snapshots,
// /api/v1/search, /api/v1/search-index (types-epic B batch 10, #8064).
// Modeled from schemas/components/08-evidence-search-sources.schema.json's
// FreshnessArtifact/SourceHealthArtifact/SourceSnapshotsArtifact/
// SearchArtifact/SearchIndexArtifact and their nested sub-shapes (each
// referenced only by its one artifact here -- verified via repo-wide $ref
// grep -- so modeled locally, not registered).
//
// CountMap/ProviderKind (SourceHealthProvider's own fields) ARE referenced by
// several OTHER still-hand-edited components outside this batch (verified via
// repo-wide $ref grep) -- their hand-edited definitions stay untouched.
// CountMap gets a local unregistered Zod equivalent here; ProviderKind is
// imported from ./providers-rpc.ts (this same batch's Provider.kind field)
// rather than duplicated, since both live in this one PR.
//
// Bucket (b) finding: `/freshness`'s live overlay (src/health-serving.ts's
// mergeFreshness()) injects `summary.operational_probe_as_of`, a field the
// hand-edited FreshnessArtifact.summary (additionalProperties: false) never
// declared -- the served response has always included it; the hand-edited
// schema was stale. Modeled here as present.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import { HealthStatusSchema } from "../shared.ts";
import { AuthoritySchema } from "./subnet-detail.ts";
import { ProviderKindSchema } from "./providers-rpc.ts";

const CountMapSchema = z.record(z.string(), z.int().min(0));

const FreshnessSourceSchema = z
  .object({
    as_of: z.string().nullable(),
    id: z.string(),
    lane: z.enum([
      "adapter-snapshot",
      "candidate-discovery",
      "candidate-verification",
      "health-probe",
      "native-data",
      "schema-snapshot",
      // Serve-time lanes: both move on their own schedule rather than the
      // publish's, so they exist only in the live overlay, never in the built artifact.
      "economics",
      "live-rpc",
    ]),
    notes: z.string().optional(),
    path: z.string(),
    required_for_publish: z.boolean(),
    // Not an integer since the live-RPC lane's window is minutes, not hours.
    stale_after_hours: z.number().min(0),
    stale_behavior: z.enum(["block", "warn"]),
    status: z.enum(["captured", "current", "degraded", "missing", "stale"]),
    timestamp: z.string().nullable(),
    timestamp_field: z.string().nullable(),
  })
  .strict();

export const FreshnessArtifactSchema = ArtifactBaseSchema.extend({
  sources: z.array(FreshnessSourceSchema),
  summary: z
    .object({
      adapter_count: z.int().min(0),
      adapter_snapshot_as_of: z.string().nullable(),
      blocking_source_count: z.int().min(0),
      candidate_discovery_as_of: z.string().nullable(),
      health_surface_count: z.int().min(0),
      health_probe_as_of: z.string().nullable(),
      missing_blocking_source_count: z.int().min(0),
      native_snapshot_captured_at: z.string(),
      native_data_as_of: z.string(),
      openapi_surface_count: z.int().min(0),
      // Live-injected by mergeFreshness(), not in the hand-edited schema --
      // see header.
      operational_probe_as_of: z.string().nullable().optional(),
      // Also live-injected: the two lanes that move independently of the
      // publish. Optional for the same reason the line above is — the built artifact
      // carries neither, so only the served response has them.
      economics_as_of: z.string().nullable().optional(),
      live_rpc_as_of: z.string().nullable().optional(),
      publish_ready_without_age_check: z.boolean(),
      schema_snapshot_as_of: z.string().nullable(),
      stale_window_warnings: z.array(z.string()),
      verification_as_of: z.string().nullable(),
      verification_generated_at: z.string().nullable(),
      warning_source_count: z.int().min(0),
    })
    .strict(),
});
export type FreshnessArtifact = z.infer<typeof FreshnessArtifactSchema>;

const SourceHealthProviderSchema = z
  .object({
    authority: AuthoritySchema,
    candidate_count: z.int().min(0),
    classifications: CountMapSchema,
    endpoint_count: z.int().min(0),
    id: z.string(),
    kind: ProviderKindSchema,
    name: z.string(),
    rpc_endpoint_count: z.int().min(0),
    status: HealthStatusSchema,
    verification_result_count: z.int().min(0),
  })
  .strict();

export const SourceHealthArtifactSchema = ArtifactBaseSchema.extend({
  providers: z.array(SourceHealthProviderSchema),
  source: z.literal("generated-provider-and-verification-summary"),
  summary: z
    .object({
      candidate_count: z.int().min(0),
      endpoint_count: z.int().min(0),
      provider_count: z.int().min(0),
      rpc_endpoint_count: z.int().min(0),
      status_counts: CountMapSchema,
      verification_result_count: z.int().min(0),
    })
    .strict(),
});
export type SourceHealthArtifact = z.infer<typeof SourceHealthArtifactSchema>;

const SourceSnapshotSchema = z
  .object({
    captured_at: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    id: z.string(),
    kind: z.enum([
      "adapter-snapshot",
      "candidate-discovery",
      "native-chain",
      "probe-results",
      "registry-manifest",
      "review-ledger",
    ]),
    path: z.string(),
    record_count: z.int().min(0),
  })
  .strict();

export const SourceSnapshotsArtifactSchema = ArtifactBaseSchema.extend({
  sources: z.array(SourceSnapshotSchema),
  summary: z
    .object({
      adapter_snapshot_count: z.int().min(0),
      candidate_count: z.int().min(0),
      overlay_count: z.int().min(0),
      provider_count: z.int().min(0),
      source_count: z.int().min(0),
      verification_result_count: z.int().min(0),
    })
    .strict(),
});
export type SourceSnapshotsArtifact = z.infer<
  typeof SourceSnapshotsArtifactSchema
>;

const SearchDocumentSchema = z
  .object({
    id: z.string(),
    type: z.enum(["subnet", "surface", "provider"]),
    netuid: z.int().min(0).optional(),
    slug: z.string().optional(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.string().optional(),
    artifact_path: z.string(),
    tokens: z.array(z.string()),
    categories: z.array(z.string()).optional(),
    service_kinds: z.array(z.string()).optional(),
  })
  .strict();

export const SearchArtifactSchema = ArtifactBaseSchema.extend({
  document_count: z.int().min(0).optional(),
  documents: z.array(SearchDocumentSchema),
});
export type SearchArtifact = z.infer<typeof SearchArtifactSchema>;

// Deliberately not identical to SearchDocument -- no `tokens` field (a slim
// index projection, not the full searchable-token document).
const SearchIndexDocumentSchema = z
  .object({
    id: z.string(),
    type: z.enum(["subnet", "surface", "provider"]),
    netuid: z.int().min(0).optional(),
    slug: z.string().optional(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.string().optional(),
    artifact_path: z.string(),
    categories: z.array(z.string()).optional(),
    service_kinds: z.array(z.string()).optional(),
  })
  .strict();

export const SearchIndexArtifactSchema = ArtifactBaseSchema.extend({
  document_count: z.int().min(0).optional(),
  documents: z.array(SearchIndexDocumentSchema),
});
export type SearchIndexArtifact = z.infer<typeof SearchIndexArtifactSchema>;
