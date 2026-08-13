// GET /api/v1/subnets/{netuid}/owner-capture (#10929).
//
// The served shape of src/owner-capture.ts. THE ONE SCHEMA -- REST publishes it
// through openapi.json, the MCP tool's outputSchema IS this artifact schema by
// identity (schemas-src/mcp-tools/get-subnet-owner-capture.ts), and the GraphQL
// type is generated from it.
//
// THE DESCRIPTIONS HERE ARE PART OF THE SAFETY ARGUMENT, not decoration. This
// surface answers "how much of a subnet's emission reaches its owner", and an
// agent will quote whatever it is handed. So every field that could be read as
// an accusation carries, in its own description, what it does and does NOT
// establish:
//
//   - `owner_attributed_share` is emission that LANDED on owner-held UIDs. It
//     is not what the owner keeps; that depends on layers this cannot see.
//   - `nominator_share` is a measured fraction of stake. It says nothing about
//     who those nominators are, and a large one is not evidence of anything.
//   - `verdict` is `unresolved` for every coldkey but the declared owner, and
//     `unresolved` is the honest default, never a negative finding.
//
// The verdict vocabulary is IMPORTED from schemas-src/attribution.ts rather
// than restated, so this surface cannot drift into its own set of words for
// what it is claiming.
import { z } from "zod";
import { AttributionVerdictSchema } from "../attribution.ts";
import { FieldSourcesSchema, subnetHistoryArtifactSchema } from "../shared.ts";

const OwnerCapturePointSchema = z
  .object({
    snapshot_date: z.string(),
    neuron_count: z.int().min(0).optional(),
    owner_cut_share: z.number().nullable().optional().meta({
      description:
        "L1 — the protocol owner cut applied to this day. `SubnetOwnerCut` is 11796/65535 (18%, not 1/6) and is UNSET on chain, so this is the runtime default rather than a read. Every subnet pays it and no subnet chooses it.",
    }),
    owner_cut_alpha: z.number().nullable().optional().meta({
      description:
        "The L1 leg in alpha, `total_alpha x owner_cut_share`. RECONSTRUCTED — it is not summed from per-UID rows, because the owner cut is paid outside the UID set entirely.",
    }),
    owner_uid_count: z.int().min(0).nullable().optional().meta({
      description:
        "How many UIDs on this day were held by the declared owner coldkey. NULL when the owner coldkey is unknown — which is a different fact from 0, and 0 is the one that reads as 'the owner runs nothing here'.",
    }),
    owner_uid_alpha: z.number().nullable().optional().meta({
      description:
        "L2 — emission that landed on UIDs held by the owner coldkey. MEASURED from neuron_daily. Alpha-denominated: comparable within one subnet, never across subnets without the price join.",
    }),
    uid_alpha: z.number().nullable().optional().meta({
      description:
        "Emission across the whole UID set on this day. NOT the day's total — the owner cut is paid outside the UID set, so this is the distributable remainder. See `total_alpha`.",
    }),
    total_alpha: z.number().nullable().optional().meta({
      description:
        "The whole day's alpha emission, `alpha_out_emission x 7200 blocks`. RECONSTRUCTED, and the same basis /owner-cut and /emission-split/history use, so the three cannot disagree about what a day of emission is.",
    }),
    owner_attributed_share_of_uid: z.number().nullable().optional().meta({
      description:
        "`owner_uid_alpha / uid_alpha`. MEASURED and parameter-free — a ratio of two observed sums this response also publishes, carrying no owner-cut assumption. Null when the day emitted nothing to any UID, never 0.",
    }),
    owner_attributed_share: z.number().nullable().optional().meta({
      description:
        "L2 as a share of the WHOLE day, `owner_uid_alpha / total_alpha`. RECONSTRUCTED, because the denominator is. ATTRIBUTED, NOT CAPTURED: this is emission that landed on owner-held UIDs, not what the owner ultimately keeps — the stake behind those UIDs (L3) and any application-layer treasury cut (L4) are outside what the chain shows. See `blind_spots`.",
    }),
    owner_combined_share: z.number().nullable().optional().meta({
      description:
        "`owner_cut_share + owner_attributed_share` — the two chain-visible layers over one denominator. Named for the arithmetic it is. It is NOT 'what the owner takes', and a caller reporting it as such is asserting L3 and L4 this surface explicitly does not measure.",
    }),
  })
  .strict();

