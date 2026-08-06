// MCP tools `get_chain_turnover`, `get_chain_stake_flow`,
// `get_chain_alpha_volume`, `get_chain_weights`, `get_chain_weight_setters`,
// `get_chain_stake_moves`, `get_chain_stake_transfers`,
// `get_chain_axon_removals`, `get_chain_serving`, `get_chain_prometheus`
// (types-epic E batch 9, #8072). Each mirrors a GET /api/v1/chain/* route
// that is not one of schemas-src/routes/'s covered pilot routes -- no
// existing Zod schema to reuse. Modeled fresh, matching each hand-written
// literal field-for-field. Nine of the ten share one shape (subnet_count +
// a STRICT `network` rollup object + a nullable `*_distribution` stats
// object [DistributionStatsSchema, shared.ts] + a `subnets` leaderboard
// array of STRICT items -- additionalProperties:false, every item field
// required, unlike the objectItems() looseness convention used elsewhere
// in this epic), but with genuinely different per-tool field names
// (movers vs senders vs removers, etc.), so each is modeled explicitly
// rather than through a shared factory. get_chain_weight_setters is the
// exception: a flat setters leaderboard with no network/distribution
// rollup, using the usual objectItems() item-level looseness instead.
import { z } from "zod";
import {
  DistributionStatsSchema,
  limitSchema,
  netuidSchema,
  windowSchema,
} from "./shared.ts";

const WINDOWS_2 = ["7d", "30d"] as const;
const WINDOWS_3 = ["7d", "30d", "90d"] as const;
const LIMIT_MAX_100 = 100;

export const GetChainTurnoverInputSchema = z
  .object({
    window: windowSchema(WINDOWS_3).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainTurnoverInput = z.infer<typeof GetChainTurnoverInputSchema>;

const ChainTurnoverNetworkSchema = z
  .object({
    validators_start: z.int(),
    validators_end: z.int(),
    validators_entered: z.int(),
    validators_exited: z.int(),
    validator_retention: z.number().nullable(),
    stability_score: z.int().nullable(),
  })
  .strict();

const ChainTurnoverSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    validators_start: z.int(),
    validators_end: z.int(),
    validators_entered: z.int(),
    validators_exited: z.int(),
    validator_retention: z.number(),
    stability_score: z.int(),
  })
  .strict();

export const GetChainTurnoverOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    comparable: z.boolean(),
    subnet_count: z.int(),
    network: ChainTurnoverNetworkSchema,
    stability_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainTurnoverSubnetSchema),
  })
  .passthrough();
export type GetChainTurnoverOutput = z.infer<
  typeof GetChainTurnoverOutputSchema
>;

export const GetChainStakeFlowInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainStakeFlowInput = z.infer<
  typeof GetChainStakeFlowInputSchema
>;

const ChainStakeFlowNetworkSchema = z
  .object({
    total_staked_tao: z.number(),
    total_unstaked_tao: z.number(),
    net_flow_tao: z.number(),
    gross_flow_tao: z.number(),
    stake_events: z.int(),
    unstake_events: z.int(),
    gaining: z.int(),
    losing: z.int(),
    flat: z.int(),
  })
  .strict();

const ChainStakeFlowSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    total_staked_tao: z.number(),
    total_unstaked_tao: z.number(),
    net_flow_tao: z.number(),
    gross_flow_tao: z.number(),
    stake_events: z.int(),
    unstake_events: z.int(),
    direction: z.string(),
  })
  .strict();

export const GetChainStakeFlowOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainStakeFlowNetworkSchema,
    net_flow_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainStakeFlowSubnetSchema),
  })
  .passthrough();
export type GetChainStakeFlowOutput = z.infer<
  typeof GetChainStakeFlowOutputSchema
>;

export const GetChainAlphaVolumeInputSchema = z
  .object({
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainAlphaVolumeInput = z.infer<
  typeof GetChainAlphaVolumeInputSchema
>;

const ChainAlphaVolumeNetworkSchema = z
  .object({
    buy_volume_alpha: z.unknown(),
    sell_volume_alpha: z.unknown(),
    total_volume_alpha: z.unknown(),
    buy_volume_tao: z.unknown(),
    sell_volume_tao: z.unknown(),
    total_volume_tao: z.unknown(),
    buy_count: z.int(),
    sell_count: z.int(),
    net_volume_alpha: z.unknown(),
    sentiment_ratio: z.number().nullable(),
    sentiment: z.string(),
  })
  .strict();

// Each subnet entry is a full get_subnet_volume-shaped scorecard -- loose
// (additionalProperties:true), only netuid/window required, matching the
// hand-written original exactly rather than nesting get_subnet_volume's own
// (not-yet-converted) precise schema.
const ChainAlphaVolumeSubnetSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string(),
    buy_volume_alpha: z.unknown().optional(),
    sell_volume_alpha: z.unknown().optional(),
    total_volume_alpha: z.unknown().optional(),
    buy_volume_tao: z.unknown().optional(),
    sell_volume_tao: z.unknown().optional(),
    total_volume_tao: z.unknown().optional(),
    buy_count: z.int().optional(),
    sell_count: z.int().optional(),
    net_volume_alpha: z.unknown().optional(),
    sentiment_ratio: z.number().nullable().optional(),
    sentiment: z.string().nullable().optional(),
    vol_mcap_ratio: z.number().nullable().optional(),
  })
  .passthrough();

export const GetChainAlphaVolumeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainAlphaVolumeNetworkSchema,
    volume_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainAlphaVolumeSubnetSchema),
  })
  .passthrough();
