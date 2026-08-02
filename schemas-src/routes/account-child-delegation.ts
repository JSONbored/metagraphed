// GET /api/v1/accounts/{ss58}/children + .../parents (types-epic B batch 5,
// #8059). Live finney RPC (ChildKeys/ParentKeys storage maps), 120s
// KV-cached -- no static file. Modeled from src/child-hotkey-delegation.ts's
// loadAccountChildren()/loadAccountParents() (both share the same
// ChildHotkeyGraphResult shape internally), cross-checked against the
// hand-edited AccountChildrenArtifact/AccountParentsArtifact components they
// replace.
//
// ChildDelegationEntry/ChildDelegationSubnet/ParentDelegationEntry/
// ParentDelegationSubnet are intentionally NOT registered as shared
// components -- each is referenced only by the one hand-edited component
// this batch replaces (verified via repo-wide $ref grep), so all four
// hand-edited component keys become fully orphaned.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

const ChildDelegationEntrySchema = z
  .object({
    child: z.string().nullable(),
    proportion: z.string(),
    proportion_fraction: z.number(),
  })
  .strict();

const ChildDelegationSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    entries: z.array(ChildDelegationEntrySchema),
  })
  .strict();

export const AccountChildrenArtifactSchema = z
  .object({
    schema_version: z.int(),
    account: z.string(),
    subnets: z.array(ChildDelegationSubnetSchema).nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type AccountChildrenArtifact = z.infer<
  typeof AccountChildrenArtifactSchema
>;
export const AccountChildrenResponseSchema = successEnvelopeSchema(
  AccountChildrenArtifactSchema,
);
export const AccountChildrenQuerySchema = z.object({}).strict();
export type AccountChildrenQuery = z.infer<typeof AccountChildrenQuerySchema>;

const ParentDelegationEntrySchema = z
  .object({
    parent: z.string().nullable(),
    proportion: z.string(),
    proportion_fraction: z.number(),
  })
  .strict();

const ParentDelegationSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    entries: z.array(ParentDelegationEntrySchema),
  })
  .strict();

export const AccountParentsArtifactSchema = z
  .object({
    schema_version: z.int(),
    account: z.string(),
    subnets: z.array(ParentDelegationSubnetSchema).nullable().optional(),
    queried_at: z.string().nullable().optional(),
    // #9108. Required: attached outside the KV cache on every read, so no
    // response shape legitimately lacks it.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type AccountParentsArtifact = z.infer<
  typeof AccountParentsArtifactSchema
>;
export const AccountParentsResponseSchema = successEnvelopeSchema(
  AccountParentsArtifactSchema,
);
export const AccountParentsQuerySchema = z.object({}).strict();
export type AccountParentsQuery = z.infer<typeof AccountParentsQuerySchema>;
