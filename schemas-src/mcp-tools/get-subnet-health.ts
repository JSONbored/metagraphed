// MCP tool `get_subnet_health` (types-epic E batch 2, #8065). "Mirrors" the
// health domain conceptually but the REST route it names isn't one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { McpUnsortedPageFields, netuidSchema } from "./shared.ts";
import { ListSubnetHealthInputSchema } from "./subnet-scoped-lists.ts";
import {
  HealthSubnetArtifactSchema,
  ReliabilityScoreSchema,
} from "../routes/health-surfaces.ts";

/**
 * DERIVED FROM THE NETWORK-WIDE SIBLING (#9998).
 *
 * `netuid` alone meant an agent could not narrow a subnet's health rows by
 * kind, provider, status or classification, nor page them, while a REST caller
 * could. The per-subnet view is list_subnet_health with `netuid` moved from an
 * optional FILTER to the required SUBJECT.
 */
export const GetSubnetHealthInputSchema = ListSubnetHealthInputSchema.omit({
  netuid: true,
})
  .extend({ netuid: netuidSchema() })
  .strict();
export type GetSubnetHealthInput = z.infer<typeof GetSubnetHealthInputSchema>;

// THE ROUTE'S OWN ARTIFACT SCHEMA (#10904, completed), not a copy of any of
// it. #10905 shared the surface ROW and left the top level restated -- and the
// restatement was already wrong: overlaySubnetHealth() emits contract_version/
// generated_at/slug/name at the top level (undefined-valued when the static
// half is absent, but present, which .strict() counts), so every warm-tier
// call still drifted on exactly the four keys the route artifact declares and
// this copy lacked. The whole shape now derives from HealthSubnetArtifactSchema;
// what remains here is only what the TOOL adds to the route's contract.
export const GetSubnetHealthOutputSchema = HealthSubnetArtifactSchema.extend({
  // The route's OWN reliability shape (#10790) -- `computeReliability().subnet`,
  // served here since the score landed and declared nowhere. Nullable is the
  // honest answer for a subnet with no samples: no probe data, no score, never
  // a zero that reads as "measured, and bad".
  reliability: ReliabilityScoreSchema.nullable().optional(),
  // This tool pages its `surfaces`; the route serves them whole.
  ...McpUnsortedPageFields,
});
export type GetSubnetHealthOutput = z.infer<typeof GetSubnetHealthOutputSchema>;
