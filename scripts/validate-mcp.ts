// Contract validator for the remote MCP server at POST /mcp.
//
// Exercises the JSON-RPC lifecycle (initialize + tools/list) and a tools/call
// for every registered tool against a cold local artifact env, asserting the
// MCP result envelope shape. Kept separate from validate-api.ts because the
// MCP endpoint is not artifact-backed and must not enter the
// `checks.length === API_ROUTES.length` invariant.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { handleRequest } from "../workers/api.ts";
import { PRIMARY_DOMAIN, REPOSITORY_URL } from "../src/contracts.ts";
import {
  ACCOUNTS_LIST_LIMIT_MAX,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  CHAIN_TURNOVER_LIMIT_MAX,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  MOVERS_LIMIT_MAX,
  SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  TOP_HOLDERS_LIMIT_MAX,
  VALIDATOR_ECONOMICS_LIMIT_MAX,
} from "../src/route-limits.ts";
import { MCP_SERVER_INFO } from "../src/mcp-server.ts";
import {
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import {
  buildAnthropicToolSpecs,
  buildOpenAIToolSpecs,
} from "../src/agent-tool-specs.ts";
import { ChainFirehoseHub } from "../workers/chain-firehose-hub.ts";
import {
  MCP_CHAIN_STREAM_RESOURCE_URI,
  McpSessionHub,
} from "../workers/mcp-session-hub.ts";
import { SubnetStatusHub } from "../workers/subnet-status-hub.ts";
import { buildSubnetStatusResourceUri } from "../src/subnet-status-subscribe.ts";
import { EVM_PRECOMPILE_BY_ADDRESS } from "../src/evm-precompiles.ts";
import {
  artifactFilePath,
  createLocalArtifactEnv,
  latestArtifactDate,
} from "./lib.ts";

// MCP tool call results are dynamic JSON-RPC payloads, read only for
// assertion purposes -- never trusted for control flow. Mirrors the
// readJson/readArtifactJson precedent in lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

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

// --- Response-shape coverage (#9795) ---------------------------------------
//
// The assertion above is correct and was still blind. Five tools shipped
// responses that failed their own published outputSchema while this gate was
// green (#9794), for two reasons that both amount to the check running over
// nothing:
//
//   1. Only the tools this script explicitly calls were ever validated. The
//      rest were listed, their input schemas inspected, and never invoked.
//   2. Of the ones called, several answer from the local artifact harness with
//      empty collections -- `days: []`, `positions: []`, `endpoints: []`. The
//      offending field lived INSIDE those arrays, so with zero elements there
//      was nothing to reject. `get_economics_trends` declared
//      `days[].total_stake_alpha` as a number while production served a
//      precision string, and this gate passed on it every run.
//
// A schema check over a zero-length array proves nothing, and reads as coverage.
// So the run now keeps two ledgers and asserts against them at the end: which
// tools had a response validated at all, and which of their declared
// collections actually carried a row. Anything that cannot be exercised locally
// has to say so out loud, with a reason, rather than passing quietly.
const RESPONSE_VALIDATED = new Set<string>();
const COLLECTIONS_EXERCISED = new Map<string, Set<string>>();

function recordResponseCoverage(name: string, payload: Row): void {
  RESPONSE_VALIDATED.add(name);
  const exercised = COLLECTIONS_EXERCISED.get(name) ?? new Set<string>();
  for (const [key, value] of Object.entries(payload)) {
    if (Array.isArray(value) && value.length > 0) exercised.add(key);
  }
  COLLECTIONS_EXERCISED.set(name, exercised);
}

/**
 * The top-level properties a tool's outputSchema declares as an array of
 * objects -- the ones whose element shape is only checked when an element
 * exists. Arrays of scalars are excluded: their item schema is asserted by the
 * array's own type, so an empty one hides nothing.
 */
function declaredObjectCollections(schema: Row | undefined): string[] {
  const properties = schema?.properties as Row | undefined;
  if (!properties) return [];
  return Object.entries(properties)
    .filter(([, value]) => {
      const node = value as Row;
      if (node?.type !== "array") return false;
      const items = node.items as Row | undefined;
      if (!items) return false;
      if (items.type === "object") return true;
      // A nullable or unioned item shape still hides an object behind a branch.
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        const branch = items[key];
        if (
          Array.isArray(branch) &&
          branch.some((entry: Row) => entry?.type === "object")
        ) {
          return true;
        }
      }
      return false;
    })
    .map(([key]) => key);
}

interface McpCallOptions {
  method?: string;
  headers?: Record<string, string>;
  envOverride?: Row;
}

async function mcp(
  payload: unknown,
  { method = "POST", headers = {}, envOverride = env }: McpCallOptions = {},
): Promise<Row> {
  const response = await mcpRaw(payload, { method, headers, envOverride });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

// Raw-response variant for GET (an open SSE stream -- .text() would hang
// draining it until MCP_SESSION_MAX_STREAM_DURATION_MS) and DELETE (a bare
// 204/405, no body to parse).
async function mcpRaw(
  payload: unknown,
  { method = "POST", headers = {}, envOverride = env }: McpCallOptions = {},
) {
  const request = new Request(MCP_URL, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  return handleRequest(request, envOverride as unknown as Env, {});
}

async function getJson(path: string): Promise<Row> {
  const request = new Request(`https://api.metagraph.sh${path}`, {
    method: "GET",
  });
  const response = await handleRequest(request, env as unknown as Env, {});
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function call(name: string, args: unknown): Promise<Row> {
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

async function callOk(name: string, args: unknown): Promise<Row> {
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
  recordResponseCoverage(name, result.structuredContent);
  return result.structuredContent;
}

// --- MCP resource-subscription fixtures (#4983 MCP half) -------------------
//
// Two real Durable Object classes (McpSessionHub + ChainFirehoseHub) wired
// together exactly like wrangler.jsonc's two bindings, backed by in-memory
// fakes for state.storage / state.getWebSockets -- same "fake infra, real
// business logic" convention as createLocalArtifactEnv's ASSETS/R2/KV fakes
// above, so the resources/subscribe -> ingest -> notifications/resources/
// updated round trip below exercises the actual class code, not a
// hand-rolled simulation of it.

function inMemoryDoStorage() {
  const data = new Map<string, unknown>();
  return {
    async get(keys: string[]) {
      const result = new Map<string, unknown>();
      for (const key of keys) {
        if (data.has(key)) result.set(key, data.get(key));
      }
      return result;
    },
    async put(entries: Record<string, unknown>) {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    },
    async setAlarm() {
      // no-op: nothing in this script waits out MCP_SESSION_IDLE_TTL_MS
    },
  };
}

interface DoStub {
  fetch(request: Request): Promise<Response> | Response;
}

// A minimal fake DurableObjectNamespace: the SAME id always resolves to the
// SAME instance (required for GET /stream and POST /subscribe on one
// session to reach the same McpSessionHub), matching real
// idFromName()/get() semantics.
function fakeDoNamespace(makeInstance: (id: string) => DoStub) {
  const instances = new Map<string, DoStub>();
  return {
    idFromName: (name: string) => name,
    get(id: string) {
      if (!instances.has(id)) instances.set(id, makeInstance(id));
      const instance = instances.get(id) as DoStub;
      return {
        fetch: (url: string | URL, init?: RequestInit) =>
          instance.fetch(new Request(url, init)),
      };
    },
  };
}

// Mutually-referencing by design (McpSessionHub tells ChainFirehoseHub /
// SubnetStatusHub about a subscribe/unsubscribe; those hubs tell
// McpSessionHub about a new event) -- safe because fakeDoNamespace only
// calls its factory lazily, by which point all bindings below are fully
// initialized.
const mcpSessionHubNS: ReturnType<typeof fakeDoNamespace> = fakeDoNamespace(
  () =>
    new McpSessionHub(
      { storage: inMemoryDoStorage() } as unknown as DurableObjectState,
      {
        CHAIN_FIREHOSE_HUB: chainFirehoseHubNS,
        SUBNET_STATUS_HUB: subnetStatusHubNS,
      } as unknown as Env,
    ),
);
const chainFirehoseHubNS: ReturnType<typeof fakeDoNamespace> = fakeDoNamespace(
  () =>
    new ChainFirehoseHub(
      { getWebSockets: () => [] } as unknown as DurableObjectState,
      { MCP_SESSION_HUB: mcpSessionHubNS } as unknown as Env,
    ),
);
const subnetStatusHubNS: ReturnType<typeof fakeDoNamespace> = fakeDoNamespace(
  () =>
    new SubnetStatusHub(
      { storage: inMemoryDoStorage() } as unknown as DurableObjectState,
      { MCP_SESSION_HUB: mcpSessionHubNS } as unknown as Env,
    ),
);
const lifecycleEnv = createLocalArtifactEnv({
  MCP_SESSION_HUB: mcpSessionHubNS,
  CHAIN_FIREHOSE_HUB: chainFirehoseHubNS,
  SUBNET_STATUS_HUB: subnetStatusHubNS,
});

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
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  "serverInfo.version must be SemVer without leading-zero numeric identifiers (MCP_SERVER_VERSION), not the date-based CONTRACT_VERSION",
);
assert.equal(
  init.body.result.serverInfo.version,
  MCP_SERVER_VERSION,
  "serverInfo.version must match the MCP_SERVER_VERSION constant",
);
// The MCP Registry listing (server.json) is a SECOND published description of
// this server, and it must not disagree with the first.
//
// Only the version was pinned here. Title, endpoint and repository were
// hand-copied literals that happened to be right -- and a registry listing
// disagreeing with the live endpoint is precisely the defect ADR 0027 was
// written about (#8967: the card advertised `authentication: "none"` while
// /mcp was a live OAuth 2.1 protected resource). Every field below is asserted
// against the SAME constant the worker-computed card renders from, so a
// listing refresh cannot drift from what the server actually is.
//
// `name` is deliberately NOT compared: the registry namespaces it
// ("io.github.JSONbored/metagraphed") while the server reports "metagraphed".
// Those differ on purpose.
const serverManifest = JSON.parse(readFileSync("server.json", "utf8")) as Row;
assert.equal(
  serverManifest.version,
  MCP_SERVER_VERSION,
  "server.json version (MCP Registry listing) must match MCP_SERVER_VERSION",
);
assert.equal(
  serverManifest.title,
  MCP_SERVER_INFO.title,
  "server.json title must match MCP_SERVER_INFO.title (the title the server card renders)",
);
assert.equal(
  (serverManifest.remotes as Row[])?.[0]?.url,
  `https://${PRIMARY_DOMAIN}/mcp`,
  "server.json must point registry consumers at the endpoint the server actually serves",
);
assert.equal(
  (serverManifest.remotes as Row[])?.[0]?.type,
  "streamable-http",
  "server.json transport must match the card's declared transport",
);
assert.equal(
  (serverManifest.repository as Row)?.url,
  REPOSITORY_URL,
  "server.json repository must match the repository the server card publishes",
);
assert.ok(
  init.body.result.capabilities.tools,
  "must advertise tools capability",
);

const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = listed.body.result.tools as Row[];
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

// --- Input-schema honesty ------------------------------------------
//
// The published input schema is the WHOLE contract an MCP client sees: dispatch
// validates that arguments are an object and nothing else — no types, no enums, no
// bounds — so a schema that misdescribes a parameter is not caught anywhere at runtime.
// Three classes had accumulated, all of them invisible to the one assertion above.

const SENTINEL_MAX = Number.MAX_SAFE_INTEGER;
const SENTINEL_MIN = Number.MIN_SAFE_INTEGER;

/** Walk every subschema of a published input schema, with a readable path. */
function* walkSchema(
  schema: unknown,
  path = "",
): Generator<{ path: string; node: Row }> {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const [index, entry] of schema.entries()) {
      yield* walkSchema(entry, `${path}[${index}]`);
    }
    return;
  }
  const node = schema as Row;
  yield { path: path || ".", node };
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      yield* walkSchema(value, path ? `${path}.${key}` : key);
    }
  }
}

