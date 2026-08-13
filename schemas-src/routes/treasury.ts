// GET /api/v1/subnets/{netuid}/treasury (#10933).
//
// The served shape of src/treasury-readings.ts. THE ONE SCHEMA — REST publishes
// it through openapi.json, the MCP tool's outputSchema IS this artifact schema
// by identity, and the GraphQL type is generated from it. The reading and
// evidence shapes are IMPORTED from schemas-src/treasury.ts rather than
// restated, so this surface cannot drift into its own words for what it claims.
//
// THE DESCRIPTIONS CARRY THE SAFETY ARGUMENT. This surface is one careless
// sentence away from "this team is quietly skimming miner emission", so every
// field that could read as an accusation says what it does and does not
// establish — most of all the three states that must not collapse into two.
import { z } from "zod";
import {
  TreasuryEvidenceSchema,
  TreasuryReviewStateSchema,
  TreasuryAppliesToSchema,
} from "../treasury.ts";
import { FieldSourcesSchema } from "../shared.ts";

const ServedReadingSchema = z
  .object({
    review_state: TreasuryReviewStateSchema.meta({
      description:
        "How far this reading has got through the human gate. A `candidate` is a machine reading nobody has checked: its READ STATUS is published (which repo, which commit, when) and its FINDING is not. Only `reviewed` rows publish a share.",
    }),
    evidence: TreasuryEvidenceSchema.extend({
      first_seen: z.string().nullable().optional().meta({
        description:
          "When this repo was first read, preserved across re-reads — so 'we have been watching this since' survives a repo that moves weekly.",
      }),
    }).meta({
      description:
        "The citation. `read_at_sha` is the commit that was HEAD when the repo was read, which is what makes the finding re-derivable by someone who does not trust us.",
    }),
    found: z.boolean().nullable().optional().meta({
      description:
        "Did this read find an allocation? THREE STATES: `true` (found, reviewed), `false` (READ AT A COMMIT AND FOUND NOTHING — a measurement, and the expected answer for most subnets), and `null` (not yet reviewed, so no finding is published). A subnet nobody has read has no reading at all rather than a `false`.",
    }),
    declared_share: z.number().nullable().optional().meta({
      description:
        "The declared allocation as a FRACTION (0..1), never a percentage. Null when the reading found nothing or has not been reviewed.",
    }),
    treasury_address: z.string().nullable().optional(),
    applies_to: TreasuryAppliesToSchema.nullable().optional().meta({
      description:
        "What the allocation is taken out of. Shares with different bases are never summed — a payout fee and an emission cut are not the same quantity.",
    }),
  })
  .strict();

export const SubnetTreasuryArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    netuid: z.int().min(0),
    repos_read: z.int().min(0).meta({
      description:
        "How many of this subnet's registered source repositories have been read. ZERO IS THE IMPORTANT VALUE: it means nobody has looked, which is NOT the same as looking and finding no treasury cut. A card with `repos_read: 0` makes no claim about this subnet at all.",
    }),
    reviewed_count: z.int().min(0),
    pending_review_count: z.int().min(0).meta({
      description:
        "Readings a machine produced that no maintainer has checked. Their findings are deliberately withheld from this payload — a model's or a regex's summary of source code is not evidence.",
    }),
    declared_share: z.number().nullable().optional().meta({
      description:
        "The total REVIEWED allocation taken from miner emission, as a fraction. Null when nothing reviewed applies. A treasury cut written into a public repo is a DISCLOSED BUSINESS MODEL, not a discovery.",
    }),
    observed_share: z.number().nullable().optional().meta({
      description:
        "What the chain shows reaching the owner, from the owner-capture index. Null when it cannot be measured for this subnet.",
    }),
    declared_matches_observed: z.boolean().nullable().optional().meta({
      description:
        "Does the declared allocation agree with what the chain shows? TRI-STATE, and `null` — the comparison was not possible because one side is unread — is the normal answer today. Null must never be rendered as `false`: that reads as 'the team is not doing what they said', which is precisely the claim an unread repo cannot support. AGREEMENT IS THE EXPECTED RESULT and is published as prominently as divergence.",
    }),
    readings: z.array(ServedReadingSchema).meta({
      description:
        "One entry per repository read. An empty list means nobody has read this subnet's sources — not that it takes no treasury cut.",
    }),
    field_sources: FieldSourcesSchema.optional(),
  })
  .strict()
  .describe(
    "What one subnet's own published source says it allocates to a treasury, against what the chain shows. Some subnets take a share of miner emission in their own validator code, applied before emission is ever assigned — that is not a chain event and no indexer can see it. A cut disclosed in a public repo is a BUSINESS MODEL, not a finding, and for most subnets the answer is that declared matches observed. THREE STATES MUST NOT BE COLLAPSED: no reading at all (nobody looked), a reading with `found: false` (read at a commit, found nothing — evidence), and a reading with a share. Machine readings are published as `candidate` with their finding withheld until a maintainer reviews them. Mirrors GET /api/v1/subnets/{netuid}/treasury.",
  );
