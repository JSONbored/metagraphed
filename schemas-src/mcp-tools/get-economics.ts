// MCP tool `get_economics` (types-epic E pilot batch, #7863). The handler
// (src/network-economics.ts's loadNetworkEconomics) calls resolveLiveEconomics
// -- the SAME live/R2-fallback tier the REST `economics` route uses -- so the
// underlying per-subnet row data is identical to
// schemas-src/routes/economics.ts's
// SubnetEconomicsSchema. The hand-written wire schema this replaces
// (GET_ECONOMICS_OUTPUT_SCHEMA, src/network-economics.ts) deliberately left
// `summary`/`subnets` shallow (bare `{type:["object","null"]}` /
// `{type:"array", items:{type:"object"}}`), unlike the REST route's deep,
// `.strict()` EconomicsArtifactSchema. Kept exactly that looseness here for
// the same reason get-network-health.ts does -- #7863's wire-compatibility
// constraint means NOT tightening beyond what already shipped, even though
// the real per-row data happens to satisfy the deeper REST schema too.
import { z } from "zod";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  fieldsSchema,
  limitSchema,
  offsetSchema,
  orderSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";
import { EconomicsSummarySchema } from "../routes/economics.ts";
import { SubnetEconomicsSchema } from "../shared.ts";

export const GetEconomicsInputSchema = z
  .object({
    netuid: API_QUERY_COLLECTIONS.economics.filter_schemas.netuid.optional(),
    registration_allowed:
      API_QUERY_COLLECTIONS.economics.filter_schemas.registration_allowed
        .optional()
        .describe("Restrict to subnets currently accepting registrations.")
        .meta({ examples: ["true"] }),
    q: querySchema().optional(),
    sort: sortSchema(API_QUERY_COLLECTIONS.economics.sort_fields).optional(),
    order: orderSchema().optional(),
    // `sort` and `order` were enums while this was a bare string with no stated
    // format anywhere — comma-separated? a JSON array? — so the one parameter an agent
    // could not guess was the only one left undocumented.
    fields: fieldsSchema().optional(),
    limit: limitSchema(1000, 20).optional(),
    cursor: offsetSchema().optional(),
  })
  .strict();
export type GetEconomicsInput = z.infer<typeof GetEconomicsInputSchema>;

export const GetEconomicsOutputSchema = z
  .object({
    source: z.string().nullable(),
    captured_at: z.string().nullable().optional(),
    network: z.string().nullable().optional(),
    // Typed from the route's own schemas (#9797). Verified against production
    // 2026-08-07, including the rao-precision decimal STRINGS on the summary
    // totals -- nine decimal places, exactly, and a caller reading them as
    // floats loses rao.
    summary: EconomicsSummarySchema.nullable().optional(),
    // PARTIAL: this tool advertises `fields`, so a caller can project a row
    // down to one column and a strict row schema would break the tool's own
    // contract the moment they do (#9884).
    subnets: z.array(SubnetEconomicsSchema.partial()),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .strict();
export type GetEconomicsOutput = z.infer<typeof GetEconomicsOutputSchema>;
