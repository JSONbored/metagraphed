// MCP tools `list_subnet_validators`, `list_global_validators`,
// `get_validator_detail`, `compare_validators`, `get_validator_nominators`,
// `get_validator_history` (types-epic E batch 4, #8068). Each mirrors a
// GET /api/v1/validators* route that is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching each hand-written literal field-for-field.
import { z } from "zod";
import { NeuronFieldsInputSchema, OpenObjectArraySchema } from "./shared.ts";

// Mirrors workers/config.ts's SS58_ADDRESS_PATTERN (inlined rather than
// cross-imported from workers/, matching this directory's existing
// convention of inlining its own regex constants, e.g. subnets.ts's
// HttpUrlSchema).
const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListSubnetValidatorsInputSchema = z
  .object({
    netuid: z.int().min(0),
    limit: z.int().min(1).optional(),
    min_stake_tao: z.number().min(0).optional(),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema,
  })
  .strict();
export type ListSubnetValidatorsInput = z.infer<
  typeof ListSubnetValidatorsInputSchema
>;

export const ListSubnetValidatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    validator_count: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    validators: OpenObjectArraySchema,
  })
  .passthrough();
export type ListSubnetValidatorsOutput = z.infer<
  typeof ListSubnetValidatorsOutputSchema
>;

// Symbolic in the hand-written original (src/metagraph-neurons.ts's
// GLOBAL_VALIDATOR_SORTS/DEFAULT_GLOBAL_VALIDATOR_SORT/*_LIMIT_*), cross-
// checked against the actual runtime source at the time of writing.
const GLOBAL_VALIDATOR_SORTS = [
  "avg_validator_trust",
  "max_validator_trust",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
] as const;

export const ListGlobalValidatorsInputSchema = z
  .object({
    sort: z.enum(GLOBAL_VALIDATOR_SORTS).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type ListGlobalValidatorsInput = z.infer<
  typeof ListGlobalValidatorsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const GlobalValidatorSubnetItemSchema = z
  .object({
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    stake_tao: z.unknown().optional(),
    emission_tao: z.unknown().optional(),
    validator_trust: z.number().nullable().optional(),
  })
  .passthrough();

const GlobalValidatorItemSchema = z
  .object({
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    coldkey_count: z.int().optional(),
    subnet_count: z.int().optional(),
    uid_count: z.int().optional(),
    total_stake_tao: z.unknown().optional(),
    total_emission_tao: z.unknown().optional(),
    avg_validator_trust: z.number().nullable().optional(),
    max_validator_trust: z.number().nullable().optional(),
    latest_captured_at: z.string().nullable().optional(),
    latest_block_number: z.int().nullable().optional(),
    stake_dominance: z.number().nullable().optional(),
    subnets: z.array(GlobalValidatorSubnetItemSchema).optional(),
  })
  .passthrough();

export const ListGlobalValidatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    sort: z.enum(GLOBAL_VALIDATOR_SORTS),
    limit: z.int(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    validator_count: z.int(),
    validators: z.array(GlobalValidatorItemSchema),
  })
  .passthrough();
export type ListGlobalValidatorsOutput = z.infer<
  typeof ListGlobalValidatorsOutputSchema
>;

export const GetValidatorDetailInputSchema = z
  .object({
    hotkey: Ss58Schema,
  })
  .strict();
export type GetValidatorDetailInput = z.infer<
  typeof GetValidatorDetailInputSchema
>;

export const GetValidatorDetailOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    hotkey: z.string(),
    coldkey: z.string().nullable().optional(),
    coldkey_count: z.int().optional(),
    subnet_count: z.int(),
    take: z.number().nullable().optional(),
    total_stake_tao: z.unknown().optional(),
    total_emission_tao: z.unknown().optional(),
    avg_validator_trust: z.number().nullable().optional(),
    max_validator_trust: z.number().nullable().optional(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    subnets: OpenObjectArraySchema,
  })
  .passthrough();
export type GetValidatorDetailOutput = z.infer<
  typeof GetValidatorDetailOutputSchema
>;

// src/analytics-live.ts's COMPARE_VALIDATORS_MAX, cross-checked against the
// actual runtime value at the time of writing.
const COMPARE_VALIDATORS_MAX = 16;

