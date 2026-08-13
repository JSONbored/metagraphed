// MCP tool `get_subnet_health` (types-epic E batch 2, #8065).
//
// This file DERIVES its shapes from the route schemas below -- the summary
// from HealthSubnetSummarySchema (#9797), the rows from
// HealthSubnetSurfaceSchema (#10904), the input from
// ListSubnetHealthInputSchema (#9998).
//
// It did not always. The header here used to read "no existing Zod schema to
// reuse -- modeled fresh, shallow, from the hand-written literal it replaces",
// which was true at #8065 and false from #10904 onward, when the copied row
// schema was replaced by the route's own for the reason that commit records:
// the copy "sat five fields behind the route's", so the outbound tripwire
// refused every netuid-0 call the moment the fallback tier answered.
//
// The sentence survived the fix it described. A header that still advertises a
// design the file abandoned costs more than a stale comment usually does: it is
// read as the reason for a drift, and it sends the reader looking for a
// hand-copied schema that is no longer here.
import { z } from "zod";
import { McpUnsortedPageFields, netuidSchema } from "./shared.ts";
import { ListSubnetHealthInputSchema } from "./subnet-scoped-lists.ts";
import { HealthSubnetSummarySchema } from "../routes/health.ts";
import { LIVE_HEALTH_OVERLAY } from "../routes/subnet-detail.ts";
import {
  HealthSubnetSurfaceSchema,
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

// THE ROUTE'S OWN ROW SCHEMA (#10904), not a copy. This tool serves the
// same overlaySubnetHealth()/fallback-tier rows GET /subnets/{netuid}/health
// serves, and its previous hand-copied row schema sat five fields behind
// the route's -- so the outbound tripwire refused every netuid-0 call the
// moment the fallback tier answered. A second declaration is how the copy
// comes to omit the field that matters (#10790's own words); this tool
// advertises no `fields`, so the rows are never projected and the route's
// exact shape is the right one.
const GetSubnetHealthSurfaceSchema = HealthSubnetSurfaceSchema;

export const GetSubnetHealthOutputSchema = z
  .object({
    netuid: netuidSchema(),
    // Typed from the route's own HealthSubnetSummarySchema (#9797). This tool
    // advertises no `fields`, so it is not partial. Verified against
    // production 2026-08-07.
    summary: HealthSubnetSummarySchema,
    ...LIVE_HEALTH_OVERLAY,
    surfaces: z.array(GetSubnetHealthSurfaceSchema),
    // The route's OWN reliability shape (#10790) -- `computeReliability().subnet`,
    // served here since the score landed and declared nowhere. Bounded score and
    // an A-F grade enum, which a second declaration here had loosened to
    // `z.number()`/`z.string()` before this collapse. Nullable is the honest
    // answer for a subnet with no samples: no probe data, no score, never a zero
    // that reads as "measured, and bad".
    reliability: ReliabilityScoreSchema.nullable().optional(),
    schema_version: z.int().optional(),
    // This tool pages its `surfaces`, and said so nowhere.
    ...McpUnsortedPageFields,
  })
  .strict();
export type GetSubnetHealthOutput = z.infer<typeof GetSubnetHealthOutputSchema>;
