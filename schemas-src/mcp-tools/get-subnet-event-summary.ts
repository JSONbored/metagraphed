// MCP tool `get_subnet_event_summary`.
// Mirrors GET /api/v1/subnets/{netuid}/event-summary.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_event_summary: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
} from "../../src/route-limits.ts";
import { limitSchema, netuidSchema, windowSchema } from "./shared.ts";
import { SubnetEventSummaryArtifactSchema } from "../routes/subnet-event-summary.ts";

const SUBNET_EVENT_SUMMARY_WINDOWS = ["7d", "30d", "90d"] as const;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetSubnetEventSummaryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(SUBNET_EVENT_SUMMARY_WINDOWS).optional(),
    limit: limitSchema(
      SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
      SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
    ).optional(),
  })
  .strict();
export type GetSubnetEventSummaryInput = z.infer<
  typeof GetSubnetEventSummaryInputSchema
>;

export const GetSubnetEventSummaryOutputSchema =
  SubnetEventSummaryArtifactSchema;
export type GetSubnetEventSummaryOutput = z.infer<
  typeof GetSubnetEventSummaryOutputSchema
>;
