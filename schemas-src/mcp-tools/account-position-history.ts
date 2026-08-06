// MCP tool `get_account_position_history` (types-epic E batch 6, #8069).
// Mirrors GET /api/v1/accounts/{ss58}/subnets/{netuid}/history, which is
// not one of schemas-src/routes/'s covered pilot routes -- no existing Zod
// schema to reuse. Modeled fresh, matching the hand-written literal it
// replaces field-for-field.
import { z } from "zod";
import {
  OpenObjectArraySchema,
  netuidSchema,
  ss58Schema,
  windowSchema,
} from "./shared.ts";

export const GetAccountPositionHistoryInputSchema = z
  .object({
    ss58: ss58Schema(),
    netuid: netuidSchema(),
    window: windowSchema(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type GetAccountPositionHistoryInput = z.infer<
  typeof GetAccountPositionHistoryInputSchema
>;

export const GetAccountPositionHistoryOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ss58: z.string(),
    netuid: netuidSchema(),
    window: z.string().nullable().optional(),
    point_count: z.int(),
    points: OpenObjectArraySchema,
  })
  .passthrough();
export type GetAccountPositionHistoryOutput = z.infer<
  typeof GetAccountPositionHistoryOutputSchema
>;
