// GET /api/v1/subnets/{netuid}/wallets and /subnets/{netuid}/owner-cut (#10488).
//
// The served shape of the money map. Three things the schema has to carry that
// a naive response would drop, each of which is the difference between a number
// and an allegation:
//
//   1. EVERY DECLARED WALLET CARRIES ITS source_urls IN THE RESPONSE. A
//      consumer reading "SN X's treasury is 5abc…" must be able to check that
//      attribution without a second call. An agent that reports it without the
//      evidence is making an unsourced allegation on our behalf.
//   2. `owner` IS CHAIN-DERIVED AND VISIBLY DIFFERENT. It is read from
//      SubnetOwner, never declared, and a consumer must be able to tell it from
//      a human attribution without knowing our schema -- hence an explicit
//      flag rather than an absent source_urls being the tell.
//   3. `unresolved` SERIALISES DISTINCTLY FROM 0. Given #10481 it may be the
//      majority state at launch, and a null-vs-zero conflation here says "this
//      owner kept nothing" about a subnet we simply could not measure.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";
import { FieldSourcesSchema } from "../shared.ts";

const WALLET_ROLE_VALUES = [
  "owner",
  "treasury",
  "burn",
  "payment-collector",
  "multisig",
] as const;
const WalletRoleSchema = z.enum(WALLET_ROLE_VALUES);

const WalletLegSchema = z
  .object({
    denomination: z.enum(["tao", "alpha"]),
    netuid: z.int().min(0).nullable().meta({
      description:
        "Null for TAO. Alpha legs always carry one, because alpha is a different token per subnet and two alpha figures only combine when they share a netuid.",
    }),
    in: z.number(),
    out: z.number(),
    net: z.number().meta({
      description:
        "in - out. Negative is a real answer about a treasury: more left than arrived.",
    }),
    events: z.int().min(0),
  })
  .strict();

const WalletActivitySchema = z
  .object({
    legs: z.array(WalletLegSchema).meta({
      description:
        "One leg per (denomination, netuid). Deliberately NOT summed into a single value: TAO and alpha are different tokens, and a combined figure would be a unit error dressed as a total.",
    }),
    event_count: z.int().min(0),
    first_observed_at: z.string().nullable(),
    last_observed_at: z.string().nullable(),
    skipped: z
      .array(z.object({ reason: z.string(), count: z.int().min(0) }).strict())
      .meta({
        description:
          "Rows that could not be placed on a leg, with the reason. Published rather than dropped: a quietly discarded movement makes a net figure look complete when it is not.",
      }),
  })
  .strict();

const SubnetWalletSchema = z
  .object({
    ss58: z.string(),
    role: WalletRoleSchema,
    chain_derived: z.boolean().meta({
      description:
        "TRUE for `owner`, which is read from SubtensorModule.SubnetOwner and can never be hand-declared. FALSE for every other role, which is a human attribution backed by source_urls. A consumer must be able to tell these apart without knowing our schema.",
    }),
    name: z.string().nullable().optional(),
    source_urls: z.array(z.string()).meta({
      description:
        "The evidence that this address belongs to this entity. EMPTY for a chain-derived owner, which needs none. Never empty for a declared role -- the registry refuses an entry without it.",
    }),
    unspendable_proof_basis: z.string().nullable().optional().meta({
      description:
        "For `burn` only: how unspendability was established. A burn is a CLAIM until proven, and an address with no observed outbound is not a basis.",
    }),
    activity: WalletActivitySchema,
  })
  .strict();

export const SubnetWalletsArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0).max(65535),
  window_days: z.int().min(1),
  wallet_count: z.int().min(0),
  wallets: z.array(SubnetWalletSchema),
  field_sources: FieldSourcesSchema,
}).describe(
  "One subnet's declared wallets with their roles, evidence and per-window activity. `owner` is chain-derived from SubnetOwner and flagged as such; every other role is a human attribution and carries the source_urls that prove it, in the response rather than only in the registry. An empty list means nothing has been attributed for this subnet — not that nothing exists. Mirrors GET /api/v1/subnets/{netuid}/wallets.",
);

const OwnerCutAccrualSchema = z
  .object({
    owner_cut: z.number().nullable().meta({
      description:
        "The share applied, echoed so a reader never has to assume 18%. Null when SubnetOwnerCut could not be resolved — the storage item is unset on chain and the runtime default is used, so a null here means even that failed.",
    }),
    alpha: z.number().nullable(),
    tao: z.number().nullable(),
    usd: z.number().nullable(),
    accrues: z.boolean(),
    reason: z.string().nullable().meta({
      description:
        "Why the figures are null or zero. A subnet with owner_cut_enabled false accrues a REAL zero with a stated reason; an unread price or emission is null instead.",
    }),
  })
  .strict();

const OwnerCutDispositionSchema = z
  .object({
    accrued_alpha: z.number().nullable().meta({
      description:
        "What the buckets are accounting for. Null when the accrual itself could not be measured, in which case nothing is attributed to it.",
    }),
    buckets: z
      .object({
        "held-as-stake": z.number().nullable(),
        unstaked: z.number().nullable(),
        "transferred-out": z.number().nullable(),
        burned: z.number().nullable(),
        unresolved: z.number().nullable(),
      })
      .strict()
      .meta({
        description:
          "Five buckets, not six. On dTAO, StakeRemoved takes alpha out of the AMM pool and returns TAO, so removing stake IS the disposal — a separate `sold` bucket would be a distinction the chain cannot evidence. NULL is not 0: null means unresolved or unread, and may be the majority state.",
      }),
    residual_alpha: z.number().nullable().meta({
      description:
        "accrued minus everything accounted for. Reported rather than balanced away: assigning the remainder so the totals tie would turn 'we cannot account for this' into a number that looks derived. A NEGATIVE residual means the parts exceed the whole and is reported, never clamped.",
    }),
    reconciles: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();

export const SubnetOwnerCutArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0).max(65535),
  window_days: z.int().min(1),
  owner_coldkey: z.string().nullable(),
  owner_hotkey: z.string().nullable(),
  accrual: OwnerCutAccrualSchema,
  disposition: OwnerCutDispositionSchema,
  field_sources: FieldSourcesSchema,
}).describe(
  "One subnet's owner-cut accrual and what became of it. The cut is 18% (SubnetOwnerCut is 11796/65535, not one sixth) and is paid as STAKE rather than a liquid balance — so a disposition derived from transfers alone would report 'held' for every subnet, and absence of flow evidence resolves to `unresolved` instead. Mirrors GET /api/v1/subnets/{netuid}/owner-cut.",
);
