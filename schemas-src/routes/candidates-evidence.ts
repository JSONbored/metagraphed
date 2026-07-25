// GET /api/v1/candidates, /api/v1/subnets/{netuid}/candidates,
// /api/v1/evidence, /api/v1/subnets/{netuid}/evidence (types-epic B batch 9,
// #8063). Modeled from schemas/components/04-surfaces.schema.json's
// CandidatesArtifact/SubnetCandidatesArtifact and 08-evidence-search-sources
// .schema.json's EvidenceLedgerArtifact/SubnetEvidenceArtifact.
//
// CandidateSurface is ALREADY a registered Zod component (pilot batch,
// subnet-detail.ts) -- reused by import. SourceTier is ALSO already
// registered (pilot batch too) -- same treatment for EvidenceClaim.source_tier.
//
// Bucket (b) finding, both per-subnet routes: SubnetCandidatesArtifact/
// SubnetEvidenceArtifact were hand-declared as bare `$ref` aliases to their
// global counterparts, which drops the real, always-present netuid/slug/name
// fields the real per-subnet builders write (and the global counterparts
// never carry -- mutually exclusive key sets, verified against real built
// artifacts). Modeled as their own distinct shapes instead of aliases, same
// finding/fix as this batch's SubnetSurfacesArtifact/SubnetEndpointsArtifact
// (schemas-src/routes/endpoints-pools.ts) -- a systemic gap across several
// hand-edited `*-subnet` aliases, not unique to any one family.
//
// Bucket (b) finding: EvidenceLedgerArtifact.summary (4 always-present int
// counts) is always set by buildEvidenceLedger() but was never declared --
// silently permitted only via ArtifactBase's additionalProperties:true.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import { CandidateSurfaceSchema, SourceTierSchema } from "./subnet-detail.ts";

// ---- GET /api/v1/candidates -> CandidatesArtifact ----

export const CandidatesArtifactSchema = ArtifactBaseSchema.extend({
  candidates: z.array(CandidateSurfaceSchema),
});
export type CandidatesArtifact = z.infer<typeof CandidatesArtifactSchema>;

// ---- GET /api/v1/subnets/{netuid}/candidates -> SubnetCandidatesArtifact
// (own shape -- see header; NOT a $ref alias to CandidatesArtifact). ----

export const SubnetCandidatesArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  candidates: z.array(CandidateSurfaceSchema),
});
export type SubnetCandidatesArtifact = z.infer<
  typeof SubnetCandidatesArtifactSchema
>;

// ---- GET /api/v1/evidence -> EvidenceLedgerArtifact ----

// Registered below (openapi-registry.ts): generate-client.ts hardcodes
// `export type EvidenceClaim = components["schemas"]["EvidenceClaim"];` --
// must stay a standalone registered component regardless of its single
// $ref referrer (same treatment as CandidateSurface/AdapterArtifact).
export const EvidenceClaimSchema = z
  .object({
    claim: z.string(),
    subject: z.string(),
    // Not always a URL -- real subnet-origin claims carry a registry-
    // relative path (e.g. "registry/native/finney-subnets.json"), verified
    // against a real captured production ledger. z.string(), not z.url().
    source_url: z.string(),
    source_type: z.string(),
    source_tier: SourceTierSchema,
    confidence: z.enum(["low", "medium", "high"]),
    support_summary: z.string(),
    limits: z.string(),
    verified_at: z.string().nullable().optional(),
  })
  .strict();
export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

export const EvidenceLedgerArtifactSchema = ArtifactBaseSchema.extend({
  // Bucket (b): buildEvidenceLedger() always sets summary (4 always-present
  // int counts) -- the hand-edited schema never declared it, silently
  // permitted only via ArtifactBase's additionalProperties:true.
  summary: z
    .object({
      candidate_claim_count: z.int().min(0),
      claim_count: z.int().min(0),
      subnet_claim_count: z.int().min(0),
      surface_claim_count: z.int().min(0),
    })
    .strict(),
  claims: z.array(EvidenceClaimSchema),
});
export type EvidenceLedgerArtifact = z.infer<
  typeof EvidenceLedgerArtifactSchema
>;

// ---- GET /api/v1/subnets/{netuid}/evidence -> SubnetEvidenceArtifact
// (own shape -- see header; NOT a $ref alias to EvidenceLedgerArtifact).
// Real per-subnet builder never sets `summary` either (only the global
// ledger does) -- deliberately not declared here. ----

export const SubnetEvidenceArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  claims: z.array(EvidenceClaimSchema),
});
export type SubnetEvidenceArtifact = z.infer<
  typeof SubnetEvidenceArtifactSchema
>;
