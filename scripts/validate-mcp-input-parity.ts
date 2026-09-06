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
import { stripSentinelIntegerBounds } from "../src/mcp-input-schema.ts";

type Row = Record<string, unknown>;

/**
 * Arguments every tool may carry that no route publishes.
 *
 * These are transport-level, not data-level: `context` is agent-intent
 * telemetry (#9642) and `conversation_id` its conversation-stitching sibling
 * (both stripped before any handler runs), `cursor` is the MCP pagination
 * idiom where REST uses the same name but does not always publish it,
 * `network` is a path PREFIX on the REST side (`/api/v1/testnet/...`) rather
 * than a parameter, and `fields` is the projection contract (#9884).
 */
const MCP_TRANSPORT_ARGS = new Set([
  "context",
  "conversation_id",
  "cursor",
  "network",
  "fields",
]);

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

/**
 * The tool's output ORDER is its answer, so a caller-supplied sort would
 * overwrite the thing it came for.
 *
 * `find_subnet_for_task` ranks by how well each subnet matches the task
 * (`rankSubnetsForTask`, intent-ranked when the AI layer is up, keyword
 * otherwise) and `find_subnets_by_capability` ranks by callable-service count.
 * Both read the agent-catalog route, which publishes `sort`/`order` because it
 * serves an unranked index -- but passing them through here would let
 * `sort=netuid` silently replace the ranking with an arbitrary order while the
 * tool still describes itself as ranked.
 *
 * This is the per-tool judgement #9981 asked for, resolved the other way: the
 * capability is declined rather than deferred, so this entry is not debt and is
 * not expected to shrink.
 */
const RANKED_OUTPUT =
  "the tool's output order IS its answer (ranked by match/capability); a caller-supplied sort would overwrite the ranking it was called for (#10605)";

/**
 * The tool takes this VALUE already, under another argument.
 *
 * `get_extrinsic_chain_events` is pinned to one extrinsic by `ref`, a composite
 * `block_number-extrinsic_index` it parses and validates. Both halves reach the
 * feed loader from there, so accepting `block` and `extrinsic` separately would
 * give a caller a second way to say what they already said -- and therefore a
 * way to contradict it, which has no correct resolution.
 */
const RESOLVED_FROM_REF =
  "the tool already takes this inside `ref` (block_number-extrinsic_index) and passes it on; a second way to say it is a way to contradict it (#10793)";

/**
 * A range bound over a set that spans one point.
 *
 * `before` is a block-height ceiling (`safeBlockNumber`), and this tool reads
 * the events of a single extrinsic -- so every row shares one block_number and
 * the bound selects either all of them or none. Exposing it would publish a
 * filter whose only two outcomes are "no effect" and "empty".
 */
const SINGLE_BLOCK_SCOPE =
  "a block-height bound on a tool scoped to ONE block by `ref`; it can only select every event or none (#10793)";

/**
 * The route's filter, on the route's OWN tool.
 *
 * `list_review_gaps` is declared against `/api/v1/gaps` with `/api/v1/review/gaps`
 * as an additional route, but it reads /metagraph/review/gap-priorities.json
 * through the `review-gap-priorities` collection -- which has no
 * `coverage_level` column to filter on. `/api/v1/gaps` is `list_gaps`' route,
 * and `list_gaps` exposes `coverage_level` already.
 */
const SIBLINGS_ROUTE_FILTER =
  "this filter belongs to the sibling tool that actually mirrors the route (list_gaps); this tool reads the review feed, whose collection has no such column (#10793)";

/**
 * Standing debt: the route publishes it and the tool cannot pass it.
 *
 * EMPTY as of #10793, and kept anyway. The next route to publish a parameter
 * its tool cannot pass needs somewhere honest to land, and deleting the reason
 * would make "add it to DECLARED with a made-up category" the path of least
 * resistance. An entry here is an admission with a deadline, not a decision.
 */
const NOT_YET_EXPOSED =
  "NOT YET EXPOSED -- the route publishes this and the tool cannot pass it; delete this entry by adding it, not by keeping it";