for (const tool of tools) {
  for (const { path, node } of walkSchema(tool.inputSchema)) {
    if (node.type !== "integer") continue;
    // Zod's `z.int()` carries the safe-integer range as a real constraint, so every
    // integer parameter published one whether or not anyone chose it — which made a
    // deliberate `.max()` indistinguishable from the default. listToolDefinitions()
    // strips them; this is what keeps a newly-added `z.int()` from reintroducing the
    // class. Add a real `.max()`, or leave the parameter genuinely unbounded.
    assert.notEqual(
      node.maximum,
      SENTINEL_MAX,
      `${tool.name}: ${path} publishes Zod's safe-integer sentinel as a maximum`,
    );
    assert.notEqual(
      node.minimum,
      SENTINEL_MIN,
      `${tool.name}: ${path} publishes Zod's safe-integer sentinel as a minimum`,
    );
  }
}

// Every `limit` must declare the same ceiling the mirrored REST route enforces. #8251
// moved a ceiling in one place and left the published contract declaring the old one,
// so a client generated from our own spec rejected the request our own site makes;
// src/route-limits.ts exists to make that impossible and only helps if it is read.
const MCP_LIMIT_CEILINGS: Record<string, number> = {
  list_global_validators: GLOBAL_VALIDATOR_LIMIT_MAX,
  list_validator_economics: VALIDATOR_ECONOMICS_LIMIT_MAX,
  get_subnet_movers: MOVERS_LIMIT_MAX,
  get_chain_turnover: CHAIN_TURNOVER_LIMIT_MAX,
  get_top_holders: TOP_HOLDERS_LIMIT_MAX,
  list_accounts: ACCOUNTS_LIST_LIMIT_MAX,
  get_subnet_event_summary: SUBNET_EVENT_SUMMARY_RECENT_LIMIT_MAX,
  get_chain_identity_history: CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
};
for (const [name, ceiling] of Object.entries(MCP_LIMIT_CEILINGS)) {
  const tool = tools.find((entry: Row) => entry.name === name);
  assert.ok(tool, `${name}: named in MCP_LIMIT_CEILINGS but not published`);
  const limit = ((tool.inputSchema as Row)?.properties as Row)?.limit as Row;
  assert.ok(limit, `${name}: has a route-limit ceiling but no limit parameter`);
  assert.equal(
    limit.maximum,
    ceiling,
    `${name}: declares limit maximum ${limit.maximum} but src/route-limits.ts says ${ceiling}`,
  );
}

