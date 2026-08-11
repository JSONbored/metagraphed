// GET /api/v1/chain/concentration (types-epic B batch 6, #8060). Live
// neurons D1-tier data -- no static file. Modeled from src/concentration.ts's
// buildChainConcentration() (which reuses computeConcentration(), the exact
// function ConcentrationMetricsSchema in shared.ts models, from types-epic B
// batch 3/#8057), cross-checked against the hand-edited
// ChainConcentrationArtifact component it replaces.
import { z } from "zod";
import { ConcentrationMetricsSchema } from "../shared.ts";

export const ChainConcentrationArtifactSchema = z
  .object({
    schema_version: z.int(),
    subnet_count: z
      .int()
      .min(0)
      .describe("Distinct subnets the snapshot spans."),
    neuron_count: z.int().min(0),
    entity_count: z
      .int()
      .min(0)
      .describe(
        "Distinct controlling entities (coldkeys) network-wide, collapsed across subnets.",
      ),
    uids_per_entity: z
      .number()
      .nullable()
      .describe(
        "UIDs per controlling entity network-wide -- a consolidation signal (1.0 = every UID a distinct owner; higher = fewer operators each running many). Null when no entities.",
      ),
    captured_at: z.string().nullable(),
    // NULLABLE, and this card's own description already said so -- "Metric
    // blocks are null on a cold/empty store" -- while all five promised
    // non-null (#10786).
    //
    // The PRODUCER is right. `computeConcentration` (src/concentration.ts)
    // returns `ConcentrationScorecard | null` and answers null when no value in
    // the population is positive, so a cold store or an all-zero network has no
    // scorecard to report. The HISTORY variant of this same card
    // (chain-concentration-history.ts) has carried `.nullable()` on all five
    // since it was written -- one shape, two schemas, and only one of them
    // true.
    stake: ConcentrationMetricsSchema.nullable().describe(
      "Raw stake concentration across every neuron network-wide; null on a cold or all-zero store.",
    ),
    emission: ConcentrationMetricsSchema.nullable().describe(
      "Raw emission concentration across every neuron network-wide; null on a cold or all-zero store.",
    ),
    entity_stake: ConcentrationMetricsSchema.nullable().describe(
      "Stake concentration per controlling entity -- hotkeys collapsed across subnets, so one operator counts once.",
    ),
    entity_emission: ConcentrationMetricsSchema.nullable().describe(
      "Emission concentration per controlling entity -- hotkeys collapsed across subnets.",
    ),
    validator_stake: ConcentrationMetricsSchema.nullable().describe(
      "Stake concentration across permitted validators network-wide only; null when no permitted validator carries stake.",
    ),
  })
  .strict()
  .describe(
    "Network-wide stake & emission decentralization card (#5872). Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/concentration.",
  );
export type ChainConcentrationArtifact = z.infer<
  typeof ChainConcentrationArtifactSchema
>;
