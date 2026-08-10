// The curated address-label registry, as its own published artifact (#10483).
//
//   /metagraph/entities.json -> EntitiesArtifact
//
// The build has written this file since #6737 (scripts/build-artifacts.ts's
// `loadEntities()` passthrough, minus rejected entries) and the Worker has read
// it since #6740 -- but it was never added to PUBLIC_ARTIFACTS, so
// `/metagraph/entities.json` answered `not_found: No public artifact contract
// matched this path` while its sibling `/metagraph/providers.json` served 200.
// The layer existed at both ends and was unreachable in the middle.
//
// WHY THE WHOLE FILE, NOT JUST THE LABEL: `/accounts/{ss58}/entities` answers
// "what is THIS address" and needs a caller to already hold the address. The
// money map (#10440) asks the opposite question -- "which addresses are
// declared treasuries, and for which subnets" -- which is a scan over the
// registry, not a lookup. Without this artifact every consumer of that question
// has to enumerate accounts it cannot enumerate.
//
// The record here is `schemas/entity.schema.json`, which OWNS the shape: that
// file is what a registry contribution is validated against. This is the
// published projection of it, and `validate:schema-vocabularies` now asserts
// the category vocabularies match rather than trusting a comment.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import {
  EntityCategorySchema,
  SubmissionReviewStateSchema,
} from "../shared.ts";

// Why unspendability is established, for `category: "burn"`. Mirrors
// entity.schema.json's own enum; an address with no observed outbound is NOT a
// basis, because absence of spending is not inability to spend.
export const UNSPENDABLE_PROOF_BASIS_VALUES = [
  "known-black-hole",
  "provably-keyless",
  "documented-recycle-call",
] as const;
export const UnspendableProofBasisSchema = z.enum(
  UNSPENDABLE_PROOF_BASIS_VALUES,
);

const UnspendableProofSchema = z
  .object({
    basis: UnspendableProofBasisSchema,
    evidence_url: z.string(),
    note: z.string().optional(),
  })
  .passthrough()
  .describe(
    'Why this address cannot spend what it receives. Required for `category: burn`, because a burn is a CLAIM until proven -- "the team says they burn here" is an operator attestation, not a burn.',
  );

const EntityReviewSchema = z
  .object({
    state: SubmissionReviewStateSchema,
    submitted_by: z.string().optional(),
    submitted_at: z.string().optional(),
    review_notes: z.string().optional(),
  })
  .passthrough()
  .describe(
    "Human-governance axis only, the same shape and meaning as a subnet surface's own `review` block. `rejected` entries are filtered out at build time and never appear here.",
  );

export const EntitySchema = z
  .object({
    schema_version: z.literal(1),
    ss58: z
      .string()
      .describe(
        "The labeled address, checksum-validated against Bittensor's network prefix at build time and identical to its own filename in registry/entities/.",
      ),
    name: z.string(),
    category: EntityCategorySchema,
    netuid: z
      .int()
      .min(0)
      .max(65535)
      .optional()
      .describe(
        "The subnet this address belongs to, when the label is subnet-scoped (a treasury, burn address, or payment collector). Omitted for network-wide entities like an exchange.",
      ),
    unspendable_proof: UnspendableProofSchema.optional(),
    notes: z.string().optional(),
    url: z
      .string()
      .optional()
      .describe(
        "The entity's own canonical homepage, for linking the rendered nametag. Distinct from source_urls: a homepage is not proof of address ownership.",
      ),
    source_urls: z
      .array(z.string())
      .min(1)
      .describe(
        "Independent public proof that this address belongs to this entity -- not that the entity exists, not that the address exists, but that the two are the same thing. See docs/nametag-evidence-bar.md for what clears the bar.",
      ),
    review: EntityReviewSchema,
  })
  .passthrough()
  .describe(
    "One curated address label. There is deliberately no `owner` category: subnet ownership is chain-derived from SubnetOwner and must never be hand-declared.",
  );

export const EntitiesArtifactSchema = ArtifactBaseSchema.extend({
  entities: z
    .array(EntitySchema)
    .describe(
      "Every non-rejected label in registry/entities/, sorted by ss58. An EMPTY array is a real answer, not a cold store: the registry holds only what has cleared the evidence bar, and a curated layer with nothing in it yet is the honest state.",
    ),
}).describe(
  "The curated address-label registry (#6737/#10483): one entry per ss58 that has cleared docs/nametag-evidence-bar.md, each carrying the source_urls that prove the attribution. Mirrors the built /metagraph/entities.json.",
);

export type EntitiesArtifact = z.infer<typeof EntitiesArtifactSchema>;