// A parameter whose description enumerates a closed set must DECLARE that set. An
// agent cannot be expected to parse prose to avoid a guaranteed rejection, and the
// same server already declared enums for 54 of 55 window parameters — so the misses
// read as oversights, not as a different convention.
const ENUM_REQUIRED: Array<[string, string]> = [
  ["list_validator_economics", "sort"],
  ["get_subnet_validator_economics_history", "window"],
  ["call_rpc", "method"],
  ["get_subnet_burn_history", "window"],
];
for (const [name, param] of ENUM_REQUIRED) {
  const tool = tools.find((entry: Row) => entry.name === name);
  assert.ok(tool, `${name}: named in ENUM_REQUIRED but not published`);
  const node = ((tool.inputSchema as Row)?.properties as Row)?.[param] as Row;
  assert.ok(node, `${name}: no ${param} parameter to constrain`);
  assert.ok(
    Array.isArray(node.enum) && node.enum.length > 0,
    `${name}.${param}: its description names a closed set, so the schema must declare an enum`,
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
for (const entry of openaiSpec.body as Row[]) {
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
for (const entry of anthropicSpec.body as Row[]) {
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
const excluded = await callOk("list_subnets", {
  not_status: "inactive",
  limit: 5,
});
assert.ok(
  Array.isArray(excluded.subnets) &&
    excluded.subnets.every((s) => s.status !== "inactive"),
  "list_subnets not_status must exclude matching subnets",
);
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
const agentResources = await callOk("get_agent_resources", {});
assert.ok(
  Array.isArray(agentResources.resources) && agentResources.mcp,
  "get_agent_resources must return resources[] and mcp",
);
const curationPage = await callOk("list_curation", { limit: 3 });
assert.ok(
  Array.isArray(curationPage.curation),
  "list_curation must return curation[]",
);
const gapsPage = await callOk("list_gaps", { limit: 3 });
assert.ok(Array.isArray(gapsPage.gaps), "list_gaps must return gaps[]");
const enrichmentQueuePage = await callOk("list_enrichment_queue", {
  limit: 3,
  lane: "direct-submission",
});
assert.ok(
  Array.isArray(enrichmentQueuePage.queue),
  "list_enrichment_queue must return queue[]",
);
const adapterCandidatesPage = await callOk("list_adapter_candidates", {
  limit: 3,
  operational_kinds: "openapi",
});
assert.ok(
  Array.isArray(adapterCandidatesPage.candidates),
  "list_adapter_candidates must return candidates[]",
);
const enrichmentEvidencePage = await callOk("list_enrichment_evidence", {
  limit: 3,
  evidence_action: "replace-stale-evidence",
});
assert.ok(
  Array.isArray(enrichmentEvidencePage.entries),
  "list_enrichment_evidence must return entries[]",
);
const reviewGapsPage = await callOk("list_review_gaps", {
  limit: 3,
  curation_level: "candidate-discovered",
});
assert.ok(
  Array.isArray(reviewGapsPage.priorities),
  "list_review_gaps must return priorities[]",
);
const reviewEnrichmentTargetsPage = await callOk(
  "list_review_enrichment_targets",
  {
    limit: 3,
    target_type: "surface-candidate",
  },
);
assert.ok(
  Array.isArray(reviewEnrichmentTargetsPage.targets),
  "list_review_enrichment_targets must return targets[]",
);
const subnetEndpointsPage = await callOk("list_subnet_endpoints", {
  netuid: 7,
  limit: 3,
  kind: "subnet-api",
});
assert.ok(
  Array.isArray(subnetEndpointsPage.endpoints),
  "list_subnet_endpoints must return endpoints[]",
);
const subnetEvidencePage = await callOk("list_subnet_evidence", {
  netuid: 7,
  limit: 3,
});
assert.ok(
  Array.isArray(subnetEvidencePage.claims),
  "list_subnet_evidence must return claims[]",
);
const evidencePage = await callOk("list_evidence", { limit: 3, q: "openapi" });
assert.ok(
  Array.isArray(evidencePage.claims),
  "list_evidence must return claims[]",
);
const providersPage = await callOk("list_providers", {
  limit: 3,
  authority: "official",
});
assert.ok(
  Array.isArray(providersPage.providers),
  "list_providers must return providers[]",
);
const surfacesPage = await callOk("list_surfaces", {
  limit: 3,
  kind: "openapi",
});
assert.ok(
  Array.isArray(surfacesPage.surfaces),
  "list_surfaces must return surfaces[]",
);
const searchIndexPage = await callOk("list_search_index", { limit: 3 });
assert.ok(
  Array.isArray(searchIndexPage.documents),
  "list_search_index must return documents[]",
);
const searchPage = await callOk("list_search", { limit: 3 });
assert.ok(
  Array.isArray(searchPage.documents),
  "list_search must return documents[]",
);
const sourceSnapshotsPage = await callOk("list_source_snapshots", {
  limit: 3,
  q: "native",
});
assert.ok(
  Array.isArray(sourceSnapshotsPage.sources),
  "list_source_snapshots must return sources[]",
);
const endpointPoolsPage = await callOk("list_endpoint_pools", { limit: 3 });
assert.ok(
  Array.isArray(endpointPoolsPage.pools),
  "list_endpoint_pools must return pools[]",
);
const endpointIncidentsPage = await callOk("list_endpoint_incidents", {
  limit: 3,
});
assert.ok(
  Array.isArray(endpointIncidentsPage.incidents),
  "list_endpoint_incidents must return incidents[]",
);
const providerEndpointsPage = await callOk("list_provider_endpoints", {
  slug: "allways",
  limit: 3,
});
assert.ok(
  Array.isArray(providerEndpointsPage.endpoints),
  "list_provider_endpoints must return endpoints[]",
);
assert.equal(
  providerEndpointsPage.slug,
  "allways",
  "list_provider_endpoints must echo the requested slug",
);
await callOk("registry_summary", {});
await callOk("get_coverage", {});
const contracts = await callOk("get_contracts", {});
assert.equal(contracts.schema_version, 1);
assert.ok(
  Array.isArray(contracts.artifacts) && contracts.artifacts.length > 0,
  "get_contracts must return artifacts[]",
);
const changelog = await callOk("get_changelog", {});
assert.equal(
  changelog.source,
  "generated-artifact-diff",
  "get_changelog must return the publish-time diff payload",
);
assert.ok(changelog.summary && typeof changelog.summary === "object");
assert.ok(changelog.artifacts && typeof changelog.artifacts === "object");
assert.ok(changelog.subnets && typeof changelog.subnets === "object");
const build = await callOk("get_build", {});
assert.equal(typeof build.artifact_count, "number");
assert.ok(Array.isArray(build.artifacts), "get_build must return artifacts[]");
const adapterArtifactPath = artifactFilePath("adapters/gittensor.json");
if (existsSync(adapterArtifactPath)) {
  const adapter = await callOk("get_adapter", { slug: "gittensor" });
  assert.equal(
    adapter.slug,
    "gittensor",
    "get_adapter must return the requested adapter slug",
  );
  assert.ok(
    adapter.snapshot && typeof adapter.snapshot === "object",
    "get_adapter must return snapshot object when staged",
  );
} else {
  const adapterCold = await call("get_adapter", { slug: "gittensor" });
  assert.equal(
    adapterCold.isError,
    true,
    "get_adapter must isError when the R2 adapter artifact is absent",
  );
  assert.match(
    adapterCold.content[0]?.text,
    /No adapter snapshot exists/i,
    "get_adapter must report not_found when the artifact is missing",
  );
}

// Per-subnet gap artifacts are R2-only (review/gaps/{netuid}.json); the cold
// env has them only after `npm run build` stages dist/. Exercise the happy path
// when staged, otherwise assert the not_found guard.
const gapsArtifactPath = artifactFilePath("review/gaps/7.json");
if (existsSync(gapsArtifactPath)) {
  const subnetGaps = await callOk("get_subnet_gaps", { netuid: 7 });
  assert.ok(
    Array.isArray(subnetGaps.priorities) &&
      Array.isArray(subnetGaps.enrichment_queue),
    "get_subnet_gaps must return priorities[] + enrichment_queue[]",
  );
  assert.equal(subnetGaps.netuid, 7, "get_subnet_gaps must echo the netuid");
} else {
  const subnetGapsCold = await call("get_subnet_gaps", { netuid: 7 });
  assert.equal(
    subnetGapsCold.isError,
    true,
    "get_subnet_gaps must isError when the R2 gap artifact is absent",
  );
  assert.match(
    subnetGapsCold.content[0]?.text,
    /No gap report exists/i,
    "get_subnet_gaps must report not_found when the artifact is missing",
  );
}

// Economic opportunity boards project from the committed economics.json in the
// cold local env; assert the call succeeds and returns the economic boards.
const opportunities = await callOk("find_subnet_opportunities", { limit: 5 });
assert.ok(
  opportunities.boards && typeof opportunities.boards === "object",
  "find_subnet_opportunities must return a boards object",
);
assert.ok(
  Array.isArray(opportunities.boards["open-slots"]),
  "find_subnet_opportunities must return the open-slots board",
);

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

// --- Economics + metagraph data tools --------------------------------------
// Economics serves live-KV-primary with committed-R2 fallback; this cold env has
// no live KV, so it falls back to the committed economics.json (netuid 7 has a row).
const econ = await callOk("get_subnet_economics", { netuid: 7 });
assert.ok(
  econ.economics && Number.isInteger(econ.economics.netuid),
  "get_subnet_economics must return the per-subnet economics row",
);
const economics = await callOk("get_economics", { limit: 5 });
assert.ok(
  Array.isArray(economics.subnets) &&
    economics.subnets.length <= 5 &&
    Number.isInteger(economics.total),
  "get_economics must return subnets[] with pagination totals",
);
const profilesList = await callOk("list_profiles", { limit: 5 });
assert.ok(
  Array.isArray(profilesList.profiles) &&
    profilesList.profiles.length <= 5 &&
    Number.isInteger(profilesList.total),
  "list_profiles must return profiles[] with pagination totals",
);
const subnetProfile = await callOk("get_subnet_profile", { netuid: 7 });
assert.ok(
  subnetProfile?.subnet?.netuid === 7 || subnetProfile?.profile,
  "get_subnet_profile must return subnet profile detail for netuid 7",
);

// The trajectory/metagraph/validators/neuron tiers are D1-backed; this cold env
// has no neurons DB, so each tool must degrade to its schema-stable empty
// payload (validated against the declared outputSchema), never an error.
const traj = await callOk("get_subnet_trajectory", { netuid: 7 });
assert.ok(
  Array.isArray(traj.points),
  "get_subnet_trajectory must return points[]",
);
const econTrends = await callOk("get_economics_trends", { window: "30d" });
assert.ok(
  Array.isArray(econTrends.days),
  "get_economics_trends must return days[]",
);
const chainCalls = await callOk("get_chain_calls", { window: "7d", limit: 10 });
assert.ok(
  Array.isArray(chainCalls.calls),
  "get_chain_calls must return calls[]",
);
const chainConc = await callOk("get_chain_concentration", {});
assert.ok(
  Number.isInteger(chainConc.subnet_count),
  "get_chain_concentration must return an integer subnet_count",
);
const chainTurnover = await callOk("get_chain_turnover", {
  window: "30d",
  limit: 5,
});
assert.ok(
  typeof chainTurnover.comparable === "boolean" &&
    Number.isInteger(chainTurnover.subnet_count) &&
    Array.isArray(chainTurnover.subnets) &&
    chainTurnover.network != null,
  "get_chain_turnover must return comparable + subnet_count + network + subnets[]",
);
const chainStakeFlow = await callOk("get_chain_stake_flow", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainStakeFlow.subnet_count) &&
    Array.isArray(chainStakeFlow.subnets) &&
    chainStakeFlow.network != null,
  "get_chain_stake_flow must return subnet_count + network + subnets[]",
);
const chainAlphaVolume = await callOk("get_chain_alpha_volume", { limit: 5 });
assert.ok(
  Number.isInteger(chainAlphaVolume.subnet_count) &&
    Array.isArray(chainAlphaVolume.subnets) &&
    chainAlphaVolume.network != null,
  "get_chain_alpha_volume must return subnet_count + network + subnets[]",
);
const chainWeights = await callOk("get_chain_weights", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainWeights.subnet_count) &&
    Array.isArray(chainWeights.subnets) &&
    chainWeights.network != null,
  "get_chain_weights must return subnet_count + network + subnets[]",
);
const subnetWeights = await callOk("get_subnet_weights", {
  netuid: 7,
  window: "7d",
});
assert.equal(
  subnetWeights.netuid,
  7,
  "get_subnet_weights must echo the netuid",
);
assert.ok(
  Number.isInteger(subnetWeights.distinct_setters) &&
    Number.isInteger(subnetWeights.weight_sets),
  "get_subnet_weights must return distinct_setters + weight_sets",
);
const chainWeightSetters = await callOk("get_chain_weight_setters", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainWeightSetters.distinct_setters) &&
    Array.isArray(chainWeightSetters.setters),
  "get_chain_weight_setters must return distinct_setters + setters[]",
);
const chainStakeMoves = await callOk("get_chain_stake_moves", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainStakeMoves.subnet_count) &&
    Array.isArray(chainStakeMoves.subnets) &&
    chainStakeMoves.network != null,
  "get_chain_stake_moves must return subnet_count + network + subnets[]",
);
const chainStakeTransfers = await callOk("get_chain_stake_transfers", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainStakeTransfers.subnet_count) &&
    Array.isArray(chainStakeTransfers.subnets) &&
    chainStakeTransfers.network != null,
  "get_chain_stake_transfers must return subnet_count + network + subnets[]",
);
const subnetStakeTransfers = await callOk("get_subnet_stake_transfers", {
  netuid: 7,
  window: "7d",
});
assert.equal(
  subnetStakeTransfers.netuid,
  7,
  "get_subnet_stake_transfers must echo the netuid",
);
assert.ok(
  Number.isInteger(subnetStakeTransfers.distinct_senders) &&
    Number.isInteger(subnetStakeTransfers.transfers),
  "get_subnet_stake_transfers must return distinct_senders + transfers",
);
const chainAxonRemovals = await callOk("get_chain_axon_removals", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainAxonRemovals.subnet_count) &&
    Array.isArray(chainAxonRemovals.subnets) &&
    chainAxonRemovals.network != null,
  "get_chain_axon_removals must return subnet_count + network + subnets[]",
);
const chainDeregistrations = await callOk("get_chain_deregistrations", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainDeregistrations.subnet_count) &&
    Array.isArray(chainDeregistrations.subnets) &&
    chainDeregistrations.network != null,
  "get_chain_deregistrations must return subnet_count + network + subnets[]",
);
const chainPrometheus = await callOk("get_chain_prometheus", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainPrometheus.subnet_count) &&
    Array.isArray(chainPrometheus.subnets) &&
    chainPrometheus.network != null,
  "get_chain_prometheus must return subnet_count + network + subnets[]",
);
const subnetPrometheus = await callOk("get_subnet_prometheus", {
  netuid: 7,
  window: "7d",
});
assert.equal(
  subnetPrometheus.netuid,
  7,
  "get_subnet_prometheus must echo the netuid",
);
assert.ok(
  Number.isInteger(subnetPrometheus.distinct_exporters) &&
    Number.isInteger(subnetPrometheus.announcements),
  "get_subnet_prometheus must return distinct_exporters + announcements",
);
const subnetServing = await callOk("get_subnet_serving", {
  netuid: 7,
  window: "7d",
});
assert.equal(
  subnetServing.netuid,
  7,
  "get_subnet_serving must echo the netuid",
);
assert.ok(
  Number.isInteger(subnetServing.distinct_servers) &&
    Number.isInteger(subnetServing.announcements),
  "get_subnet_serving must return distinct_servers + announcements",
);
const chainServing = await callOk("get_chain_serving", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Number.isInteger(chainServing.subnet_count) &&
    Array.isArray(chainServing.subnets) &&
    chainServing.network != null,
  "get_chain_serving must return subnet_count + network + subnets[]",
);
const chainTransferPairs = await callOk("get_chain_transfer_pairs", {
  window: "7d",
  limit: 5,
  sort: "volume",
});
assert.ok(
  Number.isInteger(chainTransferPairs.pair_count) &&
    Array.isArray(chainTransferPairs.pairs) &&
    typeof chainTransferPairs.total_volume_tao === "number",
  "get_chain_transfer_pairs must return pair_count + pairs[] + total_volume_tao",
);
const meta = await callOk("get_subnet_metagraph", { netuid: 7 });
assert.ok(
  Array.isArray(meta.neurons),
  "get_subnet_metagraph must return neurons[]",
);
const metaValidators = await callOk("get_subnet_metagraph", {
  netuid: 7,
  validator_permit: true,
});
assert.ok(
  Array.isArray(metaValidators.neurons),
  "get_subnet_metagraph (validator_permit) must return neurons[]",
);
const vals = await callOk("list_subnet_validators", { netuid: 7 });
assert.ok(
  Array.isArray(vals.validators),
  "list_subnet_validators must return validators[]",
);
const globalVals = await callOk("list_global_validators", {
  sort: "subnet_count",
  limit: 5,
});
assert.ok(
  Array.isArray(globalVals.validators),
  "list_global_validators must return validators[]",
);
assert.equal(
  globalVals.sort,
  "subnet_count",
  "list_global_validators must echo sort",
);
assert.equal(globalVals.limit, 5, "list_global_validators must echo limit");
assert.equal(
  typeof globalVals.validator_count,
  "number",
  "list_global_validators must return validator_count",
);
const yieldCard = await callOk("get_subnet_yield", { netuid: 7 });
assert.ok(
  Array.isArray(yieldCard.neurons),
  "get_subnet_yield must return neurons[]",
);
assert.equal(yieldCard.netuid, 7, "get_subnet_yield must echo the netuid");
const yieldHistory = await callOk("get_subnet_yield_history", {
  netuid: 7,
  window: "7d",
});
assert.equal(
  yieldHistory.netuid,
  7,
  "get_subnet_yield_history must echo the netuid",
);
assert.ok(
  Number.isInteger(yieldHistory.point_count) &&
    Array.isArray(yieldHistory.points),
  "get_subnet_yield_history must return point_count + points[]",
);
const uptimeFiltered = await callOk("get_subnet_uptime", {
  netuid: 7,
  min_samples: 5,
});
assert.ok(
  Array.isArray(uptimeFiltered.surfaces),
  "get_subnet_uptime must accept the min_samples filter",
);
const stakeFlowCold = await callOk("get_subnet_stake_flow", {
  netuid: 7,
  window: "30d",
});
assert.equal(stakeFlowCold.netuid, 7, "get_subnet_stake_flow must echo netuid");
assert.equal(
  stakeFlowCold.net_flow_tao,
  0,
  "get_subnet_stake_flow must degrade to zeros on cold D1",
);
const stakeFlowIn = await callOk("get_subnet_stake_flow", {
  netuid: 7,
  direction: "in",
});
assert.equal(
  stakeFlowIn.netuid,
  7,
  "get_subnet_stake_flow must accept the direction filter",
);
const moversCold = await callOk("get_subnet_movers", {
  window: "30d",
  sort: "stake",
  limit: 5,
});
assert.ok(
  Array.isArray(moversCold.movers),
  "get_subnet_movers must return movers[]",
);
const neuron = await callOk("get_neuron", { netuid: 7, uid: 0 });
assert.ok("neuron" in neuron, "get_neuron must return a neuron field");

