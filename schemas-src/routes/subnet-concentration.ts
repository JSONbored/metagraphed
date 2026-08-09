// GET /api/v1/subnets/{netuid}/concentration + .../concentration/history
// (types-epic B batch 2, #8056). Live neurons/neuron_daily-tier stats -- no
// static file. Modeled from src/concentration.ts's buildConcentration()/
// buildConcentrationHistory(), cross-checked against the hand-edited
// SubnetConcentrationArtifact/SubnetConcentrationHistoryArtifact components
// they replace. The inline stake/emission/entity_stake/entity_emission/
// validator_stake lens shape is intentionally NOT the shared
// ConcentrationMetrics component (schemas/components/06-health.schema.json)
// -- the hand-written SubnetConcentrationArtifact never $ref'd it either
// (kept independently inline), and ConcentrationMetrics is still referenced
// by SubnetPerformanceArtifact (a different, not-yet-converted route) --
// touching it is out of this batch's scope.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_CONCENTRATION_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

const ConcentrationLensSchema = z
  .object({
    holders: z.int().min(0).optional(),
    total: z.number().nullable().optional(),
    gini: z.number().nullable().optional(),
    hhi: z.number().nullable().optional(),
    hhi_normalized: z.number().nullable().optional(),
    nakamoto_coefficient: z.int().nullable().optional(),
    top_1pct_share: z.number().nullable().optional(),
    top_5pct_share: z.number().nullable().optional(),
    top_10pct_share: z.number().nullable().optional(),
    top_20pct_share: z.number().nullable().optional(),
    entropy: z.number().nullable().optional(),
    entropy_normalized: z.number().nullable().optional(),
  })
  .passthrough()
  .describe(
    "Concentration metrics over a value distribution -- Gini, HHI (raw + holder-count-normalized), Nakamoto coefficient, top-percentile shares, and Shannon entropy.",
  );

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
    stake: ConcentrationLensSchema.nullable().describe(
      "Stake concentration across all UIDs.",
    ),
    emission: ConcentrationLensSchema.nullable().describe(
      "Emission concentration across all UIDs.",
    ),
    entity_stake: ConcentrationLensSchema.nullable()
      .optional()
      .describe(
        "Stake concentration collapsed to one holder per controlling entity.",
      ),
    entity_emission: ConcentrationLensSchema.nullable()
      .optional()
      .describe(
        "Emission concentration collapsed to one holder per controlling entity.",
      ),
    validator_stake: ConcentrationLensSchema.nullable()
      .optional()
      .describe("Stake concentration across permitted validators only."),
  })
  .passthrough()
  .describe(
    "Per-subnet stake & emission concentration card (#5901) over the current neurons snapshot. Metric blocks are null on a cold/empty subnet. Mirrors GET /api/v1/subnets/{netuid}/concentration.",
  );
export type SubnetConcentrationArtifact = z.infer<
  typeof SubnetConcentrationArtifactSchema
>;
export const SubnetConcentrationResponseSchema = successEnvelopeSchema(
  SubnetConcentrationArtifactSchema,
);

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
  .passthrough();

export const SubnetConcentrationHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: z
      .string()
      .nullable()
      .optional()
      .describe("The resolved window label (7d/30d/90d)."),
    point_count: z.int().min(0),
    points: z.array(SubnetConcentrationHistoryPointSchema),
  })
  .passthrough()
  .describe(
    "Per-subnet per-day concentration trend (#5901) from the neuron_daily rollup, newest first. An empty series (point_count 0) on a cold store, never a GraphQL error. Mirrors GET /api/v1/subnets/{netuid}/concentration/history.",
  );
export type SubnetConcentrationHistoryArtifact = z.infer<
  typeof SubnetConcentrationHistoryArtifactSchema
>;
export const SubnetConcentrationHistoryResponseSchema = successEnvelopeSchema(
  SubnetConcentrationHistoryArtifactSchema,
);
