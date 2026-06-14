// Contract validator for the remote MCP server at POST /mcp.
//
// Exercises the JSON-RPC lifecycle (initialize + tools/list) and a tools/call
// for every registered tool against a cold local artifact env, asserting the
// MCP result envelope shape. Kept separate from validate-api.mjs because the
// MCP endpoint is not artifact-backed and must not enter the
// `checks.length === API_ROUTES.length` invariant.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { handleRequest } from "../workers/api.mjs";
import {
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  listToolDefinitions,
} from "../src/mcp-server.mjs";
import {
  buildAnthropicToolSpecs,
  buildOpenAIToolSpecs,
} from "../src/agent-tool-specs.mjs";
import { createLocalArtifactEnv } from "./lib.mjs";

const env = createLocalArtifactEnv();
const MCP_URL = "https://api.metagraph.sh/mcp";

// Compile each tool's declared outputSchema once; callOk asserts every
// successful tool result's structuredContent validates against it, so a tool's
// output can never drift from its advertised outputSchema.
const ajv = new Ajv2020({ strict: false });
const OUTPUT_VALIDATORS = new Map(
  listToolDefinitions()
    .filter((def) => def.outputSchema)
    .map((def) => [def.name, ajv.compile(def.outputSchema)]),
);

async function mcp(payload, { method = "POST" } = {}) {
  const request = new Request(MCP_URL, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  const response = await handleRequest(request, env, {});
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function getJson(path) {
  const request = new Request(`https://api.metagraph.sh${path}`, {
    method: "GET",
  });
  const response = await handleRequest(request, env, {});
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function call(name, args) {
  const res = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(res.status, 200, `${name}: expected HTTP 200`);
  const result = res.body?.result;
  assert.ok(result, `${name}: missing JSON-RPC result`);
  assert.ok(
    Array.isArray(result.content) && result.content.length > 0,
    `${name}: result.content must be a non-empty array`,
  );
  assert.equal(
    result.content[0].type,
    "text",
    `${name}: first content block must be text`,
  );
  return result;
}

async function callOk(name, args) {
  const result = await call(name, args);
  assert.equal(
    result.isError,
    false,
    `${name}: expected a successful tool result, got isError=true (${result.content[0]?.text})`,
  );
  assert.equal(
    typeof result.structuredContent,
    "object",
    `${name}: successful results must include structuredContent`,
  );
  const validate = OUTPUT_VALIDATORS.get(name);
  if (validate) {
    assert.ok(
      validate(result.structuredContent),
      `${name}: structuredContent must validate against its declared outputSchema: ${JSON.stringify(validate.errors)}`,
    );
  }
  return result.structuredContent;
}

// --- Lifecycle -------------------------------------------------------------

const init = await mcp({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
});
assert.equal(init.status, 200, "initialize must return HTTP 200");
assert.equal(
  init.body.result.protocolVersion,
  "2025-06-18",
  "initialize must negotiate the requested protocol version",
);
assert.equal(init.body.result.serverInfo.name, "metagraphed");
// The MCP server version is its own SemVer (#393), distinct from the date-based
// CONTRACT_VERSION, and must match the source constant.
assert.match(
  init.body.result.serverInfo.version,
  /^\d+\.\d+\.\d+$/,
  "serverInfo.version must be SemVer (MCP_SERVER_VERSION), not the date-based CONTRACT_VERSION",
);
assert.equal(
  init.body.result.serverInfo.version,
  MCP_SERVER_VERSION,
  "serverInfo.version must match the MCP_SERVER_VERSION constant",
);
// The MCP Registry listing (server.json) must advertise the same version the
// live server reports, so registry discovery and a direct connect agree.
const serverManifestVersion = JSON.parse(
  readFileSync("server.json", "utf8"),
).version;
assert.equal(
  serverManifestVersion,
  MCP_SERVER_VERSION,
  "server.json version (MCP Registry listing) must match MCP_SERVER_VERSION",
);
assert.ok(
  init.body.result.capabilities.tools,
  "must advertise tools capability",
);

const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = listed.body.result.tools;
assert.equal(
  tools.length,
  MCP_TOOLS.length,
  `tools/list must expose all ${MCP_TOOLS.length} registered tools`,
);
const listedNames = new Set(tools.map((tool) => tool.name));
for (const tool of MCP_TOOLS) {
  assert.ok(listedNames.has(tool.name), `tools/list missing ${tool.name}`);
}
for (const tool of tools) {
  assert.equal(typeof tool.name, "string", "tool.name must be a string");
  assert.equal(
    typeof tool.description,
    "string",
    `${tool.name}: needs a description`,
  );
  assert.equal(
    tool.inputSchema?.type,
    "object",
    `${tool.name}: inputSchema must be an object schema`,
  );
}

// --- Agent tool specs (OpenAI + Anthropic) ---------------------------------
// The /.well-known/agent-tools/* specs are projected at request time from the
// same listToolDefinitions() the MCP server advertises, so they must cover
// every tool and match the canonical projection byte-for-byte (no drift).

const toolNames = new Set(MCP_TOOLS.map((tool) => tool.name));

const openaiSpec = await getJson("/.well-known/agent-tools/openai.json");
assert.equal(openaiSpec.status, 200, "openai.json must return HTTP 200");
assert.deepEqual(
  openaiSpec.body,
  buildOpenAIToolSpecs(listToolDefinitions()),
  "served openai.json must equal the canonical OpenAI projection",
);
assert.equal(
  openaiSpec.body.length,
  MCP_TOOLS.length,
  "openai.json must expose every MCP tool",
);
for (const entry of openaiSpec.body) {
  assert.equal(entry.type, "function", "openai entry must be a function tool");
  assert.ok(
    toolNames.has(entry.function?.name),
    `openai entry references unknown tool ${entry.function?.name}`,
  );
  assert.equal(
    entry.function?.parameters?.type,
    "object",
    `${entry.function?.name}: openai parameters must be an object schema`,
  );
  assert.equal(
    typeof entry.function?.description,
    "string",
    `${entry.function?.name}: openai tool needs a description`,
  );
}

const anthropicSpec = await getJson("/.well-known/agent-tools/anthropic.json");
assert.equal(anthropicSpec.status, 200, "anthropic.json must return HTTP 200");
assert.deepEqual(
  anthropicSpec.body,
  buildAnthropicToolSpecs(listToolDefinitions()),
  "served anthropic.json must equal the canonical Anthropic projection",
);
for (const entry of anthropicSpec.body) {
  assert.ok(
    toolNames.has(entry.name),
    `anthropic entry references unknown tool ${entry.name}`,
  );
  assert.equal(
    entry.input_schema?.type,
    "object",
    `${entry.name}: anthropic input_schema must be an object schema`,
  );
}

const toolsIndex = await getJson("/.well-known/agent-tools/index.json");
assert.equal(toolsIndex.status, 200, "agent-tools index must return HTTP 200");
assert.equal(
  toolsIndex.body.executor?.endpoint,
  "https://api.metagraph.sh/mcp",
  "agent-tools index executor must point at the MCP endpoint",
);
assert.equal(
  toolsIndex.body.executor?.jsonrpc_method,
  "tools/call",
  "agent-tools index executor must use tools/call",
);
assert.deepEqual(
  [...toolsIndex.body.tools].sort(),
  [...toolNames].sort(),
  "agent-tools index must list every MCP tool",
);

// --- One tools/call per tool ----------------------------------------------

await callOk("search_subnets", { query: "subnet", limit: 5 });
await callOk("find_subnets_by_capability", { capability: "data", limit: 5 });
const overview = await callOk("get_subnet", { netuid: 7 });
assert.equal(overview.netuid ?? overview.subnet?.netuid ?? 7, 7);
await callOk("get_subnet_health", { netuid: 7 });

const apis = await callOk("list_subnet_apis", { netuid: 7 });
assert.ok(
  Array.isArray(apis.services),
  "list_subnet_apis must return services[]",
);

await callOk("get_agent_catalog", {});
await callOk("get_agent_catalog", { netuid: 7 });
await callOk("registry_summary", {});

// Goal-shaped tools work without the AI layer (find_subnet_for_task falls back
// to keyword discovery; how_do_i_call reads the agent-catalog detail).
const taskMatch = await callOk("find_subnet_for_task", {
  task: "data",
  limit: 3,
});
assert.ok(
  Array.isArray(taskMatch.results),
  "find_subnet_for_task must return results[]",
);
const callGuide = await callOk("how_do_i_call", { netuid: 7 });
assert.equal(
  callGuide.netuid,
  7,
  "how_do_i_call must echo the resolved netuid",
);
assert.ok(
  Array.isArray(callGuide.services),
  "how_do_i_call must return services[]",
);

// get_best_rpc_endpoint may legitimately return zero eligible endpoints on a
// cold local build (no live probe KV), but must still succeed structurally.
const rpc = await callOk("get_best_rpc_endpoint", { limit: 3 });
assert.ok(
  Array.isArray(rpc.endpoints),
  "get_best_rpc_endpoint must return endpoints[]",
);

// Derive a real surface_id with a captured schema so get_api_schema resolves.
const schemaService = apis.services.find((service) => service.schema_artifact);
if (schemaService) {
  const schema = await callOk("get_api_schema", {
    surface_id: schemaService.surface_id,
  });
  assert.ok(schema, "get_api_schema must return the captured schema artifact");
} else {
  console.warn(
    "validate-mcp: no SN7 service exposed a schema_artifact; skipped get_api_schema happy-path.",
  );
}

// --- AI tools degrade gracefully without the AI bindings -------------------
// semantic_search + ask need VECTORIZE + AI, absent in this cold env. They must
// return a clean isError result (pointing at the keyword fallback), never throw.

const semanticCold = await call("semantic_search", {
  query: "image generation",
});
assert.equal(
  semanticCold.isError,
  true,
  "semantic_search must isError without the AI layer",
);
const askCold = await call("ask", { question: "Which subnet exposes an API?" });
assert.equal(askCold.isError, true, "ask must isError without the AI layer");

// --- Negative paths --------------------------------------------------------

const unknownMethod = await mcp({
  jsonrpc: "2.0",
  id: 9,
  method: "no/such/method",
});
assert.equal(
  unknownMethod.body.error.code,
  -32601,
  "unknown methods must return method-not-found",
);

const unknownTool = await call("not_a_real_tool", {});
assert.equal(unknownTool.isError, true, "unknown tools must return isError");

const getRejected = await mcp(null, { method: "GET" });
assert.equal(getRejected.status, 405, "GET /mcp must be rejected with 405");

console.log(
  `MCP validation passed: ${MCP_TOOLS.length} tools, lifecycle + ${
    schemaService ? "all" : "all-but-schema"
  } tools/call.`,
);
