// MCP tool `get_subnet_event_summary` (types-epic E batch 3, #8066). Mirrors
// GET /api/v1/subnets/{netuid}/event-summary, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse (schemas-src/routes/subnet-event-summary.ts, #8055, is REST-side
// and not yet mergeable-shared as of this batch). Modeled fresh, shallow,
// from the hand-written literal it replaces. Window enum hardcoded from
// src/account-events.ts's SUBNET_EVENT_SUMMARY_WINDOWS at the time of
// writing.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

const SUBNET_EVENT_SUMMARY_WINDOWS = ["7d", "30d", "90d"] as const;
const SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX = 50;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const EventCategorySummarySchema = z
  .object({
    category: z.string().nullable().optional(),
    event_count: z.int().optional(),
    kind_count: z.int().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_observed_at: z.string().nullable().optional(),
    last_observed_at: z.string().nullable().optional(),
  })
  .passthrough();

const EventKindSummarySchema = z
  .object({
    event_kind: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    event_count: z.int().optional(),
    hotkey_count: z.int().optional(),
    coldkey_count: z.int().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    first_block: z.int().nullable().optional(),
    last_block: z.int().nullable().optional(),
    first_observed_at: z.string().nullable().optional(),
    last_observed_at: z.string().nullable().optional(),
  })
  .passthrough();

export const GetSubnetEventSummaryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(SUBNET_EVENT_SUMMARY_WINDOWS).optional(),
    limit: z.int().min(1).max(SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX).optional(),
  })
  .strict();
export type GetSubnetEventSummaryInput = z.infer<
  typeof GetSubnetEventSummaryInputSchema
>;

export const GetSubnetEventSummaryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    total_events: z.int(),
    kind_count: z.int(),
    category_count: z.int().optional(),
    recent_event_count: z.int(),
    limit: z.int().nullable().optional(),
    categories: z.array(EventCategorySummarySchema),
    event_kinds: z.array(EventKindSummarySchema),
    recent_events: OpenObjectArraySchema,
  })
  .passthrough();
export type GetSubnetEventSummaryOutput = z.infer<
  typeof GetSubnetEventSummaryOutputSchema
>;
