// MCP tool `get_subnet_events` (types-epic E batch 4, #8067). Mirrors GET
// /api/v1/subnets/{netuid}/events, covered by schemas-src/routes/
// subnet-events.ts (#8055) -- NOT reused: that REST schema's AccountEvent
// item requires block_number+event_kind and the artifact requires
// schema_version; this tool's own hand-written ACCOUNT_EVENT_ITEM leaves
// every item field optional (via the shared objectItems() shape) and
// schema_version optional too. Modeled fresh instead, matching the
// hand-written literal it replaces field-for-field.
import { z } from "zod";
import {
  blockBoundSchema,
  keysetCursorSchema,
  kindStringSchema,
  limitSchema,
  netuidSchema,
  offsetSchema,
} from "./shared.ts";

export const GetSubnetEventsInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindStringSchema().optional(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
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
    netuid: netuidSchema().nullable().optional(),
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
    netuid: netuidSchema(),
    event_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventItemSchema),
  })
  .passthrough();
export type GetSubnetEventsOutput = z.infer<typeof GetSubnetEventsOutputSchema>;
