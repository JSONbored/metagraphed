// MCP tool `get_alert_trigger` (types-epic E batch 4, #8068). Mirrors
// GET /api/v1/alerts/triggers/{id}.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). This file used to model the
// response itself, with a header explaining there was "no existing Zod schema
// to reuse" -- true when it was written, and no longer true: #9967 documented
// the route and gave it an ArtifactSchema, so the shape moved there and this
// imports it. A route field rename is now a compile error here.
import { z } from "zod";
import { AlertTriggerArtifactSchema } from "../routes/alert-triggers.ts";

export const GetAlertTriggerInputSchema = z
  .object({
    id: z
      .string()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    owner_token: z
      .string()
      .describe(
        "The secret token issued when the alert was created. Required to read it back; it is not recoverable if lost.",
      )
      .meta({ examples: ["mg_alert_..."] }),
  })
  .strict();
export type GetAlertTriggerInput = z.infer<typeof GetAlertTriggerInputSchema>;

export const GetAlertTriggerOutputSchema = AlertTriggerArtifactSchema;
export type GetAlertTriggerOutput = z.infer<typeof GetAlertTriggerOutputSchema>;
