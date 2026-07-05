// Contract validator for the remote MCP server at POST /mcp.
//
// Exercises the JSON-RPC lifecycle (initialize + tools/list) and a tools/call
// for every registered tool against a cold local artifact env, asserting the
// MCP result envelope shape. Kept separate from validate-api.mjs because the
// MCP endpoint is not artifact-backed and must not enter the
// `checks.length === API_ROUTES.length` invariant.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
import {
  artifactFilePath,
  createLocalArtifactEnv,
  latestArtifactDate,
} from "./lib.mjs";

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
const searchIndexPage = await callOk("list_search_index", { limit: 3 });
assert.ok(
  Array.isArray(searchIndexPage.documents),
  "list_search_index must return documents[]",
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
