// GET /api/v1/subnets/{netuid}/hyperparameters + .../hyperparameters/history
// (types-epic B batch 3, #8057). Live subnet_hyperparams/subnet_hyperparams_
// history D1-tier data -- no static file. Modeled from src/subnet-hyperparams.ts
// / src/subnet-hyperparams-history.ts's column lists and SUBNET_HYPERPARAMS_
// INSERT_COLUMNS, cross-checked against the hand-edited SubnetHyperparametersArtifact
// / SubnetHyperparamsHistoryArtifact components they replace, and against a
// live get_subnet_hyperparams/get_subnet_hyperparams_history response for
// subnet 1 (confirmed several *_ratio/burn_half_life/burn_increase_mult/
// min_childkey_take_ratio fields genuinely read back null on an older history
// entry, matching their declared nullability).
//
// SubnetHyperparameters and SubnetHyperparamsHistoryEntry are intentionally
// NOT registered as shared components -- SubnetHyperparametersArtifact and
// SubnetHyperparamsHistoryEntry are SubnetHyperparameters's only two referrers,
// and SubnetHyperparamsHistoryArtifact is SubnetHyperparamsHistoryEntry's only
// referrer (verified via repo-wide $ref grep across every schemas/components/
// *.schema.json file), and all three are converted together in this same
// batch, so both hand-edited component keys become fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const SubnetHyperparametersSchema = z
  .object({
    kappa_ratio: z.number().nullable().optional(),
    immunity_period: z.int().nullable().optional(),
    min_allowed_weights: z.int().nullable().optional(),
    max_weight_limit_ratio: z.number().nullable().optional(),
    tempo: z.int().nullable().optional(),
    weights_version: z.int().nullable().optional(),
    weights_rate_limit: z.int().nullable().optional(),
    activity_cutoff: z.int().nullable().optional(),
    activity_cutoff_factor: z.int().nullable().optional(),
    registration_allowed: z.boolean(),
    target_regs_per_interval: z.int().nullable().optional(),
    min_burn_tao: z.number().nullable().optional(),
    max_burn_tao: z.number().nullable().optional(),
    burn_half_life: z.int().nullable().optional(),
    burn_increase_mult: z.number().nullable().optional(),
    // Raw on-chain integer, not yet ratio-converted (scaling constant unconfirmed).
    bonds_moving_avg_raw: z.int().nullable().optional(),
    max_regs_per_block: z.int().nullable().optional(),
    serving_rate_limit: z.int().nullable().optional(),
    max_validators: z.int().nullable().optional(),
    commit_reveal_period: z.int().nullable().optional(),
    commit_reveal_enabled: z.boolean(),
    alpha_high_ratio: z.number().nullable().optional(),
    alpha_low_ratio: z.number().nullable().optional(),
    liquid_alpha_enabled: z.boolean(),
    alpha_sigmoid_steepness: z.number().nullable().optional(),
    yuma_version: z.int().nullable().optional(),
    subnet_is_active: z.boolean(),
    transfers_enabled: z.boolean(),
    bonds_reset_enabled: z.boolean(),
    user_liquidity_enabled: z.boolean(),
    owner_cut_enabled: z.boolean(),
    owner_cut_auto_lock_enabled: z.boolean(),
    min_childkey_take_ratio: z.number().nullable().optional(),
  })
  .strict();

export const SubnetHyperparametersArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    hyperparameters: SubnetHyperparametersSchema.nullable(),
  })
  .passthrough();
export type SubnetHyperparametersArtifact = z.infer<
  typeof SubnetHyperparametersArtifactSchema
>;
export const SubnetHyperparametersResponseSchema = successEnvelopeSchema(
  SubnetHyperparametersArtifactSchema,
);
export const SubnetHyperparametersQuerySchema = z.object({}).strict();
export type SubnetHyperparametersQuery = z.infer<
  typeof SubnetHyperparametersQuerySchema
>;

const SubnetHyperparamsHistoryEntrySchema = z
  .object({
    block_number: z.int().min(0).nullable().optional(),
    observed_at: z.string().nullable(),
    hyperparameters: SubnetHyperparametersSchema.nullable().optional(),
    hyperparams_hash: z.string(),
  })
  .strict();

export const SubnetHyperparamsHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    entry_count: z.int().min(0),
    limit: z.int().min(1).max(1000).nullable().optional(),
    offset: z.int().min(0).nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(SubnetHyperparamsHistoryEntrySchema),
  })
  .passthrough();
export type SubnetHyperparamsHistoryArtifact = z.infer<
  typeof SubnetHyperparamsHistoryArtifactSchema
>;
export const SubnetHyperparamsHistoryResponseSchema = successEnvelopeSchema(
  SubnetHyperparamsHistoryArtifactSchema,
);
export const SubnetHyperparamsHistoryQuerySchema = z
  .object({
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetHyperparamsHistoryQuery = z.infer<
  typeof SubnetHyperparamsHistoryQuerySchema
>;
