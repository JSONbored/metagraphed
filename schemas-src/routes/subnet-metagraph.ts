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

export const NeuronSchema = z
  .object({
    uid: z.int().min(0),
    hotkey: z.string().nullable(),
    coldkey: z.string().nullable(),
    active: z.boolean(),
    validator_permit: z.boolean(),
    rank: z.number().nullable().optional(),
    trust: z.number().nullable().optional(),
    validator_trust: z.number().nullable().optional(),
    consensus: z.number().nullable().optional(),
    incentive: z.number().nullable().optional(),
    dividends: z.number().nullable().optional(),
    emission_tao: z.number().nullable().optional(),
    stake_tao: z.number().nullable().optional(),
    registered_at_block: z.int().nullable().optional(),
    is_immunity_period: z.boolean().optional(),
    // registered_at_block+immunity_period; present only while is_immunity_period
    // is true and both inputs are known (#6640) -- omitted, not null, otherwise.
    immunity_expires_at_block: z.int().optional(),
    // Wall-clock ETA for immunity_expires_at_block, extrapolated at ~12s/block;
    // only present alongside immunity_expires_at_block.
    immunity_expires_at: z.string().nullable().optional(),
    axon: z.string().nullable().optional(),
    // Only present on SubnetValidatorsArtifact rows (a real Set is always
    // passed there); omitted (not false) on metagraph/neuron-detail rows.
    featured: z.boolean().optional(),
    // Validator take/commission (#2548), global per-hotkey. Null if the
    // hotkey had no Delegates entry at capture time.
    take: z.number().nullable().optional(),
  })
  .strict();

/** Every field of the published neuron row, derived from the schema itself so
 * a field added above is projectable the same day and no second list exists to
 * drift (#9082). Used by the `?fields=` projection on the three neuron routes.
 * Deliberately the SCHEMA's keys and not the returned rows': several fields
 * here are optional (immunity_expires_at_block is emitted only inside an
 * immunity window), and a row-derived set would reject those as unsupported on
 * a subnet where no neuron happens to carry them. */
export const NEURON_FIELD_NAMES: ReadonlySet<string> = new Set(
  Object.keys(NeuronSchema.shape),
);

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
export const NeuronDetailQuerySchema = z.object({}).strict();
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
export const SubnetValidatorsQuerySchema = z.object({}).strict();
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
