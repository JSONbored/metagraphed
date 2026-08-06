// MCP tool `get_subnet_snapshot` (types-epic E batch 2, #8065). Fans out to
// 5 live views (hyperparameters, concentration, performance, top_validators,
// recent_events) with its own compound handler -- no single REST route or
// schemas-src schema to reuse. Modeled fresh, shallow, from the hand-written
// literal it replaces.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

export const GetSubnetSnapshotInputSchema = z
  .object({
    netuid: netuidSchema(),
    top_validators_limit: z
      .int()
      .min(1)
      .optional()
      .describe(
        "How many top validators to include in the embedded validator list.",
      ),
    recent_events_limit: z
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "How many recent events to embed. Clamped to the tool's ceiling rather than rejected.",
      ),
  })
  .strict();
export type GetSubnetSnapshotInput = z.infer<
  typeof GetSubnetSnapshotInputSchema
>;

export const GetSubnetSnapshotOutputSchema = z
  .object({
    netuid: netuidSchema(),
    hyperparameters: OpenObjectSchema,
    concentration: OpenObjectSchema,
    performance: OpenObjectSchema,
    top_validators: OpenObjectSchema,
    recent_events: OpenObjectSchema,
  })
  .passthrough();
export type GetSubnetSnapshotOutput = z.infer<
  typeof GetSubnetSnapshotOutputSchema
>;