for (const [key, reason] of Object.entries({
  // --- path parameters under a different name -----------------------------
  "get_neuron.hotkey": PATH_PARAMETER,
  "get_extrinsic.ref": PATH_PARAMETER,
  "get_extrinsic_chain_events.ref": PATH_PARAMETER,
  "get_block_chain_events.block_number": PATH_PARAMETER,
  "get_api_schema.surface_id": PATH_PARAMETER,
  "get_agent_catalog.netuid": PATH_PARAMETER,
  "verify_integration.netuid": PATH_PARAMETER,
  "get_domain_summary.domain": PATH_PARAMETER,
  "get_feed.kind": PATH_PARAMETER,
  "get_feed.netuid": PATH_PARAMETER,
  // --- POST bodies ---------------------------------------------------------
  "ask.question": REQUEST_BODY,
  "ask.type": REQUEST_BODY,
  // --- MCP-native ----------------------------------------------------------
  "find_subnet_for_task.task": MCP_NATIVE,
  "find_subnets_by_capability.capability": MCP_NATIVE,
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
  // --- output whose ORDER is the answer ------------------------------------
  "find_subnets_by_capability.sort": RANKED_OUTPUT,
  "find_subnets_by_capability.order": RANKED_OUTPUT,
  "find_subnet_for_task.sort": RANKED_OUTPUT,
  "find_subnet_for_task.order": RANKED_OUTPUT,
  // list_enrichment_targets returns the coverage-depth scorecard's ranked
  // QUEUE and carries `rank` on every row, so the same judgement applies: a
  // caller-supplied sort would replace the priority order this tool exists to
  // publish. `q` is exposed rather than declined because a filter narrows the
  // queue without reordering it -- rank survives a filter and does not survive
  // a re-sort (#10793).
  "list_enrichment_targets.sort": RANKED_OUTPUT,
  "list_enrichment_targets.order": RANKED_OUTPUT,
  // --- resolved from another argument the tool already takes ---------------
  "get_extrinsic_chain_events.block": RESOLVED_FROM_REF,
  "get_extrinsic_chain_events.extrinsic": RESOLVED_FROM_REF,
  "get_extrinsic_chain_events.before": SINGLE_BLOCK_SCOPE,
  // --- the sibling list tool carries them (#10793) -------------------------
  // Both mirror /api/v1/economics, and `get_economics` IS that route's list
  // view -- it already publishes q/sort/order/limit/cursor. Every OTHER list
  // parameter on these two tools was already declared CURATED_VIEW above; `q`
  // sat under NOT_YET_EXPOSED by oversight rather than by a second decision.
  "get_subnet_economics.q": CURATED_VIEW,
  "find_subnet_opportunities.q": CURATED_VIEW,
  "list_review_gaps.coverage_level": SIBLINGS_ROUTE_FILTER,
})) {
  DECLARED[key] = reason;
}

// ---- the comparison --------------------------------------------------------

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as Row;

/** route path -> the query and path parameter names it publishes. */
const published = new Map<
  string,
  { query: Set<string>; path: Set<string>; querySchemas: Map<string, Row> }
>();
for (const [route, operations] of Object.entries(
  (openapi.paths ?? {}) as Record<string, Row>,
)) {
  const query = new Set<string>();
  const path = new Set<string>();
  const querySchemas = new Map<string, Row>();
  for (const operation of Object.values(operations)) {
    for (const parameter of ((operation as Row)?.parameters ?? []) as Row[]) {
      (parameter.in === "query" ? query : path).add(String(parameter.name));
      if (parameter.in === "query")
        querySchemas.set(
          String(parameter.name),
          (parameter.schema ?? {}) as Row,
        );
    }
  }
  published.set(route, { query, path, querySchemas });
}

