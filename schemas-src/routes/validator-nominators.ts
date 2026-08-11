// GET /api/v1/validators/{hotkey}/nominators (types-epic B batch 7, #8061).
// Live account_events StakeAdded/StakeRemoved-stream data -- no static
// file. Modeled from src/validator-nominators.ts's
// buildValidatorNominators(), cross-checked against the hand-edited
// ValidatorNominatorsArtifact component it replaces.
//
// ValidatorNominatorEntry is intentionally NOT registered as a shared
// component -- ValidatorNominatorsArtifact is its only referrer (verified
// via repo-wide $ref grep), so the hand-edited component key becomes fully
// orphaned.
import { z } from "zod";

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES = [
  "net_staked",
  "gross_staked",
  "last_activity",
] as const;

/** This route's own vocabulary, owned here so its MCP tool imports rather than restates it (#9799). */
export const VALIDATOR_NOMINATORS_WINDOW_VALUES = ["7d", "30d", "90d"] as const;

const ValidatorNominatorEntrySchema = z
  .object({
    coldkey: z.string(),
    staked_tao: z.number().min(0),
    unstaked_tao: z.number().min(0),
    net_staked_tao: z.number().describe("staked_tao - unstaked_tao."),
    gross_staked_tao: z
      .number()
      .min(0)
      .describe(
        "staked_tao + unstaked_tao (total churn, regardless of direction).",
      ),
    event_count: z.int().min(0),
    last_observed_at: z
      .string()
      .nullable()
      .describe(
        "Most recent StakeAdded/StakeRemoved time for this `coldkey`; null when unstamped.",
      ),
  })
  .strict()
  .describe(
    "One nominating `coldkey`'s staking activity toward a validator within the window.",
  );

export const ValidatorNominatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    window: z
      .string()
      .nullable()
      .describe(
        "The resolved window label; null only if the builder was handed no window.",
      ),
    sort: z
      .enum(VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES)
      .describe(
        "The resolved sort actually applied (an omitted sort resolves to net_staked).",
      ),
    limit: z.int().min(0).max(100),
    offset: z.int().min(0),
    nominator_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "Distinct delegating coldkeys in the window. NULL when the rows are a page and the true total could not be read (#9393) — it is deliberately not the page size, which is what this reported before and which tracked ?limit.",
      ),
    // #9390: how concentrated the delegated stake is. Null unless the rows in hand are
    // the whole set -- a top-holder share computed over one page describes the page.
    concentration_complete: z.boolean(),
    top_nominator_share: z.number().min(0).max(1).nullable(),
    top5_nominator_share: z.number().min(0).max(1).nullable(),
    nominator_gini: z.number().min(0).max(1).nullable(),
    nominators: z.array(ValidatorNominatorEntrySchema),
  })
  .strict()
  .describe(
    "One validator's nominator leaderboard (#5692). Mirrors GET /api/v1/validators/{hotkey}/nominators' data envelope.",
  );
export type ValidatorNominatorsArtifact = z.infer<
  typeof ValidatorNominatorsArtifactSchema
>;

/**
 * The OTHER shape this route serves: `?basis=positions` (#9617).
 *
 * A different question, so a different card rather than optional fields bolted
 * onto the one above -- `window`, `sort` and the concentration block do not
 * exist here (they belong to the flow aggregation, and the route 400s rather
 * than ignore them), and `nominators` carries alpha PER SUBNET instead of TAO
 * totals. Modeled from src/validator-nominator-positions.ts's
 * buildNominatorPositions and verified against production 2026-08-11:
 * 2,377 nominators for 5E2LP6En...TKeZ5u, where the flow basis over the same
 * hotkey reports 0.
 *
 * Written now because #10793 gives the MCP tool `basis`, and a tool that can
 * return this shape while publishing only the flow one publishes a schema its
 * own output fails.
 */
const ValidatorNominatorPositionSchema = z
  .object({
    netuid: z.int().min(0),
    alpha: z.number().min(0),
  })
  .strict();

const ValidatorNominatorPositionEntrySchema = z
  .object({
    coldkey: z.string(),
    subnet_count: z.int().min(0),
    // The largest SINGLE holding, netuid attached. Each subnet's alpha is a
    // different token, so a cross-subnet total is not computed here and a bare
    // number would invite one -- the netuid rides with it for that reason.
    largest_position: ValidatorNominatorPositionSchema,
    subnets: z.array(ValidatorNominatorPositionSchema),
  })
  .strict()
  .describe(
    "One delegating `coldkey`'s standing alpha positions toward a validator, broken down by subnet.",
  );

export const ValidatorNominatorPositionsSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.unknown(),
    basis: z.literal("positions"),
    limit: z.int().min(0).nullable(),
    offset: z.int().min(0),
    nominator_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The WHOLE delegator set, never bounded by the page -- unlike the flow basis, where it is null when the true total could not be read.",
      ),
    captured_at: z.string().nullable(),
    positions_captured_at: z.string().nullable(),
    nominators: z.array(ValidatorNominatorPositionEntrySchema),
    // Present only on the decline. The positions basis refuses to answer while
    // the hotkey_alpha pool ledger has no complete pass, because a partial
    // ledger underprices a nominator rather than dropping them -- a wrong
    // number that looks right.
    degraded: z.object({ reason: z.string() }).strict().optional(),
  })
  .strict()
  .describe(
    "One validator's standing delegator positions (#9617). Mirrors GET /api/v1/validators/{hotkey}/nominators?basis=positions.",
  );
// NO `export type ValidatorNominatorPositions` beside it, unlike the sibling
// above. Nothing infers one, and validate:unreferenced-exports is a ratchet
// over exactly this pile -- 241 of its 738 are schemas-src/routes type aliases
// exported by convention rather than by need. A caller who wants the type can
// `z.infer<typeof ValidatorNominatorPositionsSchema>` at the point of use.
