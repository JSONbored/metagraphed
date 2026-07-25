// MCP tool `get_subnet_uptime` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/subnets/{netuid}/uptime, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { OpenObjectArraySchema, OpenObjectSchema } from "./shared.ts";

const UPTIME_WINDOWS = ["90d", "1y"] as const;

export const GetSubnetUptimeInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.enum(UPTIME_WINDOWS).optional(),
    min_samples: z.int().min(0).optional(),
  })
  .strict();
export type GetSubnetUptimeInput = z.infer<typeof GetSubnetUptimeInputSchema>;

export const GetSubnetUptimeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: z.int(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    surfaces: OpenObjectArraySchema,
    reliability: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetUptimeOutput = z.infer<typeof GetSubnetUptimeOutputSchema>;
