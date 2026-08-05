// GET /api/v1/subnets/{netuid}/metagraph + .../neurons/{uid} +
// .../neurons/{uid}/history + .../validators (types-epic B batch 3, #8057).
// Live neurons/neuron_daily-tier data -- no static file. Modeled from
// src/metagraph-neurons.ts's formatNeuron()/buildSubnetMetagraph()/
// buildNeuronDetail()/buildSubnetValidators() and src/neuron-history.ts,
// cross-checked against the hand-edited SubnetMetagraphArtifact/
// NeuronDetailArtifact/SubnetValidatorsArtifact/NeuronHistoryArtifact
// components they replace, and against live get_subnet_metagraph/get_neuron/
// list_subnet_validators/get_neuron_history responses for subnet 1.
//
// Real finding (bucket b): formatNeuron() only emits immunity_expires_at_block/
// immunity_expires_at when the caller passes a resolved immunityPeriod AND the
// row is currently in its immunity window -- confirmed live (uid 0's is_immunity_
// period:true row on subnet 1 carries both fields; every other row omits them).
// The hand-edited Neuron component already declared both as optional, so this
// is a compatibility confirmation, not a correction.
//
// The Neuron shape is intentionally NOT registered as a shared component here
// (matching subnet-concentration.ts's ConcentrationLensSchema precedent) --
// SubnetMetagraphArtifact/NeuronDetailArtifact/SubnetValidatorsArtifact are its
// only three referrers anywhere in schemas/components/*.schema.json (verified
// via repo-wide $ref grep), and all three are converted together in this same
// batch, so the hand-edited Neuron component key becomes fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

// Exported so the surfaces that serve these rows can derive `fields=`'s
// allowed set from the CONTRACT rather than from a second list (#9082) --
// see src/metagraph-neurons.ts's NEURON_PROJECTABLE_FIELDS.
export const NeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    coldkey: z.string().nullable(),
    active: z.boolean(),
    validator_permit: z.boolean(),
    rank: z
      .number()
      .nullable()
      .optional()
      .describe(
        "1-based position by incentive, descending. dTAO has no chain rank storage, " +
          "so this is DERIVED by the producer and assigned only to neurons with " +
          "non-zero incentive -- null for the whole incentive == 0 population, which " +
          "is most validators. Verified on netuid 64: non-null on exactly the 16 UIDs " +
          "with incentive > 0. Null means unranked, not rank-last (#9541).",
      ),
    trust: z.number().nullable().optional(),
    validator_trust: z.number().nullable().optional(),
    consensus: z.number().nullable().optional(),
    incentive: z.number().nullable().optional(),
    dividends: z.number().nullable().optional(),
    emission_tao: z
      .number()
      .nullable()
      .optional()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO.",
      ),
    stake_tao: z
      .number()
      .nullable()
      .optional()
      .describe(
        "This row's stake in the subnet named by the sibling `netuid`. ALPHA for non-root subnets -- a non-root neuron's stake is that subnet's own alpha token, not TAO (#2550); netuid 0 (root) stake is genuine TAO. Comparable within one subnet, never summable across subnets: the cross-subnet totals that ARE safe to read as TAO convert through each subnet's alpha price first (#9051/#8803). Kept under the on-chain column name deliberately (#8945).",
      ),
    registered_at_block: z.int().nullable().optional(),
    is_immunity_period: z.boolean().optional(),
    // registered_at_block+immunity_period; present only while is_immunity_period
    // is true and both inputs are known (#6640) -- omitted, not null, otherwise.
    immunity_expires_at_block: z.int().optional(),
    // Wall-clock ETA for immunity_expires_at_block, extrapolated at ~12s/block;
    // only present alongside immunity_expires_at_block.
    immunity_expires_at: z.string().nullable().optional(),
    axon: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The neuron's announced serving endpoint (ip:port), emitted only when the " +
          "on-chain axon IP is non-zero. Null means NOT SERVING, which is the normal " +
          "state for a validator -- so validator-scoped views read null throughout " +
          "while miner rows on the same table carry a value. There is no alternate " +
          "carrier: AxonServed stores only [netuid, hotkey] (#9541).",
      ),
    // Only present on SubnetValidatorsArtifact rows (a real Set is always
    // passed there); omitted (not false) on metagraph/neuron-detail rows.
    featured: z.boolean().optional(),
    // Validator take/commission (#2548), global per-hotkey. Null if the
    // hotkey had no Delegates entry at capture time.
    take: z.number().nullable().optional(),
  })
  .strict();

export const SubnetMetagraphArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neurons: z.array(NeuronSchema),
  })
  .passthrough();
export type SubnetMetagraphArtifact = z.infer<
  typeof SubnetMetagraphArtifactSchema
>;
export const SubnetMetagraphResponseSchema = successEnvelopeSchema(
  SubnetMetagraphArtifactSchema,
);
export const SubnetMetagraphQuerySchema = z
  .object({
    validator_permit: z.enum(["true", "false"]).optional(),
    // #9082: comma-separated Neuron field names, validated against
    // NeuronSchema's own shape. Omit for the full row.
    fields: z.string().optional(),
  })
  .strict();
export type SubnetMetagraphQuery = z.infer<typeof SubnetMetagraphQuerySchema>;

export const NeuronDetailArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron: NeuronSchema.nullable(),
  })
  .passthrough();
export type NeuronDetailArtifact = z.infer<typeof NeuronDetailArtifactSchema>;
export const NeuronDetailResponseSchema = successEnvelopeSchema(
  NeuronDetailArtifactSchema,
);
export const NeuronDetailQuerySchema = z
  .object({
    // #9082: comma-separated Neuron field names, validated against
    // NeuronSchema's own shape. Omit for the full row.
    fields: z.string().optional(),
  })
  .strict();
export type NeuronDetailQuery = z.infer<typeof NeuronDetailQuerySchema>;

export const SubnetValidatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    validator_count: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    validators: z.array(NeuronSchema),
  })
  .passthrough();
export type SubnetValidatorsArtifact = z.infer<
  typeof SubnetValidatorsArtifactSchema
>;
export const SubnetValidatorsResponseSchema = successEnvelopeSchema(
  SubnetValidatorsArtifactSchema,
);
export const SubnetValidatorsQuerySchema = z
  .object({
    // #9082: comma-separated Neuron field names, validated against
    // NeuronSchema's own shape. Omit for the full row.
    fields: z.string().optional(),
  })
  .strict();
export type SubnetValidatorsQuery = z.infer<typeof SubnetValidatorsQuerySchema>;

// Per-day neuron_daily rollup point: a Neuron's state on one snapshot_date
// (every Neuron field, always present per the live neuron_daily rollup query,
// plus the per-point stamp fields) -- confirmed live via get_neuron_history.
const NeuronHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
  })
  .extend(NeuronSchema.shape)
  .passthrough();

export const NeuronHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    uid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(NeuronHistoryPointSchema),
  })
  .passthrough();
export type NeuronHistoryArtifact = z.infer<typeof NeuronHistoryArtifactSchema>;
export const NeuronHistoryResponseSchema = successEnvelopeSchema(
  NeuronHistoryArtifactSchema,
);
export const NeuronHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type NeuronHistoryQuery = z.infer<typeof NeuronHistoryQuerySchema>;
