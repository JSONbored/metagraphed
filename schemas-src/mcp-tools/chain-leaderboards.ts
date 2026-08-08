// MCP tools `get_chain_stake_flow`, `get_chain_alpha_volume`,
// `get_chain_turnover`, `get_chain_stake_moves`, `get_chain_axon_removals`,
// `get_chain_stake_transfers`, `get_chain_prometheus`, `get_chain_serving`,
// `get_chain_weights`, `get_chain_weight_setters`.
// Mirror GET /api/v1/chain/stake-flow, GET /api/v1/chain/alpha-volume, GET
// /api/v1/chain/turnover, GET /api/v1/chain/stake-moves, GET
// /api/v1/chain/axon-removals, GET /api/v1/chain/stake-transfers, GET
// /api/v1/chain/prometheus, GET /api/v1/chain/serving, GET
// /api/v1/chain/weights, GET /api/v1/chain/weights/setters.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import { ChainAlphaVolumeArtifactSchema } from "../routes/chain-alpha-volume.ts";
import {
  ChainAxonRemovalsArtifactSchema,
  ChainPrometheusArtifactSchema,
  ChainServingArtifactSchema,
  ChainStakeMovesArtifactSchema,
  ChainStakeTransfersArtifactSchema,
  ChainWeightsArtifactSchema,
} from "../routes/chain-network-rollups.ts";
import { ChainStakeFlowArtifactSchema } from "../routes/chain-stake-flow.ts";
import { ChainTurnoverArtifactSchema } from "../routes/chain-turnover.ts";
import { ChainWeightSettersArtifactSchema } from "../routes/chain-weight-setters.ts";

const RouteQuery_chain_turnover = ROUTE_QUERY_SCHEMAS["/api/v1/chain/turnover"];

const RouteQuery_chain_stake_flow =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/stake-flow"];

const RouteQuery_chain_prometheus =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/prometheus"];

const RouteQuery_chain_serving = ROUTE_QUERY_SCHEMAS["/api/v1/chain/serving"];

const RouteQuery_chain_axon_removals =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/axon-removals"];

const RouteQuery_chain_stake_transfers =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/stake-transfers"];

const RouteQuery_chain_stake_moves =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/stake-moves"];

const RouteQuery_chain_weights_setters =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/weights/setters"];

const RouteQuery_chain_weights = ROUTE_QUERY_SCHEMAS["/api/v1/chain/weights"];

const RouteQuery_chain_alpha_volume =
  ROUTE_QUERY_SCHEMAS["/api/v1/chain/alpha-volume"];

export const GetChainTurnoverInputSchema = z
  .object({
    window: RouteQuery_chain_turnover.shape.window,
    limit: RouteQuery_chain_turnover.shape.limit,
  })
  .strict();
export type GetChainTurnoverInput = z.infer<typeof GetChainTurnoverInputSchema>;

export const GetChainTurnoverOutputSchema = ChainTurnoverArtifactSchema;
export type GetChainTurnoverOutput = z.infer<
  typeof GetChainTurnoverOutputSchema
>;

export const GetChainStakeFlowInputSchema = z
  .object({
    window: RouteQuery_chain_stake_flow.shape.window,
    limit: RouteQuery_chain_stake_flow.shape.limit,
  })
  .strict();
export type GetChainStakeFlowInput = z.infer<
  typeof GetChainStakeFlowInputSchema
>;

export const GetChainStakeFlowOutputSchema = ChainStakeFlowArtifactSchema;
export type GetChainStakeFlowOutput = z.infer<
  typeof GetChainStakeFlowOutputSchema
>;

export const GetChainAlphaVolumeInputSchema = z
  .object({
    limit: RouteQuery_chain_alpha_volume.shape.limit,
  })
  .strict();
export type GetChainAlphaVolumeInput = z.infer<
  typeof GetChainAlphaVolumeInputSchema
>;

