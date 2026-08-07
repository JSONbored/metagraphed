// MCP tool `get_emission_changes`.
// Mirrors GET /api/v1/chain/governance/emission-changes.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { kindSchema, limitSchema } from "./shared.ts";
import {
  EMISSION_CHANGES_LIMIT_DEFAULT,
  EMISSION_CHANGES_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { EmissionGateChangesArtifactSchema } from "../routes/emission-gate-changes.ts";

export const GetEmissionChangesInputSchema = z
  .object({
    kind: kindSchema(["param", "subnet", "flow"]).optional(),
    limit: limitSchema(
      EMISSION_CHANGES_LIMIT_MAX,
      EMISSION_CHANGES_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetEmissionChangesInput = z.infer<
  typeof GetEmissionChangesInputSchema
>;

export const GetEmissionChangesOutputSchema = EmissionGateChangesArtifactSchema;
export type GetEmissionChangesOutput = z.infer<
  typeof GetEmissionChangesOutputSchema
>;
