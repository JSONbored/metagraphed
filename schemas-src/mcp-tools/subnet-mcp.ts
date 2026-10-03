import { z } from "zod";
import { StoredSurfaceCredentialSchema } from "./ai-integration.ts";
import { surfaceIdSchema } from "./shared.ts";

export const DiscoverSubnetMcpInputSchema = z.object({
  surface_id: surfaceIdSchema(),
  credential: StoredSurfaceCredentialSchema.optional().describe(
    "Caller credential in the registry's declared format. Authenticated callers can store it once with store_surface_credential and omit this argument.",
  ),
  timeout_ms: z.int().min(1).max(30_000).optional(),
}).strict();

export const CallSubnetMcpInputSchema = DiscoverSubnetMcpInputSchema.extend({
  tool_name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.json()).optional(),
}).strict();

export const DiscoverSubnetMcpOutputSchema = z.object({
  surface_id: z.string(),
  tools: z.array(z.object({
    name: z.string(),
    access: z.enum(["read", "write"]),
    // The provider owns this extensible MCP definition, including its nested
    // JSON Schemas. The SDK validates it before it reaches this JSON document.
    definition: z.record(z.string(), z.json()),
  }).strict()),
}).strict();

export const CallSubnetMcpOutputSchema = z.object({
  surface_id: z.string(),
  tool_name: z.string(),
  upstream_is_error: z.boolean(),
  structured_content: z.record(z.string(), z.json()).optional(),
  upstream_meta: z.record(z.string(), z.json()).optional(),
  credential_source: z.enum(["argument", "stored"]).optional(),
}).strict();
