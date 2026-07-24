// MCP tool `get_network_health` (types-epic E pilot batch, #7863). The
// handler calls the SAME loadGlobalOperationalHealth() the REST `health`
// route uses (workers/api.ts's handleApiRequest, matched.id === "health"),
// so the underlying DATA is identical -- but the hand-written wire schema
// this replaces (GET_NETWORK_HEALTH_OUTPUT_SCHEMA, src/global-operational-health.ts)
// deliberately left `global`/`subnets` shallow (bare `{type:"object"}` /
// `{type:"array", items:{type:"object"}}`, no property-level constraints),
// unlike the REST route's own deep, `.strict()` HealthSummaryArtifactSchema
// (schemas-src/routes/health.ts). Keeping that same looseness here --
// NOT reusing HealthSummaryArtifactSchema wholesale -- per #7863's wire-
// compatibility constraint: publishing a stricter MCP contract than the one
// that already shipped would reject payloads existing clients' own
// validators (calibrated to the loose original) currently accept, which the
// issue calls out as a regression, not an improvement. Only the fields that
// were ALREADY typed at this same shallow grain are modeled; nothing here
// changes what a conforming client accepts.
import { z } from "zod";

export const GetNetworkHealthInputSchema = z.object({}).strict();
export type GetNetworkHealthInput = z.infer<typeof GetNetworkHealthInputSchema>;

const OpenObjectSchema = z.object({}).passthrough();

export const GetNetworkHealthOutputSchema = z
  .object({
    schema_version: z.int(),
    // A flat 3-member union (int | string | null), not
    // z.union([...]).nullable() -- the latter nests (anyOf-of-anyOf) where
    // the original is a single flat `type:["integer","string","null"]`.
    contract_version: z.union([z.int(), z.string(), z.null()]).optional(),
    generated_at: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
    scope: z.string(),
    operational_observed_at: z.string().nullable().optional(),
    global: OpenObjectSchema,
    subnets: z.array(OpenObjectSchema),
  })
  .passthrough();
export type GetNetworkHealthOutput = z.infer<
  typeof GetNetworkHealthOutputSchema
>;
