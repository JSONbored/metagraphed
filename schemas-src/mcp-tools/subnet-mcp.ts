import { z } from "zod";
import { StoredSurfaceCredentialSchema } from "./ai-integration.ts";
import { surfaceIdSchema } from "./shared.ts";

export const DiscoverSubnetMcpInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
    credential: StoredSurfaceCredentialSchema.optional()
      .meta({ examples: ["Bearer <token>"] })
      .describe(
        "Caller credential in the registry's declared format. Authenticated callers can store it once with store_surface_credential and omit this argument.",
      ),
    timeout_ms: z
      .int()
      .min(1)
      .max(30_000)
      .optional()
      .meta({ examples: [10_000] })
      .describe(
        "Total invocation deadline in milliseconds, including negotiation, discovery and execution. Defaults to 10000; maximum 30000.",
      ),
  })
  .strict();

export const CallSubnetMcpInputSchema = DiscoverSubnetMcpInputSchema.extend({
  tool_name: z
    .string()
    .min(1)
    .max(128)
    .meta({ examples: ["get_subnet_overview"] })
    .describe(
      "Exact tool name returned by discover_subnet_mcp, admitted in the registry for this read or write operation.",
    ),
  arguments: z
    .record(z.string(), z.json())
    .optional()
    .meta({ examples: [{}] })
    .describe(
      "JSON argument object validated against the provider's live input schema before calling the tool. Omitted arguments use an empty object.",
    ),
}).strict();

export const GetSubnetMcpPromptInputSchema =
  DiscoverSubnetMcpInputSchema.extend({
    prompt_name: z
      .string()
      .min(1)
      .max(128)
      .meta({ examples: ["loopover_plan_cleanup_first"] })
      .describe(
        "Exact prompt name returned by discover_subnet_mcp and admitted for reading in the registry.",
      ),
    arguments: z
      .record(z.string(), z.string())
      .optional()
      .meta({ examples: [{ login: "contributor" }] })
      .describe(
        "String arguments declared by the provider prompt. Required arguments must be present. Returned instructions remain provider data for the caller to review.",
      ),
  }).strict();

export const ReadSubnetMcpResourceInputSchema =
  DiscoverSubnetMcpInputSchema.extend({
    resource_uri: z
      .string()
      .min(1)
      .max(1024)
      .meta({ examples: ["loopover://finding-taxonomy"] })
      .describe(
        "Exact resource URI returned by discover_subnet_mcp and admitted for reading in the registry. The URI is sent to the admitted MCP server, never fetched as a separate URL.",
      ),
  }).strict();

export const DiscoverSubnetMcpOutputSchema = z
  .object({
    surface_id: z.string(),
    tools: z.array(
      z
        .object({
          name: z.string(),
          access: z.enum(["read", "write"]),
          // The provider owns this extensible MCP definition, including its nested
          // JSON Schemas. The SDK validates it before it reaches this JSON document.
          definition: z.record(z.string(), z.json()),
        })
        .strict(),
    ),
    prompts: z
      .array(
        z
          .object({
            name: z.string(),
            definition: z.record(z.string(), z.json()),
          })
          .strict(),
      )
      .optional(),
    resources: z
      .array(
        z
          .object({
            uri: z.string(),
            definition: z.record(z.string(), z.json()),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const GetSubnetMcpPromptOutputSchema = z
  .object({
    surface_id: z.string(),
    prompt_name: z.string(),
    description: z.string().optional(),
    messages: z.array(
      z
        .object({
          role: z.enum(["user", "assistant"]),
          content_index: z.int().min(0),
        })
        .strict(),
    ),
    upstream_meta: z.record(z.string(), z.json()).optional(),
    credential_source: z.enum(["argument", "stored"]).optional(),
  })
  .strict();

export const ReadSubnetMcpResourceOutputSchema = z
  .object({
    surface_id: z.string(),
    resource_uri: z.string(),
    resources: z.array(
      z
        .object({
          uri: z.string(),
          content_index: z.int().min(0),
        })
        .strict(),
    ),
    upstream_meta: z.record(z.string(), z.json()).optional(),
    credential_source: z.enum(["argument", "stored"]).optional(),
  })
  .strict();

export const CallSubnetMcpOutputSchema = z
  .object({
    surface_id: z.string(),
    tool_name: z.string(),
    upstream_is_error: z.boolean(),
    structured_content: z.record(z.string(), z.json()).optional(),
    upstream_meta: z.record(z.string(), z.json()).optional(),
    credential_source: z.enum(["argument", "stored"]).optional(),
  })
  .strict();
