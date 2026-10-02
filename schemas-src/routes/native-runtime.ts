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
// One named recursive value contract keeps OpenAPI references anchored to a
// real component instead of Zod's anonymous __shared definitions container.
export const NativeJsonValueSchema = z.json();
export const NativeEvmResultSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("decoded"),
        values: z.array(NativeJsonValueSchema),
      })
      .strict(),
    z
      .object({
        status: z.enum([
          "reverted",
          "dispatch_error",
          "execution_error",
          "invalid_output",
          "unrecognized_result",
        ]),
      })
      .strict(),
  ])
  .describe(
    "Release-bound Solidity return interpretation for an evm_call simulation. Values are in the declared output order, tuples use their unique named fields or positional arrays, and wide integers are exact decimal strings. The native value retains all original return bytes, gas, logs, reverts and dispatch errors. Failed executions and malformed return bytes are never interpreted as successful values.",
  );
const args = z.array(NativeJsonValueSchema).max(64).default([]);
const evmAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
export const NativeEvmCallSchema = z
  .object({
    signature: z.string().min(3).max(1024),
    args,
  })
  .strict()
  .describe(
    "Solidity signature and ordered arguments from this finalized runtime's precompile catalogue. Available on EthereumRuntimeRPCApi.call and EVM.call preparation. Keep the declared data/input argument as 0x; the existing to/target selects the precompile. Wide integers are exact decimal strings. Successful simulations include source-ABI-decoded evm_result values alongside the complete native result. Encoding and return decoding add no chain request and retain the ordinary gas, value and wallet-review rules.",
  );
export const NativeCodeArtifactSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .describe(
        "Public raw.githubusercontent.com URL pinned to a full 40-character commit, with no credentials, query or fragment.",
      ),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("SHA-256 of the exact uncompressed artifact bytes."),
    bytes: z
      .int()
      .min(1)
      .max(131072)
      .describe(
        "Exact artifact byte length, also bounded by this source runtime's Contracts.MaxCodeLen.",
      ),
  })
  .strict()
  .describe(
    "Checksum-bound public Wasm code for ContractsApi upload_code/instantiate or Contracts upload_code/instantiate_with_code preparation. Keep the code argument as 0x (or Code::Upload with fields 0x); the server verifies and fills only that declared byte vector. One distinct artifact is fetched per request, with no persistent storage.",
  );
export const NativeRuntimeOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("runtime_scale"),
      api: name,
      member: name,
      input: z
        .string()
        .regex(/^0x(?:[0-9a-f]{2})*$/)
        .max(32768)
        .meta({ examples: ["0x"] })
        .describe(
          "Exact SCALE arguments encoded for the source runtime API version. Only audited read methods are admitted; result bytes retain their source API id and version. Use typed runtime operations when metadata publishes the signature.",
        ),
    })
    .strict(),
  z.object({ kind: z.literal("storage"), ...common, args }).strict(),
  z
    .object({
      kind: z.literal("entries"),
      ...common,
      args,
      limit: z.int().min(1).max(32).default(16),
      cursor: z
        .string()
        .regex(/^0x(?:[0-9a-f]{2})+$/)
        .max(8194)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("constant"), ...common }).strict(),
  z
    .object({
      kind: z.literal("runtime"),
      api: name,
      member: name,
      args,
      code_artifact: NativeCodeArtifactSchema.optional(),
      evm_call: NativeEvmCallSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prepare"),
      ...common,
      args,
      code_artifact: NativeCodeArtifactSchema.optional(),
      evm_call: NativeEvmCallSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("describe"),
      pallet: name.optional(),
      api: name.optional(),
      type_id: typeId.optional(),
      evm: z
        .union([z.literal(true), evmAddress])
        .optional()
        .describe(
          "true lists this source's precompile addresses; an address lists its Solidity signatures, argument names/types and output layouts. Shares the normal offset/limit pagination and finalized source.",
        ),
      offset: z.int().min(0).max(16384).default(0),
      limit: z.int().min(1).max(64).default(32),
    })
    .strict(),
]);
export const NativeRuntimeRequestSchema = z
  .object({
    network: McpNetworkSchema.optional(),
    as_of: hash
      .meta({ examples: [`0x${"33".repeat(32)}`] })
      .optional()
      .describe(
        "Canonical finalized block hash to read; omitted selects the current finalized head. Reuse the response's source hash for a consistent multi-request view.",
      ),
    operations: z
      .array(NativeRuntimeOperationSchema)
      .min(1)
      .max(16)
      .meta({
        examples: [
          [{ kind: "describe", pallet: "SubtensorModule", limit: 16 }],
        ],
      })
      .describe(
        "One to sixteen native operations sharing the same finalized context. Describe discovers runtime names, portable argument types and paged release-bound EVM precompile signatures; storage, constant and runtime read typed values; runtime_scale accepts caller-encoded SCALE for audited read methods and returns exact bytes with the source API id/version, including V14 APIs without typed signatures; entries pages map records using up to 32 keys per operation and 64 keys per request; prepare produces unsigned call method bytes. Entries args select leading keys. Continue with next_cursor and the response source as_of hash.",
      ),
  })
  .strict()
  .describe(
    "Use runtime metadata to read exact native storage, constants and runtime APIs or prepare an unsigned native call. Ethereum call/create and ContractsApi call/instantiate/upload_code simulate at the same finalized source. EVM requests have an aggregate 1,000,000 gas cap. Contracts require an explicit Some gas_limit Weight; distinct simulations share a 250,000,000,000 ref_time and 65,536 proof_size budget, with one inline code upload of at most 16,384 bytes. A commit-pinned code_artifact reference supports up to 131,072 bytes within the source runtime MaxCodeLen; the reference must include its exact SHA-256 and byte count, and the code argument must be empty hex. Integers are exact decimal strings; byte vectors and AccountId32 are hex. Enum input is {variant,fields}; named fields are objects and unnamed multi-fields are arrays. No signature, submission or persistent state mutation occurs.",
  );
export const NativeRuntimeSourceSchema = z
  .object({
    network: BittensorNetworkSchema,
    network_genesis_hash: hash,
    finalized_block_hash: hash,
    finalized_block: z.string().regex(/^(0|[1-9]\d*)$/),
    runtime_spec_version: z.int().nonnegative(),
    runtime_transaction_version: z.int().nonnegative(),
    runtime_code_hash: hash.nullable(),
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
              "entries",
              "constant",
              "runtime",
              "runtime_scale",
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
            value: NativeJsonValueSchema.optional(),
            evm_result: NativeEvmResultSchema.optional(),
            call_data: z
              .string()
              .regex(/^0x(?:[0-9a-f]{2})+$/)
              .optional(),
            contract: NativeJsonValueSchema,
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
