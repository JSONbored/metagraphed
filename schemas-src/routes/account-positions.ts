// GET /api/v1/accounts/{ss58}/positions + .../subnets/{netuid}/history
// (types-epic B batch 4, #8058). Live nominator_positions/neurons +
// account_position_daily D1-tier data -- no static file. Modeled from
// src/account-nominator-positions.ts's buildAccountPositions() and
// src/account-position-history.ts's buildAccountPositionHistory()/
// formatAccountPosition(), cross-checked against the hand-edited
// AccountPositionsArtifact/AccountPositionHistoryArtifact components they
// replace.
//
// Real finding (bucket b): the hand-edited AccountPositionHistoryArtifact's
// `points[]` item only declared 2 minimal fields (snapshot_date,
// captured_at) -- confirmed against buildAccountPositionHistory()/
// formatAccountPosition() that each point actually carries the FULL
// AccountPositionEntry shape (uid/coldkey/role/active/stake_tao/
// emission_tao/rank/trust/incentive/dividends/yield) plus the two stamp
// fields, the same field shape as AccountPortfolioArtifact's own
// `positions[]` entries (minus netuid, fixed for the whole series) -- see
// account-position-history.ts's own header comment. Generated schema
// matches reality; hand-edited component was incomplete.
//
// NominatorPosition is intentionally NOT registered as a shared component --
// AccountPositionsArtifact is its only referrer anywhere in schemas/
// components/*.schema.json (verified via repo-wide $ref grep), so the
// hand-edited component key becomes fully orphaned.
//
// Bucket (c): captured_at fields drop format:date-time in favor of plain
// z.string().nullable(), matching this epic's established convention.
import { z } from "zod";
import { POSITIONS_DEGRADED_REASONS } from "../../src/account-nominator-positions.ts";
import { successEnvelopeSchema } from "../envelope.ts";

const NominatorPositionSchema = z
  .object({
    hotkey: z.string(),
    netuid: z.int().min(0),
    share_fraction: z.number().min(0).max(1),
    stake_tao: z
      .number()
      .min(0)
      .describe(
        "This position's stake in the subnet named by the sibling `netuid`. ALPHA, not TAO: nominator_positions holds only netuid != 0 rows, so this is always that subnet's alpha token (#2550). It is the per-row counterpart of `total_stake_alpha` above -- same denomination, kept under the on-chain column name deliberately (#8945).",
      ),
  })
  .strict();

// #9273. Present ONLY when this payload's zero is not a measurement, so a
// consumer that ignores it reads exactly what it read before. Optional rather
// than nullable for that reason: the key's absence is the healthy case, and a
// permanently-null field trains callers not to look.
const AccountPositionsDegradedSchema = z
  .object({
    // Built from the loader's own tuple, not re-typed here (#9804). This enum
    // used to list two of the three reasons the code can emit, so production
    // served `positions_unpriceable` against a contract that called it
    // impossible -- a strict client rejected a valid response, and a client
    // switching on the enum fell through silently.
    reason: z
      .enum(POSITIONS_DEGRADED_REASONS)
      .describe(
        "`tier_unavailable`: every tier declined, so this zero is a read failure. `snapshot_predates_stake_activity`: the position ledger answered zero, but this account has an on-chain StakeAdded/StakeRemoved NEWER than the ledger's own snapshot -- it was demonstrably staking after the ledger was captured, so `positions: 0` is a claim the ledger is not entitled to make. `positions_unpriceable`: the ledger HAS rows for this account, but one or more could not be priced against the live neurons table -- they are excluded from `positions` and from `total_stake_alpha` rather than reported with a fabricated zero, so the total understates the real holding.",
      ),
    snapshot_captured_at: z
      .string()
      .nullable()
      .describe(
        "The LEDGER's own capture stamp, not this account's -- present even when the account has no rows in it, which is the case this field exists for.",
      ),
    latest_stake_event_at: z
      .string()
      .nullable()
      .describe(
        "The newest StakeAdded/StakeRemoved this account has on chain, when that is what contradicts the zero.",
      ),
  })
  .strict();

export const AccountPositionsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    captured_at: z.string().nullable(),
    position_count: z.int().min(0),
    total_stake_alpha: z
      .number()
      .min(0)
      .describe(
        "Sum of this account's stake across every position. ALPHA, not TAO: nominator_positions holds only netuid != 0 rows and non-root stake is that subnet's alpha token, so this sums different subnets' alpha (renamed from total_stake_tao in #8803). Not a TAO value and not comparable with a free-balance figure.",
      ),
    positions: z.array(NominatorPositionSchema),
    degraded: AccountPositionsDegradedSchema.optional(),
  })
  .passthrough();
export type AccountPositionsArtifact = z.infer<
  typeof AccountPositionsArtifactSchema
>;
export const AccountPositionsResponseSchema = successEnvelopeSchema(
  AccountPositionsArtifactSchema,
);
export const AccountPositionsQuerySchema = z.object({}).strict();
export type AccountPositionsQuery = z.infer<typeof AccountPositionsQuerySchema>;

const AccountPositionHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    captured_at: z.string().nullable(),
    uid: z.int().nullable(),
    coldkey: z.string().nullable(),
    role: z.enum(["validator", "miner"]),
    active: z.boolean(),
    stake_tao: z
      .number()
      .describe(
        "This row's stake in the subnet named by the sibling `netuid`. ALPHA for non-root subnets -- a non-root neuron's stake is that subnet's own alpha token, not TAO (#2550); netuid 0 (root) stake is genuine TAO. Comparable within one subnet, never summable across subnets: the cross-subnet totals that ARE safe to read as TAO convert through each subnet's alpha price first (#9051/#8803). Kept under the on-chain column name deliberately (#8945).",
      ),
    emission_tao: z
      .number()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO.",
      ),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    yield: z.number().nullable(),
  })
  .strict();

export const AccountPositionHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    ss58: z.string(),
    netuid: z.int().min(0),
    window: z.string().nullable().optional(),
    point_count: z.int().min(0),
    points: z.array(AccountPositionHistoryPointSchema),
  })
  .passthrough();
export type AccountPositionHistoryArtifact = z.infer<
  typeof AccountPositionHistoryArtifactSchema
>;
export const AccountPositionHistoryResponseSchema = successEnvelopeSchema(
  AccountPositionHistoryArtifactSchema,
);
export const AccountPositionHistoryQuerySchema = z
  .object({
    window: z.string().optional(),
  })
  .strict();
export type AccountPositionHistoryQuery = z.infer<
  typeof AccountPositionHistoryQuerySchema
>;
