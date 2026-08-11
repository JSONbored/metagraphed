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
    stake: ConcentrationMetricsSchema.describe(
      "Raw stake concentration across every neuron network-wide.",
    ),
    emission: ConcentrationMetricsSchema.describe(
      "Raw emission concentration across every neuron network-wide.",
    ),
    entity_stake: ConcentrationMetricsSchema.describe(
      "Stake concentration per controlling entity -- hotkeys collapsed across subnets, so one operator counts once.",
    ),
    entity_emission: ConcentrationMetricsSchema.describe(
      "Emission concentration per controlling entity -- hotkeys collapsed across subnets.",
    ),
    validator_stake: ConcentrationMetricsSchema.describe(
      "Stake concentration across permitted validators network-wide only.",
    ),
  })
  .passthrough()
  .describe(
    "Network-wide stake & emission decentralization card (#5872). Metric blocks are null on a cold/empty store. Mirrors GET /api/v1/chain/concentration.",
  );
export type ChainConcentrationArtifact = z.infer<
  typeof ChainConcentrationArtifactSchema
>;