export type GetChainAlphaVolumeOutput = z.infer<
  typeof GetChainAlphaVolumeOutputSchema
>;

export const GetChainWeightsInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainWeightsInput = z.infer<typeof GetChainWeightsInputSchema>;

const ChainWeightsNetworkSchema = z
  .object({
    distinct_setters: z.int(),
    weight_sets: z.int(),
    sets_per_setter: z.number().nullable(),
  })
  .strict();

const ChainWeightsSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_setters: z.int(),
    weight_sets: z.int(),
    sets_per_setter: z.number(),
  })
  .strict();

export const GetChainWeightsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainWeightsNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainWeightsSubnetSchema),
  })
  .passthrough();
export type GetChainWeightsOutput = z.infer<typeof GetChainWeightsOutputSchema>;

export const GetChainWeightSettersInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainWeightSettersInput = z.infer<
  typeof GetChainWeightSettersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const ChainWeightSetterSchema = z
  .object({
    hotkey: z.string().nullable().optional(),
    uid: z.int().nullable().optional(),
    weight_sets: z.int().optional(),
    share: z.unknown().optional(),
    first_set_at: z.string().nullable().optional(),
    last_set_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetChainWeightSettersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    distinct_setters: z.int(),
    weight_sets: z.int(),
    setter_count: z.int(),
    setters: z.array(ChainWeightSetterSchema),
  })
  .passthrough();
export type GetChainWeightSettersOutput = z.infer<
  typeof GetChainWeightSettersOutputSchema
>;

export const GetChainStakeMovesInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainStakeMovesInput = z.infer<
  typeof GetChainStakeMovesInputSchema
>;

const ChainStakeMovesNetworkSchema = z
  .object({
    distinct_movers: z.int(),
    movements: z.int(),
    movements_per_mover: z.number().nullable(),
  })
  .strict();

const ChainStakeMovesSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_movers: z.int(),
    movements: z.int(),
    movements_per_mover: z.number(),
  })
  .strict();

export const GetChainStakeMovesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainStakeMovesNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainStakeMovesSubnetSchema),
  })
  .passthrough();
export type GetChainStakeMovesOutput = z.infer<
  typeof GetChainStakeMovesOutputSchema
>;

export const GetChainStakeTransfersInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainStakeTransfersInput = z.infer<
  typeof GetChainStakeTransfersInputSchema
>;

const ChainStakeTransfersNetworkSchema = z
  .object({
    distinct_senders: z.int(),
    transfers: z.int(),
    transfers_per_sender: z.number().nullable(),
  })
  .strict();

const ChainStakeTransfersSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_senders: z.int(),
    transfers: z.int(),
    transfers_per_sender: z.number(),
  })
  .strict();

export const GetChainStakeTransfersOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainStakeTransfersNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainStakeTransfersSubnetSchema),
  })
  .passthrough();
export type GetChainStakeTransfersOutput = z.infer<
  typeof GetChainStakeTransfersOutputSchema
>;

export const GetChainAxonRemovalsInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainAxonRemovalsInput = z.infer<
  typeof GetChainAxonRemovalsInputSchema
>;

const ChainAxonRemovalsNetworkSchema = z
  .object({
    distinct_removers: z.int(),
    removals: z.int(),
    removals_per_remover: z.number().nullable(),
  })
  .strict();

const ChainAxonRemovalsSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_removers: z.int(),
    removals: z.int(),
    removals_per_remover: z.number(),
  })
  .strict();

export const GetChainAxonRemovalsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainAxonRemovalsNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainAxonRemovalsSubnetSchema),
  })
  .passthrough();
export type GetChainAxonRemovalsOutput = z.infer<
  typeof GetChainAxonRemovalsOutputSchema
>;

export const GetChainServingInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainServingInput = z.infer<typeof GetChainServingInputSchema>;

const ChainServingNetworkSchema = z
  .object({
    distinct_servers: z.int(),
    announcements: z.int(),
    announcements_per_server: z.number().nullable(),
  })
  .strict();

const ChainServingSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_servers: z.int(),
    announcements: z.int(),
    announcements_per_server: z.number(),
  })
  .strict();

export const GetChainServingOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainServingNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainServingSubnetSchema),
  })
  .passthrough();
export type GetChainServingOutput = z.infer<typeof GetChainServingOutputSchema>;

export const GetChainPrometheusInputSchema = z
  .object({
    window: windowSchema(WINDOWS_2).optional(),
    limit: limitSchema(LIMIT_MAX_100).optional(),
  })
  .strict();
export type GetChainPrometheusInput = z.infer<
  typeof GetChainPrometheusInputSchema
>;

const ChainPrometheusNetworkSchema = z
  .object({
    distinct_exporters: z.int(),
    announcements: z.int(),
    announcements_per_exporter: z.number().nullable(),
  })
  .strict();

const ChainPrometheusSubnetSchema = z
  .object({
    netuid: netuidSchema(),
    distinct_exporters: z.int(),
    announcements: z.int(),
    announcements_per_exporter: z.number(),
  })
  .strict();

export const GetChainPrometheusOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    subnet_count: z.int(),
    network: ChainPrometheusNetworkSchema,
    intensity_distribution: DistributionStatsSchema.nullable().optional(),
    subnets: z.array(ChainPrometheusSubnetSchema),
  })
  .passthrough();
export type GetChainPrometheusOutput = z.infer<
  typeof GetChainPrometheusOutputSchema
>;
