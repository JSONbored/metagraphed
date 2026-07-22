// AI-resources index loader for MCP parity on GET /api/v1/agent-resources.
// Serves the baked /metagraph/agent-resources.json artifact (copyable agent,
// MCP install metadata, skill/OpenAPI links, and the agent-facing API index).

import type { StorageReadResult } from "../workers/storage.ts";

export const AGENT_RESOURCES_ARTIFACT = "/metagraph/agent-resources.json";

export interface AgentResourcesToolError extends Error {
  toolError: true;
  code: string;
}

export function agentResourcesToolError(
  code: string,
  message: string,
): AgentResourcesToolError {
  const error = new Error(message) as AgentResourcesToolError;
  error.toolError = true;
  error.code = code;
  return error;
}

export async function loadAgentResources(
  ctx: {
    env: Env;
    readArtifact: (env: Env, path: string) => Promise<StorageReadResult>;
  },
  {
    readArtifact,
  }: {
    readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  } = {},
): Promise<unknown> {
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, AGENT_RESOURCES_ARTIFACT);
  if (!result?.ok) {
    const code =
      (result as { code?: string } | undefined)?.code || "artifact_unavailable";
    if (code === "artifact_not_found") {
      throw agentResourcesToolError(
        "not_found",
        "The AI-resources index is unavailable in this environment.",
      );
    }
    throw agentResourcesToolError(
      code,
      `Could not load ${AGENT_RESOURCES_ARTIFACT} (${code}).`,
    );
  }
  const blob = result.data;
  if (!blob || typeof blob !== "object") {
    throw agentResourcesToolError(
      "not_found",
      "The AI-resources index is unavailable in this environment.",
    );
  }
  return blob;
}

export const GET_AGENT_RESOURCES_INSTRUCTIONS =
  "get_agent_resources the AI-resources index (copyable agent, MCP install, " +
  "skill, OpenAPI, and agent-facing API links; mirrors GET /api/v1/agent-resources), ";

export const GET_AGENT_RESOURCES_MCP_TOOL = {
  name: "get_agent_resources",
  title: "Get the AI-resources index",
  description:
    "Fetch the machine-readable AI-resources index: the copyable agent prompt " +
    "(/agent.md), MCP server install metadata and tool listing, the Bittensor " +
    "skill, llms.txt, OpenAPI, and links to agent-facing APIs (catalog, " +
    "semantic search, ask, fixtures, lineage). Use it to bootstrap an agent " +
    "integration session before calling get_agent_catalog or list_fixtures. " +
    "Mirrors GET /api/v1/agent-resources.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };

export const GET_AGENT_RESOURCES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["resources", "mcp"],
  properties: {
    generated_at: NULLABLE_STRING,
    published_at: NULLABLE_STRING,
    content_hash: NULLABLE_STRING,
    summary: { type: "object" },
    copyable_agent: { type: "object" },
    mcp: { type: "object" },
    resources: { type: "array", items: { type: "object" } },
  },
};
