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

// ── The stored child-key detail (#13166) ─────────────────────────────────────
// Additive, optional blocks beside the live-RPC graph: the per-hotkey take
// (SubtensorModule.ChildkeyTake), the pending relation queue
// (PendingChildKeys), the parent-keyed threshold bookkeeping
// (ChildkeyThresholdChecks / ChildkeyThresholdSuspended) and the ChildKeys
// capture history, all read from the child-keys store (migration 0054).
// NULL is the decline: the whole block is null while the store is unbound
// (today's deployed Workers) or the read is testnet-addressed (the tables
// carry no network column), and every count inside is NULL over an empty
// list, never a fabricated zero.

export const ChildkeyTakeEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    take: z
      .int()
      .min(0)
      .max(65535)
      .describe(
        "The take this hotkey charges its parents on the subnet, in PerU16 parts of 65535 (SubtensorModule.ChildkeyTake).",
      ),
    take_fraction: z
      .number()
      .describe("The same take pre-divided to a 0..1 float."),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe("One subnet's stored child-key take for the account.");

export const PendingChildKeyEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    child: z.string(),
    proportion: z
      .string()
      .describe(
        "The scheduled stake-weight proportion -- the raw stringified u64 (0..u64::MAX represents 0..100%).",
      ),
    proportion_fraction: z
      .number()
      .describe("The same value pre-divided to a 0..1 float."),
    cool_down_block: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The block the pending relations apply at (SubtensorModule.PendingChildKeys' cool-down). Null when the capture did not carry it.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One scheduled-but-unapplied child relation of the account (SubtensorModule.PendingChildKeys).",
  );

export const ChildkeyThresholdSchema = z
  .object({
    pending_check: z
      .boolean()
      .nullable()
      .describe(
        "Whether the account sits in SubtensorModule.ChildkeyThresholdChecks (stake changed; re-check queued for on_idle). Null when the capture did not carry that map's answer.",
      ),
    suspended: z
      .boolean()
      .nullable()
      .describe(
        "Whether the account sits in SubtensorModule.ChildkeyThresholdSuspended (total stake below StakeThreshold; its child relations stay stored but are inert). Null when the capture did not carry that map's answer -- never a fabricated false.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe("The account's stored child-key threshold bookkeeping.");

export const ChildKeysHistoryEntrySchema = z
  .object({
    netuid: z.int().min(0).max(65535),
    parent: z.string(),
    child: z.string(),
    proportion: z
      .string()
      .describe("The raw stringified u64 proportion at the capture."),
    proportion_fraction: z
      .number()
      .describe("The same value pre-divided to a 0..1 float."),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One captured (parent, netuid, child, proportion) relation observation from the ChildKeys history.",
  );

export const ChildKeyDetailSchema = z
  .object({
    takes: z
      .array(ChildkeyTakeEntrySchema)
      .describe("The account's own per-subnet take rows, ordered by netuid."),
    take_count: z.int().min(1).nullable(),
    pending: z
      .array(PendingChildKeyEntrySchema)
      .describe(
        "The account's scheduled child relations, ordered by (netuid, child).",
      ),
    pending_count: z.int().min(1).nullable(),
    threshold: ChildkeyThresholdSchema.nullable().describe(
      "The account's threshold bookkeeping, null when the capture holds none.",
    ),
    history: z
      .array(ChildKeysHistoryEntrySchema)
      .describe(
        "The account's parent-keyed relation history, newest capture first, store-capped.",
      ),
    history_count: z.int().min(1).nullable(),
  })
  .strict()
  .describe(
    "The stored child-key detail beside the live children graph (#13166): takes, the pending queue, threshold bookkeeping and capture history, from the child-keys store. Every count is NULL over an empty list until the engine's child-key capture lands.",
  );

export const ParentKeyDetailSchema = z
  .object({
    takes: z
      .array(ChildkeyTakeEntrySchema)
      .describe("The account's own per-subnet take rows, ordered by netuid."),
    take_count: z.int().min(1).nullable(),
    history: z
      .array(ChildKeysHistoryEntrySchema)
      .describe(
        "The account's child-keyed relation history, newest capture first, store-capped.",
      ),
    history_count: z.int().min(1).nullable(),
  })
  .strict()
  .describe(
    "The stored child-key detail beside the live parents graph (#13166): the account's takes and its child-keyed capture history. The pending queue and threshold bookkeeping are parent-keyed state and live on the children surface.",
  );

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
    // #13166: the stored detail beside the live graph -- additive and
    // optional, null until the engine's child-key capture lands (and on any
    // testnet-addressed read; the tables are mainnet-only).
    child_key_detail: ChildKeyDetailSchema.nullable().optional(),
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
    // #13166: the stored detail beside the live graph -- additive and
    // optional, null until the engine's child-key capture lands (and on any
    // testnet-addressed read; the tables are mainnet-only).
    child_key_detail: ParentKeyDetailSchema.nullable().optional(),
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