// Account tools are D1-backed too; the cold env degrades each to its
// schema-stable empty payload (validated against the declared outputSchema).
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const account = await callOk("get_account", { ss58: SS58 });
assert.ok(
  Array.isArray(account.registrations) && Array.isArray(account.recent_events),
  "get_account must return registrations[] + recent_events[]",
);
const accountEvents = await callOk("get_account_events", {
  ss58: SS58,
  kind: "StakeAdded",
  limit: 50,
});
assert.ok(
  Array.isArray(accountEvents.events),
  "get_account_events must return events[]",
);
const accountSubnets = await callOk("get_account_subnets", { ss58: SS58 });
assert.ok(
  Array.isArray(accountSubnets.subnets),
  "get_account_subnets must return subnets[]",
);
const accountStakeFlow = await callOk("get_account_stake_flow", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountStakeFlow.subnets),
  "get_account_stake_flow must return subnets[]",
);
assert.equal(
  accountStakeFlow.address,
  SS58,
  "get_account_stake_flow must echo the address",
);
const accountStakeFlowIn = await callOk("get_account_stake_flow", {
  ss58: SS58,
  direction: "in",
});
assert.equal(
  accountStakeFlowIn.address,
  SS58,
  "get_account_stake_flow must accept the direction filter",
);
const accountStakeMoves = await callOk("get_account_stake_moves", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountStakeMoves.subnets),
  "get_account_stake_moves must return subnets[]",
);
assert.equal(
  accountStakeMoves.address,
  SS58,
  "get_account_stake_moves must echo the address",
);
const accountAxonRemovals = await callOk("get_account_axon_removals", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountAxonRemovals.subnets),
  "get_account_axon_removals must return subnets[]",
);
assert.equal(
  accountAxonRemovals.address,
  SS58,
  "get_account_axon_removals must echo the address",
);
const accountPrometheus = await callOk("get_account_prometheus", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountPrometheus.subnets),
  "get_account_prometheus must return subnets[]",
);
assert.equal(
  accountPrometheus.address,
  SS58,
  "get_account_prometheus must echo the address",
);
const accountRegistrations = await callOk("get_account_registrations", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountRegistrations.subnets),
  "get_account_registrations must return subnets[]",
);
assert.equal(
  accountRegistrations.address,
  SS58,
  "get_account_registrations must echo the address",
);
const accountWeightSetters = await callOk("get_account_weight_setters", {
  ss58: SS58,
  window: "7d",
});
assert.ok(
  Array.isArray(accountWeightSetters.subnets),
  "get_account_weight_setters must return subnets[]",
);
assert.equal(
  accountWeightSetters.address,
  SS58,
  "get_account_weight_setters must echo the address",
);
const accountServing = await callOk("get_account_serving", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountServing.subnets),
  "get_account_serving must return subnets[]",
);
assert.equal(
  accountServing.address,
  SS58,
  "get_account_serving must echo the address",
);
const accountDeregistrations = await callOk("get_account_deregistrations", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountDeregistrations.subnets),
  "get_account_deregistrations must return subnets[]",
);
assert.equal(
  accountDeregistrations.address,
  SS58,
  "get_account_deregistrations must echo the address",
);
const accountWeightSetters30d = await callOk("get_account_weight_setters", {
  ss58: SS58,
  window: "30d",
});
assert.ok(
  Array.isArray(accountWeightSetters30d.subnets),
  "get_account_weight_setters must return subnets[]",
);
assert.equal(
  accountWeightSetters30d.address,
  SS58,
  "get_account_weight_setters must echo the address",
);
const accountBalance = await callOk("get_account_balance", { ss58: SS58 });
assert.ok(
  "balance_tao" in accountBalance && accountBalance.ss58 === SS58,
  "get_account_balance must return ss58 + balance_tao (null on cold RPC)",
);
const evmAddressMapping = await callOk("get_evm_address_mapping", {
  h160: "0x0000000000000000000000000000000000000001",
});
assert.ok(
  "ss58" in evmAddressMapping &&
    evmAddressMapping.h160 === "0x0000000000000000000000000000000000000001",
  "get_evm_address_mapping must return h160 + ss58 (null on cold RPC)",
);

