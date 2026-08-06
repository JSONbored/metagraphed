// MCP tools `get_account_stake_moves`, `get_account_axon_removals`,
// `get_account_prometheus`, `get_account_registrations`,
// `get_account_weight_setters`, `get_account_serving`,
// `get_account_deregistrations` (types-epic E batch 7, #8070). Each mirrors
// a GET /api/v1/accounts/{ss58}/* footprint route that is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. All seven share one shape (address/window/total_X/subnet_count/
// concentration/dominant_netuid/subnets), but with genuinely different
// per-tool field names (movements vs removals vs announcements, etc.), so
// each is modeled explicitly rather than through a shared factory. Unlike
// the objectItems()-built item shapes elsewhere in this epic, these
// `subnets` items are hand-written as STRICT objects (additionalProperties:
// false) with every field in their own `required` array -- modeled here
// with the SAME strictness, not the usual item-level looseness.
import { z } from "zod";
import { netuidSchema, ss58Schema, windowSchema } from "./shared.ts";

// Symbolic in each hand-written original (src/account-*.ts's own
// *_WINDOWS/DEFAULT_*_WINDOW constants), cross-checked against the actual
// runtime source at the time of writing. Six of the seven tools share the
// same 3-way set; get_account_weight_setters uses a 2-way set.
const FOOTPRINT_WINDOWS_3 = ["7d", "30d", "90d"] as const;
const WEIGHT_SETTERS_WINDOWS_2 = ["7d", "30d"] as const;

export const GetAccountStakeMovesInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountStakeMovesInput = z.infer<
  typeof GetAccountStakeMovesInputSchema
>;

const StakeMovesSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    movements: z.int(),
    first_moved_at: z.string().nullable(),
    last_moved_at: z.string().nullable(),
    price_tao_at_last_move: z.number().nullable(),
  })
  .strict();

export const GetAccountStakeMovesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_movements: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(StakeMovesSubnetSchema),
  })
  .passthrough();
export type GetAccountStakeMovesOutput = z.infer<
  typeof GetAccountStakeMovesOutputSchema
>;

export const GetAccountAxonRemovalsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountAxonRemovalsInput = z.infer<
  typeof GetAccountAxonRemovalsInputSchema
>;

const AxonRemovalsSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    removals: z.int(),
    first_removed_at: z.string().nullable(),
    last_removed_at: z.string().nullable(),
  })
  .strict();

export const GetAccountAxonRemovalsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_removals: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(AxonRemovalsSubnetSchema),
  })
  .passthrough();
export type GetAccountAxonRemovalsOutput = z.infer<
  typeof GetAccountAxonRemovalsOutputSchema
>;

export const GetAccountPrometheusInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountPrometheusInput = z.infer<
  typeof GetAccountPrometheusInputSchema
>;

const PrometheusSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    announcements: z.int(),
    first_announced_at: z.string().nullable(),
    last_announced_at: z.string().nullable(),
  })
  .strict();

export const GetAccountPrometheusOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_announcements: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(PrometheusSubnetSchema),
  })
  .passthrough();
export type GetAccountPrometheusOutput = z.infer<
  typeof GetAccountPrometheusOutputSchema
>;

export const GetAccountRegistrationsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountRegistrationsInput = z.infer<
  typeof GetAccountRegistrationsInputSchema
>;

const RegistrationsSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    registrations: z.int(),
    first_registered_at: z.string().nullable(),
    last_registered_at: z.string().nullable(),
  })
  .strict();

export const GetAccountRegistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_registrations: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(RegistrationsSubnetSchema),
  })
  .passthrough();
export type GetAccountRegistrationsOutput = z.infer<
  typeof GetAccountRegistrationsOutputSchema
>;

export const GetAccountWeightSettersInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(WEIGHT_SETTERS_WINDOWS_2).optional(),
  })
  .strict();
export type GetAccountWeightSettersInput = z.infer<
  typeof GetAccountWeightSettersInputSchema
>;

const WeightSettersSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    weight_sets: z.int(),
    first_set_at: z.string().nullable(),
    last_set_at: z.string().nullable(),
  })
  .strict();

export const GetAccountWeightSettersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_weight_sets: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(WeightSettersSubnetSchema),
  })
  .passthrough();
export type GetAccountWeightSettersOutput = z.infer<
  typeof GetAccountWeightSettersOutputSchema
>;

export const GetAccountServingInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountServingInput = z.infer<
  typeof GetAccountServingInputSchema
>;

const ServingSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    announcements: z.int(),
    first_served_at: z.string().nullable(),
    last_served_at: z.string().nullable(),
  })
  .strict();

export const GetAccountServingOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_announcements: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(ServingSubnetSchema),
  })
  .passthrough();
export type GetAccountServingOutput = z.infer<
  typeof GetAccountServingOutputSchema
>;

export const GetAccountDeregistrationsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: windowSchema(FOOTPRINT_WINDOWS_3).optional(),
  })
  .strict();
export type GetAccountDeregistrationsInput = z.infer<
  typeof GetAccountDeregistrationsInputSchema
>;

const DeregistrationsSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    deregistrations: z.int(),
    first_deregistered_at: z.string().nullable(),
    last_deregistered_at: z.string().nullable(),
  })
  .strict();

export const GetAccountDeregistrationsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    address: z.string(),
    window: z.string().nullable(),
    total_deregistrations: z.int(),
    subnet_count: z.int(),
    concentration: z.number().nullable().optional(),
    dominant_netuid: z.int().nullable().optional(),
    subnets: z.array(DeregistrationsSubnetSchema),
  })
  .passthrough();
export type GetAccountDeregistrationsOutput = z.infer<
  typeof GetAccountDeregistrationsOutputSchema
>;