// ---- the CONSTRAINTS half (#10064) ----------------------------------------
//
// Everything above compares NAMES. That was the whole gate until now, and it
// leaves the more common failure untouched: a tool that takes the right
// argument and accepts the wrong values.
//
// Measured when this was written: of 654 shared argument pairs, 212 disagreed
// about what the value may BE. They are not one problem, so they are not one
// verdict.
//
//   LOOSER    the tool drops a constraint its route publishes -- an `enum` it
//             does not name, a `pattern` it does not apply, a `maxLength` it
//             does not cap. This is the defect. An agent cannot discover the
//             accepted values from the tool schema, and a wrong value is not
//             an error: it filters to nothing and reads as "no data". The
//             unbounded text ones cost real work too, since `searchRows` scans
//             per term per row (#5544).
//
//   NARROWED  the tool is STRICTER -- a lower `maximum`, a declared `default`,
//             an integer where the route says number. Correct and deliberate
//             (#9701: a browser can stream 9 MB, a context window cannot).
//             Allowed without a declaration, because a tool cannot become
//             wrong by accepting less than its route.
//
//   SHAPE     the same value in the form each surface speaks -- a boolean
//             instead of `"true"`, an array instead of a comma-separated
//             string. Legitimate, but DECLARED, because a wrong shape looks
//             exactly like a right one from here.
//
// 4/5 closes LOOSER by deriving the tool input from the route's Zod. Until
// then every one is listed, and the list can only shrink.

type Divergence = "LOOSER" | "NARROWED" | "SHAPE";

