// GET /api/v1/subnets/{netuid}/events (types-epic B batch 1, #8055). Live
// paginated account_events feed -- no static file. AccountEventSchema is
// shared with subnet-event-summary.ts's recent_events slice (same
// src/account-events.ts formatAccountEvent() row shape). Modeled from
// formatAccountEvent()/buildSubnetEvents(), cross-checked against the
// hand-edited AccountEvent/SubnetEventsArtifact components they replace.
// AccountEvent's required set intentionally matches the hand-edited
// original (block_number + event_kind only) even though the real formatter
// always sets every key -- AccountEvent is reused by many untouched routes
// beyond this batch's two, so this batch makes no behavior change to it.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

export const AccountEventSchema = z
  .object({
    block_number: z.int().nullable(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.number().nullable().optional(),
    alpha_amount: z.number().nullable().optional(),
    observed_at: z.iso.datetime().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .strict();
export type AccountEvent = z.infer<typeof AccountEventSchema>;

export const SubnetEventsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int(),
    event_count: z.int().min(0),
    limit: z.int().optional(),
    offset: z.int().optional(),
    next_cursor: z.string().nullable().optional(),
    events: z.array(AccountEventSchema),
  })
  .passthrough();
export type SubnetEventsArtifact = z.infer<typeof SubnetEventsArtifactSchema>;
export const SubnetEventsResponseSchema = successEnvelopeSchema(
  SubnetEventsArtifactSchema,
);

export const SubnetEventsQuerySchema = z
  .object({
    kind: z.string().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    limit: z.int().min(1).max(1000).optional(),
    offset: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SubnetEventsQuery = z.infer<typeof SubnetEventsQuerySchema>;
