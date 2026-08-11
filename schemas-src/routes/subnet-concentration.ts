// GET /api/v1/subnets/{netuid}/concentration + .../concentration/history
// (types-epic B batch 2, #8056). Live neurons/neuron_daily-tier stats -- no
// static file. Modeled from src/concentration.ts's buildConcentration()/
// buildConcentrationHistory(), cross-checked against the hand-edited
// SubnetConcentrationArtifact/SubnetConcentrationHistoryArtifact components
// they replace.
//
// The five lenses USE the shared ConcentrationMetrics component (#10214).
// They held a local copy of it, on the reasoning that the hand-written
// artifact never $ref'd it either and converting it was out of #8056's batch.
// Both reasons were about migration order, not about the shape: the copy was
// byte-identical to the shared one, and being unregistered it inlined five
// more times -- so the published GraphQL schema grew five anonymous twins of
// a type it already had a name for.
import { z } from "zod";
import {
  ConcentrationMetricsSchema,
  subnetHistoryArtifactSchema,
} from "../shared.ts";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_CONCENTRATION_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

export const SubnetConcentrationArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    neuron_count: z.int().min(0),
    entity_count: z
      .int()
      .min(0)
      .describe(
        "Distinct controlling entities (coldkeys) behind the subnet's UIDs.",
      ),
    uids_per_entity: z
      .number()
      .nullable()
      .optional()
      .describe(
        "UIDs per controlling entity -- a Sybil/consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many hotkeys). Null on an empty subnet.",
      ),
    captured_at: z.string().nullable().optional(),
    stake: ConcentrationMetricsSchema.nullable().describe(
      "Stake concentration across all UIDs.",
    ),
    emission: ConcentrationMetricsSchema.nullable().describe(
      "Emission concentration across all UIDs.",
    ),
    entity_stake: ConcentrationMetricsSchema.nullable()
      .optional()
      .describe(
        "Stake concentration collapsed to one holder per controlling entity.",
      ),
    entity_emission: ConcentrationMetricsSchema.nullable()
      .optional()
      .describe(
        "Emission concentration collapsed to one holder per controlling entity.",
      ),
    validator_stake: ConcentrationMetricsSchema.nullable()
      .optional()
      .describe("Stake concentration across permitted validators only."),
  })
  .strict()
  .describe(
    "Per-subnet stake & emission concentration card (#5901) over the current neurons snapshot. Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/concentration.",
  );
export type SubnetConcentrationArtifact = z.infer<
  typeof SubnetConcentrationArtifactSchema
>;

const SubnetConcentrationHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    stake_gini: z.number().nullable().optional(),
    stake_nakamoto_coefficient: z.int().nullable().optional(),
    stake_top_10pct_share: z.number().nullable().optional(),
    emission_gini: z.number().nullable().optional(),
    emission_nakamoto_coefficient: z.int().nullable().optional(),
    emission_top_10pct_share: z.number().nullable().optional(),
  })
  .strict();

export const SubnetConcentrationHistoryArtifactSchema =
  subnetHistoryArtifactSchema(SubnetConcentrationHistoryPointSchema).describe(
    "Per-subnet per-day concentration trend (#5901) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/concentration/history.",
  );
export type SubnetConcentrationHistoryArtifact = z.infer<
  typeof SubnetConcentrationHistoryArtifactSchema
>;
