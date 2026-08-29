// The route<->tool map is complete, live, and accounts for every route (#9880).
//
// Four set comparisons against artifacts already in the repo. None of them
// needs a live request, which is the point: this is a CONTRACT question, and
// the contract is in the tree.
//
// 1. Every tool is classified. A tool absent from the map fails -- `null` with
//    a reason is a classification, absence is an oversight.
// 2. No stale entry. A map entry naming a tool that no longer exists fails, so
//    the map cannot rot the way a hand-kept list does.
// 3. Every declared route exists in openapi.json. Catches a tool pointing at a
//    route that was renamed or removed.
// 4. Every route is mirrored or declared agent-unreachable. This is the one
//    that turns "267 routes, 225 tools, nobody can characterise the delta"
//    into a reviewed list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";

const NETWORK_PREFIX = "/api/v1/{network}/";

/**
 * Routes with no MCP tool, and why.
 *
 * A route here is a DECISION that agents reach it another way (or should not
 * reach it at all), not a gap nobody noticed. Entries may only be removed --
 * adding a tool for one is what removes it.
 */
const AGENT_UNREACHABLE: Record<string, string> = {
  "/api/v1":
    "The API index. An agent discovers tools through tools/list, not through this.",
  "/api/v1/openapi.json":
    "The contract document itself. get_api_schema serves a SUBNET's captured schema; this one is ours, and get_contracts describes it.",
  "/api/v1/search/resolve":
    "Identifier resolution (#9672). search_subnets and semantic_search are the agent-facing discovery paths; resolve is a UI affordance.",
  "/api/v1/validators/operators":
    "A compact HTTP/SSR projection for the website directory. Agents already receive the richer validator records through list_global_validators; mirroring this reduced payload would expose a second, less capable answer to the same question.",
  "/api/v1/accounts/directory":
    "A compact HTTP/SSR projection for the website directory. Agents already receive independently sortable account rows through list_accounts; mirroring this bounded payload would expose a second, less capable answer to the same question.",
  "/api/v1/export/chain-events":
    "The paid export tier (#11600). Deliberately HTTP-only: the x402 gate " +
    "prices a request by its RESOLVED pathname, and every MCP call arrives on " +
    "/mcp, which is the `edge` family at weight 1. A tool mirroring this route " +
    "would therefore serve a 25,000-row export for free through the very " +
    "surface the payment exists to bound -- a paywall with a documented way " +
    "around it. The free, paginated twin (list_chain_events) is what agents " +
    "get, and it is unchanged.",
  "/api/v1/chain/stream":
    "The realtime firehose (#11045). A request/response tool cannot hold an " +
    "event stream open; MCP sessions subscribe through the hub's own " +
    "/mcp-subscribe channel (mcpSubscribedSessions), and the polled twin is " +
    "list_chain_events.",
};

/** `.atom`/`.rss`/`.json` feed variants: get_feed serves the JSON one. */
const isFeedVariant = (route: string) =>
  /^\/api\/v1\/feeds\//.test(route) && /\.(atom|rss|json)$/.test(route);
/** A bare feed path whose JSON sibling get_feed already mirrors. */
const isFeedBase = (route: string) =>
  /^\/api\/v1\/feeds\//.test(route) && !/\.(atom|rss|json)$/.test(route);

const doc = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as { paths: Record<string, unknown> };
const publishedRoutes = new Set(Object.keys(doc.paths));
const liveTools = new Set(
  (listToolDefinitions() as Array<{ name: string }>).map((t) => t.name),
);

const errors: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) errors.push(message);
};

// --- 1 + 2: the map and the tool registry agree exactly ---------------------
for (const name of liveTools) {
  check(
    Object.hasOwn(MCP_TOOL_ROUTES, name),
    `${name} is a registered tool with no entry in MCP_TOOL_ROUTES -- declare its route, or null with a reason`,
  );
}
for (const name of Object.keys(MCP_TOOL_ROUTES)) {
  check(
    liveTools.has(name),
    `MCP_TOOL_ROUTES names ${name}, which is not a registered tool -- delete the entry`,
  );
}

// --- 3: a declared route must exist, and a null must carry a reason ---------
for (const [name, entry] of Object.entries(MCP_TOOL_ROUTES)) {
  if (entry.route === null) {
    check(
      Boolean(entry.reason && entry.reason.length > 20),
      `${name} declares route: null with no real reason -- "why not" is the whole value of a null here`,
    );
    continue;
  }
  for (const extra of entry.additionalRoutes ?? []) {
    check(
      publishedRoutes.has(extra),
      `${name} declares additional route ${extra}, which openapi.json does not publish`,
    );
  }
  check(
    !entry.route.startsWith(NETWORK_PREFIX),
    `${name} declares the network-addressed form ${entry.route} -- name the plain twin; the gate derives the prefix`,
  );
  check(
    publishedRoutes.has(entry.route),
    `${name} declares ${entry.route}, which openapi.json does not publish -- the route was renamed, removed, or never documented`,
  );
}

// --- 4: every published route is mirrored or declared unreachable -----------
const mirrored = new Set<string>();
for (const entry of Object.values(MCP_TOOL_ROUTES)) {
  if (!entry.route) continue;
  for (const route of [entry.route, ...(entry.additionalRoutes ?? [])]) {
    mirrored.add(route);
    // The network-addressed twin is the same handler behind a prefix.
    mirrored.add(NETWORK_PREFIX + route.slice("/api/v1/".length));
  }
}
const unaccounted = [...publishedRoutes]
  .filter(
    (route) =>
      !mirrored.has(route) &&
      !Object.hasOwn(AGENT_UNREACHABLE, route) &&
      !isFeedVariant(route) &&
      !isFeedBase(route) &&
      !(
        route.startsWith(NETWORK_PREFIX) &&
        Object.hasOwn(
          AGENT_UNREACHABLE,
          "/api/v1/" + route.slice(NETWORK_PREFIX.length),
        )
      ),
  )
  .sort();
check(
  unaccounted.length === 0,
  `${unaccounted.length} published route(s) are neither mirrored by a tool nor declared agent-unreachable:\n` +
    unaccounted.map((r) => `    ${r}`).join("\n") +
    `\n  Add a tool, or add the route to AGENT_UNREACHABLE with the reason it is not one.`,
);

// A stale unreachable entry is the same rot as a stale allowlist anywhere else.
for (const route of Object.keys(AGENT_UNREACHABLE)) {
  check(
    publishedRoutes.has(route),
    `AGENT_UNREACHABLE names ${route}, which openapi.json no longer publishes -- delete the entry`,
  );
  check(
    !mirrored.has(route),
    `AGENT_UNREACHABLE names ${route}, but a tool now mirrors it -- delete the entry`,
  );
}

if (errors.length > 0) {
  console.error(
    `MCP route-map validation failed with ${errors.length} issue(s):\n` +
      errors.map((e) => `- ${e}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  const mirrors = Object.values(MCP_TOOL_ROUTES).filter((e) => e.route).length;
  const feeds = [...publishedRoutes].filter(
    (r) => isFeedVariant(r) || isFeedBase(r),
  ).length;
  console.log(
    `MCP route-map validation passed: ${liveTools.size} tools all classified ` +
      `(${mirrors} mirror a route, ${liveTools.size - mirrors} declared route-less with a reason); ` +
      `${publishedRoutes.size} published routes all accounted for ` +
      `(${Object.keys(AGENT_UNREACHABLE).length} declared agent-unreachable, ${feeds} feed paths served by get_feed).`,
  );
}

assert.ok(true);
