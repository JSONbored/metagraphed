// Agent tool specs for NON-MCP agent runtimes.
//
// The canonical MCP server (src/mcp-server.mjs) exposes our tools over the MCP
// `tools/list` projection. The two largest agent ecosystems — OpenAI function
// calling and Anthropic tool use — consume *static* tool JSON instead, so we
// project the same `listToolDefinitions()` output into their shapes. Building
// from that single source means the OpenAI/Anthropic specs can never drift from
// what the MCP server advertises (same names, descriptions, and JSON Schemas,
// including the untrusted-data note baked into each description).
//
// Execution is uniform: every tool is run by forwarding the model's tool call
// to the MCP endpoint as a JSON-RPC `tools/call` (see buildAgentToolsIndex).
import { CONTRACT_VERSION, PRIMARY_DOMAIN } from "./contracts.ts";
import { MCP_SERVER_INFO, listToolDefinitions } from "./mcp-server.mjs";

const ORIGIN = `https://${PRIMARY_DOMAIN}`;
const MCP_ENDPOINT = `${ORIGIN}/mcp`;
const OPENAI_SPEC_URL = `${ORIGIN}/.well-known/agent-tools/openai.json`;
const ANTHROPIC_SPEC_URL = `${ORIGIN}/.well-known/agent-tools/anthropic.json`;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

// OpenAI Chat Completions / Responses `tools[]` entries: a bare, paste-ready
// array of `{ type: "function", function: { name, description, parameters } }`.
export function buildOpenAIToolSpecs(
  tools: ToolDefinition[] = listToolDefinitions(),
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// Anthropic Messages `tools[]` entries: `{ name, description, input_schema }`.
export function buildAnthropicToolSpecs(
  tools: ToolDefinition[] = listToolDefinitions(),
): Array<{ name: string; description: string; input_schema: unknown }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// A small machine-readable hub: what the specs are, where they live, and the
// single uniform executor (the MCP endpoint). Keeps the executor mapping out of
// the spec arrays themselves (which must stay valid for their target SDK).
export function buildAgentToolsIndex(
  tools: ToolDefinition[] = listToolDefinitions(),
  { contractVersion = CONTRACT_VERSION }: { contractVersion?: string } = {},
): {
  schema_version: 1;
  title: string;
  description: string;
  contract_version: string;
  executor: {
    transport: string;
    endpoint: string;
    jsonrpc_method: string;
  };
  specs: { openai: string; anthropic: string };
  tools: string[];
} {
  return {
    schema_version: 1,
    title: `${MCP_SERVER_INFO.title} — agent tool specs`,
    description:
      "Paste-ready OpenAI + Anthropic tool specs derived from the metagraphed " +
      "MCP tools. Execute any tool by forwarding the model's tool call to the " +
      "MCP endpoint as a JSON-RPC tools/call.",
    contract_version: contractVersion,
    executor: {
      transport: "mcp-streamable-http",
      endpoint: MCP_ENDPOINT,
      jsonrpc_method: "tools/call",
    },
    specs: {
      openai: OPENAI_SPEC_URL,
      anthropic: ANTHROPIC_SPEC_URL,
    },
    tools: tools.map((tool) => tool.name),
  };
}
