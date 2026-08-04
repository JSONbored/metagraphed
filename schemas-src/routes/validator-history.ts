// GET /api/v1/validators/{hotkey}/history (types-epic B batch 7, #8061).
// Live neuron_daily D1-tier data -- no static file. Modeled from
// src/validator-history.ts's buildValidatorHistory(), cross-checked against
// the hand-edited ValidatorHistoryArtifact component it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

const ValidatorHistoryPointSchema = z
  .object({
    snapshot_date: z.string(),
    subnet_count: z.int().min(0).nullable(),
    total_stake_tao: z
      .number()
      .nullable()
      .describe(
        "TAO-priced at this point's OWN snapshot_date (#9051): each day's cross-subnet total converts each membership through that day's alpha_price_tao (root at 1:1), so the series is a true TAO-value history. A day-row with no matching price is excluded from that day's sum.",
      ),
    total_emission_tao: z.number().nullable(),
    rewards_per_1000_tao: z.number().nullable(),
    // #9383, per-subnet scope. OPTIONAL rather than nullable: these are absent
    // from the cross-subnet series entirely, because vTrust/consensus/dividends/
    // take are per-(hotkey, netuid) facts and averaging them across subnets would
    // publish a number the chain never computes. The point schema is .strict(), so
    // they have to be declared here or a scoped response fails its own contract.
    netuid: z.int().min(0).nullable().optional(),
    uid: z.int().min(0).nullable().optional(),
    stake_alpha: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Native alpha, NOT converted to TAO — the unit the subnet actually emits in, and what an operator compares day over day. The TAO-priced equivalents remain total_stake_tao/total_emission_tao on the same point.",
      ),
    emission_alpha: z.number().nullable().optional(),
    validator_trust: z.number().nullable().optional(),
    consensus: z.number().nullable().optional(),
    dividends: z.number().nullable().optional(),
    take: z.number().nullable().optional(),
    validator_permit: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Whether the permit was held that day. The scoped series reports a lost permit rather than dropping the day, so 'lost the permit' stays distinguishable from 'no data'.",
      ),
    rewards_per_1000_alpha: z.number().nullable().optional(),
    // #9390. `dividends` is already normalised by the chain (the column sums to ~1.0
    // across a subnet's neurons), so it IS the dividend share; efficiency is that over
    // stake share. Above 1 the validator out-earns its stake, below 1 it under-earns.
    // The denominator is TOTAL subnet stake including miners -- measured at 99.87-100%
    // validator stake, so the distinction is sub-0.2%.
    stake_share: z.number().min(0).nullable().optional(),
    dividend_efficiency: z.number().min(0).nullable().optional(),
  })
  .strict();

export const ValidatorHistoryArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    window: z.string().nullable(),
    // The subnet this series was scoped to; null for the cross-subnet rollup, so a
    // consumer never has to probe a point to learn which shape it received.
    netuid: z.int().min(0).nullable(),
    // #9390: take is a delegate-level fact, reported once for the series rather than
    // per point, and compared as the u16 the chain stores it in — the float rendering
    // is not stable and diffing it manufactures changes that never happened.
    take_u16: z.int().min(0).max(65535).nullable(),
    take_last_changed_date: z.string().nullable(),
    next_take_change_eligible_date: z
      .string()
      .nullable()
      .describe(
        "take_last_changed_date + TxDelegateTakeRateLimit (216,000 blocks / 30.00 days, read from the chain's runtime metadata default). NULL when no change is resolvable in the retained window, which is SHORTER than the rate limit — so 'no change seen' cannot be resolved to 'eligible now'.",
      ),
    take_change_observable: z.boolean(),
    point_count: z.int().min(0),
    points: z.array(ValidatorHistoryPointSchema),
  })
  .passthrough();
export type ValidatorHistoryArtifact = z.infer<
  typeof ValidatorHistoryArtifactSchema
>;
export const ValidatorHistoryResponseSchema = successEnvelopeSchema(
  ValidatorHistoryArtifactSchema,
);
export const ValidatorHistoryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type ValidatorHistoryQuery = z.infer<typeof ValidatorHistoryQuerySchema>;
