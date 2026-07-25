// MCP tool `get_subnet_events` (types-epic E batch 4, #8067). Mirrors GET
// /api/v1/subnets/{netuid}/events, covered by schemas-src/routes/
// subnet-events.ts (#8055) -- NOT reused: that REST schema's AccountEvent
// item requires block_number+event_kind and the artifact requires
// schema_version; this tool's own hand-written ACCOUNT_EVENT_ITEM leaves
// every item field optional (via the shared objectItems() shape) and
// schema_version optional too. Modeled fresh instead, matching the
// hand-written literal it replaces field-for-field.
import { z } from "zod";

export const GetSubnetEventsInputSchema = z
  .object({
    netuid: z.int().min(0),
    kind: z.string().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type GetSubnetEventsInput = z.infer<typeof GetSubnetEventsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
const AccountEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .passthrough();

export const GetSubnetEventsOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    event_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventItemSchema),
  })
  .passthrough();
export type GetSubnetEventsOutput = z.infer<typeof GetSubnetEventsOutputSchema>;
