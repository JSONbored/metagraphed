// MCP tools `list_extrinsics`, `get_extrinsic` (types-epic E batch 8,
// #8071). Each mirrors a GET /api/v1/extrinsics* route that is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, matching each hand-written literal field-for-field.
import { z } from "zod";
import {
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
} from "./shared.ts";

/**
 * Page-size ceiling for the extrinsics feeds and the two fixed-call_module feeds
 * modelled on them (get_sudo, get_governance_config_changes). Exported so those two
 * read it rather than restating it — they previously declared no maximum at all.
 */
export const EXTRINSICS_LIMIT_MAX = 100;
import {
  AccountEventItemSchema,
  ExtrinsicItemSchema,
  OpenObjectSchema,
} from "./shared.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListExtrinsicsInputSchema = z
  .object({
    block: z
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this exact block height."),
    signer: Ss58Schema.optional().describe(
      "Restrict to extrinsics signed by this SS58 account. Unsigned (inherent) extrinsics never match.",
    ),
    call_module: z
      .string()
      .optional()
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      ),
    call_function: z
      .string()
      .optional()
      .describe(
        "Restrict to one call within the pallet (`add_stake`). Case-sensitive; pair with `call_module` to disambiguate.",
      ),
    call_hash: z
      .string()
      .optional()
      .describe("Restrict to the extrinsic with this 0x-prefixed hash."),
    success: z
      .boolean()
      .optional()
      .describe(
        "Restrict to successful (`true`) or failed (`false`) extrinsics. Omit for both.",
      ),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive start of the range. A block height on chain tools, an ISO-8601 date on time-series ones.",
      ),
    to: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive end of the range. A block height on chain tools, an ISO-8601 date on time-series ones; an EVM address on decode_evm_call.",
      ),
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type ListExtrinsicsInput = z.infer<typeof ListExtrinsicsInputSchema>;

export const ListExtrinsicsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type ListExtrinsicsOutput = z.infer<typeof ListExtrinsicsOutputSchema>;

export const GetExtrinsicInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      ),
  })
  .strict();
export type GetExtrinsicInput = z.infer<typeof GetExtrinsicInputSchema>;

export const GetExtrinsicOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    extrinsic: OpenObjectSchema.nullable().optional(),
    events: z.array(AccountEventItemSchema).optional(),
  })
  .passthrough();
export type GetExtrinsicOutput = z.infer<typeof GetExtrinsicOutputSchema>;
