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
import { successEnvelopeSchema } from "../envelope.ts";

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
    net_staked_tao: z.number(),
    gross_staked_tao: z.number().min(0),
    event_count: z.int().min(0),
    last_observed_at: z.string().nullable(),
  })
  .strict();

export const ValidatorNominatorsArtifactSchema = z
  .object({
    schema_version: z.int(),
    hotkey: z.string(),
    window: z.string().nullable(),
    sort: z.enum(VALIDATOR_NOMINATORS_NOMINATOR_SORTS_VALUES),
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
  .passthrough();
export type ValidatorNominatorsArtifact = z.infer<
  typeof ValidatorNominatorsArtifactSchema
>;
export const ValidatorNominatorsResponseSchema = successEnvelopeSchema(
  ValidatorNominatorsArtifactSchema,
);
