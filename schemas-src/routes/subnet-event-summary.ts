// GET /api/v1/subnets/{netuid}/event-summary (types-epic B batch 1, #8055).
// Live windowed account_events rollup -- no static file. Reuses
// AccountEventSchema from subnet-events.ts (recent_events is the same row
// shape). Modeled from src/account-events.ts's buildSubnetEventSummary()
// (CategorySummary/SubnetEventSummaryEventKind interfaces, every field
// always set), cross-checked against the hand-edited
// SubnetEventCategorySummary/SubnetEventKindSummary/SubnetEventSummaryArtifact
// components it replaces.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";
import { AccountEventSchema } from "./subnet-events.ts";

const EVENT_CATEGORIES = [
  "registration",
  "stake",
  "serving",
  "consensus",
  "delegation",
  "identity",
  "governance",
  "transfer",
  "other",
] as const;

export const SubnetEventCategorySummarySchema = z
  .object({
    category: z.enum(EVENT_CATEGORIES),
    event_count: z.int().min(0),
    kind_count: z.int().min(0),
    amount_tao: z.number().min(0),
    alpha_amount: z.number().min(0),
    first_block: z.int().min(0).nullable(),
    last_block: z.int().min(0).nullable(),
    first_observed_at: z.iso.datetime().nullable(),
    last_observed_at: z.iso.datetime().nullable(),
  })
  .strict();
export type SubnetEventCategorySummary = z.infer<
  typeof SubnetEventCategorySummarySchema
>;

export const SubnetEventKindSummarySchema = z
  .object({
    event_kind: z.string(),
    category: z.enum(EVENT_CATEGORIES),
    event_count: z.int().min(0),
    hotkey_count: z.int().min(0),
    coldkey_count: z.int().min(0),
    amount_tao: z.number().min(0),
    alpha_amount: z.number().min(0),
    first_block: z.int().min(0).nullable(),
    last_block: z.int().min(0).nullable(),
    first_observed_at: z.iso.datetime().nullable(),
    last_observed_at: z.iso.datetime().nullable(),
  })
  .strict();
export type SubnetEventKindSummary = z.infer<
  typeof SubnetEventKindSummarySchema
>;

export const SubnetEventSummaryArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int(),
    window: z.enum(["7d", "30d", "90d"]),
    observed_at: z.iso.datetime().nullable(),
    total_events: z.int().min(0),
    kind_count: z.int().min(0),
    category_count: z.int().min(0),
    recent_event_count: z.int().min(0),
    limit: z.int().min(1).max(50),
    categories: z.array(SubnetEventCategorySummarySchema),
    event_kinds: z.array(SubnetEventKindSummarySchema),
    recent_events: z.array(AccountEventSchema),
  })
  .passthrough();
export type SubnetEventSummaryArtifact = z.infer<
  typeof SubnetEventSummaryArtifactSchema
>;
export const SubnetEventSummaryResponseSchema = successEnvelopeSchema(
  SubnetEventSummaryArtifactSchema,
);

export const SubnetEventSummaryQuerySchema = z
  .object({
    window: z.enum(["7d", "30d", "90d"]).optional(),
    limit: z.int().min(1).max(50).optional(),
  })
  .strict();
export type SubnetEventSummaryQuery = z.infer<
  typeof SubnetEventSummaryQuerySchema
>;