// Derive a real surface_id with a captured schema so get_api_schema resolves.
const schemaService = apis.services.find((service) => service.schema_artifact);
if (schemaService) {
  const schema = await callOk("get_api_schema", {
    surface_id:
      schemaService.schema_source?.surface_id || schemaService.surface_id,
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

// get_chain_activity reads the all-events tier through the DATA_API service
// binding, absent in this cold env. It must return a clean isError result (the
// "tier unavailable" guard), never throw.
const activityCold = await call("get_chain_activity", { blocks: 500 });
assert.equal(
  activityCold.isError,
  true,
  "get_chain_activity must isError without the DATA_API binding",
);
const blockChainEventsCold = await call("get_block_chain_events", {
  block_number: 4200000,
});
assert.equal(
  blockChainEventsCold.isError,
  true,
  "get_block_chain_events must isError without the DATA_API binding",
);
const extrinsicChainEventsCold = await call("get_extrinsic_chain_events", {
  ref: "4200000-3",
});
assert.equal(
  extrinsicChainEventsCold.isError,
  true,
  "get_extrinsic_chain_events must isError without the DATA_API binding",
);
const signersCold = await callOk("get_chain_signers", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Array.isArray(signersCold.signers) && signersCold.window === "7d",
  "get_chain_signers must return window + signers[] on cold D1",
);
const feesCold = await callOk("get_chain_fees", {
  window: "7d",
  limit: 5,
});
assert.ok(
  Array.isArray(feesCold.daily) &&
    Array.isArray(feesCold.top_fee_payers) &&
    feesCold.window === "7d",
  "get_chain_fees must return window + daily[] + top_fee_payers[] on cold D1",
);
const transfersCold = await callOk("get_chain_transfers", {
  window: "7d",
  limit: 5,
});
assert.ok(
  transfersCold.window === "7d" &&
    Array.isArray(transfersCold.top_senders) &&
    Array.isArray(transfersCold.top_receivers),
  "get_chain_transfers must return window + top_senders[] + top_receivers[] on cold D1",
);
const networkActivityCold = await callOk("get_network_activity", {
  window: "7d",
});
assert.ok(
  networkActivityCold.window === "7d" &&
    Array.isArray(networkActivityCold.days),
  "get_network_activity must return window + days[] on cold D1",
);
const rpcUsageCold = await callOk("get_rpc_usage", { window: "7d" });
assert.ok(
  rpcUsageCold.window === "7d" &&
    Array.isArray(rpcUsageCold.endpoints) &&
    Array.isArray(rpcUsageCold.buckets),
  "get_rpc_usage must return window + endpoints[] + buckets[] on cold D1",
);
const healthTrendsCold = await callOk("get_health_trends", {});
assert.ok(
  healthTrendsCold.windows?.["7d"] &&
    Array.isArray(healthTrendsCold.windows["7d"].subnets),
  "get_health_trends must return windows.7d.subnets[] on cold D1",
);
const networkHealthCold = await callOk("get_network_health", {});
assert.ok(
  networkHealthCold.scope === "operational" &&
    networkHealthCold.global &&
    Array.isArray(networkHealthCold.subnets),
  "get_network_health must return scope + global + subnets[] on cold KV",
);
const latestHealthHistoryDate = await latestArtifactDate("health/history");
assert.ok(
  latestHealthHistoryDate,
  "validate:mcp requires a local health/history/YYYY-MM-DD.json artifact; run `npm run build` first",
);
const healthHistory = await callOk("get_health_history", {
  date: latestHealthHistoryDate,
  limit: 2,
});
assert.ok(
  healthHistory.date === latestHealthHistoryDate &&
    Array.isArray(healthHistory.surfaces) &&
    healthHistory.surfaces.length <= 2,
  "get_health_history must return date + surfaces[] for the staged snapshot",
);
const blockExtrinsicsCold = await callOk("list_block_extrinsics", {
  ref: "4200000",
});
assert.ok(
  blockExtrinsicsCold.ref === "4200000" &&
    blockExtrinsicsCold.block_number == null &&
    Array.isArray(blockExtrinsicsCold.extrinsics),
  "list_block_extrinsics must return ref + block_number:null + extrinsics[] on cold D1",
);
const blockEventsCold = await callOk("get_block_events", { ref: "4200000" });
assert.ok(
  blockEventsCold.ref === "4200000" &&
    blockEventsCold.block_number == null &&
    Array.isArray(blockEventsCold.events),
  "get_block_events must return ref + block_number:null + events[] on cold D1",
);

// Curated saved-query library (#6755/#6757): one call per seed template,
// exercising the same dispatch GET /api/v1/queries/{id} shares.
const savedLeaderboard = await callOk("run_saved_query", {
  query_id: "subnet-leaderboard",
  params: { board: "highest-emission", limit: 5 },
});
assert.equal(savedLeaderboard.query_id, "subnet-leaderboard");
assert.ok(
  savedLeaderboard.data && typeof savedLeaderboard.data === "object",
  "run_saved_query(subnet-leaderboard) must return a data object",
);
const savedRegistrations = await callOk("run_saved_query", {
  query_id: "chain-registrations-window",
  params: { window: "7d", limit: 5 },
});
assert.equal(savedRegistrations.query_id, "chain-registrations-window");
assert.equal(savedRegistrations.data.window, "7d");

// EVM precompile decoding (#6725/#6729): one known-address/known-selector
// call, exercising the same registry+decoder decodeEthereumTransactArgs's
// own precompile_call field shares.
const subnetPrecompileAddress = "0x0000000000000000000000000000000000000803";
const getWeightsVersionKeyFn = EVM_PRECOMPILE_BY_ADDRESS.get(
  subnetPrecompileAddress,
)!.functions.find((fn) => fn.name === "getWeightsVersionKey");
const evmDecoded = await callOk("decode_evm_call", {
  to: subnetPrecompileAddress,
  input: `${getWeightsVersionKeyFn!.selector}${"7".padStart(64, "0")}`,
});
assert.equal(evmDecoded.precompile, "Subnet");
assert.equal(evmDecoded.function, "getWeightsVersionKey");
assert.equal(evmDecoded.args.netuid, 7);
const evmUnknownSelector = await callOk("decode_evm_call", {
  to: subnetPrecompileAddress,
  input: "0xffffffff",
});
assert.equal(evmUnknownSelector.precompile, "Subnet");
assert.equal(evmUnknownSelector.function, null);

// --- Negative paths --------------------------------------------------------

const unknownSavedQuery = await call("run_saved_query", {
  query_id: "not-a-real-template",
});
assert.equal(
  unknownSavedQuery.isError,
  true,
  "run_saved_query with an unknown query_id must return isError",
);

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

// 405, not 400: the Streamable HTTP transport names 405 as the sanctioned "this
// endpoint offers no SSE stream", and a conformant client treats it as POST-only
// and carries on. Any other non-2xx is a transport error that starts a reconnect
// loop — which is what every client opening the push channel used to hit.
const getWithoutSession = await mcpRaw(null, { method: "GET" });
assert.equal(
  getWithoutSession.status,
  405,
  "GET /mcp without an Mcp-Session-Id header must answer 405, not a transport error",
);
assert.equal(
  getWithoutSession.headers.get("allow"),
  "POST, DELETE, OPTIONS",
  "a 405 must say which methods the endpoint does take",
);

const A_SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const getUnprovisioned = await mcpRaw(null, {
  method: "GET",
  headers: { "mcp-session-id": A_SESSION_ID },
});
assert.equal(
  getUnprovisioned.status,
  405,
  "GET /mcp on a deployment with no MCP_SESSION_HUB binding must degrade to 405",
);

const deleteWithoutSession = await mcpRaw(null, { method: "DELETE" });
assert.equal(
  deleteWithoutSession.status,
  400,
  "DELETE /mcp without an Mcp-Session-Id header must be rejected with 400",
);

const badProtocolVersion = await mcp(
  { jsonrpc: "2.0", id: 1, method: "ping" },
  { headers: { "mcp-protocol-version": "1999-01-01" } },
);
assert.equal(
  badProtocolVersion.status,
  400,
  "an unrecognized MCP-Protocol-Version header must be rejected with 400",
);

// --- MCP resource-subscription lifecycle (#4983 MCP half) ------------------
//
// The full contract, end to end through the two real Durable Object classes
// wired above: initialize mints a session -> resources/subscribe on the
// chain-stream resource -> a chain event actually lands via POST /ingest
// (the same route the box-side relay hits in production, #4981/#4982) ->
// the open GET stream receives a pointer-only notifications/resources/
// updated push -> resources/read returns the CURRENT payload (never the
// push itself, which per spec carries no data) -> unsubscribe -> DELETE
// terminates the session -> a later GET 404s. Same verification bar as
// #4982's SSE/WS lifecycle and #4983's GraphQL subscriptions, per this
// issue's own "extend validate:mcp to cover the subscription lifecycle"
// deliverable.

const lifecycleInit = await mcp(
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { envOverride: lifecycleEnv },
);
const sessionId = lifecycleInit.headers.get("mcp-session-id");
assert.ok(
  sessionId,
  "a successful initialize must mint an Mcp-Session-Id response header",
);

const subscribeRes = await mcp(
  {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/subscribe",
    params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
  },
  { envOverride: lifecycleEnv, headers: { "mcp-session-id": sessionId } },
);
assert.deepEqual(
  subscribeRes.body.result,
  {},
  "resources/subscribe on the chain-stream resource must succeed",
);

const streamRes = await mcpRaw(null, {
  method: "GET",
  headers: { "mcp-session-id": sessionId },
  envOverride: lifecycleEnv,
});
assert.equal(
  streamRes.status,
  200,
  "GET /mcp must open the SSE stream for a subscribed session",
);
assert.equal(streamRes.headers.get("content-type"), "text/event-stream");
const reader = streamRes.body.getReader();

const firehoseStub = chainFirehoseHubNS.get(
  chainFirehoseHubNS.idFromName("global"),
);
const ingestRes = await firehoseStub.fetch(
  "https://chain-firehose-hub.internal/ingest",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ table: "blocks", block_number: 8_675_309 }),
  },
);
assert.equal(
  ingestRes.status,
  202,
  "ChainFirehoseHub ingest must accept a valid payload",
);

