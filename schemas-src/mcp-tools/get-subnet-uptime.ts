// MCP tool `get_subnet_uptime` (types-epic E batch 2, #8065). Mirrors GET
// /api/v1/subnets/{netuid}/uptime, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces.
import { z } from "zod";
import {
  OpenObjectArraySchema,
  OpenObjectSchema,
  netuidSchema,
  windowSchema,
} from "./shared.ts";

const UPTIME_WINDOWS = ["90d", "1y"] as const;

export const GetSubnetUptimeInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(UPTIME_WINDOWS).optional(),
    min_samples: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Drop rows computed from fewer than this many samples, so a thin sample cannot look like a trend.",
      )
      .meta({ examples: [10] }),
  })
  .strict();
export type GetSubnetUptimeInput = z.infer<typeof GetSubnetUptimeInputSchema>;

export const GetSubnetUptimeOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    window: z.string().nullable(),
    observed_at: z.string().nullable().optional(),
    surfaces: OpenObjectArraySchema,
    reliability: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetUptimeOutput = z.infer<typeof GetSubnetUptimeOutputSchema>;
