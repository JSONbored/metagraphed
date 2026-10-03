import { z } from "zod";

/** Reviewed transport and tool permissions, independent of recurring GET probes.
 * Provider annotations never promote a tool into the read admission. */
export const McpSurfaceAdmissionSchema = z.object({
  transport: z.literal("streamable-http"),
  read_tools: z.array(z.string().min(1).max(128)).max(512),
  write_tools: z.array(z.string().min(1).max(128)).max(512),
}).strict();

