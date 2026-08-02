// MCP tool `get_account_root_claim` (types-epic E batch 6, #8069). Mirrors
// GET /api/v1/accounts/{ss58}/root-claim, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching the hand-written literal it replaces
// field-for-field.
import { z } from "zod";
import { FieldSourcesSchema } from "../shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const GetAccountRootClaimInputSchema = z
  .object({
    ss58: Ss58Schema,
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
    netuid: z.int(),
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