export const CompareValidatorsInputSchema = z
  .object({
    hotkeys: z.array(Ss58Schema).min(1).max(COMPARE_VALIDATORS_MAX),
    netuid: z.int().min(0).optional(),
  })
  .strict();
export type CompareValidatorsInput = z.infer<
  typeof CompareValidatorsInputSchema
>;

export const CompareValidatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int().nullable().optional(),
    validator_count: z.int(),
    validators: OpenObjectArraySchema,
  })
  .passthrough();
export type CompareValidatorsOutput = z.infer<
  typeof CompareValidatorsOutputSchema
>;

// Symbolic in the hand-written original (src/validator-nominators.ts's
// NOMINATOR_WINDOWS/NOMINATOR_SORTS/*_LIMIT_*), cross-checked against the
// actual runtime source at the time of writing.
const NOMINATOR_WINDOWS = ["7d", "30d", "90d"] as const;
const NOMINATOR_SORTS = [
  "net_staked",
  "gross_staked",
  "last_activity",
] as const;

export const GetValidatorNominatorsInputSchema = z
  .object({
    hotkey: Ss58Schema,
    window: z.enum(NOMINATOR_WINDOWS).optional(),
    sort: z.enum(NOMINATOR_SORTS).optional(),
    limit: z.int().min(1).max(100).optional(),
    offset: z.int().min(0).optional(),
    coldkey: Ss58Schema.optional(),
  })
  .strict();
export type GetValidatorNominatorsInput = z.infer<
  typeof GetValidatorNominatorsInputSchema
>;

// objectItems(...) properties, none required at the item level.
const NominatorItemSchema = z
  .object({
    coldkey: z.string().optional(),
    staked_tao: z.unknown().optional(),
    unstaked_tao: z.unknown().optional(),
    net_staked_tao: z.unknown().optional(),
    gross_staked_tao: z.unknown().optional(),
    event_count: z.int().optional(),
    last_observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetValidatorNominatorsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    hotkey: z.string(),
    window: z.string().nullable().optional(),
    sort: z.enum(NOMINATOR_SORTS).optional(),
    limit: z.int().optional(),
    offset: z.int().optional(),
    nominator_count: z.int(),
    nominators: z.array(NominatorItemSchema),
  })
  .passthrough();
export type GetValidatorNominatorsOutput = z.infer<
  typeof GetValidatorNominatorsOutputSchema
>;

export const GetValidatorHistoryInputSchema = z
  .object({
    hotkey: Ss58Schema,
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
    // #9383: scopes the series to one subnet and switches the points to the
    // per-subnet shape (vTrust, consensus, dividends, take, native alpha).
    netuid: z.int().min(0).max(65535).optional(),
  })
  .strict();
export type GetValidatorHistoryInput = z.infer<
  typeof GetValidatorHistoryInputSchema
>;

// objectItems(...) properties, none required at the item level.
const ValidatorHistoryPointSchema = z
  .object({
    snapshot_date: z.string().nullable().optional(),
    subnet_count: z.int().nullable().optional(),
    // Present only when the request scoped a netuid. Absent (not null) on the
    // unscoped series, because vTrust/consensus/dividends/take are per-subnet
    // facts and a cross-subnet average of them is a number the chain never
    // computes -- see subnetScopedFields in src/validator-history.ts.
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    stake_alpha: z.number().nullable().optional(),
    emission_alpha: z.number().nullable().optional(),
    validator_trust: z.number().nullable().optional(),
    consensus: z.number().nullable().optional(),
    dividends: z.number().nullable().optional(),
    take: z.number().nullable().optional(),
    validator_permit: z.boolean().nullable().optional(),
    rewards_per_1000_alpha: z.number().nullable().optional(),
    total_stake_tao: z.unknown().optional(),
    total_emission_tao: z.unknown().optional(),
    rewards_per_1000_tao: z.number().nullable().optional(),
  })
  .passthrough();

export const GetValidatorHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    hotkey: z.string(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: z.array(ValidatorHistoryPointSchema),
  })
  .passthrough();
export type GetValidatorHistoryOutput = z.infer<
  typeof GetValidatorHistoryOutputSchema
>;