const CONSTRAINT_KEYWORDS = [
  "enum",
  "pattern",
  "maxLength",
  "minLength",
  "maximum",
  "minimum",
  "format",
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Row;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A schema as this gate compares it -- prose and examples are not contract. */
function constraintsOnly(schema: Row): string {
  const {
    description: _description,
    examples: _examples,
    ...rest
  } = stripSentinelIntegerBounds(schema);
  return canonical(rest);
}

/**
 * How a tool argument differs from the route parameter it mirrors, or null
 * when they agree.
 *
 * Computed rather than declared: which KIND of difference this is falls out of
 * the two schemas, and only the ones that need a human judgement get listed.
 */
function classify(toolSchema: Row, routeSchema: Row): Divergence | null {
  const tool = stripSentinelIntegerBounds(toolSchema);
  const route = stripSentinelIntegerBounds(routeSchema);
  const ignore = new Set(["description", "examples", "default", "$schema"]);
  const same = (key: string) => canonical(tool[key]) === canonical(route[key]);
  const differing = [
    ...new Set([...Object.keys(tool), ...Object.keys(route)]),
  ].filter((key) => !ignore.has(key) && !same(key));
  if (differing.length === 0) return null;

  // A different `type`, or one side using a composite, is the surface speaking
  // its own dialect -- JSON has booleans and arrays, a query string does not.
  if (
    tool.type !== route.type ||
    tool.anyOf !== undefined ||
    route.anyOf !== undefined
  ) {
    return "SHAPE";
  }
  // Dropping a constraint the route states is the defect, whatever else also
  // differs. Checked first so a tool that both loosens an enum and lowers a
  // maximum is reported as the loosening.
  for (const keyword of CONSTRAINT_KEYWORDS) {
    if (route[keyword] !== undefined && tool[keyword] === undefined)
      return "LOOSER";
    if (keyword === "maxLength" || keyword === "maximum") {
      if (
        typeof route[keyword] === "number" &&
        typeof tool[keyword] === "number" &&
        (tool[keyword] as number) > (route[keyword] as number)
      )
        return "LOOSER";
    }
    if (keyword === "enum" && route.enum && tool.enum) {
      const routeValues = new Set(route.enum as string[]);
      if ((tool.enum as string[]).some((value) => !routeValues.has(value)))
        return "LOOSER";
    }
    if (keyword === "pattern" && route.pattern && tool.pattern) {
      if (route.pattern !== tool.pattern) return "LOOSER";
    }
  }
  return "NARROWED";
}

/**
 * Constraint divergences that are NOT the tool simply being stricter.
 *
 * `LOOSER` entries are standing debt -- delete one by TIGHTENING the tool, not
 * by keeping it. `SHAPE` entries are the surface speaking JSON where the route
 * speaks a query string, and are permanent.
 *
 * A stale entry fails, so the list can only shrink.
 */
const CONSTRAINT_DIVERGENCES: Record<string, Divergence> = {
  // SHAPE -- the same value in the form each surface speaks. Permanent.
  // #10065 published `type` on /api/v1/search/semantic (the handler has always
  // scoped on it). A query string can carry one value per key -- a repeat is
  // ambiguous and is now a 400 -- while an MCP argument is JSON and can carry
  // the list outright, which parseSemanticTypes already accepts. The same
  // value in the form each surface speaks.
  "semantic_search.type": "SHAPE",
  "compare_subnets.dimensions": "SHAPE",
  "compare_subnets.netuids": "SHAPE",
  "compare_validators.hotkeys": "SHAPE",
  "get_governance_config_changes.success": "SHAPE",
  "get_neuron.fields": "SHAPE",
  // Endpoint flags use JSON Booleans in MCP and Boolean words in REST;
  // the list handlers explicitly forward both known_status values.
  "get_subnet_endpoints.pool_eligible": "SHAPE",
  "get_subnet_endpoints.known_status": "SHAPE",
  "get_subnet_metagraph.fields": "SHAPE",
  "get_subnet_metagraph.validator_permit": "SHAPE",
  "get_subnet_turnover.changes": "SHAPE",
  "get_sudo.success": "SHAPE",
  "list_endpoints.pool_eligible": "SHAPE",
  "list_endpoints.known_status": "SHAPE",
  "list_extrinsics.success": "SHAPE",
  "list_provider_endpoints.pool_eligible": "SHAPE",
  "list_provider_endpoints.known_status": "SHAPE",
  // The third of the three, declared when #10790 single-sourced the endpoint
  // filter block: its handler has decoded a real boolean through
  // `withBooleanWords` since #10772, and only its SCHEMA still spelled the
  // route's `"true"`/`"false"` words. GraphQL publishes `Boolean` here too.
  "list_subnet_endpoints.pool_eligible": "SHAPE",
  "list_subnet_endpoints.known_status": "SHAPE",
  "list_rpc_endpoints.cursor": "SHAPE",
  "list_rpc_endpoints.pool_eligible": "SHAPE",
  "list_rpc_endpoints.known_status": "SHAPE",
  "list_subnet_validators.fields": "SHAPE",

  // LOOSER -- standing debt. Delete an entry by TIGHTENING the tool
  // (4/5, #10064), never by keeping it.
  //
  // The one that is a DECISION rather than an oversight, and it is backwards.
  // /api/v1/chain-events clamps at 100 (workers/api.ts); the reader serving
  // MCP and GraphQL clamps at 200, with a stated rationale in
  // src/data-api-mcp.ts ("both are already public API"). #9701's premise is
  // the opposite -- a browser can stream 9 MB and a context window cannot --
  // so the MCP surface being the WIDER of the two is worth a deliberate
  // decision, not a silent flip by whoever noticed. Left as found (#10109),
  // and declared here so it is visible while that decision is made.
  //
  // BOTH tools that mirror this route, because there is no separate extrinsic
  // route -- get_extrinsic_chain_events is the same feed with two filters and
  // is declared against /api/v1/chain-events too. So an agent can page 200
  // events out of a route whose own contract caps at 100, by either door.
  "get_extrinsic_chain_events.limit": "LOOSER",
  "list_chain_events.limit": "LOOSER",
};

const errors: string[] = [];
const constraintErrors: string[] = [];
const used = new Set<string>();
const constraintUsed = new Set<string>();
let sharedPairs = 0;
let identicalPairs = 0;
let narrowedPairs = 0;
let compared = 0;
let aligned = 0;

for (const tool of listToolDefinitions()) {
  const declaration = MCP_TOOL_ROUTES[tool.name];
  const route = declaration?.route;
  const parameters = route ? published.get(route) : undefined;
  /**
   * The route schemas to compare a shared argument's CONSTRAINTS against.
   *
   * Two tools genuinely answer for more than one route (#9880's
   * `additionalRoutes`) -- `list_review_gaps` reads both gap feeds, and their
   * `sort` enums differ. Comparing only the primary reported the tool as
   * LOOSER for naming values its OTHER route accepts, which is the opposite of
   * a defect. A value any declared route takes is a value the tool may
   * advertise, so the comparison is against the union.
   */
  const constraintSources = [
    route,
    ...(declaration?.additionalRoutes ?? []),
  ].flatMap((path) => {
    const entry = path ? published.get(path) : undefined;
    return entry ? [entry.querySchemas] : [];
  });
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

  // The constraints half: for every argument the tool and route SHARE, do they
  // agree on what the value may be?
  const toolProperties = ((tool.inputSchema as Row)?.properties ??
    {}) as Record<string, Row>;
  for (const [argument, toolSchema] of Object.entries(toolProperties)) {
    const routeSchemas = constraintSources
      .map((source) => source.get(argument))
      .filter((entry): entry is Row => entry !== undefined);
    if (routeSchemas.length === 0) continue;
    sharedPairs += 1;
    // Agreeing with ANY route it answers for is agreement. Only a value no
    // declared route accepts is a divergence.
    const verdicts = routeSchemas.map((routeSchema) =>
      classify(toolSchema, routeSchema),
    );
    const divergence = verdicts.includes(null)
      ? null
      : verdicts.includes("NARROWED")
        ? "NARROWED"
        : (verdicts[0] as Divergence);
    const routeSchema = routeSchemas[0];
    if (divergence === null) {
      identicalPairs += 1;
      continue;
    }
    if (divergence === "NARROWED") {
      narrowedPairs += 1;
      continue;
    }
    const key = `${tool.name}.${argument}`;
    const declared = CONSTRAINT_DIVERGENCES[key];
    if (declared === divergence) {
      constraintUsed.add(key);
      continue;
    }
    constraintErrors.push(
      declared === undefined
        ? `${tool.name}.${argument} is ${divergence} than ${route} publishes\n` +
            `    route: ${constraintsOnly(routeSchema)}\n` +
            `    tool:  ${constraintsOnly(toolSchema)}`
        : `${tool.name}.${argument} is declared ${declared} but is now ${divergence}`,
    );
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

// A stale constraint declaration means the tool was tightened (or the route
// loosened) and nobody deleted the admission.
const staleConstraints = Object.keys(CONSTRAINT_DIVERGENCES)
  .filter((key) => !constraintUsed.has(key))
  .sort();
if (staleConstraints.length > 0) {
  constraintErrors.push(
    `${staleConstraints.length} CONSTRAINT_DIVERGENCES entr(y/ies) no longer diverge — delete them:\n` +
      staleConstraints.map((key) => `    ${key}`).join("\n"),
  );
}
errors.push(...constraintErrors);

if (errors.length > 0) {
  console.error(
    `MCP input-parity validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const looserCount = Object.values(CONSTRAINT_DIVERGENCES).filter(
  (kind) => kind === "LOOSER",
).length;
const shapeCount = Object.values(CONSTRAINT_DIVERGENCES).filter(
  (kind) => kind === "SHAPE",
).length;
const debt = Object.entries(DECLARED).filter(
  ([, reason]) => reason === NOT_YET_EXPOSED,
).length;
assert.ok(compared > 0, "no tool resolved to a published route");
console.log(
  `MCP input-parity validation passed: ${compared} tools compared against their route's ` +
    `published parameters, ${aligned} aligned exactly, ` +
    `${Object.keys(DECLARED).length} declared divergences (${debt} of them standing debt). ` +
    `${sharedPairs} shared argument pairs: ${identicalPairs} identical, ` +
    `${narrowedPairs} narrowed for the context window, ` +
    `${looserCount} looser than their route (standing debt), ` +
    `${shapeCount} a declared JSON-shape adaptation.`,
);
