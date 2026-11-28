// GET /api/v1/subnets/{netuid}/emission-split (MET-7365, runtime spec 497).
// One subnet's emission split as the chain declares it -- the five fixed
// slots SubtensorModule.SubnetEmissionWeights holds and the gamma shares
// SubnetGammaEmission holds -- with its lifecycle state (SubnetState,
// SubnetEpochConsensus, SubnetCreatedViaLease) and the validity-range history
// of both, served live from state.subnet_emission_splits and
// state.subnet_lifecycle_states (migration 0060).
import { z } from "zod";

const PARTS = /^(0|[1-9][0-9]{0,19})$/;
const partsSchema = (what: string) =>
  z
    .string()
    .regex(PARTS)
    .describe(
      `${what} in the runtime's exact u64 parts of u64::MAX (18446744073709551615), as decimal text.`,
    );
const shareSchema = (what: string) =>
  z
    .number()
    .min(0)
    .max(1)
    .describe(
      `${what} as a fraction of the subnet's emission, rounded to nine places; \`parts\` holds the exact value.`,
    );

export const EmissionSlotPartsSchema = z
  .object({
    burn: partsSchema("The burn slot"),
    recycle: partsSchema("The recycle slot"),
    owner: partsSchema("The owner slot"),
    validator: partsSchema("The validator slot"),
    miner: partsSchema("The miner slot"),
  })
  .strict()
  .describe("The five fixed slots in exact u64 parts.");

export const EmissionSlotsSchema = z
  .object({
    burn: shareSchema(
      "Alpha destroyed outright (it still counts toward issuance)",
    ),
    recycle: shareSchema("Alpha removed from issuance"),
    owner: shareSchema("The subnet owner's cut"),
    validator: shareSchema(
      "Validator dividends (root's alpha is carved out of this slot)",
    ),
    miner: shareSchema(
      "Miner incentive (split across mechanisms by MechanismEmissionSplit)",
    ),
    parts: EmissionSlotPartsSchema,
  })
  .strict()
  .describe(
    "The five fixed slots `[burn, recycle, owner, validator, miner]`, as fractions and exact parts.",
  );

export const GammaShareSchema = z
  .object({
    target_netuid: z
      .int()
      .min(0)
      .max(65535)
      .describe("The subnet whose gamma this share converts into each epoch."),
    share: shareSchema("This gamma share"),
    parts: partsSchema("This gamma share"),
  })
  .strict()
  .describe(
    "One gamma share (SubnetGammaEmission): a part of the subnet's alpha emission converted each epoch into the target subnet's gamma for the subnet owner hotkey. At most 10% each, at most sixteen.",
  );

export const EmissionSplitSchema = EmissionSlotsSchema.extend({
  valid_from: z
    .int()
    .min(0)
    .describe(
      "The first capture block at which this split was observed. The change happened between the previous capture and this block, about 75 blocks at the 15-minute cadence; the event log (SubnetEmissionWeightsSet) has the exact block.",
    ),
  valid_to: z
    .int()
    .min(0)
    .nullable()
    .describe(
      "The first capture block at which another split was observed (exclusive). Null while it is the current split.",
    ),
  gamma_shares: z
    .array(GammaShareSchema)
    .describe("The split's gamma shares, ascending by target netuid."),
  is_default: z
    .boolean()
    .describe(
      "True when this is the runtime's default split for a subnet that never set one: owner 18% (InitialSubnetOwnerCut, 11796/65535), validators 41%, miners the rest, and no gamma shares.",
    ),
})
  .strict()
  .describe(
    "One emission split with its validity range. The five slots and the gamma shares sum to exactly u64::MAX.",
  );

export const SubnetLifecycleStateSchema = z
  .object({
    valid_from: z
      .int()
      .min(0)
      .describe("The first capture block at which this state was observed."),
    valid_to: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The first capture block at which another state was observed (exclusive). Null while it is current.",
      ),
    stage: z
      .enum(["registered", "started", "pending_dissolution", "dissolving"])
      .describe(
        "SubnetState: `registered` (its start call has not completed), `started`, `pending_dissolution` (it has left the active set and waits for cleanup) or `dissolving` (on_idle is cleaning it up).",
      ),
    epoch_consensus: z
      .enum(["yuma", "null"])
      .describe(
        "SubnetEpochConsensus: `yuma`, or `null` -- the largest-stake validator's weights and stake-proportional dividends.",
      ),
    created_via_lease: z
      .boolean()
      .describe(
        "SubnetCreatedViaLease: the subnet was registered through a lease. Such a subnet may not set its owner slot below the default.",
      ),
  })
  .strict()
  .describe("One lifecycle state with its validity range.");

const observedFields = {
  observed_block: z
    .int()
    .min(0)
    .nullable()
    .describe(
      "The newest finalized block the capture read every subnet's split and state at. Null when no capture has been observed (store unbound, or the capture has not run): the response then carries no split at all.",
    ),
  observed_at: z
    .string()
    .nullable()
    .describe("When that capture ran, as an ISO timestamp."),
};

export const SubnetEmissionSplitArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    ...observedFields,
    exists: z
      .boolean()
      .nullable()
      .describe(
        "Whether the chain held this subnet at the observed block. False for a subnet dissolved since, or never registered; null with no observation.",
      ),
    lifecycle: SubnetLifecycleStateSchema.nullable().describe(
      "The subnet's current lifecycle state, or null when it does not exist at the observed block.",
    ),
    split: EmissionSplitSchema.nullable().describe(
      "The subnet's current emission split, or null when it has none at the observed block.",
    ),
    history: z
      .array(EmissionSplitSchema)
      .describe(
        "Every split this subnet has had since the capture began, newest first, at most 100.",
      ),
    lifecycle_history: z
      .array(SubnetLifecycleStateSchema)
      .describe(
        "Every lifecycle state this subnet has had since the capture began, newest first, at most 100.",
      ),
  })
  .strict()
  .describe(
    "One subnet's emission split and lifecycle state from chain storage (runtime spec 497). Mirrors GET /api/v1/subnets/{netuid}/emission-split.",
  );
