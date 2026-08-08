// MCP tools `get_account_axon_removals`, `get_account_prometheus`,
// `get_account_weight_setters`, `get_account_deregistrations`,
// `get_account_stake_moves`, `get_account_registrations`,
// `get_account_serving`.
// Mirror GET /api/v1/accounts/{ss58}/axon-removals, GET
// /api/v1/accounts/{ss58}/prometheus, GET
// /api/v1/accounts/{ss58}/weight-setters, GET
// /api/v1/accounts/{ss58}/deregistrations, GET
// /api/v1/accounts/{ss58}/stake-moves, GET
// /api/v1/accounts/{ss58}/registrations, GET /api/v1/accounts/{ss58}/serving.
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
import { ss58Schema } from "./shared.ts";
import {
  AccountAxonRemovalsArtifactSchema,
  AccountDeregistrationsArtifactSchema,
  AccountRegistrationsArtifactSchema,
  AccountWeightSettersArtifactSchema,
} from "../routes/account-activity-registrations.ts";
import {
  AccountPrometheusArtifactSchema,
  AccountServingArtifactSchema,
  AccountStakeMovesArtifactSchema,
} from "../routes/account-activity.ts";

// Symbolic in each hand-written original (src/account-*.ts's own
// *_WINDOWS/DEFAULT_*_WINDOW constants), cross-checked against the actual
// runtime source at the time of writing. Six of the seven tools share the
// same 3-way set; get_account_weight_setters uses a 2-way set.

const RouteQuery_accounts_ss58_stake_moves =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/stake-moves"];

const RouteQuery_accounts_ss58_axon_removals =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/axon-removals"];

const RouteQuery_accounts_ss58_deregistrations =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/deregistrations"];

const RouteQuery_accounts_ss58_serving =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/serving"];

const RouteQuery_accounts_ss58_weight_setters =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/weight-setters"];

const RouteQuery_accounts_ss58_registrations =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/registrations"];

const RouteQuery_accounts_ss58_prometheus =
  ROUTE_QUERY_SCHEMAS["/api/v1/accounts/{ss58}/prometheus"];

export const GetAccountStakeMovesInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_stake_moves.shape.window,
  })
  .strict();
export type GetAccountStakeMovesInput = z.infer<
  typeof GetAccountStakeMovesInputSchema
>;

export const GetAccountStakeMovesOutputSchema = AccountStakeMovesArtifactSchema;
export type GetAccountStakeMovesOutput = z.infer<
  typeof GetAccountStakeMovesOutputSchema
>;

export const GetAccountAxonRemovalsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_axon_removals.shape.window,
  })
  .strict();
export type GetAccountAxonRemovalsInput = z.infer<
  typeof GetAccountAxonRemovalsInputSchema
>;

export const GetAccountAxonRemovalsOutputSchema =
  AccountAxonRemovalsArtifactSchema;
export type GetAccountAxonRemovalsOutput = z.infer<
  typeof GetAccountAxonRemovalsOutputSchema
>;

export const GetAccountPrometheusInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_prometheus.shape.window,
  })
  .strict();
export type GetAccountPrometheusInput = z.infer<
  typeof GetAccountPrometheusInputSchema
>;

export const GetAccountPrometheusOutputSchema = AccountPrometheusArtifactSchema;
export type GetAccountPrometheusOutput = z.infer<
  typeof GetAccountPrometheusOutputSchema
>;

export const GetAccountRegistrationsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_registrations.shape.window,
  })
  .strict();
export type GetAccountRegistrationsInput = z.infer<
  typeof GetAccountRegistrationsInputSchema
>;

export const GetAccountRegistrationsOutputSchema =
  AccountRegistrationsArtifactSchema;
export type GetAccountRegistrationsOutput = z.infer<
  typeof GetAccountRegistrationsOutputSchema
>;

export const GetAccountWeightSettersInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_weight_setters.shape.window,
  })
  .strict();
export type GetAccountWeightSettersInput = z.infer<
  typeof GetAccountWeightSettersInputSchema
>;

export const GetAccountWeightSettersOutputSchema =
  AccountWeightSettersArtifactSchema;
export type GetAccountWeightSettersOutput = z.infer<
  typeof GetAccountWeightSettersOutputSchema
>;

export const GetAccountServingInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_serving.shape.window,
  })
  .strict();
export type GetAccountServingInput = z.infer<
  typeof GetAccountServingInputSchema
>;

export const GetAccountServingOutputSchema = AccountServingArtifactSchema;
export type GetAccountServingOutput = z.infer<
  typeof GetAccountServingOutputSchema
>;

export const GetAccountDeregistrationsInputSchema = z
  .object({
    ss58: ss58Schema(),
    window: RouteQuery_accounts_ss58_deregistrations.shape.window,
  })
  .strict();
export type GetAccountDeregistrationsInput = z.infer<
  typeof GetAccountDeregistrationsInputSchema
>;

export const GetAccountDeregistrationsOutputSchema =
  AccountDeregistrationsArtifactSchema;
export type GetAccountDeregistrationsOutput = z.infer<
  typeof GetAccountDeregistrationsOutputSchema
>;
