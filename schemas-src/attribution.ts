// #10924: how a surface is allowed to talk about who controls a wallet.
//
// Every owner-capture surface in the #10923 epic reads the same on-chain facts
// and then faces the same question: does this coldkey belong to the subnet's
// team? The chain does not answer it. A large nominator behind an owner-run
// validator has at least four innocent explanations before "hidden team
// wallet" -- a custodial exchange staking for many users, a delegation service,
// an unaffiliated whale, a DAO treasury -- and every one of them produces the
// IDENTICAL on-chain shape.
//
// So the vocabulary here is not decoration. `unresolved` is the default and the
// honest answer for most coldkeys, and a verdict above it is only expressible
// with an `evidence` object attached. That pairing is the whole point: a
// publishable claim is one a reader can follow to a page or an extrinsic.
//
// Getting this wrong is not a bug, it is a defamation exposure -- a wrong
// revenue figure is an error, "this team is quietly taking 60%" is not
// retractable once an agent has quoted it. See the published method statement
// at apps/ui/content/docs/attribution-method.mdx, which states the six rules
// this file enforces the shape of.
import { z } from "zod";

/**
 * How confident we are that a coldkey belongs to a subnet's operator.
 *
 * ORDERED WEAKEST FIRST, and `unresolved` is index 0 deliberately: it is the
 * default, not a failure state. A surface that cannot produce `unresolved` for
 * most rows is not measuring, it is guessing.
 *
 * - `unresolved` -- nobody has established a relationship either way. NOT an
 *   accusation, and never to be rendered as a negative.
 * - `third-party` -- positively established as NOT the operator's: a known
 *   exchange, a delegation service, a labelled institution.
 * - `affiliated` -- linked to the operator by evidence, without being the
 *   declared owner key itself (a funding path, a shared identity, a
 *   self-declaration).
 * - `owner` -- the subnet's declared `owner_coldkey` from chain storage. The
 *   only verdict that needs no evidence object, because the chain IS the
 *   evidence.
 */
export const ATTRIBUTION_VERDICT_VALUES = [
  "unresolved",
  "third-party",
  "affiliated",
  "owner",
] as const;
export const AttributionVerdictSchema = z.enum(ATTRIBUTION_VERDICT_VALUES);
export type AttributionVerdict = (typeof ATTRIBUTION_VERDICT_VALUES)[number];

/** The default. Stated as a constant so a surface cannot drift into a
 * different one, and so the choice is greppable. */
export const DEFAULT_ATTRIBUTION_VERDICT: AttributionVerdict = "unresolved";

/**
 * What kind of thing establishes a link.
 *
 * DELIBERATELY NARROW. Timing correlation, similar stake sizes and
 * "registered in the same block" are absent because they are reviewer hints,
 * not publishable evidence -- they are exactly the reasoning that turns a
 * coincidence into an allegation.
 *
 * - `funding-path` -- a transfer from the owner coldkey, cited to the
 *   extrinsic that carried it.
 * - `chain-identity` -- an on-chain identity naming the team.
 * - `self-declared` -- the subnet's own docs, repo or site says so. The
 *   registry already stores these with a `source_url`.
 * - `key-rotation` -- a coldkey swap or hotkey rotation linking the two.
 * - `known-entity` -- a labelled third party (an exchange, a delegation
 *   service). Supports `third-party`, not `affiliated`.
 */
export const ATTRIBUTION_EVIDENCE_KINDS = [
  "funding-path",
  "chain-identity",
  "self-declared",
  "key-rotation",
  "known-entity",
] as const;
export const AttributionEvidenceKindSchema = z.enum(ATTRIBUTION_EVIDENCE_KINDS);

/**
 * One checkable reason for a verdict.
 *
 * `source_url` OR `extrinsic_hash` -- one of the two is required, because an
 * evidence object a reader cannot follow is not evidence. Enforced by the
 * refinement rather than by prose, so a surface cannot construct a claim
 * without a citation.
 */
export const AttributionEvidenceSchema = z
  .object({
    kind: AttributionEvidenceKindSchema,
    source_url: z.string().nullable().optional().meta({
      description:
        "A public page a reader can open — the subnet's own docs, repo or site. Pin a repo citation to a commit SHA; a branch moves under the claim.",
    }),
    extrinsic_hash: z.string().nullable().optional().meta({
      description:
        "The extrinsic that carried the funding path or key rotation, so the link can be re-derived from chain rather than trusted.",
    }),
    observed_at: z.string().meta({
      description:
        "When this was established. Evidence goes stale: a wallet relationship true last quarter may not be true today, and a citation without a date cannot be aged out.",
    }),
  })
  .strict()
  .refine(
    (e) => Boolean(e.source_url) || Boolean(e.extrinsic_hash),
    "evidence needs a source_url or an extrinsic_hash — a claim a reader cannot check is not publishable",
  );

/**
 * A coldkey, its verdict, and why.
 *
 * THE REFINEMENT IS THE RULE. Anything above `unresolved` other than `owner`
 * must carry evidence; `owner` is exempt because it comes from
 * `SubtensorModule.SubnetOwner` and the chain read is itself the citation.
 * Written as a schema constraint rather than a convention so a surface that
 * forgets cannot serialise at all.
 */
export const AttributedColdkeyFields = {
  coldkey: z.string(),
  verdict: AttributionVerdictSchema.default(DEFAULT_ATTRIBUTION_VERDICT),
  evidence: z.array(AttributionEvidenceSchema).default([]),
};

/** The rule itself, as a predicate, so the factory below and the plain schema
 * apply ONE copy of it. `owner` is exempt because the chain read is the
 * evidence; `unresolved` is the default and asserts nothing. */
// Takes `unknown` and narrows, rather than a structural type: the factory
// below applies it to an object whose shape is generic in the caller's extra
// fields, and Zod's inferred output there is not assignable to a hand-written
// interface.
export function verdictIsSupported(row: unknown): boolean {
  const { verdict, evidence } = (row ?? {}) as {
    verdict?: unknown;
    evidence?: unknown;
  };
  return (
    verdict === "unresolved" ||
    verdict === "owner" ||
    (Array.isArray(evidence) && evidence.length > 0)
  );
}

export const ATTRIBUTION_EVIDENCE_REQUIRED_MESSAGE =
  "a verdict above `unresolved` needs at least one evidence entry — see the attribution method statement";

export const AttributedColdkeySchema = z
  .object(AttributedColdkeyFields)
  .strict()
  .refine(verdictIsSupported, ATTRIBUTION_EVIDENCE_REQUIRED_MESSAGE);

/**
 * The same coldkey+verdict+evidence shape, plus whatever a surface measures
 * about it, WITH THE REFINEMENT REAPPLIED.
 *
 * A surface that needs an extra field (a stake share, a flow total) must reach
 * for this rather than re-declaring the three fields beside its own — a
 * re-declared `evidence: z.array(z.unknown())` type-checks, serialises, and
 * silently drops the "a claim a reader cannot check is not publishable" rule
 * that is the entire point of this file.
 */
export function attributedColdkeySchema<T extends z.ZodRawShape>(extra: T) {
  return z
    .object({ ...AttributedColdkeyFields, ...extra })
    .strict()
    .refine(verdictIsSupported, ATTRIBUTION_EVIDENCE_REQUIRED_MESSAGE);
}
