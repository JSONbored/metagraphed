// GET /api/v1/subnets/movers (types-epic B batch 2, #8056). Live
// neuron_daily-tier cross-subnet leaderboard -- no static file. Modeled
// from src/movers.ts's buildMovers()/buildNetworkSummary(), cross-checked
// against the hand-edited SubnetMoversArtifact component it replaces.
import { z } from "zod";
import { MOVERS_SORTS } from "../../src/movers.ts";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_MOVERS_MOVERS_SORTS_VALUES = MOVERS_SORTS;

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const SUBNET_MOVERS_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

// Cumulative totals are never negative; a boundary delta genuinely can be
// (network stake/emission can net-decrease over a window) -- two separate
// patterns, matching the hand-written original exactly rather than loosening
// the totals to accept a sign they can never carry.
const RaoPrecisionTaoStringSchema = z.string().regex(/^\d+\.\d{9}$/);
const SignedRaoPrecisionTaoStringSchema = z.string().regex(/^-?\d+\.\d{9}$/);

const MoversNetworkSummarySchema = z
  .object({
    total_stake_start_alpha: RaoPrecisionTaoStringSchema.describe(
      "Lossless fixed 9-decimal (rao-precision) TAO string -- exceeds the exact-double ceiling as a JSON number, so it is served as a string rather than Float.",
    ),
    total_stake_end_alpha: RaoPrecisionTaoStringSchema,
    total_stake_delta_alpha: SignedRaoPrecisionTaoStringSchema,
    total_emission_start_alpha: RaoPrecisionTaoStringSchema,
    total_emission_end_alpha: RaoPrecisionTaoStringSchema,
    total_emission_delta_alpha: SignedRaoPrecisionTaoStringSchema,
    total_validators_start: z.int().min(0),
    total_validators_end: z.int().min(0),
    total_validators_delta: z.int(),
    gainers: z.int().min(0),
    losers: z.int().min(0),
    unchanged: z.int().min(0),
  })
  .strict()
  .describe(
    "Network-wide boundary totals for the movers window, summed across every ranked subnet (not just the returned page).",
  );

const MoverEntrySchema = z
  .object({
    netuid: z.int().min(0),
    stake_start_alpha: z.number(),
    stake_end_alpha: z.number(),
    stake_delta_alpha: z.number(),
    stake_pct_change: z
      .number()
      .nullable()
      .describe(
        "Null when the start snapshot's stake was 0 (growth from nothing is undefined).",
      ),
    stake_share_pct: z
      .number()
      .min(0)
      .max(100)
      .nullable()
      .describe(
        "This subnet's share of network stake at the end snapshot; null when the network total is 0.",
      ),
    emission_start_alpha: z.number(),
    emission_end_alpha: z.number(),
    emission_delta_alpha: z.number(),
    emission_pct_change: z.number().nullable(),
    emission_share_pct: z.number().min(0).max(100).nullable(),
    validators_start: z.int().min(0),
    validators_end: z.int().min(0),
    validators_delta: z.int(),
    neurons_start: z.int().min(0),
    neurons_end: z.int().min(0),
    neurons_delta: z.int(),
  })
  .strict()
  .describe(
    "One subnet's stake/emission/validator/neuron movement between the window's start and end snapshots.",
  );

export const SubnetMoversArtifactSchema = z
  .object({
    schema_version: z.int(),
    window: z.enum(SUBNET_MOVERS_WINDOW_VALUES).nullable(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    covered_days: z
      .int()
      .nullable()
      .describe(
        "Days actually spanned between start_date and end_date. Null when either bound is unresolvable.",
      ),
    requested_days: z
      .int()
      .nullable()
      .describe(
        "Days the requested window asked for (7, 30 or 90). Null when no window was resolved.",
      ),
    window_truncated: z
      .boolean()
      .nullable()
      .describe(
        "True when covered_days is short of requested_days because the store does not reach back that far. It matters in ONE direction: every figure here is a DELTA between the window's endpoints, so a shortened span understates each change -- and the leaderboard is ORDERED by that understated delta, so truncation reorders it, not just shrinks it. NULL when the bounds could not be resolved at all, never false, which would assert a window nobody measured was complete.",
      ),
    sort: z.enum(SUBNET_MOVERS_MOVERS_SORTS_VALUES),
    subnet_count: z.int().min(0),
    network: MoversNetworkSummarySchema,
    movers: z.array(MoverEntrySchema),
  })
  .strict();
export type SubnetMoversArtifact = z.infer<typeof SubnetMoversArtifactSchema>;
