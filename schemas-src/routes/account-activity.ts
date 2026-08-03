// GET /api/v1/accounts/{ss58}/serving + .../prometheus + .../stake-moves +
// .../stake-flow (types-epic B batch 4, #8058). Live account_events-stream
// data -- no static file. Modeled from src/account-serving.ts's
// buildAccountServing(), src/account-prometheus.ts's buildAccountPrometheus(),
// src/account-stake-moves.ts's buildAccountStakeMoves(), and
// src/account-stake-flow.ts's buildAccountStakeFlow() -- all four share the
// same per-netuid HHI-concentration-scorecard shape (window + totals +
// concentration + dominant_netuid + a per-subnet breakdown array), driven by
// workers/request-handlers/entities.ts's shared makeAccountEventHandler()
// factory (serving/prometheus/stake-moves; stake-flow is its own handler but
// the same response shape) -- cross-checked against the hand-edited
// AccountServingArtifact/AccountPrometheusArtifact/AccountStakeMovesArtifact/
// AccountStakeFlowArtifact components they replace.
//
// Bucket (c): the per-subnet first_*_at/last_*_at timestamp fields drop
// format:date-time in favor of plain z.string().nullable(), matching this
// epic's established convention. AccountStakeFlowArtifact needed no fix at
// all (diff:openapi-zod reports PASS after cosmetic normalization).
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { EventStreamDegradedSchema } from "./event-stream-honesty.ts";

const WINDOW_ENUM = ["7d", "30d", "90d"] as const;

export const AccountServingArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM).nullable(),
    total_announcements: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          announcements: z.int().min(0),
          first_served_at: z.string().nullable(),
          last_served_at: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AccountServingArtifact = z.infer<
  typeof AccountServingArtifactSchema
>;
export const AccountServingResponseSchema = successEnvelopeSchema(
  AccountServingArtifactSchema,
);
export const AccountServingQuerySchema = z
  .object({ window: z.enum(WINDOW_ENUM).optional() })
  .strict();
export type AccountServingQuery = z.infer<typeof AccountServingQuerySchema>;

export const AccountPrometheusArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM).nullable(),
    total_announcements: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          announcements: z.int().min(0),
          first_announced_at: z.string().nullable(),
          last_announced_at: z.string().nullable(),
        })
        .strict(),
    ),
    // #9307: the chain emits PrometheusServed and our account_events curation
    // drops all 18,041 of them, so this footprint's zero is "we could not
    // look".
    degraded: EventStreamDegradedSchema.optional(),
  })
  .strict();
export type AccountPrometheusArtifact = z.infer<
  typeof AccountPrometheusArtifactSchema
>;
export const AccountPrometheusResponseSchema = successEnvelopeSchema(
  AccountPrometheusArtifactSchema,
);
export const AccountPrometheusQuerySchema = z
  .object({ window: z.enum(WINDOW_ENUM).optional() })
  .strict();
export type AccountPrometheusQuery = z.infer<
  typeof AccountPrometheusQuerySchema
>;

export const AccountStakeMovesArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM).nullable(),
    total_movements: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          movements: z.int().min(0),
          first_moved_at: z.string().nullable(),
          last_moved_at: z.string().nullable(),
          price_tao_at_last_move: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AccountStakeMovesArtifact = z.infer<
  typeof AccountStakeMovesArtifactSchema
>;
export const AccountStakeMovesResponseSchema = successEnvelopeSchema(
  AccountStakeMovesArtifactSchema,
);
export const AccountStakeMovesQuerySchema = z
  .object({ window: z.enum(WINDOW_ENUM).optional() })
  .strict();
export type AccountStakeMovesQuery = z.infer<
  typeof AccountStakeMovesQuerySchema
>;

const FLOW_DIRECTION_ENUM = [
  "accumulating",
  "exiting",
  "churning",
  "idle",
] as const;

export const AccountStakeFlowArtifactSchema = z
  .object({
    schema_version: z.int(),
    address: z.string(),
    window: z.enum(WINDOW_ENUM).nullable(),
    total_staked_tao: z.number(),
    total_unstaked_tao: z.number(),
    net_flow_tao: z.number(),
    gross_flow_tao: z.number(),
    flow_ratio: z.number().nullable(),
    direction: z.enum(FLOW_DIRECTION_ENUM),
    stake_events: z.int().min(0),
    unstake_events: z.int().min(0),
    subnet_count: z.int().min(0),
    concentration: z.number().nullable(),
    dominant_netuid: z.int().min(0).nullable(),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          staked_tao: z.number(),
          unstaked_tao: z.number(),
          net_flow_tao: z.number(),
          gross_flow_tao: z.number(),
          flow_ratio: z.number().nullable(),
          direction: z.enum(FLOW_DIRECTION_ENUM),
          stake_events: z.int().min(0),
          unstake_events: z.int().min(0),
        })
        .strict(),
    ),
  })
  .strict();
export type AccountStakeFlowArtifact = z.infer<
  typeof AccountStakeFlowArtifactSchema
>;
export const AccountStakeFlowResponseSchema = successEnvelopeSchema(
  AccountStakeFlowArtifactSchema,
);
export const AccountStakeFlowQuerySchema = z
  .object({
    window: z.enum(WINDOW_ENUM).optional(),
    direction: z.enum(["all", "in", "out"]).optional(),
  })
  .strict();
export type AccountStakeFlowQuery = z.infer<typeof AccountStakeFlowQuerySchema>;