const OwnerHeldUidSchema = z
  .object({
    uid: z.number().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    validator_permit: z.boolean().optional(),
    emission_tao: z.number().nullable().optional().meta({
      description:
        "This UID's emission on the newest day, alpha-denominated for every non-root subnet despite the column's `_tao` suffix.",
    }),
    take: z.number().nullable().optional().meta({
      description:
        "Validator take/commission (0..1) from SubtensorModule::Delegates. GLOBAL per hotkey, not per subnet. NULL means no Delegates entry at capture — which is not 0%, and must not be rendered as one.",
    }),
    owner_stake_share: z.number().nullable().optional().meta({
      description:
        "Fraction of the stake behind this hotkey held by the owner coldkey itself. Measured from nominator_positions. Null when the position set for this hotkey is not provably whole — see `stake_split_reason`.",
    }),
    nominator_share: z.number().nullable().optional().meta({
      description:
        "`1 - owner_stake_share`: the fraction of this validator's stake that is NOT the owner coldkey's. MEASURED, and published with no interpretation attached. A high value is not evidence of anything — a custodial exchange, a delegation service, an unaffiliated whale and a team wallet all produce this identical shape. Resolving which is L3, and is not done here.",
    }),
    stake_split_reason: z.string().nullable().optional().meta({
      description:
        "Why the stake split is null, when it is. A short sentence rather than a code, because the reasons are not a closed set the caller should branch on.",
    }),
  })
  .strict();

const AttributedStakeholderSchema = z
  .object({
    coldkey: z.string(),
    stake_share: z.number().meta({
      description:
        "This coldkey's summed share of the stake behind the owner's validator UIDs on this subnet. Per-subnet: alpha is a different token per subnet and these fractions are never summed across netuids.",
    }),
    verdict: AttributionVerdictSchema.meta({
      description:
        "From the shared attribution vocabulary. `owner` is the only verdict this surface assigns, because the chain read (SubtensorModule.SubnetOwner) IS its evidence. EVERY OTHER COLDKEY IS `unresolved` — the honest default for a relationship nobody has established, and never to be rendered as a negative finding. Nothing here computes a verdict from stake size, timing or co-registration.",
    }),
    evidence: z.array(z.unknown()).meta({
      description:
        "Always empty on this surface. A verdict above `unresolved` requires an evidence object a reader can follow, and this surface establishes none — see the attribution method statement.",
    }),
  })
  .strict();

const BlindSpotSchema = z
  .object({ layer: z.string(), summary: z.string() })
  .strict();

export const SubnetOwnerCaptureArtifactSchema = subnetHistoryArtifactSchema(
  OwnerCapturePointSchema,
)
  .extend({
    owner_coldkey: z.string().nullable().optional().meta({
      description:
        "The subnet's declared owner coldkey, from SubtensorModule.SubnetOwner. Null when no ownership row has been captured — in which case every owner-derived field is null rather than 0.",
    }),
    owner_uid_count: z.int().min(0).nullable().optional(),
    owner_uids: z.array(OwnerHeldUidSchema).optional().meta({
      description:
        "The owner-held UIDs on the NEWEST day only, and who is staked behind them. Newest-day rather than unioned across the window, because a UID set unioned over a month lists neurons that have since deregistered as though they were current.",
    }),
    attribution: z.array(AttributedStakeholderSchema).optional().meta({
      description:
        "Every coldkey staked behind the owner's validator UIDs, largest share first, each with its verdict. An empty list means no positions were captured, not that nobody is staked.",
    }),
    attribution_vocabulary: z.array(z.string()).optional().meta({
      description:
        "The four defined verdicts, published beside the verdicts themselves so a caller can tell `unresolved` is a state rather than a missing value.",
    }),
    blind_spots: z.array(BlindSpotSchema).optional().meta({
      description:
        "What this measurement cannot see, in the payload rather than only in the docs — because the payload is what gets quoted. Covers the stake behind owner validators (L3), application-layer treasury cuts (L4), and root delegation (L5).",
    }),
    field_sources: FieldSourcesSchema.optional(),
  })
  .describe(
    "How much of one subnet's emission reaches its owner, over a 7d/30d/90d window, newest first — the protocol cut (L1) and emission landing on owner-held UIDs (L2), which are both chain-visible. What the owner ULTIMATELY KEEPS is not published: that depends on the stake behind those validators (L3) and on any application-layer treasury cut (L4), and `blind_spots` states both in the response. Every coldkey but the declared owner reports `verdict: unresolved`, which is the honest default and not a negative finding. A subnet with no daily rollup resolves to a schema-stable empty series (point_count 0), never null. Mirrors GET /api/v1/subnets/{netuid}/owner-capture.",
  );
