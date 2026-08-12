// GET /api/v1/subnets/{netuid}/emission-split/history (#10928).
//
// The served shape of src/emission-split.ts. THE ONE SCHEMA -- REST publishes
// it through openapi.json, the MCP tool's outputSchema IS this artifact schema
// by identity (schemas-src/mcp-tools/get-subnet-emission-split-history.ts), and
// the GraphQL type is generated from it. A field renamed here is a compile
// error on all three surfaces rather than a drift nobody notices.
//
// Two things the schema has to carry that a naive response would drop:
//
//   1. WHICH HALF IS MEASURED. `validator_share_of_uid` / `miner_share_of_uid`
//      are exact ratios of observed per-UID sums. Everything carrying the owner
//      cut or a day's `alpha_out_emission` is RECONSTRUCTED over a runtime
//      default -- `SubnetOwnerCut` is unset on chain. `field_sources` states it
//      per field, and the descriptions here say it in prose so a reader of the
//      OpenAPI alone cannot miss it.
//   2. THE DENOMINATION. `*_alpha` is alpha for every non-root subnet despite
//      the `_tao` suffix the underlying column carries. Within one subnet a
//      share is dimensionless and safe; across subnets it is not, and a caller
//      summing alpha across subnets is adding different units.
import { z } from "zod";
import { FieldSourcesSchema, subnetHistoryArtifactSchema } from "../shared.ts";

const SubnetEmissionSplitPointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    validator_count: z.int().min(0).optional(),
    miner_count: z.int().min(0).optional(),
    earning_validator_count: z.int().min(0).optional().meta({
      description:
        "Validator-permit UIDs that recorded emission above zero on this day.",
    }),
    earning_miner_count: z.int().min(0).optional().meta({
      description:
        "Non-validator UIDs that recorded emission above zero on this day. Against `miner_count` this is how many registered miners earned anything at all — the median subnet has almost none, and a miner count read alone overstates participation.",
    }),
    validator_alpha: z.number().nullable().optional().meta({
      description:
        "Emission to validator-permit UIDs. ALPHA-denominated for every non-root subnet — safe to compare within one subnet, never across subnets without the price join.",
    }),
    miner_alpha: z.number().nullable().optional().meta({
      description: "Emission to non-validator UIDs, alpha-denominated.",
    }),
    uid_alpha: z.number().nullable().optional().meta({
      description:
        "Emission across the whole UID set. This is NOT the day's total emission: the subnet owner's cut is paid outside the UID set, so this is the distributable remainder — see `total_alpha`.",
    }),
    validator_share_of_uid: z.number().nullable().optional().meta({
      description:
        "Validator share of the observed per-UID emission. MEASURED and parameter-free — a ratio of two sums this response also publishes. Null when the day emitted nothing, never 0, which would read as 'validators received none of it'.",
    }),
    miner_share_of_uid: z.number().nullable().optional().meta({
      description: "Miner share of the observed per-UID emission. Measured.",
    }),
    owner_cut: z.number().nullable().optional().meta({
      description:
        "The owner share applied to this day. `SubnetOwnerCut` is 11796/65535 — 18%, not 1/6 — and is UNSET on chain, so this is the runtime default rather than a read. Published so a reader can see which constant produced the reconstructed fields.",
    }),
    total_alpha: z.number().nullable().optional().meta({
      description:
        "The whole day's alpha emission: `alpha_out_emission x 7200 blocks`. RECONSTRUCTED. Null when the day's snapshot carries no `alpha_out_emission` — the measured legs are still published beside it, because a validator/miner split is a real answer even when the day's total is not known.",
    }),
    owner_alpha: z.number().nullable().optional().meta({
      description:
        "The owner leg, `total_alpha x owner_cut`. RECONSTRUCTED. It is NOT summed from the rows — the owner cut is paid outside the UID set, so no per-UID row carries it.",
    }),
    owner_share: z.number().nullable().optional().meta({
      description:
        "Owner share of the whole day. Reconstructed. `owner_share + validator_share + miner_share` sums to 1 within rao precision.",
    }),
    validator_share: z.number().nullable().optional().meta({
      description:
        "Validator share of the WHOLE day, owner leg included — so it is strictly below `validator_share_of_uid`, which is a share of the distributable remainder only. Reconstructed.",
    }),
    miner_share: z.number().nullable().optional().meta({
      description: "Miner share of the whole day. Reconstructed.",
    }),
    alpha_price_tao: z.number().nullable().optional().meta({
      description:
        "The day's alpha price in TAO, from the same daily snapshot. This is `SubnetMovingPrice`, the chain's emission-weighting average — not a traded mark.",
    }),
    total_tao: z.number().nullable().optional().meta({
      description:
        "`total_alpha` priced through `alpha_price_tao`. Reconstructed, and null whenever either input is.",
    }),
  })
  .strict();

export const SubnetEmissionSplitHistoryArtifactSchema =
  subnetHistoryArtifactSchema(SubnetEmissionSplitPointSchema)
    .extend({ field_sources: FieldSourcesSchema.optional() })
    .describe(
      "Per-day split of one subnet's emission by recipient class — owner, validators, miners — over a 7d/30d/90d window, newest first. The validator/miner split is MEASURED from the per-UID neuron_daily rollup; the owner leg and every absolute figure are RECONSTRUCTED, because the owner's cut is paid outside the UID set and `SubnetOwnerCut` is unset on chain. A subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/emission-split/history.",
    );
export type SubnetEmissionSplitHistoryArtifact = z.infer<
  typeof SubnetEmissionSplitHistoryArtifactSchema
>;
