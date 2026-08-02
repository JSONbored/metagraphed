// MCP tool `get_subnet_movers` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/subnets/movers, which is not one of schemas-src/routes/'s covered
// pilot routes -- no existing Zod schema to reuse. Modeled fresh, shallow,
// from the hand-written literal it replaces. Window/sort enums hardcoded
// from src/movers.ts's MOVERS_WINDOWS/MOVERS_SORTS at the time of writing
// (mirrors the pilot batch's ECONOMICS_SORT_FIELDS precedent -- not
// cross-imported, to avoid a runtime dependency for what is purely a wire-
// schema enum).
import { z } from "zod";

const MOVERS_WINDOW_KEYS = ["7d", "30d", "90d"] as const;
const MOVERS_SORTS = ["stake", "emission", "validators", "neurons"] as const;
const MOVERS_LIMIT_MAX = 100;

export const GetSubnetMoversInputSchema = z
  .object({
    window: z.enum(MOVERS_WINDOW_KEYS).optional(),
    sort: z.enum(MOVERS_SORTS).optional(),
    limit: z.int().min(1).max(MOVERS_LIMIT_MAX).optional(),
  })
  .strict();
export type GetSubnetMoversInput = z.infer<typeof GetSubnetMoversInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const GetSubnetMoverItemSchema = z
  .object({
    netuid: z.int().optional(),
    stake_start_alpha: z.unknown().optional(),
    stake_end_alpha: z.unknown().optional(),
    stake_delta_alpha: z.unknown().optional(),
    stake_pct_change: z.number().nullable().optional(),
    emission_start_alpha: z.unknown().optional(),
    emission_end_alpha: z.unknown().optional(),
    emission_delta_alpha: z.unknown().optional(),
    emission_pct_change: z.number().nullable().optional(),
    validators_start: z.int().optional(),
    validators_end: z.int().optional(),
    validators_delta: z.int().optional(),
    neurons_start: z.int().optional(),
    neurons_end: z.int().optional(),
    neurons_delta: z.int().optional(),
  })
  .passthrough();

export const GetSubnetMoversOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    sort: z.string().nullable(),
    subnet_count: z.int(),
    movers: z.array(GetSubnetMoverItemSchema),
  })
  .passthrough();
export type GetSubnetMoversOutput = z.infer<typeof GetSubnetMoversOutputSchema>;
