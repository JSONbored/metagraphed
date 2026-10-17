// GET /api/v1/accounts/{ss58}/positions + .../subnets/{netuid}/history
// (types-epic B batch 4, #8058). Live nominator_positions/neurons +
// account_position_daily store-tier data -- no static file. Modeled from
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
import { subnetHistoryArtifactSchema } from "../shared.ts";
import { POSITIONS_DEGRADED_REASONS } from "../../src/account-nominator-positions.ts";

const NominatorPositionSchema = z
  .object({
    hotkey: z.string(),
    netuid: z.int().min(0),
    share_fraction: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Legacy fraction reported by the nominator-position ledger (0..1). This wire response does not identify an authoritative asset-quantity basis; the fraction must not establish an ownership share, holdings allocation or unstake Max.",
      ),
    stake_tao: z
      .number()
      .min(0)
      .describe(
        "Legacy reconstructed quantity for the sibling hotkey and netuid. Reconstruction can multiply a nominator fraction by neuron voting weight, so this field name does not establish a native-alpha or TAO holding. The response has no authoritative quantity-basis discriminator. Do not use it for holdings value, allocation or unstake Max.",
      ),
  })
  .strict()
  .describe(
    "One periodically recorded (hotkey, netuid) relationship from the nominator-position ledger. Legacy numeric fields are not qualified asset holdings; preserve relationship identity and capture provenance separately from quantity claims.",
  );

// #9273. Present ONLY when this payload's zero is not a measurement, so a
// consumer that ignores it reads exactly what it read before. Optional rather
// than nullable for that reason: the key's absence is the healthy case, and a
// permanently-null field trains callers not to look. This coverage marker's
// absence does not establish an authoritative token-quantity basis.
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
        "`tier_unavailable`: every tier declined, so zero is a read failure. `snapshot_predates_stake_activity`: the ledger answered zero before newer on-chain stake activity, so an empty current holding is not established. `positions_unpriceable`: ledger rows could not be reconstructed or their quantities are unqualified, so returned rows or totals are incomplete. Absence of this marker does not qualify legacy amounts as asset holdings.",
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
        "Legacy sum of reconstructed quantities across returned records. The input can be voting weight and different subnets have different units; this aggregate does not establish asset holdings, portfolio value or allocation. It is not comparable with a TAO balance, including when finite or zero.",
      ),
    positions: z.array(NominatorPositionSchema),
    degraded: AccountPositionsDegradedSchema.optional(),
  })
  .strict()
  .describe(
    "Periodic nominator-side relationship records for one account, with capture time and coverage evidence. Legacy amount/share fields do not identify an authoritative holdings basis; Root holdings are not covered and an empty response does not establish an empty wallet. Mirrors GET /api/v1/accounts/{ss58}/positions.",
  );
export type AccountPositionsArtifact = z.infer<
  typeof AccountPositionsArtifactSchema
>;

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
        "Historical metagraph voting weight stored under a legacy name. It does not establish independent native-alpha or TAO principal, including on Root. Pricing or summing voting weight cannot certify account holdings or portfolio value.",
      ),
    emission_tao: z
      .number()
      .describe(
        "This row's emission in the subnet named by the sibling `netuid`, alpha-denominated for the same reason as the sibling stake field and under the same deliberate on-chain naming (#2550/#8945). netuid 0 (root) is genuine TAO. The RATE PERIOD is one TEMPO -- the subnet's `tempo` hyperparameter, 360 blocks (~20 tempos/day) on effectively every subnet -- not one day: multiply by tempos/day before deriving a daily figure.",
      ),
    rank: z.number().nullable(),
    trust: z.number().nullable(),
    incentive: z.number().nullable(),
    dividends: z.number().nullable(),
    yield: z
      .number()
      .nullable()
      .describe(
        "Legacy operational emission-per-reported-weight ratio, not measured investment yield or principal-based return.",
      ),
  })
  .strict()
  .describe(
    "One day's recorded neuron membership for an account in one subnet: uid, role, active state, voting weight, emission and operational scores. Historical quantity and ratio fields do not establish asset holdings or investment performance.",
  );

/**
 * The shared per-subnet history envelope, scoped to one account.
 *
 * `subnetHistoryArtifactSchema()` (shared.ts) already owns
 * schema_version/netuid/window/point_count/points -- #10790 collapsed three
 * copies of it into that factory. This was a fourth, invisible to the duplicate
 * gate because it adds `ss58`: the envelope is the same, the scope is one field
 * narrower.
 */
export const AccountPositionHistoryArtifactSchema = subnetHistoryArtifactSchema(
  AccountPositionHistoryPointSchema,
)
  .extend({ ss58: z.string() })
  .describe(
    "One account's per-subnet position history over a lookback window, one point per neuron_daily snapshot. Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history.",
  );
export type AccountPositionHistoryArtifact = z.infer<
  typeof AccountPositionHistoryArtifactSchema
>;
