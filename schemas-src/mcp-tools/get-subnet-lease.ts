// MCP tools `get_subnet_lease`, `get_subnet_lease_history` (types-epic E
// batch 4, #8067). Mirror GET /api/v1/subnets/{netuid}/lease(/history),
// neither of which is one of schemas-src/routes/'s covered pilot routes --
// no existing Zod schema to reuse. Modeled fresh, shallow, from the
// hand-written literals they replace.
import { z } from "zod";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetSubnetLeaseInputSchema = z
  .object({
    netuid: z.int().min(0),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSubnetLeaseInput = z.infer<typeof GetSubnetLeaseInputSchema>;

const LeaseDetailSchema = z
  .object({
    lease_id: z.int().optional(),
    beneficiary: z.string().optional(),
    coldkey: z.string().optional(),
    hotkey: z.string().optional(),
    emissions_share_percent: z.int().optional(),
    end_block: z.int().nullable().optional(),
    netuid: z.int().optional(),
    cost_tao: z.number().optional(),
    accumulated_dividends_alpha: z.number().nullable().optional(),
  })
  .passthrough();

export const GetSubnetLeaseOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    leased: z.boolean().nullable(),
    lease: LeaseDetailSchema.nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetSubnetLeaseOutput = z.infer<typeof GetSubnetLeaseOutputSchema>;

export const GetSubnetLeaseHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetLeaseHistoryInput = z.infer<
  typeof GetSubnetLeaseHistoryInputSchema
>;

const LeaseEventSchema = z
  .object({
    event_kind: z.string().optional(),
    beneficiary: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetSubnetLeaseHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    count: z.int(),
    lease_events: z.array(LeaseEventSchema),
  })
  .passthrough();
export type GetSubnetLeaseHistoryOutput = z.infer<
  typeof GetSubnetLeaseHistoryOutputSchema
>;
