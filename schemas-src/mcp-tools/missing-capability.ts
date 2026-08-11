// MCP tool `get_more_tools` -- the capability-gap report.
//
// THE ONE TOOL HERE WITH NO ROUTE BEHIND IT, and therefore the one output
// schema in this directory that is not imported from a route's own
// ArtifactSchema. That is not the drift #9796 warned about: there is no REST
// surface for "an agent told us what we do not have", nothing for this shape
// to drift FROM, and inventing a route to host it would add a public endpoint
// nobody calls in order to satisfy a convention whose whole purpose is to keep
// two real definitions in agreement.
//
// The tool answers a fixed, contentless acknowledgement by design. Everything
// of value in the call travels as the standard `context` argument
// (withIntentArgument), which reaches PostHog as $mcp_intent.
import { z } from "zod";

export const GetMoreToolsInputSchema = z.object({}).strict();
export type GetMoreToolsInput = z.infer<typeof GetMoreToolsInputSchema>;

// No `GetMoreToolsOutput` type alias to go with this one. The sibling files
// export input/output pairs because something consumes both; here the handler
// builds the object literally and only the SCHEMA is imported (by
// TOOL_OUTPUT_SCHEMAS), so an alias would be an export nothing reads --
// exactly what validate:unreferenced-exports exists to keep out.
export const GetMoreToolsOutputSchema = z
  .object({
    /** Always true -- the gap was recorded. Present so a client can tell a
     * successful report from a transport failure without parsing prose. */
    acknowledged: z.boolean(),
    /** Always false. Named positively rather than as an error so an agent
     * reads it as a settled answer instead of a retryable fault. */
    additional_tools_available: z.boolean(),
    /** Plain-language instruction to stop looking. */
    message: z.string(),
  })
  .strict();
