import { z } from "zod";
import { McpNetworkSchema, BittensorNetworkSchema } from "../shared.ts";

const name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const typeId = z.int().min(0).max(16383);
export const NativeFieldSchema = z
  .object({ name: z.string().nullable(), type: typeId })
  .strict();
export const NativeVariantSchema = z
  .object({
    name: z.string(),
    index: z.int().min(0).max(255),
    fields: z.array(NativeFieldSchema),
  })
  .strict();
export const NativeDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("composite"),
      fields: z.array(NativeFieldSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("variant"),
      variants: z.array(NativeVariantSchema),
    })
    .strict(),
  z.object({ kind: z.literal("sequence"), type: typeId }).strict(),
  z
    .object({
      kind: z.literal("array"),
      type: typeId,
      length: z.int().min(0).max(4294967295),
    })
    .strict(),
  z.object({ kind: z.literal("tuple"), types: z.array(typeId) }).strict(),
  z
    .object({ kind: z.literal("primitive"), primitive: z.int().min(0).max(14) })
    .strict(),
  z.object({ kind: z.literal("compact"), type: typeId }).strict(),
  z.object({ kind: z.literal("bits"), store: typeId, order: typeId }).strict(),
]);
export const NativePortableTypeSchema = z
  .object({
    id: typeId,
    path: z.array(z.string()),
    definition: NativeDefinitionSchema,
  })
  .strict();
const common = { pallet: name, member: name };
const args = z.array(z.json()).max(64).default([]);
export const NativeRuntimeOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("storage"), ...common, args }).strict(),
  z.object({ kind: z.literal("constant"), ...common }).strict(),
  z
    .object({ kind: z.literal("runtime"), api: name, member: name, args })
    .strict(),
  z.object({ kind: z.literal("prepare"), ...common, args }).strict(),
  z
    .object({
      kind: z.literal("describe"),
      pallet: name.optional(),
      api: name.optional(),
      type_id: typeId.optional(),
      offset: z.int().min(0).max(16384).default(0),
      limit: z.int().min(1).max(64).default(32),
    })
    .strict(),
]);
export const NativeRuntimeRequestSchema = z
  .object({
    network: McpNetworkSchema.optional(),
    as_of: hash.meta({examples:[`0x${"33".repeat(32)}`]}).optional(),
    operations: z.array(NativeRuntimeOperationSchema).min(1).max(16).meta({examples:[[{kind:"describe",pallet:"SubtensorModule",limit:16}]]}),
  })
  .strict()
  .describe(
    "Use runtime metadata to read exact native storage, constants and runtime APIs or prepare an unsigned native call. All operations share one finalized source. Integers are exact decimal strings; byte vectors and AccountId32 are hex. Enum input is {variant,fields}; named fields are objects and unnamed multi-fields are arrays. No signature, submission or state mutation occurs.",
  );
export const NativeRuntimeSourceSchema = z
  .object({
    network: BittensorNetworkSchema,
    network_genesis_hash: hash,
    finalized_block_hash: hash,
    finalized_block: z.string().regex(/^(0|[1-9]\d*)$/),
    runtime_spec_version: z.int().nonnegative(),
    runtime_transaction_version: z.int().nonnegative(),
    metadata_version: z.literal([14, 15]),
    metadata_sha256: hash,
  })
  .strict();
export const NativeRuntimeArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    source: NativeRuntimeSourceSchema,
    types: z.array(NativePortableTypeSchema).max(16384),
    results: z
      .array(
        z
          .object({
            kind: z.enum([
              "storage",
              "constant",
              "runtime",
              "prepare",
              "describe",
            ]),
            pallet: name.optional(),
            api: name.optional(),
            member: name.optional(),
            storage_key: z
              .string()
              .regex(/^0x(?:[0-9a-f]{2})*$/)
              .optional(),
            is_default: z.boolean().optional(),
            value: z.json().optional(),
            call_data: z
              .string()
              .regex(/^0x(?:[0-9a-f]{2})+$/)
              .optional(),
            contract: z.json(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .describe(
    "Native results decoded and encoded against this finalized block's portable metadata, including newly introduced fields and operations. contract carries the relevant runtime type identities. Raw fixed-point values retain their bits. Prepared call_data is the method bytes only, not a signed extrinsic or an execution receipt. This read does not establish retained history coverage.",
  );
