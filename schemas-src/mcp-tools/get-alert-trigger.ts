// MCP tool `get_alert_trigger` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/alerts/triggers/{id}, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// matching the hand-written literal it replaces field-for-field.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";

export const GetAlertTriggerInputSchema = z
  .object({
    id: z
      .string()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      ),
    owner_token: z
      .string()
      .describe(
        "The secret token issued when the alert was created. Required to read it back; it is not recoverable if lost.",
      ),
  })
  .strict();
export type GetAlertTriggerInput = z.infer<typeof GetAlertTriggerInputSchema>;

export const GetAlertTriggerOutputSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    table_filter: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    account: z.string().nullable().optional(),
    min_amount_tao: z.number().nullable().optional(),
    channel: z.string().optional(),
    destination: z.string().optional(),
    active: z.boolean(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    last_matched_at: z.string().nullable().optional(),
    match_count: z.int().optional(),
  })
  .passthrough();
export type GetAlertTriggerOutput = z.infer<typeof GetAlertTriggerOutputSchema>;
