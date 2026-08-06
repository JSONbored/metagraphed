// get_chain_concentration_history (#9628): the network-wide concentration
// series, mirroring GET /api/v1/chain/concentration/history.
import { z } from "zod";
import { CHAIN_CONCENTRATION_HISTORY_WINDOWS } from "../../src/route-limits.ts";

export const GetChainConcentrationHistoryInputSchema = z
  .object({
    window: z
      .enum(CHAIN_CONCENTRATION_HISTORY_WINDOWS as [string, ...string[]])
      .optional(),
  })
  .strict();
export type GetChainConcentrationHistoryInput = z.infer<
  typeof GetChainConcentrationHistoryInputSchema
>;

export const GetChainConcentrationHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    window: z.string().nullable(),
    point_count: z.int().nullable(),
    oldest_day: z.string().nullable(),
    newest_day: z.string().nullable(),
    builder_versions: z.array(z.int()),
    points: z.array(
      z
        .object({
          day: z.string(),
          neuron_count: z.int().nullable(),
          subnet_count: z.int().nullable(),
          entity_count: z.int().nullable(),
          source_captured_at: z.string().nullable(),
          builder_version: z.int().nullable(),
          uids_per_entity: z.number().nullable(),
          stake: z.object({}).passthrough().nullable(),
          emission: z.object({}).passthrough().nullable(),
          entity_stake: z.object({}).passthrough().nullable(),
          entity_emission: z.object({}).passthrough().nullable(),
          validator_stake: z.object({}).passthrough().nullable(),
        })
        .passthrough(),
    ),
    // Present ONLY on a decline. An empty window is a MEASUREMENT.
    degraded: z
      .object({ reason: z.enum(["unavailable"]) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type GetChainConcentrationHistoryOutput = z.infer<
  typeof GetChainConcentrationHistoryOutputSchema
>;
