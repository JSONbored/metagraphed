// GET /api/v1/chain/governance/emission-changes (#9615): the emission-gate
// change log. Modeled from src/emission-gate-changes.ts's buildEmissionChanges().
//
// One feed, three shapes. A `param` entry has no netuid and a `subnet` entry has
// no numeric value, so each kind carries only its own fields and the rest are
// ABSENT rather than null -- an absent field says "this kind has no such thing",
// where a null would say "it has one and we do not know it".
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { EMISSION_CHANGES_LIMIT_MAX } from "../../src/route-limits.ts";

/** Shared by every kind. `predates_capture` is the honesty flag: true means the
 * row is the FIRST OBSERVATION of a value, not a change to it. */
const base = {
  kind: z.enum(["param", "subnet", "flow"]),
  observed_at: z.iso.datetime(),
  block_number: z.int().nullable(),
  predates_capture: z.boolean(),
};

export const EmissionParamChangeSchema = z
  .object({
    ...base,
    param: z.string().nullable(),
    value: z.number().nullable(),
    /** Null when predates_capture is true -- there was no prior reading. */
    previous_value: z.number().nullable(),
    /** `governance` set it; `runtime_recomputed` derived it. Two different
     * events the value alone cannot distinguish. */
    source: z.enum(["governance", "runtime_recomputed"]).nullable(),
  })
  .strict();

export const EmissionSubnetChangeSchema = z
  .object({
    ...base,
    netuid: z.int().nullable(),
    enabled: z.boolean().nullable(),
    previous_enabled: z.boolean().nullable(),
  })
  .strict();

export const EmissionFlowChangeSchema = z
  .object({
    ...base,
    item: z.string().nullable(),
    /** Nullable by design: some flow items are subnet-scoped, others are
     * network-wide, and the table's CHECK enforces that shape. */
    netuid: z.int().nullable(),
    is_set: z.boolean().nullable(),
  })
  .strict();

export const EmissionGateChangesArtifactSchema = z
  .object({
    schema_version: z.int(),
    kind: z.string().nullable(),
    limit: z.int().min(1).nullable(),
    change_count: z.int().min(0),
    /** Entries that are a first observation rather than a change. A reader
     * counting governance events must subtract these. */
    predates_capture_count: z.int().min(0),
    latest_change_at: z.iso.datetime().nullable(),
    changes: z.array(
      z.union([
        EmissionParamChangeSchema,
        EmissionSubnetChangeSchema,
        EmissionFlowChangeSchema,
      ]),
    ),
  })
  .passthrough();
export type EmissionGateChangesArtifact = z.infer<
  typeof EmissionGateChangesArtifactSchema
>;
export const EmissionGateChangesResponseSchema = successEnvelopeSchema(
  EmissionGateChangesArtifactSchema,
);
export const EmissionGateChangesQuerySchema = z
  .object({
    kind: z.enum(["param", "subnet", "flow"]).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(EMISSION_CHANGES_LIMIT_MAX)
      .optional(),
  })
  .strict();
