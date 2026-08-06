// MCP tool `get_account_root_claim` (types-epic E batch 6, #8069). Mirrors
// GET /api/v1/accounts/{ss58}/root-claim, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import { netuidSchema, ss58Schema } from "./shared.ts";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetAccountRootClaimInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountRootClaimInput = z.infer<
  typeof GetAccountRootClaimInputSchema
>;

const RootClaimTypeSchema = z
  .object({
    kind: z.string(),
    subnets: z.array(z.int()).optional(),
  })
  .strict();

const RootClaimEntrySchema = z
  .object({
    netuid: netuidSchema(),
    claimable_rate: z.number(),
    claimed: z.string(),
    threshold: z.number(),
  })
  .strict();

const RootClaimHotkeySchema = z
  .object({
    hotkey: z.string(),
    entries: z.array(RootClaimEntrySchema),
  })
  .strict();

export const GetAccountRootClaimOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    claim_type: RootClaimTypeSchema.nullable().optional(),
    hotkeys: z.array(RootClaimHotkeySchema).nullable().optional(),
    queried_at: z.string().nullable(),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetAccountRootClaimOutput = z.infer<
  typeof GetAccountRootClaimOutputSchema
>;
