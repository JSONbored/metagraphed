// A tool's ARGUMENTS agree with its route's published query parameters (#10016).
//
// #9880's route map proved every tool names a route and every route has a
// tool. It says nothing about whether the tool's arguments match what that
// route publishes -- outputs are gated by derivation, inputs by nothing. This
// is the missing half.
//
// It found a real one on its first run: /api/v1/subnets publishes
// `min_integration_readiness` while list_subnets took `min_readiness`. An agent
// reading our own OpenAPI and sending the published name was rejected for an
// unknown argument, with nothing anywhere reporting that the two surfaces
// disagreed.
//
// Compared against the EMITTED inputSchema, not the Zod source: that is what
// agents receive, and it is where a rename shows up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";

type Row = Record<string, unknown>;

/**
 * Arguments every tool may carry that no route publishes.
 *
 * These are transport-level, not data-level: `context` is agent-intent
 * telemetry (#9642), `cursor` is the MCP pagination idiom where REST uses the
 * same name but does not always publish it, `network` is a path PREFIX on the
 * REST side (`/api/v1/testnet/...`) rather than a parameter, and `fields` is
 * the projection contract (#9884).
 */
const MCP_TRANSPORT_ARGS = new Set(["context", "cursor", "network", "fields"]);

/** Query parameters a tool has no use for. `format` selects CSV; a tool
 * returns structuredContent. */
const NOT_FOR_TOOLS = new Set(["format"]);

/**
 * Declared divergences: `tool.argument` -> why.
 *
 * Same contract as validate-schema-opacity's allowlist. Every entry is a
 * statement someone made, not a gap nobody noticed, and a STALE entry fails --
 * so the list can only shrink or stay honest.
 */
const DECLARED: Record<string, string> = {};

// ---- categories, so each entry says which kind of divergence it is ---------

/** REST carries it in the PATH; MCP has only flat arguments. */
const PATH_PARAMETER =
  "the route carries this in its path; MCP has only flat arguments";
/** A POST body field, which openapi.json models as a requestBody. */
const REQUEST_BODY = "a POST body field on the route, not a query parameter";
/** No REST equivalent -- the tool computes or resolves something itself. */
const MCP_NATIVE =
  "an MCP-native argument with no REST equivalent; the tool resolves it itself";
/** The tool deliberately serves a narrowed view (#10008's classification). */
const CURATED_VIEW =
  "this tool is a curated view, not the route's list; the sibling list tool carries the route's filters";
/**
 * The SAME parameter under a different name on each side.
 *
 * The worst kind, because both surfaces work in isolation and only disagree at
 * the boundary: an agent that reads our published OpenAPI sends the route's
 * name and is rejected for an unknown argument. Tracked separately from
 * NOT_YET_EXPOSED because the fix is different -- accepting the route's name
 * too, rather than adding a capability.
 */
const RENAMED_ON_THE_MCP_SIDE =
  "a compatibility ALIAS the route does not publish; the tool also accepts the route's canonical name (#10018)";

/** A header on the route, an argument on the tool. */
const REQUEST_HEADER =
  "the route takes this as a header; a tool has no headers, only arguments";

/** Standing debt: the route publishes it and the tool cannot pass it. */
const NOT_YET_EXPOSED =
  "NOT YET EXPOSED -- the route publishes this and the tool cannot pass it; delete this entry by adding it, not by keeping it";

