// Contract validator for the remote MCP server at POST /mcp.
//
// Exercises the JSON-RPC lifecycle (initialize + tools/list) and a tools/call
// for every registered tool against a cold local artifact env, asserting the
// MCP result envelope shape. Kept separate from validate-api.mjs because the
// MCP endpoint is not artifact-backed and must not enter the
// `checks.length === API_ROUTES.length` invariant.
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { handleRequest } from "../workers/api.mjs";
import { MCP_TOOLS, listToolDefinitions } from "../src/mcp-server.mjs";
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
