// GET /api/v1/chain/turnover (types-epic B batch 6, #8060). Live
// neuron_daily D1-tier data -- no static file. Modeled from
// src/chain-turnover.ts's buildChainTurnover(), cross-checked against the
// hand-edited ChainTurnoverArtifact component it replaces.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const CHAIN_TURNOVER_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

const StabilityDistributionSchema = z
  .object({
    count: z.int().min(0),
    mean: z.number().min(0).max(100),
    min: z.int().min(0).max(100),
    p25: z.int().min(0).max(100),
    median: z.number().min(0).max(100),
    p75: z.int().min(0).max(100),
    p90: z.int().min(0).max(100),
    max: z.int().min(0).max(100),
  })
  .strict()
  .describe(
    "Spread of per-subnet stability score across EVERY subnet in the window (not just the returned page, so the spread stays network-wide when limit truncates the leaderboard).",
  );

export const ChainTurnoverArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(CHAIN_TURNOVER_WINDOW_VALUES).nullable(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .describe("Start snapshot date; null on a cold store."),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .describe("End snapshot date; null on a cold store."),
    comparable: z
      .boolean()
      .describe(
        "False when the window resolved to fewer than two distinct snapshots, so start/end churn is not measurable.",
      ),
    subnet_count: z.int().min(0),
    network: z
      .object({
        validators_start: z.int().min(0),
        validators_end: z.int().min(0),
        validators_entered: z.int().min(0),
        validators_exited: z.int().min(0),
        validator_retention: z
          .number()
          .min(0)
          .max(1)
          .nullable()
          .describe(
            "Jaccard retention of the start set into the end set; null on a cold/non-comparable window.",
          ),
        stability_score: z
          .int()
          .min(0)
          .max(100)
          .nullable()
          .describe(
            "0-100 stability score; null on a cold/non-comparable window.",
          ),
      })
      .strict()
      .describe(
        "Network-wide validator-set rollup: every subnet's validators combined, deduplicated across the network.",
      ),
    stability_distribution: StabilityDistributionSchema.nullable().describe(
      "Null when no subnet had a stability score in the window (nothing to distribute).",
    ),
    subnets: z.array(
      z
        .object({
          netuid: z.int().min(0),
          validators_start: z.int().min(0),
          validators_end: z.int().min(0),
          validators_entered: z.int().min(0),
          validators_exited: z.int().min(0),
          validator_retention: z.number().min(0).max(1).nullable(),
          stability_score: z.int().min(0).max(100).nullable(),
        })
        .strict()
        .describe(
          "One subnet's validator-set churn, ranked by gross churn (entered + exited) then netuid.",
        ),
    ),
  })
  .strict()
  .describe(
    "Network-wide validator-set churn across all subnets (#5686). Mirrors GET /api/v1/chain/turnover's data envelope.",
  );
export type ChainTurnoverArtifact = z.infer<typeof ChainTurnoverArtifactSchema>;