for (const [key, reason] of Object.entries({
  // --- path parameters under a different name -----------------------------
  "get_neuron.hotkey": PATH_PARAMETER,
  "get_extrinsic.ref": PATH_PARAMETER,
  "get_extrinsic_chain_events.ref": PATH_PARAMETER,
  "get_block_chain_events.block_number": PATH_PARAMETER,
  "get_api_schema.surface_id": PATH_PARAMETER,
  "get_validator_history.netuid": PATH_PARAMETER,
  "get_agent_catalog.netuid": PATH_PARAMETER,
  "verify_integration.netuid": PATH_PARAMETER,
  "get_domain_summary.domain": PATH_PARAMETER,
  "get_feed.kind": PATH_PARAMETER,
  "get_feed.netuid": PATH_PARAMETER,
  // --- POST bodies ---------------------------------------------------------
  "ask.question": REQUEST_BODY,
  "ask.type": REQUEST_BODY,
  "semantic_search.type": REQUEST_BODY,
  // --- MCP-native ----------------------------------------------------------
  "find_subnet_for_task.task": MCP_NATIVE,
  "find_subnet_for_task.limit": MCP_NATIVE,
  "find_subnets_by_capability.capability": MCP_NATIVE,
  "find_subnets_by_capability.limit": MCP_NATIVE,
  "how_do_i_call.subnet": MCP_NATIVE,
  "get_subnet_economics.include_summary": MCP_NATIVE,
  "get_provider_detail.include_endpoints": MCP_NATIVE,
  "get_subnet_metagraph.hotkeys": MCP_NATIVE,
  "get_subnet_metagraph.active": MCP_NATIVE,
  "get_subnet_metagraph.min_incentive": MCP_NATIVE,
  "get_subnet_metagraph.sort_by": MCP_NATIVE,
  "get_subnet_metagraph.order": MCP_NATIVE,
  "get_subnet_metagraph.limit": MCP_NATIVE,
  "list_subnet_validators.limit": MCP_NATIVE,
  "list_subnet_validators.min_stake_tao": MCP_NATIVE,
  "list_review_gaps.missing_kinds": MCP_NATIVE,
  "list_review_gaps.review_state": MCP_NATIVE,
  "list_enrichment_targets.severity": MCP_NATIVE,
  "list_enrichment_targets.gap_code": MCP_NATIVE,
  // --- curated views (#10008) ---------------------------------------------
  "find_subnet_opportunities.board": CURATED_VIEW,
  "search_subnets.type": CURATED_VIEW,
  "search_subnets.netuid": CURATED_VIEW,
  "search_subnets.sort": CURATED_VIEW,
  "search_subnets.order": CURATED_VIEW,
  "get_subnet_gaps.curation_level": CURATED_VIEW,
  "get_subnet_gaps.missing_kinds": CURATED_VIEW,
  "get_subnet_gaps.review_state": CURATED_VIEW,
  "get_subnet_gaps.limit": CURATED_VIEW,
  "get_subnet_gaps.sort": CURATED_VIEW,
  "get_subnet_gaps.order": CURATED_VIEW,
  "find_subnet_opportunities.netuid": CURATED_VIEW,
  "find_subnet_opportunities.registration_allowed": CURATED_VIEW,
  "find_subnet_opportunities.sort": CURATED_VIEW,
  "find_subnet_opportunities.order": CURATED_VIEW,
  "get_best_rpc_endpoint.id": CURATED_VIEW,
  "get_best_rpc_endpoint.kind": CURATED_VIEW,
  "get_best_rpc_endpoint.min_eligible_count": CURATED_VIEW,
  "get_best_rpc_endpoint.max_eligible_count": CURATED_VIEW,
  "get_best_rpc_endpoint.min_endpoint_count": CURATED_VIEW,
  "get_best_rpc_endpoint.max_endpoint_count": CURATED_VIEW,
  "get_best_rpc_endpoint.sort": CURATED_VIEW,
  "get_best_rpc_endpoint.order": CURATED_VIEW,
  "get_subnet_economics.registration_allowed": CURATED_VIEW,
  "get_subnet_economics.limit": CURATED_VIEW,
  "get_subnet_economics.sort": CURATED_VIEW,
  "get_subnet_economics.order": CURATED_VIEW,
  // --- exclusion filters MCP offers and the route does not publish ---------
  // list_subnets' `not_*` inversions and its own range bounds. The route's
  // engine accepts `not_` generically but openapi.json does not enumerate
  // them, so this is a ROUTE documentation gap surfaced from the MCP side.
  "list_subnets.not_status": MCP_NATIVE,
  "list_subnets.not_subnet_type": MCP_NATIVE,
  "list_subnets.not_domain": MCP_NATIVE,
  "list_subnets.not_coverage_level": MCP_NATIVE,
  "list_subnets.not_curation_level": MCP_NATIVE,
  "list_subnets.min_netuid": MCP_NATIVE,
  "list_subnets.max_netuid": MCP_NATIVE,
  // --- aliases kept for compatibility (#10018 fixed the renames) -----------
  // These three tools now accept the ROUTE's published name, so the
  // divergence is gone. What remains is the shorter name each shipped with,
  // kept so existing callers are unaffected -- an alias the route does not
  // publish, which is a different (and benign) thing from a rename.
  "search_subnets.query": RENAMED_ON_THE_MCP_SIDE,
  "semantic_search.query": RENAMED_ON_THE_MCP_SIDE,
  "list_subnets.min_readiness": RENAMED_ON_THE_MCP_SIDE,
  "list_subnets.max_readiness": RENAMED_ON_THE_MCP_SIDE,
  // --- headers -------------------------------------------------------------
  "get_alert_trigger.owner_token": REQUEST_HEADER,
  // --- standing debt -------------------------------------------------------
  // Free-text search over a list the tool otherwise mirrors. Each of these
  // routes publishes `q` and the tool cannot pass it.
  "list_subnets.q": NOT_YET_EXPOSED,
  "get_subnet_economics.q": NOT_YET_EXPOSED,
  "get_subnet_evidence.q": NOT_YET_EXPOSED,
  "get_coverage_depth.q": NOT_YET_EXPOSED,
  "list_enrichment_targets.q": NOT_YET_EXPOSED,
  "find_subnet_opportunities.q": NOT_YET_EXPOSED,
  "get_network_health.limit": NOT_YET_EXPOSED,
  "get_network_health.sort": NOT_YET_EXPOSED,
  "get_network_health.order": NOT_YET_EXPOSED,
  "get_subnet_evidence.limit": NOT_YET_EXPOSED,
  "get_subnet_evidence.sort": NOT_YET_EXPOSED,
  "get_subnet_evidence.order": NOT_YET_EXPOSED,
  "get_validator_nominators.basis": NOT_YET_EXPOSED,
  "get_extrinsic_chain_events.pallet": NOT_YET_EXPOSED,
  "get_extrinsic_chain_events.method": NOT_YET_EXPOSED,
  "get_extrinsic_chain_events.block": NOT_YET_EXPOSED,
  "get_extrinsic_chain_events.extrinsic": NOT_YET_EXPOSED,
  "get_extrinsic_chain_events.before": NOT_YET_EXPOSED,
  "list_review_gaps.coverage_level": NOT_YET_EXPOSED,
  "list_enrichment_targets.sort": NOT_YET_EXPOSED,
  "list_enrichment_targets.order": NOT_YET_EXPOSED,
})) {
  DECLARED[key] = reason;
}

