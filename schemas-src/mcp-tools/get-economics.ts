// MCP tool `get_economics` (types-epic E pilot batch, #7863). The handler
// (src/network-economics.ts's loadNetworkEconomics) calls resolveLiveEconomics
// -- the SAME live/R2-fallback tier the REST `economics` route uses -- so the
// underlying per-subnet row data is identical to schemas-src/routes/economics.ts's
// SubnetEconomicsSchema. The hand-written wire schema this replaces
// (GET_ECONOMICS_OUTPUT_SCHEMA, src/network-economics.ts) deliberately left
// `summary`/`subnets` shallow (bare `{type:["object","null"]}` /
// `{type:"array", items:{type:"object"}}`), unlike the REST route's deep,
// `.strict()` EconomicsArtifactSchema. Kept exactly that looseness here for
// the same reason get-network-health.ts does -- #7863's wire-compatibility
// constraint means NOT tightening beyond what already shipped, even though
// the real per-row data happens to satisfy the deeper REST schema too.
import { z } from "zod";

const ECONOMICS_SORT_FIELDS = [
  "alpha_fdv_tao",
  "alpha_market_cap_tao",
  "alpha_price_change_1d",
  "alpha_price_change_1h",
  "alpha_price_change_1m",
  "alpha_price_change_7d",
  "alpha_price_tao",
  "block",
  "emission_share",
  "max_stake_tao",
  "max_uids",
  "max_validators",
  "miner_count",
  "miner_readiness",
  "name",
  "netuid",
  "open_slots",
  "registration_cost_tao",
  "subnet_volume_tao",
  "total_stake_tao",
  "validator_count",
] as const;

export const GetEconomicsInputSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    registration_allowed: z.enum(["true", "false"]).optional(),
    q: z.string().optional(),
    sort: z.enum(ECONOMICS_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type GetEconomicsInput = z.infer<typeof GetEconomicsInputSchema>;

const OpenObjectSchema = z.object({}).passthrough();

export const GetEconomicsOutputSchema = z
  .object({
    source: z.string().nullable(),
    captured_at: z.string().nullable().optional(),
    network: z.string().nullable().optional(),
    summary: OpenObjectSchema.nullable().optional(),
    subnets: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type GetEconomicsOutput = z.infer<typeof GetEconomicsOutputSchema>;
