import { z } from "zod";

/** Reviewed transport and operation permissions, independent of recurring GET probes.
 * Provider annotations never promote a tool into the read admission. */
export const McpSurfaceAdmissionSchema = z
  .object({
    transport: z.literal("streamable-http"),
    public_discovery: z
      .boolean()
      .optional()
      .describe(
        "Source-reviewed keyless catalog discovery when true. Execution still uses the surface's authentication requirement. False or omission preserves the existing requirement.",
      ),
    read_tools: z.array(z.string().min(1).max(128)).max(512),
    write_tools: z.array(z.string().min(1).max(128)).max(512),
    read_prompts: z.array(z.string().min(1).max(128)).max(512).optional(),
    read_resources: z.array(z.string().min(1).max(1024)).max(512).optional(),
  })
  .strict();
