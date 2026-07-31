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
import { successEnvelopeSchema } from "../envelope.ts";

const NominatorPositionSchema = z
  .object({
    hotkey: z.string(),
    netuid: z.int().min(0),
    share_fraction: z.number().min(0).max(1),
    stake_tao: z.number().min(0),
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
    stake_tao: z.number(),
    emission_tao: z.number(),
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
