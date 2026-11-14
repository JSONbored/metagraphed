import { z } from "zod";
import { V2_REGISTRY_OPERATION_SCHEMAS } from "./registry.ts";
import { V2AccountStakeInputSchema, V2AccountStakeSchema } from "./stake.ts";
export * from "./stake.ts";
import {
  V2AccountBalanceInputSchema,
  V2AccountBalanceSchema,
} from "./balance.ts";
export * from "./balance.ts";
import {
  V2InvocationInputSchema,
  V2InvocationIntentSchema,
  V2InvocationResultSchema,
} from "./invocation.ts";

import {
  V2NetworkIdSchema,
  V2HeightSchema,
  V2HashSchema,
  V2DigestSchema,
  V2TimestampSchema as TimestampSchema,
  V2EnvelopeSchema,
  V2EcosystemEnvelopeSchema,
  V2EcosystemNetuidSchema,
  isV2SubnetAtEcosystem,
  V2FreshnessSchema,
  V2CoverageSchema,
  V2SubnetSchema,
  V2SnapshotSchema,
} from "./primitives.ts";
export * from "./primitives.ts";

export const V2HeadSchema = V2EnvelopeSchema.extend({
  coverage: V2CoverageSchema,
  observed_finalized: z
    .object({
      block_number: V2HeightSchema,
      block_hash: V2HashSchema,
      observed_at: TimestampSchema,
    })
    .strict()
    .nullable(),
}).strict();

type ExactJson =
  string | number | boolean | null | ExactJson[] | { [key: string]: ExactJson };

/** Bound decoded data before entering the recursive schema parser. */
export function isBoundedV2DecodedValue(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 16384 || current.depth > 32) return false;
    if (typeof current.value === "string") {
      bytes += encoder.encode(current.value).byteLength;
    } else if (Array.isArray(current.value)) {
      if (pending.length + nodes + current.value.length > 16384) return false;
      for (const child of current.value)
        pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (pending.length + nodes + entries.length > 16384) return false;
      for (const [key, child] of entries) {
        bytes += encoder.encode(key).byteLength;
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (
      current.value !== null &&
      typeof current.value !== "boolean" &&
      !(
        typeof current.value === "number" && Number.isSafeInteger(current.value)
      )
    ) {
      return false;
    }
    if (bytes > 262144) return false;
  }
  return true;
}

const ExactJsonSchema: z.ZodType<ExactJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    z.boolean(),
    z.null(),
    z.array(ExactJsonSchema),
    z.record(z.string(), ExactJsonSchema),
  ]),
);