// Each subnet entry is a full get_subnet_volume-shaped scorecard -- loose
// (additionalProperties:true), only netuid/window required, matching the
// hand-written original exactly rather than nesting get_subnet_volume's own
// (not-yet-converted) precise schema.
export const GetChainAlphaVolumeOutputSchema = ChainAlphaVolumeArtifactSchema;
export type GetChainAlphaVolumeOutput = z.infer<
  typeof GetChainAlphaVolumeOutputSchema
>;

export const GetChainWeightsInputSchema = z
  .object({
    window: RouteQuery_chain_weights.shape.window,
    limit: RouteQuery_chain_weights.shape.limit,
  })
  .strict();
export type GetChainWeightsInput = z.infer<typeof GetChainWeightsInputSchema>;

export const GetChainWeightsOutputSchema = ChainWeightsArtifactSchema;
export type GetChainWeightsOutput = z.infer<typeof GetChainWeightsOutputSchema>;

export const GetChainWeightSettersInputSchema = z
  .object({
    window: RouteQuery_chain_weights_setters.shape.window,
    limit: RouteQuery_chain_weights_setters.shape.limit,
  })
  .strict();
export type GetChainWeightSettersInput = z.infer<
  typeof GetChainWeightSettersInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetChainWeightSettersOutputSchema =
  ChainWeightSettersArtifactSchema;
export type GetChainWeightSettersOutput = z.infer<
  typeof GetChainWeightSettersOutputSchema
>;

export const GetChainStakeMovesInputSchema = z
  .object({
    window: RouteQuery_chain_stake_moves.shape.window,
    limit: RouteQuery_chain_stake_moves.shape.limit,
  })
  .strict();
export type GetChainStakeMovesInput = z.infer<
  typeof GetChainStakeMovesInputSchema
>;

export const GetChainStakeMovesOutputSchema = ChainStakeMovesArtifactSchema;
export type GetChainStakeMovesOutput = z.infer<
  typeof GetChainStakeMovesOutputSchema
>;

export const GetChainStakeTransfersInputSchema = z
  .object({
    window: RouteQuery_chain_stake_transfers.shape.window,
    limit: RouteQuery_chain_stake_transfers.shape.limit,
  })
  .strict();
export type GetChainStakeTransfersInput = z.infer<
  typeof GetChainStakeTransfersInputSchema
>;

export const GetChainStakeTransfersOutputSchema =
  ChainStakeTransfersArtifactSchema;
export type GetChainStakeTransfersOutput = z.infer<
  typeof GetChainStakeTransfersOutputSchema
>;

export const GetChainAxonRemovalsInputSchema = z
  .object({
    window: RouteQuery_chain_axon_removals.shape.window,
    limit: RouteQuery_chain_axon_removals.shape.limit,
  })
  .strict();
export type GetChainAxonRemovalsInput = z.infer<
  typeof GetChainAxonRemovalsInputSchema
>;

export const GetChainAxonRemovalsOutputSchema = ChainAxonRemovalsArtifactSchema;
export type GetChainAxonRemovalsOutput = z.infer<
  typeof GetChainAxonRemovalsOutputSchema
>;

export const GetChainServingInputSchema = z
  .object({
    window: RouteQuery_chain_serving.shape.window,
    limit: RouteQuery_chain_serving.shape.limit,
  })
  .strict();
export type GetChainServingInput = z.infer<typeof GetChainServingInputSchema>;

export const GetChainServingOutputSchema = ChainServingArtifactSchema;
export type GetChainServingOutput = z.infer<typeof GetChainServingOutputSchema>;

export const GetChainPrometheusInputSchema = z
  .object({
    window: RouteQuery_chain_prometheus.shape.window,
    limit: RouteQuery_chain_prometheus.shape.limit,
  })
  .strict();
export type GetChainPrometheusInput = z.infer<
  typeof GetChainPrometheusInputSchema
>;

export const GetChainPrometheusOutputSchema = ChainPrometheusArtifactSchema;
export type GetChainPrometheusOutput = z.infer<
  typeof GetChainPrometheusOutputSchema
>;