// ---- the comparison --------------------------------------------------------

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as Row;

/** route path -> the query and path parameter names it publishes. */
const published = new Map<string, { query: Set<string>; path: Set<string> }>();
for (const [route, operations] of Object.entries(
  (openapi.paths ?? {}) as Record<string, Row>,
)) {
  const query = new Set<string>();
  const path = new Set<string>();
  for (const operation of Object.values(operations)) {
    for (const parameter of ((operation as Row)?.parameters ?? []) as Row[]) {
      (parameter.in === "query" ? query : path).add(String(parameter.name));
    }
  }
  published.set(route, { query, path });
}

const errors: string[] = [];
const used = new Set<string>();
let compared = 0;
let aligned = 0;

for (const tool of listToolDefinitions()) {
  const route = MCP_TOOL_ROUTES[tool.name]?.route;
  const parameters = route ? published.get(route) : undefined;
  // A route-less tool (declared with a reason in the map) has nothing to
  // compare against; the map already gates that decision.
  if (!parameters) continue;
  compared += 1;

  const args = Object.keys(
    ((tool.inputSchema as Row)?.properties ?? {}) as Row,
  );
  const undeclaredByRoute: string[] = [];
  for (const argument of args) {
    if (MCP_TRANSPORT_ARGS.has(argument)) continue;
    if (parameters.query.has(argument) || parameters.path.has(argument)) {
      continue;
    }
    const key = `${tool.name}.${argument}`;
    if (DECLARED[key]) {
      used.add(key);
      continue;
    }
    undeclaredByRoute.push(argument);
  }

  const unreachable: string[] = [];
  for (const parameter of parameters.query) {
    if (NOT_FOR_TOOLS.has(parameter)) continue;
    if (MCP_TRANSPORT_ARGS.has(parameter)) continue;
    if (args.includes(parameter)) continue;
    const key = `${tool.name}.${parameter}`;
    if (DECLARED[key]) {
      used.add(key);
      continue;
    }
    unreachable.push(parameter);
  }

  if (undeclaredByRoute.length === 0 && unreachable.length === 0) {
    aligned += 1;
    continue;
  }
  if (undeclaredByRoute.length > 0) {
    errors.push(
      `${tool.name} accepts argument(s) ${route} does not publish: ` +
        `${undeclaredByRoute.join(", ")}.\n` +
        `  Either the route should publish them, or add "${tool.name}.<arg>" ` +
        `to DECLARED with the reason it is MCP-only.`,
    );
  }
  if (unreachable.length > 0) {
    errors.push(
      `${route} publishes query parameter(s) ${tool.name} cannot pass: ` +
        `${unreachable.join(", ")}.\n` +
        `  An agent reading our own contract would send these and be rejected. ` +
        `Expose them, or declare why this tool is not the route's list view.`,
    );
  }
}

// A stale entry means the divergence resolved itself and nobody deleted the
// admission -- the list stops describing reality the moment it stops shrinking.
const stale = Object.keys(DECLARED)
  .filter((key) => !used.has(key))
  .sort();
if (stale.length > 0) {
  errors.push(
    `${stale.length} DECLARED entr(y/ies) no longer describe a divergence — delete them:\n` +
      stale.map((key) => `    ${key}`).join("\n"),
  );
}

if (errors.length > 0) {
  console.error(
    `MCP input-parity validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const debt = Object.entries(DECLARED).filter(
  ([, reason]) => reason === NOT_YET_EXPOSED,
).length;
assert.ok(compared > 0, "no tool resolved to a published route");
console.log(
  `MCP input-parity validation passed: ${compared} tools compared against their route's ` +
    `published parameters, ${aligned} aligned exactly, ` +
    `${Object.keys(DECLARED).length} declared divergences (${debt} of them standing debt).`,
);
