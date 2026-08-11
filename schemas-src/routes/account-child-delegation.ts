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
import { FieldSourcesSchema } from "../shared.ts";

const ChildDelegationEntrySchema = z
  .object({
    child: z.string().nullable(),
    proportion: z.string(),
    proportion_fraction: z.number(),
  })
  .strict()
  .describe(
    "One child hotkey's delegated-stake proportion on a subnet. proportion is the raw stringified u64 (0..u64::MAX represents 0..100%); proportion_fraction is the same value pre-divided to a 0..1 float.",
  );

const ChildDelegationSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    entries: z.array(ChildDelegationEntrySchema),
  })
  .strict()
  .describe(
    "One subnet's child-hotkey delegation entries in an account's live children graph.",
  );

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
  .strict()
  .describe(
    "Live child-hotkey delegation graph (#6723) for one Finney ss58 account, read directly from chain via RPC (KV-cached). subnets is null on RPC failure, distinct from a confirmed-empty [] (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/children.",
  );
export type AccountChildrenArtifact = z.infer<
  typeof AccountChildrenArtifactSchema
>;

const ParentDelegationEntrySchema = z
  .object({
    parent: z.string().nullable(),
    proportion: z.string(),
    proportion_fraction: z.number(),
  })
  .strict()
  .describe(
    "One parent hotkey's delegated-stake proportion on a subnet. proportion is the raw stringified u64 (0..u64::MAX represents 0..100%); proportion_fraction is the same value pre-divided to a 0..1 float.",
  );

const ParentDelegationSubnetSchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    entries: z.array(ParentDelegationEntrySchema),
  })
  .strict()
  .describe(
    "One subnet's parent-hotkey delegation entries in an account's live parents graph.",
  );

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
  .strict()
  .describe(
    "Live parent-hotkey delegation graph (#6723) for one Finney ss58 account, read directly from chain via RPC (KV-cached). subnets is null on RPC failure, distinct from a confirmed-empty [] (schema-stable, never a GraphQL error). Mirrors GET /api/v1/accounts/{ss58}/parents.",
  );
export type AccountParentsArtifact = z.infer<
  typeof AccountParentsArtifactSchema
>;
