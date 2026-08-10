// /metagraph/operational-surfaces.json -> OperationalSurfacesArtifact (#9830).
//
// The input list for the 15-minute Cloudflare cron health prober
// (src/health-prober.ts) -- git-tier, committed, and read by the Worker at
// runtime through the ASSETS binding. No REST route serves it, so it lives
// under artifacts/ (see the sibling surface-aliases.ts header).
//
// Modeled from scripts/build-artifacts.ts's operationalSurfaces map (the sole
// producer) and cross-checked field by field against the committed artifact's
// 619 rows.
//
// TWO PUBLISHED FIELDS WERE UNDECLARED by the hand-written component this
// replaces: `surface_key` (present on all 619 rows) and `schema_source`
// (an object on 227, null on the rest). Both survived only because the item
// carried `additionalProperties: true`, so a consumer reading the contract
// was told neither existed. `schema_source` is the field
// call_subnet_surface resolves a surface's captured schema through
// (metagraphed#7674), so leaving it undeclared hid the one field an agent
// needs to call the surface at all.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";

// The probe contract the prober executes. `expect` and `method` are declared
// as plain strings rather than enums on purpose: they come from each
// surface's own registry record, so a new probe method is a registry edit,
// not a contract change. The four values observed today are JSON-RPC /
// WSS-RPC / GET / HEAD and json / any / sse / html.
const OperationalProbeSchema = z
  .object({
    method: z.string(),
    expect: z.string(),
    timeout_ms: z
      .int()
      .nullable()
      .describe(
        "null when the surface declares no timeout, so the prober applies its own default -- not zero (12 of 619 rows today).",
      ),
  })
  .passthrough();

// The captured-schema pointer, shared with the agent-catalog build via
// serviceSchemaSource(resolveAgentServiceSchema(surface)) rather than
// recomputed, so both consumers agree on which schema a surface owns.
const OperationalSchemaSourceSchema = z
  .object({
    artifact: z
      .string()
      .describe("Artifact path of the captured schema, under /metagraph/."),
    hash: z.string(),
    match: z
      .enum(["same-origin-openapi", "schema-url"])
      .describe(
        "How the schema was attributed to this surface: `schema-url` is the surface's own declared schema, `same-origin-openapi` is a same-netuid same-origin OpenAPI projection.",
      ),
    observed_at: z.string(),
    status: z.string(),
    surface_id: z.string(),
    url: z.string(),
  })
  .passthrough();

// The declaration the revenue lane reads (#10566), projected verbatim from the
// subnet manifest's own `revenue` block. Passthrough rather than a restatement
// of every field: schemas/subnet-manifest.schema.json OWNS this shape, and a
// second strict copy here would be one more thing to drift.
const OperationalRevenueSchema = z
  .object({
    role: z.string(),
    provenance: z.string(),
    currency: z.string().optional(),
    grain: z.string().optional(),
    shape: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
    excludes: z.array(z.string()).optional(),
    supersedes: z.array(z.string()).optional(),
  })
  .passthrough();

const OperationalSurfaceSchema = z
  .object({
    surface_id: z.string(),
    surface_key: z
      .string()
      .describe(
        "The stable identity (`srf-<hash of netuid|kind|url>`) the prober re-keys health history onto, so a display-name or slug rename no longer orphans a surface's probe history (#1005). The hand-authored `surface_id` stays for back-compat and display.",
      ),
    netuid: z.int().min(0),
    subnet_slug: z.string(),
    subnet_name: z.string(),
    kind: z.string(),
    provider: z.string(),
    authority: z.string(),
    url: z.string(),
    auth_required: z.boolean(),
    public_safe: z.boolean(),
    probe: OperationalProbeSchema,
    schema_source: OperationalSchemaSourceSchema.nullable().describe(
      "The captured schema this surface owns, or null when none was captured (direct surface-id match, exact schema_url match, or same-netuid same-origin OpenAPI projection for a subnet-api surface).",
    ),
    revenue: OperationalRevenueSchema.nullable().describe(
      "What this surface measures about money, or null when it declares nothing (#10566). Carried here because this artifact is already the list of probe-enabled, public-safe surfaces a lane may fetch — the revenue probe needs exactly that set plus the declaration, and enumerating 129 per-subnet artifacts on every tick to rebuild it would be the same list at 129x the cost.",
    ),
  })
  .passthrough();

export const OperationalSurfacesArtifactSchema = ArtifactBaseSchema.extend({
  surface_count: z.int().min(0),
  kinds: z
    .array(z.string())
    .describe(
      "The operational surface kinds this list is filtered to (OPERATIONAL_SURFACE_KINDS), sorted.",
    ),
  surfaces: z.array(OperationalSurfaceSchema),
});
export type OperationalSurfacesArtifact = z.infer<
  typeof OperationalSurfacesArtifactSchema
>;
