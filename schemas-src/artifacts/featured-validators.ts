// registry/featured-validators.json -> the `featured` badge on validator rows.
//
// COMMERCIAL CURATION, NOT A CHAIN FACT. Every other input to a validator row is
// derived from the chain or probed from an endpoint. This one is a list of
// hotkeys we have a partnership, sponsorship or agreement with, and it is
// maintained by hand.
//
// That is why it lives in the registry rather than in a table someone can edit
// live: a commercial relationship should be reviewable, attributable to a pull
// request, and auditable after the fact. "Who was featured, from when, and who
// added them" is a question this shape can answer and a mutable side table
// cannot.
//
// It was previously a Postgres side table that no producer wrote and no reader
// read, so `featured` was served on every validator row and was permanently
// false -- a badge for paying partners that could not be true (#11080).
import { z } from "zod";

/** How the featured relationship arose. Open on purpose -- these are commercial
 * arrangements and the vocabulary will grow before the schema does. Recorded so
 * a consumer can tell a paid placement from an editorial one rather than
 * inferring it from a bare boolean. */
const FeaturedRelationshipSchema = z
  .enum(["partner", "sponsor", "agreement"])
  .describe(
    "The nature of the arrangement. `featured` on the wire is a boolean, but the reason is recorded here so the badge is not an unexplained quality signal.",
  );

const FeaturedValidatorSchema = z
  .object({
    hotkey: z
      .string()
      .min(1)
      .describe(
        "SS58 hotkey. Matched against a neuron's hotkey, so it is the identity the chain uses, not a display name.",
      ),
    featured_at: z.iso
      .datetime()
      .describe(
        "When the arrangement began, UTC. Kept as an instant rather than a date because it is contractual: the badge is either live at a given moment or it is not.",
      ),
    relationship: FeaturedRelationshipSchema,
  })
  .strict();

export const FeaturedValidatorsFileSchema = z
  .object({
    schema_version: z.literal(1),
    featured: z
      .array(FeaturedValidatorSchema)
      .describe(
        "Every currently featured validator. Removing an entry ends the badge; there is no `active` flag, because a list that carries its own tombstones is one where an expired arrangement can be served by mistake.",
      ),
  })
  .strict();