export const V2EventSchema = z
  .object({
    event_index: z.int().min(0).max(65535),
    pallet: z.string().min(1).max(128),
    variant: z.string().min(1).max(128),
    fields: ExactJsonSchema,
    phase: z.enum(["Initialization", "ApplyExtrinsic", "Finalization"]),
    extrinsic_index: z.int().min(0).max(65535).nullable(),
    topics: z.array(V2HashSchema).max(256),
    participants: z
      .array(
        z
          .object({
            participant_index: z.int().min(0).max(255),
            account_id: V2HashSchema,
            role: z
              .string()
              .regex(/^[a-z][a-z0-9_]{0,62}$/)
              .describe(
                "Metadata-derived positional label or long-path hash token; not an economic or authorization role",
              ),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .refine(
    (event) =>
      (event.phase === "ApplyExtrinsic") === (event.extrinsic_index !== null),
  );

export const V2ExtrinsicSchema = z
  .object({
    extrinsic_index: z.int().min(0).max(65535),
    extrinsic_hash: V2HashSchema,
    pallet: z.string().min(1).max(128),
    call: z.string().min(1).max(128),
    fields: ExactJsonSchema,
    is_signed: z.boolean(),
    signer: ExactJsonSchema.nullable(),
  })
  .strict()
  .refine((value) => value.is_signed === (value.signer !== null));

export const V2BlockSummarySchema = z
  .object({
    snapshot: V2SnapshotSchema,
    source_capture_digest: V2DigestSchema,
    event_count: z.int().min(0).max(65536),
    extrinsic_count: z.int().min(0).max(65536),
  })
  .strict();

export const V2BlockListSchema = V2EnvelopeSchema.extend({
  coverage: V2CoverageSchema,
  blocks: z.array(V2BlockSummarySchema).max(100),
  next_before: V2HeightSchema.nullable().describe(
    "Continue with before and this response's anchor snapshot and coverage.from_block",
  ),
}).strict();

export const V2BlockSchema = V2EnvelopeSchema.extend({
  source_capture_digest: V2DigestSchema,
  event_count: z.int().min(0).max(65536),
  extrinsic_count: z.int().min(0).max(65536),
  events: z.array(V2EventSchema).max(200),
  extrinsics: z.array(V2ExtrinsicSchema).max(100),
  next_extrinsic_index: z.int().min(0).max(65535).nullable(),
  next_event_index: z
    .int()
    .min(0)
    .max(65535)
    .nullable()
    .describe(
      "Pass this cursor as after_event_index to retrieve the next page",
    ),
}).strict();

export const V2AccountEventCursorSchema = z
  .object({
    version: z.literal(1),
    network: V2NetworkIdSchema,
    genesis_hash: V2HashSchema,
    account_id: V2HashSchema,
    from_block: V2HeightSchema,
    anchor_height: V2HeightSchema,
    anchor_hash: V2HashSchema,
    anchor_publication_id: V2DigestSchema,
    revision_generation: V2HeightSchema.refine((value) => value !== "0"),
    revision_publication_id: V2DigestSchema,
    before_block: V2HeightSchema,
    before_event_index: z.int().min(0).max(65535),
  })
  .strict()
  .refine((value) => {
    if (
      ![value.from_block, value.anchor_height, value.before_block].every(
        (height) => V2HeightSchema.safeParse(height).success,
      )
    )
      return false;
    return (
      BigInt(value.from_block) <= BigInt(value.before_block) &&
      BigInt(value.before_block) <= BigInt(value.anchor_height)
    );
  }, "Account event cursor interval is invalid");

export const V2AccountEventsSchema = V2EnvelopeSchema.extend({
  account_id: V2HashSchema,
  coverage: V2CoverageSchema,
  revision: z
    .object({
      generation: V2HeightSchema.refine((value) => value !== "0"),
      publication_id: V2DigestSchema,
    })
    .strict(),
  events: z
    .array(
      V2BlockSummarySchema.extend({
        event: V2EventSchema,
        matching_participants: z
          .array(V2EventSchema.shape.participants.element)
          .min(1)
          .max(256),
      }).strict(),
    )
    .max(100),
  next_cursor: z
    .string()
    .min(1)
    .max(2048)
    .nullable()
    .describe(
      "Continue this account and pinned publication interval; restart if historical replay changes its revision",
    ),
}).strict();

export const V2SubnetListSchema = V2EcosystemEnvelopeSchema.safeExtend({
  coverage: z
    .object({
      registry_complete: z.literal(true),
      reportable_subnets: z.int().min(1).max(4096),
      operational_subnets: z.int().min(1).max(4096),
    })
    .strict(),
  subnets: z.array(V2SubnetSchema).max(200),
  next_after: V2EcosystemNetuidSchema.nullable().describe(
    "Continue with after and this response's ecosystem.publication_id; null ends this publication",
  ),
})
  .strict()
  .refine(
    (value) =>
      value.coverage.operational_subnets ===
        value.ecosystem.operational_netuids.length &&
      value.coverage.operational_subnets <= value.coverage.reportable_subnets &&
      value.subnets.length <= value.coverage.reportable_subnets &&
      value.subnets.every((subnet) => isV2SubnetAtEcosystem(subnet, value)),
    "Invalid ecosystem page coverage",
  );

export const V2SubnetResultSchema = V2EcosystemEnvelopeSchema.safeExtend({
  subnet: V2SubnetSchema,
})
  .strict()
  .refine(
    (value) => isV2SubnetAtEcosystem(value.subnet, value),
    "Subnet does not belong to selected ecosystem",
  );

export const V2ErrorSchema = z
  .object({
    api_version: z.literal("2"),
    error: z
      .object({
        code: z.enum([
          "invalid_input",
          "not_found",
          "method_not_allowed",
          "data_unavailable",
          "authorization_required",
          "internal_error",
        ]),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

const NetworkInputSchema = z.object({ network: V2NetworkIdSchema }).strict();

const AccountEventsInputSchema = NetworkInputSchema.extend({
  account_id: V2HashSchema,
  from_block: V2HeightSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.int().min(1).max(100).default(25),
})
  .strict()
  .refine(
    (input) => input.cursor === undefined || input.from_block === undefined,
    "A continuation cursor already selects its interval",
  );

const anchorFields = [
  "anchor_height",
  "anchor_hash",
  "anchor_publication_id",
  "from_block",
] as const;
const BlockListInputSchema = NetworkInputSchema.extend({
  anchor_height: V2HeightSchema.optional(),
  anchor_hash: V2HashSchema.optional(),
  anchor_publication_id: V2DigestSchema.optional(),
  from_block: V2HeightSchema.optional(),
  before: V2HeightSchema.optional(),
  limit: z.int().min(1).max(100).default(25),
})
  .strict()
  .refine((input) => {
    const pinned = anchorFields.some((key) => input[key] !== undefined);
    if (pinned || input.before !== undefined) {
      if (anchorFields.some((key) => input[key] === undefined)) return false;
      if (BigInt(input.from_block!) > BigInt(input.anchor_height!))
        return false;
      if (
        input.before !== undefined &&
        (BigInt(input.before) <= BigInt(input.from_block!) ||
          BigInt(input.before) > BigInt(input.anchor_height!))
      )
        return false;
    }
    return true;
  }, "Block continuation requires a complete, ordered anchor")
  .meta({
    dependentRequired: Object.fromEntries(
      [...anchorFields, "before"].map((key) => [
        key,
        anchorFields.filter((field) => field !== key),
      ]),
    ),
  });

const BlockInputSchema = NetworkInputSchema.extend({
  height: V2HeightSchema,
  block_hash: V2HashSchema.optional(),
  publication_id: V2DigestSchema.optional(),
  after_event_index: z.int().min(0).max(65535).optional(),
  after_extrinsic_index: z.int().min(0).max(65535).optional(),
  limit: z.int().min(1).max(200).default(100),
  extrinsic_limit: z.int().min(1).max(100).default(25),
})
  .strict()
  .refine((input) => {
    if (
      (input.block_hash === undefined) !==
      (input.publication_id === undefined)
    )
      return false;
    return (
      (input.after_event_index === undefined &&
        input.after_extrinsic_index === undefined) ||
      input.publication_id !== undefined
    );
  }, "Block continuation requires its exact hash and publication")
  .meta({
    dependentRequired: {
      block_hash: ["publication_id"],
      publication_id: ["block_hash"],
      after_event_index: ["block_hash", "publication_id"],
      after_extrinsic_index: ["block_hash", "publication_id"],
    },
  });

const DirectoryInputSchema = NetworkInputSchema.extend({
  publication_id: V2DigestSchema.optional().describe(
    "Select this exact complete publication; omit only when starting from the latest publication",
  ),
  after: V2EcosystemNetuidSchema.optional(),
  limit: z.int().min(1).max(200).default(100),
})
  .strict()
  .refine(
    (value) => value.after === undefined || value.publication_id !== undefined,
    "A continuation cursor requires its publication_id",
  )
  // Keep an object input for GraphQL while declaring the same dependency to
  // JSON Schema consumers. Refinements alone are not emitted by toJSONSchema.
  .meta({ dependentRequired: { after: ["publication_id"] } });

export const V2_OPERATION_SCHEMAS = {
  ...V2_REGISTRY_OPERATION_SCHEMAS,
  prepare_service_invocation: {
    input: V2InvocationInputSchema,
    output: V2InvocationIntentSchema,
  },
  approve_service_invocation: {
    input: z
      .object({
        invocation: V2InvocationInputSchema,
        expires_at: z.iso.datetime({ offset: true }),
      })
      .strict(),
    output: z
      .object({
        approval_id: z.uuid(),
        expires_at: z.iso.datetime({ offset: true }),
      })
      .strict(),
  },
  invoke_service: {
    input: V2InvocationInputSchema,
    output: V2InvocationResultSchema,
  },
  get_chain_head: {
    input: NetworkInputSchema,
    output: V2HeadSchema,
  },
  list_blocks: { input: BlockListInputSchema, output: V2BlockListSchema },
  get_block: {
    input: BlockInputSchema,
    output: V2BlockSchema,
  },
  list_account_events: {
    input: AccountEventsInputSchema,
    output: V2AccountEventsSchema,
  },
  list_account_stake: {
    input: V2AccountStakeInputSchema,
    output: V2AccountStakeSchema,
  },
  get_account_balance: {
    input: V2AccountBalanceInputSchema,
    output: V2AccountBalanceSchema,
  },
  list_subnets: {
    input: DirectoryInputSchema,
    output: V2SubnetListSchema,
  },
  get_subnet: {
    input: NetworkInputSchema.extend({
      netuid: V2EcosystemNetuidSchema,
      publication_id: V2DigestSchema.optional(),
    }).strict(),
    output: V2SubnetResultSchema,
  },
} as const;

export type V2OperationName = keyof typeof V2_OPERATION_SCHEMAS;
export type V2Freshness = z.infer<typeof V2FreshnessSchema>;
