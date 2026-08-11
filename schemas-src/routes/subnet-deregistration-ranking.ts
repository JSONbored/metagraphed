// GET /api/v1/chain/deregistration-ranking (#10285) — the order in which the
// chain would deregister subnets to make room for a new registration.
//
// Shape mirrors src/subnet-deregistration-ranking.ts, which implements
// `Subtensor::get_network_to_prune()`; that module is the source of truth and
// this is its contract projection.
import { z } from "zod";
import { ChainStateSchema, FieldSourcesSchema } from "../shared.ts";

export const DeregistrationRankEntrySchema = z
  .object({
    netuid: z.int().min(0),
    // Null for an immune subnet, which has no position in the order at all --
    // rather than a large number, which would read as "last to be pruned" and
    // is a different claim from "cannot be pruned".
    rank: z.int().min(1).nullable(),
    // What the pallet actually compares. Equals `moving_price` except on a
    // Stable subnet, where `get_moving_alpha_price` substitutes a flat 1.0.
    comparison_price: z.number(),
    // The raw storage read, published beside the comparison value so the
    // substitution is visible rather than inferred.
    moving_price: z.number().nullable(),
    registered_at_block: z.int().min(0),
    // 0 = Stable, 1 = Dynamic.
    subnet_mechanism: z.int().min(0),
    immune: z.boolean(),
    /** Block at which immunity lapses. Null once the subnet is prunable. */
    immune_until_block: z.int().min(0).nullable(),
    /** Blocks remaining before it can be pruned; 0 once it can. */
    blocks_until_prunable: z.int().min(0),
  })
  .strict();

export const DEREGISTRATION_RANKING_BODY = {
  // COMPUTED_LIVE with no static file, so no `generated_at` — same shape
  // EmissionPipelineArtifact takes for the same reason.
  schema_version: z.int(),
  chain_state: ChainStateSchema,
  // The block the ordering was COMPUTED at, spread out of `result.ranking` and
  // undeclared until #10790. It is not redundant with `chain_state.block`:
  // this ordering is only valid at one height -- immunity lapses by block, so
  // a reader comparing a cached body against a later head needs to know which
  // height produced it.
  block: z.int().min(0),
  /** Blocks of protection after registration, at this block. */
  network_immunity_period: z.int().min(0),
  // Ordered: index 0 is the subnet the chain would deregister next. Immune
  // subnets are NOT in here -- see `immune`.
  ranked: z.array(DeregistrationRankEntrySchema),
  // Immune subnets, ordered by how soon they lose protection, which is the
  // order in which they JOIN `ranked`. Ordering them by price would imply a
  // pruning position they do not have.
  immune: z.array(DeregistrationRankEntrySchema),
  /** Rank 1's netuid, or null when nothing is prunable. */
  next_to_deregister: z.int().min(0).nullable(),
  ranked_count: z.int().min(0),
  immune_count: z.int().min(0),
  field_sources: FieldSourcesSchema,
} as const;

export const SubnetDeregistrationRankingArtifactSchema = z
  .object(DEREGISTRATION_RANKING_BODY)
  .strict();
export type SubnetDeregistrationRankingArtifact = z.infer<
  typeof SubnetDeregistrationRankingArtifactSchema
>;
