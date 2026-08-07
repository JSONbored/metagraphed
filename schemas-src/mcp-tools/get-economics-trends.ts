// MCP tool `get_economics_trends` (types-epic E batch 3, #8066). Mirrors
// GET /api/v1/economics/trends.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9794). This file used to re-declare the
// response shape by hand, and its own header claimed there was "no existing Zod
// schema to reuse" -- which stopped being true once schemas-src/routes/
// economics-trends.ts landed, modelling the same bytes more precisely. The copy
// never followed, and nothing detected the divergence: it typed
// `total_stake_alpha` as a number, but network-wide alpha is summed in rao and
// serialised at full precision ("345955059.947656252") because an IEEE double
// cannot hold it. Every response failed its own published schema, and an agent
// that trusted the schema parsed the wrong type.
//
// Reusing the artifact schema makes that class of drift impossible: a field
// that changes shape in the route changes here, and a field that is renamed
// stops compiling rather than silently disagreeing in production.
//
// The window enum below is still a local literal. It is duplicated across ten
// schema files and is tracked separately in #9799 -- single-sourcing it is that
// issue's job, not this one's.
import { z } from "zod";
import { EconomicsTrendsArtifactSchema } from "../routes/economics-trends.ts";
import { windowSchema } from "./shared.ts";

const HISTORY_WINDOWS = ["7d", "30d", "90d", "1y", "all"] as const;

export const GetEconomicsTrendsInputSchema = z
  .object({
    window: windowSchema(HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetEconomicsTrendsInput = z.infer<
  typeof GetEconomicsTrendsInputSchema
>;

// The tool serves the route's artifact unchanged, so it publishes the route's
// schema unchanged. Verified against production before the switch: every day
// row the live tool returns satisfies this schema, including the precision
// string that the hand-written copy rejected.
export const GetEconomicsTrendsOutputSchema = EconomicsTrendsArtifactSchema;
export type GetEconomicsTrendsOutput = z.infer<
  typeof GetEconomicsTrendsOutputSchema
>;