const { value: frameBytes } = await reader.read();
const frame = new TextDecoder().decode(frameBytes);
assert.match(
  frame,
  /^id: \d+\ndata: /,
  "the SSE stream must deliver an id:/data: framed notification",
);
const notification = JSON.parse(
  frame.slice(frame.indexOf("data: ") + 6).trim(),
);
assert.deepEqual(
  notification,
  {
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
  },
  "the push must be a pointer-only notifications/resources/updated (uri, never the payload itself)",
);
await reader.cancel();

const readRes = await mcp(
  {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
  },
  { envOverride: lifecycleEnv },
);
assert.deepEqual(
  JSON.parse(readRes.body.result.contents[0].text),
  { table: "blocks", block_number: 8_675_309 },
  "resources/read on the chain-stream resource must return the latest ingested payload",
);

const unsubscribeRes = await mcp(
  {
    jsonrpc: "2.0",
    id: 4,
    method: "resources/unsubscribe",
    params: { uri: MCP_CHAIN_STREAM_RESOURCE_URI },
  },
  { envOverride: lifecycleEnv, headers: { "mcp-session-id": sessionId } },
);
assert.deepEqual(unsubscribeRes.body.result, {});

const terminateRes = await mcpRaw(null, {
  method: "DELETE",
  headers: { "mcp-session-id": sessionId },
  envOverride: lifecycleEnv,
});
assert.equal(
  terminateRes.status,
  204,
  "DELETE /mcp must terminate the session",
);

const postTerminateStream = await mcpRaw(null, {
  method: "GET",
  headers: { "mcp-session-id": sessionId },
  envOverride: lifecycleEnv,
});
assert.equal(
  postTerminateStream.status,
  405,
  "GET /mcp after DELETE must report no stream on offer, the same 405 way an unregistered session does",
);

// --- MCP per-subnet status subscription lifecycle (#6034) ------------------
//
// Same session machinery as the chain-stream round trip above, but the
// change signal comes from SubnetStatusHub /notify-changed (the health
// prober's write path in production) rather than ChainFirehoseHub ingest.

const statusLifecycleInit = await mcp(
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { envOverride: lifecycleEnv },
);
const statusSessionId = statusLifecycleInit.headers.get("mcp-session-id");
assert.ok(
  statusSessionId,
  "status-lifecycle initialize must mint a session id",
);

const statusUri = buildSubnetStatusResourceUri(1);
const statusSubscribe = await mcp(
  {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/subscribe",
    params: { uri: statusUri },
  },
  {
    envOverride: lifecycleEnv,
    headers: { "mcp-session-id": statusSessionId },
  },
);
assert.deepEqual(
  statusSubscribe.body.result,
  {},
  "resources/subscribe on metagraph://subnet/{netuid}/status must succeed",
);

const statusStream = await mcpRaw(null, {
  method: "GET",
  headers: { "mcp-session-id": statusSessionId },
  envOverride: lifecycleEnv,
});
assert.equal(statusStream.status, 200, "status subscription must open SSE");
const statusReader = statusStream.body.getReader();

const statusHubStub = subnetStatusHubNS.get(
  subnetStatusHubNS.idFromName("global"),
);
const statusNotify = await statusHubStub.fetch(
  "https://subnet-status-hub.internal/notify-changed",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ netuids: [1] }),
  },
);
assert.equal(statusNotify.status, 200);
const statusNotifyBody = (await statusNotify.json()) as Row;
assert.equal(
  statusNotifyBody.delivered,
  1,
  "SubnetStatusHub must deliver to the subscribed session",
);

const { value: statusFrameBytes } = await statusReader.read();
const statusFrame = new TextDecoder().decode(statusFrameBytes);
const statusNotification = JSON.parse(
  statusFrame.slice(statusFrame.indexOf("data: ") + 6).trim(),
);
assert.deepEqual(statusNotification, {
  jsonrpc: "2.0",
  method: "notifications/resources/updated",
  params: { uri: statusUri },
});
await statusReader.cancel();

const statusUnsubscribe = await mcp(
  {
    jsonrpc: "2.0",
    id: 4,
    method: "resources/unsubscribe",
    params: { uri: statusUri },
  },
  {
    envOverride: lifecycleEnv,
    headers: { "mcp-session-id": statusSessionId },
  },
);
assert.deepEqual(statusUnsubscribe.body.result, {});

