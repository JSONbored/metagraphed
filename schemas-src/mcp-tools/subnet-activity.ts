// MCP tools `get_subnet_axon_removals`, `get_subnet_stake_moves`,
// `get_subnet_prometheus`, `get_subnet_deregistrations`,
// `get_subnet_stake_transfers`, `get_subnet_registrations`,
// `get_subnet_serving`.
// Mirror GET /api/v1/subnets/{netuid}/axon-removals, GET
// /api/v1/subnets/{netuid}/stake-moves, GET
// /api/v1/subnets/{netuid}/prometheus, GET
// /api/v1/subnets/{netuid}/deregistrations, GET
// /api/v1/subnets/{netuid}/stake-transfers, GET
// /api/v1/subnets/{netuid}/registrations, GET /api/v1/subnets/{netuid}/serving.
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
import { netuidSchema } from "./shared.ts";
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";
import {
  SubnetAxonRemovalsArtifactSchema,
  SubnetDeregistrationsArtifactSchema,
  SubnetRegistrationsArtifactSchema,
  SubnetServingArtifactSchema,
} from "../routes/subnet-activity.ts";
import { SubnetPrometheusArtifactSchema } from "../routes/subnet-prometheus.ts";
import { SubnetStakeMovesArtifactSchema } from "../routes/subnet-stake-moves.ts";
import { SubnetStakeTransfersArtifactSchema } from "../routes/subnet-stake-transfers.ts";

// The ROUTE's field, not a local copy of its enum (#10060). These seven tools
// mirror /api/v1/subnets/{netuid}/{serving,registrations,…}, which publish the
// window they apply for an omitted one; a local `z.enum([...])` carries the
// values and drops the default, so `tools/list` said nothing about what an
// agent gets for omitting it while openapi.json did.
const ActivityWindowSchema =
  ROUTE_QUERY_SCHEMAS["/api/v1/subnets/{netuid}/serving"].shape.window;
const ACTIVITY_WINDOWS = ["7d", "30d"] as const;

const ActivityInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: ActivityWindowSchema.describe(
      "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
    ).meta({ examples: [ACTIVITY_WINDOWS[0]] }),
  })
  .strict();

export const GetSubnetRegistrationsInputSchema = ActivityInputSchema;
export type GetSubnetRegistrationsInput = z.infer<
  typeof GetSubnetRegistrationsInputSchema
>;
export const GetSubnetRegistrationsOutputSchema =
  SubnetRegistrationsArtifactSchema;
export type GetSubnetRegistrationsOutput = z.infer<
  typeof GetSubnetRegistrationsOutputSchema
>;

export const GetSubnetStakeMovesInputSchema = ActivityInputSchema;
export type GetSubnetStakeMovesInput = z.infer<
  typeof GetSubnetStakeMovesInputSchema
>;
export const GetSubnetStakeMovesOutputSchema = SubnetStakeMovesArtifactSchema;
export type GetSubnetStakeMovesOutput = z.infer<
  typeof GetSubnetStakeMovesOutputSchema
>;

export const GetSubnetStakeTransfersInputSchema = ActivityInputSchema;
export type GetSubnetStakeTransfersInput = z.infer<
  typeof GetSubnetStakeTransfersInputSchema
>;
export const GetSubnetStakeTransfersOutputSchema =
  SubnetStakeTransfersArtifactSchema;
export type GetSubnetStakeTransfersOutput = z.infer<
  typeof GetSubnetStakeTransfersOutputSchema
>;

export const GetSubnetAxonRemovalsInputSchema = ActivityInputSchema;
export type GetSubnetAxonRemovalsInput = z.infer<
  typeof GetSubnetAxonRemovalsInputSchema
>;
export const GetSubnetAxonRemovalsOutputSchema =
  SubnetAxonRemovalsArtifactSchema;
export type GetSubnetAxonRemovalsOutput = z.infer<
  typeof GetSubnetAxonRemovalsOutputSchema
>;

export const GetSubnetServingInputSchema = ActivityInputSchema;
export type GetSubnetServingInput = z.infer<typeof GetSubnetServingInputSchema>;
export const GetSubnetServingOutputSchema = SubnetServingArtifactSchema;
export type GetSubnetServingOutput = z.infer<
  typeof GetSubnetServingOutputSchema
>;

export const GetSubnetPrometheusInputSchema = ActivityInputSchema;
export type GetSubnetPrometheusInput = z.infer<
  typeof GetSubnetPrometheusInputSchema
>;
export const GetSubnetPrometheusOutputSchema = SubnetPrometheusArtifactSchema;
export type GetSubnetPrometheusOutput = z.infer<
  typeof GetSubnetPrometheusOutputSchema
>;

export const GetSubnetDeregistrationsInputSchema = ActivityInputSchema;
export type GetSubnetDeregistrationsInput = z.infer<
  typeof GetSubnetDeregistrationsInputSchema
>;
export const GetSubnetDeregistrationsOutputSchema =
  SubnetDeregistrationsArtifactSchema;
export type GetSubnetDeregistrationsOutput = z.infer<
  typeof GetSubnetDeregistrationsOutputSchema
>;
