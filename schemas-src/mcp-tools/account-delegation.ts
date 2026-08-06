// MCP tools `get_account_children`, `get_account_parents` (types-epic E
// batch 6, #8069). Each mirrors a GET /api/v1/accounts/{ss58}/{children,
// parents} route that is not one of schemas-src/routes/'s covered pilot
// routes -- no existing Zod schema to reuse. Modeled fresh, matching each
// hand-written literal field-for-field, including its own item-level
// looseness (neither the hand-written subnets items nor their nested
// entries items declare a `required` array).
import { z } from "zod";
import { netuidSchema, ss58Schema } from "./shared.ts";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetAccountChildrenInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountChildrenInput = z.infer<
  typeof GetAccountChildrenInputSchema
>;

const ChildEntrySchema = z
  .object({
    child: z.string().nullable().optional(),
    proportion: z.string().optional(),
    proportion_fraction: z.number().optional(),
  })
  .strict();

const ChildSubnetSchema = z
  .object({
    netuid: netuidSchema().optional(),
    entries: z.array(ChildEntrySchema).optional(),
  })
  .strict();

export const GetAccountChildrenOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    account: z.string(),
    subnets: z.array(ChildSubnetSchema).nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetAccountChildrenOutput = z.infer<
  typeof GetAccountChildrenOutputSchema
>;

export const GetAccountParentsInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountParentsInput = z.infer<
  typeof GetAccountParentsInputSchema
>;

const ParentEntrySchema = z
  .object({
    parent: z.string().nullable().optional(),
    proportion: z.string().optional(),
    proportion_fraction: z.number().optional(),
  })
  .strict();

const ParentSubnetSchema = z
  .object({
    netuid: netuidSchema().optional(),
    entries: z.array(ParentEntrySchema).optional(),
  })
  .strict();

export const GetAccountParentsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    account: z.string(),
    subnets: z.array(ParentSubnetSchema).nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetAccountParentsOutput = z.infer<
  typeof GetAccountParentsOutputSchema
>;