// --- Generic sweep: every tool the targeted assertions never call ----------
//
// The calls above are hand-written because their assertions check MEANING as
// well as shape -- that a sort actually sorted, that a filter actually
// filtered. They cover 95 of the registered tools. The rest were listed, their
// input schemas inspected, and never invoked, so their published outputSchema
// was never compared against a response at all. That is half of why #9794
// shipped through a green gate.
//
// This sweep closes it. Arguments are synthesized from each tool's own
// inputSchema rather than hand-written per tool, so a newly registered tool is
// swept the day it lands instead of the day someone remembers to add it. The
// sweep asserts only what can be asserted generically: a successful result,
// structuredContent present, and validation against the published schema.
// callOk does all three, and records the coverage the assertions below read.
// Error codes that mean the ARGUMENTS were refused rather than the data being
// unavailable. Deliberately narrow: everything else is treated as a real
// environment limit and lands on the allowlist, where a reviewer can see it.
const ARGUMENT_REJECTED = /^(invalid_params|invalid_graphql_query)\b/;

// Tools the hermetic harness cannot answer, and why. This is the one place a
// tool is allowed to go unchecked, and every entry is a standing admission that
// its published contract is not being compared against a real response -- so
// each carries a reason a reviewer can weigh, and the list is meant to shrink.
//
// A tool listed here is skipped by the sweep entirely. A tool NOT listed here
// that declines for an environment reason still runs the sweep's argument check
// above; it simply contributes no schema validation, which the assertions at
// the end then report.
const RESPONSE_UNVALIDATED_REASONS = new Map<string, string>([
  [
    "ask",
    "needs the AI layer, which is unbound in the hermetic harness (ai_unavailable)",
  ],
  [
    "semantic_search",
    "needs the AI layer, which is unbound in the hermetic harness (ai_unavailable)",
  ],
  [
    "call_rpc",
    "read-only RPC proxying is intentionally disabled until endpoint scoring and abuse controls land (rpc_proxy_disabled)",
  ],
  [
    "query_graphql",
    "executes against the live GraphQL schema, which the artifact harness does not serve",
  ],
  [
    "get_webhook_subscription",
    "the webhook subscription store is not configured on this deployment (webhooks_unavailable)",
  ],
  [
    "get_alert_trigger",
    "the alert-triggers tier is not bound to this deployment (alert_triggers_unavailable)",
  ],
  [
    "store_surface_credential",
    "the surface-credential store is authenticated-callers-only, and this gate holds no credential (auth_required)",
  ],
  [
    "list_surface_credentials",
    "the surface-credential store is authenticated-callers-only, and this gate holds no credential (auth_required)",
  ],
  [
    "delete_surface_credential",
    "the surface-credential store is authenticated-callers-only, and this gate holds no credential (auth_required)",
  ],
  [
    "verify_integration",
    "requires ONE OF surface_id/netuid, a cross-field constraint the published object schema cannot express -- MCP requires a top-level type:object, so zod cannot emit the anyOf that would say so, and the sweep has no required argument to synthesise from",
  ],
  [
    "get_chain_activity",
    "aggregates over the all-events tier, which the artifact harness does not stand up (tier_unavailable)",
  ],
  [
    "list_chain_events",
    "queries the all-events tier, which the artifact harness does not stand up (tier_unavailable)",
  ],
  [
    "get_block_chain_events",
    "the example block falls between the decoded lakehouse and the live follower; a fixed block number cannot stay inside a moving decoded window",
  ],
  [
    "get_extrinsic_chain_events",
    "same moving decoded window as its block-scoped sibling -- the example ref is well formed and production accepts it, but the harness holds no decoded events for that extrinsic",
  ],
  [
    "get_fixture",
    "resolves a recorded fixture by surface id, and the harness ships none for the example surface (not_found)",
  ],
  [
    "list_subnet_health",
    "no health snapshot exists for the example netuid in the harness (not_found)",
  ],
]);

// Arguments come from each parameter's OWN declared example, not from a table
// kept here. Every one of the published input parameters carries one, so there
// is nothing to hand-maintain and a newly registered tool is swept correctly the
// day it lands. It also means the examples are load-bearing rather than
// decorative: an example that is not a valid argument now fails this gate, which
// matters because an example is the first thing an agent copies.
function declaredExample(schema: Row | undefined): {
  found: boolean;
  value?: unknown;
} {
  if (!schema) return { found: false };
  const direct = schema.examples;
  if (Array.isArray(direct) && direct.length > 0) {
    return { found: true, value: direct[0] };
  }
  for (const key of ["anyOf", "oneOf"]) {
    const branch = schema[key];
    if (!Array.isArray(branch)) continue;
    for (const entry of branch) {
      const nested = declaredExample(entry as Row);
      if (nested.found) return nested;
    }
  }
  return { found: false };
}

for (const def of listToolDefinitions()) {
  if (RESPONSE_VALIDATED.has(def.name)) continue;
  if (RESPONSE_UNVALIDATED_REASONS.has(def.name)) continue;
  const inputSchema = def.inputSchema as Row | undefined;
  const properties = (inputSchema?.properties ?? {}) as Row;
  const required = (inputSchema?.required ?? []) as string[];
  const args: Row = {};
  const undocumented: string[] = [];
  for (const key of required) {
    const example = declaredExample(properties[key] as Row);
    if (!example.found) {
      undocumented.push(key);
      continue;
    }
    args[key] = example.value;
  }
  assert.deepEqual(
    undocumented,
    [],
    `${def.name}: required argument(s) ${undocumented.join(", ")} declare no example, so the ` +
      `sweep cannot call this tool and its response is never checked against its schema`,
  );
  // A tool that declines is not necessarily a failure here -- the hermetic
  // harness has no AI layer, no webhook store, no RPC proxy. But there is one
  // decline that always is: the server rejecting the ARGUMENTS. Those came
  // from the tool's own published examples, so a rejection means the contract
  // advertises something that does not work, and an example is the first thing
  // an agent copies. That is a defect whatever the environment, so it fails
  // here rather than being absorbed into the allowlist below.
  const probe = await call(def.name, args);
  if (probe.isError) {
    const text = String(probe.content?.[0]?.text ?? "");
    assert.ok(
      !ARGUMENT_REJECTED.test(text),
      `${def.name}: called with the arguments its own inputSchema advertises as examples ` +
        `(${JSON.stringify(args)}) and the server rejected them -- ${text}`,
    );
    continue;
  }
  await callOk(def.name, args);
}

// --- Response-shape coverage assertions (#9795) ----------------------------
//
// See the ledgers' definition above for why these exist. Both allowlists are
// deliberately noisy to add to: an entry is a standing admission that a tool's
// published contract is not being checked against a real response, so it has to
// carry a reason a reviewer can weigh.
// The one cause behind most of this list, stated once rather than reworded 74
// times. These are live and chain-backed tiers -- D1, the lakehouse, the
// chain-events store -- which the hermetic harness does not stand up, so each
// answers with a schema-stable zeroed payload. Item-shape conformance for them
// is real work that a hermetic harness structurally cannot do; #9801 covers it
// with a production sweep, which is what caught the #9794 drifts in the first
// place.
const HARNESS_SERVES_NO_ROWS =
  "live/chain-backed tier: the hermetic harness answers with a schema-stable " +
  "zeroed payload, so this collection carries no rows and the item shape inside " +
  "it is checked by the production sweep (#9801) rather than here";

