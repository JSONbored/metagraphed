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
//      are exact ratios of observed per-UID sums. Everything carrying the
//      day's split or its `alpha_out_emission` is RECONSTRUCTED over the split
//      `split_source` names: the runtime default before runtime 497, the
//      subnet's own declared split since (MET-7385). `field_sources` states it
//      per field, and the descriptions here say it in prose so a reader of the
//      OpenAPI alone cannot miss it.
//   2. THE DENOMINATION. `*_alpha` is alpha for every non-root subnet despite
//      the `_tao` suffix the underlying column carries. Within one subnet a
//      share is dimensionless and safe; across subnets it is not, and a caller
//      summing alpha across subnets is adding different units.
import { z } from "zod";
import { FieldSourcesSchema, subnetHistoryArtifactSchema } from "../shared.ts";

/** Where a day's split comes from (MET-7385): owned here, imported by every
 * per-day surface that names one. */
export const SPLIT_SOURCE_VALUES = [
  "runtime_default",
  "declared",
  "first_observed",
  "unobserved",
] as const;

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
      description:
        "Emission to non-validator UIDs, alpha-denominated -- the BURN SINK excluded (#11094): the SubnetOwnerHotkey UID carrying the MinerBurned fraction is its own `burned_alpha` leg, so this is what miners actually receive.",
    }),
    burned_alpha: z.number().nullable().optional().meta({
      description:
        "Emission landing on the subnet's burn sink -- the UID holding `SubtensorModule.SubnetOwnerHotkey` while `SubtensorModule.MinerBurned` > 0. It rode the miner leg before #11094, overstating what miners receive by 1/(1-burn); 0 on a subnet that burns nothing.",
    }),
    uid_alpha: z.number().nullable().optional().meta({
      description:
        "Emission across the whole UID set. This is NOT the day's total emission: the subnet owner's cut is paid outside the UID set, so this is the distributable remainder — see `total_alpha`.",
    }),
    validator_share_of_uid: z.number().nullable().optional().meta({
      description:
        "Validator share of the observed per-UID emission. MEASURED and parameter-free — a ratio of two sums this response also publishes. Null when the day emitted nothing, never 0, which would read as 'validators received none of it'.",
    }),
    burned_share_of_uid: z.number().nullable().optional().meta({
      description:
        "burned_alpha / uid_alpha. With `validator_share_of_uid` and `miner_share_of_uid` this sums to 1 over the UID set; null when the day emitted nothing.",
    }),
    miner_share_of_uid: z.number().nullable().optional().meta({
      description: "Miner share of the observed per-UID emission. Measured.",
    }),
    owner_cut: z.number().nullable().optional().meta({
      description:
        "The owner share applied to this day (MET-7385). Before runtime 497 (2026-11-26 on) every subnet's was the runtime default `SubnetOwnerCut`, 11796/65535 — 18%, not 1/6; since, it is the subnet's own SubnetEmissionWeights owner slot, from 0% to 33%. `split_source` says which. Null when the day's split is unobserved.",
    }),
    split_source: z.enum(SPLIT_SOURCE_VALUES).optional().meta({
      description:
        "Which split reconstructed this day: `runtime_default` (a day before runtime 497, paid under the global owner cut), `declared` (the subnet's SubnetEmissionWeights and SubnetGammaEmission in force at the day's end, from the state capture), `first_observed` (a day between the upgrade and the capture's first observation, carried back from the first observed split only where it cannot have differed: it is the default, or the day's UID emission per unit of alpha out matches it) or `unobserved` (no split is known, so every owner, removed, gamma and validator/miner share of the day is null; the measured `*_share_of_uid` ratios are still published).",
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
        "Owner share of the whole day. Reconstructed. `owner_share + removed_share + gamma_share + validator_share + miner_share` sums to 1 within rao precision.",
    }),
    removed_share: z.number().nullable().optional().meta({
      description:
        "The day's burn and recycle slots together: alpha that left circulation rather than reaching anyone (MET-7385). 0 on every day paid under the runtime default. Reconstructed.",
    }),
    gamma_share: z.number().nullable().optional().meta({
      description:
        "The day's gamma shares together: alpha converted into other subnets' gamma for the owner hotkey (MET-7385). 0 on every day paid under the runtime default. Reconstructed.",
    }),
    removed_alpha: z.number().nullable().optional().meta({
      description: "`total_alpha x removed_share`. Reconstructed.",
    }),
    gamma_alpha: z.number().nullable().optional().meta({
      description: "`total_alpha x gamma_share`. Reconstructed.",
    }),
    validator_share: z.number().nullable().optional().meta({
      description:
        "Validator share of the WHOLE day: the day's validator and miner slots together times the MEASURED `validator_share_of_uid` — so it is strictly below that ratio, which is a share of the UID set's emission only. Reconstructed.",
    }),
    tao_usd: z.number().nullable().optional().meta({
      description:
        "The day's last PRICED usd_per_tao observation from the TAO/USD index (#9609) -- the rate every *_usd_day leg below used. Null before the series began (2026-08-02) or on an unpriceable day; the legs are null with it.",
    }),
    total_usd_day: z.number().nullable().optional().meta({
      description:
        "RECONSTRUCTED (#11095): total_alpha x alpha_price_tao x tao_usd. The whole chain of assumptions is visible in this point's own fields; null when any link is. Do not hand-roll this from an assumed split constant -- the shares here are measured.",
    }),
    owner_usd_day: z.number().nullable().optional().meta({
      description: "owner_alpha x alpha_price_tao x tao_usd; null as above.",
    }),
    removed_usd_day: z.number().nullable().optional().meta({
      description: "removed_alpha, priced the same way; null as above.",
    }),
    gamma_usd_day: z.number().nullable().optional().meta({
      description: "gamma_alpha, priced the same way; null as above.",
    }),
    validator_usd_day: z.number().nullable().optional().meta({
      description:
        "The distributable day total x the MEASURED validator_share_of_uid, priced. Null when any input is.",
    }),
    miner_usd_day: z.number().nullable().optional().meta({
      description:
        "What the subnet's miners collectively received that day in USD: the distributable day total x the MEASURED miner_share_of_uid (burn sink excluded), priced through the day's alpha price and TAO/USD rate. THE figure a revenue screen wants, derived from measured shares rather than an assumed constant.",
    }),
    burned_usd_day: z.number().nullable().optional().meta({
      description:
        "The burn sink's leg, priced the same way. What the subnet recycles per day in USD terms.",
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
    .extend({
      miner_earnings: z
        .object({
          earning_miner_count: z.int().min(0).meta({
            description:
              "Miner UIDs that recorded emission on ANY day of the window. A WINDOW count, deliberately not a live one: /chain/concentration/subnets publishes an `earning_miner_count` of its own read off the current snapshot, so the two differ by the miners that earned earlier in the window and do not right now -- and the smaller live number is the one that describes today.",
          }),
          zero_miner_count: z.int().min(0).meta({
            description:
              "Miner UIDs seen in the window that never recorded emission -- published beside the percentiles because on the median subnet this is most of them, and a distribution over earners alone reads as universal income.",
          }),
          p50_alpha_day: z.number().nullable().meta({
            description:
              "The MEDIAN earning miner's alpha per day: their share of the window's summed miner emission (validators and the burn sink excluded) x the basis point's miner_alpha_day. Nearest-rank, so it is a real miner's figure and not an interpolation.",
          }),
          p75_alpha_day: z.number().nullable().meta({
            description:
              "The 75th-percentile earning miner's alpha per day, same derivation as p50.",
          }),
          p90_alpha_day: z.number().nullable().meta({
            description:
              "The 90th-percentile earning miner's alpha per day, same derivation as p50.",
          }),
          top_alpha_day: z.number().nullable().meta({
            description:
              "The single largest earning miner's alpha per day. A ceiling, never a typical figure -- on a concentrated subnet it is multiples of p90.",
          }),
          p50_usd_day: z.number().nullable().meta({
            description:
              "What the MEDIAN earning miner makes per day in USD -- each UID's share of the window's summed miner emission (validators and the burn sink excluded) x the newest point's miner_usd_day. Null when that point's USD chain is (no priced tao-usd day, unknown alpha price).",
          }),
          p75_usd_day: z.number().nullable().meta({
            description:
              "The 75th-percentile earning miner's USD per day, same derivation as p50_usd_day.",
          }),
          p90_usd_day: z.number().nullable().meta({
            description:
              "The 90th-percentile earning miner's USD per day, same derivation as p50_usd_day.",
          }),
          top_usd_day: z.number().nullable().meta({
            description:
              "The single largest earning miner's USD per day. A ceiling, never a typical figure.",
          }),
          basis_date: z.string().nullable().meta({
            description:
              "The point whose per-day legs priced these figures -- the newest in the window.",
          }),
        })
        .strict()
        .nullable()
        .optional()
        .meta({
          description:
            "THE MINER INCOME DISTRIBUTION (#11096): what a miner here actually makes, per day, at p50/p75/p90 and the top earner, in alpha and USD -- shares measured from the window's per-UID emission (burn sink excluded), priced through the newest point's own legs. Null when the window holds no miner UIDs.",
        }),
      field_sources: FieldSourcesSchema.optional(),
    })
    .describe(
      "Per-day split of one subnet's emission by recipient class — owner, validators, miners — over a 7d/30d/90d window, newest first. The validator/miner split is MEASURED from the per-UID neuron_daily rollup; the owner leg and every absolute figure are RECONSTRUCTED, because the owner's cut is paid outside the UID set and `SubnetOwnerCut` is unset on chain. A subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/emission-split/history.",
    );
