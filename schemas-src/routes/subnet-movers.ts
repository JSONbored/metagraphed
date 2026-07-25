// GET /api/v1/subnets/movers (types-epic B batch 2, #8056). Live
// neuron_daily-tier cross-subnet leaderboard -- no static file. Modeled
// from src/movers.ts's buildMovers()/buildNetworkSummary(), cross-checked
// against the hand-edited SubnetMoversArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

// Cumulative totals are never negative; a boundary delta genuinely can be
// (network stake/emission can net-decrease over a window) -- two separate
// patterns, matching the hand-written original exactly rather than loosening
// the totals to accept a sign they can never carry.
const RaoPrecisionTaoStringSchema = z.string().regex(/^\d+\.\d{9}$/);
const SignedRaoPrecisionTaoStringSchema = z.string().regex(/^-?\d+\.\d{9}$/);

const MoversNetworkSummarySchema = z
  .object({
    total_stake_start_tao: RaoPrecisionTaoStringSchema,
    total_stake_end_tao: RaoPrecisionTaoStringSchema,
    total_stake_delta_tao: SignedRaoPrecisionTaoStringSchema,
    total_emission_start_tao: RaoPrecisionTaoStringSchema,
    total_emission_end_tao: RaoPrecisionTaoStringSchema,
    total_emission_delta_tao: SignedRaoPrecisionTaoStringSchema,
    total_validators_start: z.int().min(0),
    total_validators_end: z.int().min(0),
    total_validators_delta: z.int(),
    gainers: z.int().min(0),
    losers: z.int().min(0),
    unchanged: z.int().min(0),
  })
  .strict();

const MoverEntrySchema = z
  .object({
    netuid: z.int().min(0),
    stake_start_tao: z.number(),
    stake_end_tao: z.number(),
    stake_delta_tao: z.number(),
    stake_pct_change: z.number().nullable(),
    stake_share_pct: z.number().min(0).max(100).nullable(),
    emission_start_tao: z.number(),
    emission_end_tao: z.number(),
    emission_delta_tao: z.number(),
    emission_pct_change: z.number().nullable(),
    emission_share_pct: z.number().min(0).max(100).nullable(),
    validators_start: z.int().min(0),
    validators_end: z.int().min(0),
    validators_delta: z.int(),
    neurons_start: z.int().min(0),
    neurons_end: z.int().min(0),
    neurons_delta: z.int(),
  })
  .strict();

export const SubnetMoversArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(["7d", "30d", "90d"]).nullable(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    sort: z.enum(["stake", "emission", "validators", "neurons"]),
    subnet_count: z.int().min(0),
    network: MoversNetworkSummarySchema,
    movers: z.array(MoverEntrySchema),
  })
  .strict();
export type SubnetMoversArtifact = z.infer<typeof SubnetMoversArtifactSchema>;
export const SubnetMoversResponseSchema = successEnvelopeSchema(
  SubnetMoversArtifactSchema,
);

export const SubnetMoversQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
    sort: z.enum(["stake", "emission", "validators", "neurons"]).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type SubnetMoversQuery = z.infer<typeof SubnetMoversQuerySchema>;