// Tools whose response validated, but every declared collection came back
// empty -- so the ITEM shape inside them was never checked. This is the exact
// blindness that let #9794 ship: `get_economics_trends` declared
// `days[].total_stake_alpha` as a number while production served a precision
// string, and with `days: []` there was nothing for the assertion to reject.
//
// Every entry here is a live-tier surface the hermetic harness answers with a
// schema-stable zeroed payload. Each is a standing gap, not a resolved one:
// the list shrinks by giving the harness a row, and #9801 tracks doing that
// plus the production-side conformance sweep that covers what a hermetic
// harness structurally cannot.
const COLLECTIONS_UNEXERCISED_REASONS = new Map<string, string>([
  [
    "get_network_health",
    "the harness's health artifact carries no per-subnet rows",
  ],
  ["get_subnet_health", "the harness's health artifact carries no surfaces"],
  [
    "get_subnet_health_percentiles",
    "percentiles are computed over surfaces the harness's health artifact does not carry",
  ],
  [
    "get_subnet_health_incidents",
    "incidents are probe-derived and the harness runs no prober",
  ],
  [
    "get_subnet_validator_economics_history",
    "history points come from the validator-economics tier, unbound in the harness",
  ],
  [
    "list_validator_economics",
    "rows come from the validator-economics tier, unbound in the harness",
  ],
  [
    "get_subnet_trajectory",
    "trajectory points come from the daily rollup, which the harness does not stand up",
  ],
  [
    "get_economics_trends",
    "days come from the economics daily rollup, which the harness does not stand up -- the surface this gate was blind on",
  ],
  [
    "get_chain_concentration_subnets",
    "per-subnet concentration comes from the holders tier, unbound in the harness",
  ],
  [
    "get_chain_idle_stake",
    "per-subnet idle stake comes from the stake tier, unbound in the harness",
  ],
  [
    "get_chain_identity_history",
    "identity changes come from the chain-events tier, unbound in the harness",
  ],
  [
    "get_chain_turnover",
    "per-subnet turnover comes from the daily rollup, which the harness does not stand up",
  ],
  [
    "get_chain_stake_flow",
    "per-subnet stake flow comes from the chain-events tier, unbound in the harness",
  ],
  [
    "get_chain_alpha_volume",
    "per-subnet alpha volume comes from the daily rollup, which the harness does not stand up",
  ],
  ["get_account", HARNESS_SERVES_NO_ROWS],
  ["get_account_axon_removals", HARNESS_SERVES_NO_ROWS],
  ["get_account_deregistrations", HARNESS_SERVES_NO_ROWS],
  ["get_account_entities", HARNESS_SERVES_NO_ROWS],
  ["get_account_events", HARNESS_SERVES_NO_ROWS],
  ["get_account_extrinsics", HARNESS_SERVES_NO_ROWS],
  ["get_account_history", HARNESS_SERVES_NO_ROWS],
  ["get_account_identity_history", HARNESS_SERVES_NO_ROWS],
  ["get_account_portfolio", HARNESS_SERVES_NO_ROWS],
  ["get_account_position_history", HARNESS_SERVES_NO_ROWS],
  ["get_account_positions", HARNESS_SERVES_NO_ROWS],
  ["get_account_prometheus", HARNESS_SERVES_NO_ROWS],
  ["get_account_registrations", HARNESS_SERVES_NO_ROWS],
  ["get_account_serving", HARNESS_SERVES_NO_ROWS],
  ["get_account_stake_flow", HARNESS_SERVES_NO_ROWS],
  ["get_account_stake_moves", HARNESS_SERVES_NO_ROWS],
  ["get_account_subnets", HARNESS_SERVES_NO_ROWS],
  ["get_account_transfers", HARNESS_SERVES_NO_ROWS],
  ["get_account_weight_setters", HARNESS_SERVES_NO_ROWS],
  ["get_chain_axon_removals", HARNESS_SERVES_NO_ROWS],
  ["get_chain_burn", HARNESS_SERVES_NO_ROWS],
  ["get_chain_concentration_history", HARNESS_SERVES_NO_ROWS],
  ["get_chain_holders", HARNESS_SERVES_NO_ROWS],
  ["get_chain_prometheus", HARNESS_SERVES_NO_ROWS],
  ["get_chain_serving", HARNESS_SERVES_NO_ROWS],
  ["get_chain_stake_moves", HARNESS_SERVES_NO_ROWS],
  ["get_chain_stake_transfers", HARNESS_SERVES_NO_ROWS],
  ["get_chain_weight_setters", HARNESS_SERVES_NO_ROWS],
  ["get_chain_weights", HARNESS_SERVES_NO_ROWS],
  ["get_emission_changes", HARNESS_SERVES_NO_ROWS],
  ["get_emission_pipeline_history", HARNESS_SERVES_NO_ROWS],
  ["get_failure_reasons", HARNESS_SERVES_NO_ROWS],
  [
    "get_feed",
    "the harness's generated feed artifact carries no items; production serves 50 for kind=registry, so an entry appearing here is worth checking against the live feed before it is assumed to be the harness",
  ],
  ["get_global_incidents", HARNESS_SERVES_NO_ROWS],
  ["get_neuron_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_burn_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_concentration_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_conviction", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_event_summary", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_events", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_holders", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_hyperparams_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_identity_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_lease_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_metagraph", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_movers", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_ohlc", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_ownership_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_performance_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_surface_history", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_uptime", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_weight_setters", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_yield", HARNESS_SERVES_NO_ROWS],
  ["get_subnet_yield_history", HARNESS_SERVES_NO_ROWS],
  ["get_tao_usd", HARNESS_SERVES_NO_ROWS],
  ["get_validator_detail", HARNESS_SERVES_NO_ROWS],
  ["get_validator_history", HARNESS_SERVES_NO_ROWS],
  ["get_validator_nominators", HARNESS_SERVES_NO_ROWS],
  ["list_global_validators", HARNESS_SERVES_NO_ROWS],
  ["list_subnet_validators", HARNESS_SERVES_NO_ROWS],
  ["get_account_counterparties", HARNESS_SERVES_NO_ROWS],
  ["get_block_events", HARNESS_SERVES_NO_ROWS],
  ["get_chain_calls", HARNESS_SERVES_NO_ROWS],
  ["get_chain_deregistrations", HARNESS_SERVES_NO_ROWS],
  ["get_chain_fees", HARNESS_SERVES_NO_ROWS],
  ["get_chain_registrations", HARNESS_SERVES_NO_ROWS],
  ["get_chain_signers", HARNESS_SERVES_NO_ROWS],
  ["get_chain_transfer_pairs", HARNESS_SERVES_NO_ROWS],
  ["get_chain_transfers", HARNESS_SERVES_NO_ROWS],
  ["get_extrinsic", HARNESS_SERVES_NO_ROWS],
  ["get_governance_config_changes", HARNESS_SERVES_NO_ROWS],
  ["get_network_activity", HARNESS_SERVES_NO_ROWS],
  ["get_rpc_usage", HARNESS_SERVES_NO_ROWS],
  ["get_runtime", HARNESS_SERVES_NO_ROWS],
  ["get_sudo", HARNESS_SERVES_NO_ROWS],
  ["get_top_holders", HARNESS_SERVES_NO_ROWS],
  ["list_accounts", HARNESS_SERVES_NO_ROWS],
  ["list_block_extrinsics", HARNESS_SERVES_NO_ROWS],
  ["list_blocks", HARNESS_SERVES_NO_ROWS],
  ["list_endpoint_incidents", HARNESS_SERVES_NO_ROWS],
  ["list_extrinsics", HARNESS_SERVES_NO_ROWS],
  ["list_review_gaps", HARNESS_SERVES_NO_ROWS],
]);

{
  const unvalidated = listToolDefinitions()
    .filter((def) => def.outputSchema && !RESPONSE_VALIDATED.has(def.name))
    .map((def) => def.name)
    .sort();
  const undeclared = unvalidated.filter(
    (name) => !RESPONSE_UNVALIDATED_REASONS.has(name),
  );
  assert.deepEqual(
    undeclared,
    [],
    `these tools publish an outputSchema that no response was ever checked against -- ` +
      `call them here, or declare them in RESPONSE_UNVALIDATED_REASONS with a reason:\n  ` +
      undeclared.join("\n  "),
  );

  const hollow: string[] = [];
  for (const def of listToolDefinitions()) {
    if (!RESPONSE_VALIDATED.has(def.name)) continue;
    const declared = declaredObjectCollections(def.outputSchema as Row);
    if (declared.length === 0) continue;
    const exercised = COLLECTIONS_EXERCISED.get(def.name) ?? new Set<string>();
    if (declared.some((key) => exercised.has(key))) continue;
    hollow.push(`${def.name} (${declared.join(", ")})`);
  }
  const undeclaredHollow = hollow.filter(
    (entry) =>
      !COLLECTIONS_UNEXERCISED_REASONS.has(entry.slice(0, entry.indexOf(" ("))),
  );
  assert.deepEqual(
    undeclaredHollow,
    [],
    `these tools were validated against a response whose every declared collection was EMPTY, ` +
      `so the item shape inside them was never checked -- give the harness a row, or declare ` +
      `them in COLLECTIONS_UNEXERCISED_REASONS with a reason:\n  ` +
      undeclaredHollow.join("\n  "),
  );

  // A THIRD blindness, stated here because it is real and this gate does not
  // close it: a nullable field that the harness only ever answers with `null`
  // satisfies its schema whatever the declared non-null type is. `get_rpc_usage`
  // is the worked example -- reverting its `observed_at` to `string` still
  // passes this run, because the hermetic harness reaches the zeroed floor and
  // the floor has no stamp.
  //
  // Empty collections and null-only fields are the same shape of problem, and a
  // hermetic harness structurally cannot fix either: they need a response with
  // real data in it. That is the production conformance sweep in #9801 -- the
  // one that found all five drifts in #9794 by validating live responses. This
  // gate covers what it can cover cheaply and deterministically, and says
  // plainly what it cannot.
  console.log(
    `MCP response coverage: ${RESPONSE_VALIDATED.size}/${listToolDefinitions().length} tools ` +
      `validated against a real response (${RESPONSE_UNVALIDATED_REASONS.size} declared ` +
      `unanswerable by the hermetic harness); ${COLLECTIONS_UNEXERCISED_REASONS.size} validated ` +
      `over empty collections, so their item shapes rely on the production sweep.`,
  );
}

console.log(
  `MCP validation passed: ${MCP_TOOLS.length} tools, lifecycle + ${
    schemaService ? "all" : "all-but-schema"
  } tools/call + the resources/subscribe -> ingest -> notify round trip ` +
    `+ the subnet-status subscribe -> notify-changed -> notify round trip.`,
);
