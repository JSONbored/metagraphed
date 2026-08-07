// Opening an object in a published schema must be a REVIEWED choice (#9797).
//
// Epic #9793 sets one rule for both published contracts: every object site is
// either (1) fully typed properties, (2) a typed record -- dynamic keys with a
// declared VALUE schema -- or (3) explicitly open, carrying a written reason
// and listed here. Anything else is accidental opacity, and accidental opacity
// is how `get_account_positions` came to publish `positions` as an untyped
// array while the route it mirrors typed all 13 fields per position.
//
// This gate walks both contracts, classifies every object site, and fails when
// an untyped one is not on the allowlist below. It also fails when an
// allowlist entry no longer matches anything, so the list cannot rot into a
// blanket exemption after the site it named was typed.
//
// The reason strings are not decoration. `NOT_YET_TYPED` is a standing
// admission of debt against #9797 and its entries are meant to disappear; every
// other entry is a decision, and a reviewer should be able to disagree with it.
// Same idea as scripts/validate-mcp.ts's RESPONSE_UNVALIDATED_REASONS.
import path from "node:path";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { readJson, repoRoot } from "./lib.ts";

type Row = Record<string, unknown>;

// ---- reasons ---------------------------------------------------------------

/** A third-party document embedded verbatim. We do not own its shape and must
 * not constrain it -- a subnet's OpenAPI is whatever that subnet publishes. */
const EMBEDDED_THIRD_PARTY_DOCUMENT =
  "an embedded third-party document, served verbatim; its shape is not ours to declare";

/** Substrate call arguments and event fields. The shape is per-pallet and
 * per-call, decoded from chain metadata that changes at every runtime upgrade
 * -- there is no fixed shape to declare, and inventing one would reject valid
 * chain data after the next upgrade. */
const DECODED_CHAIN_PAYLOAD =
  "decoded chain data, shaped per pallet+call and re-shaped by every runtime upgrade";

/** A schema-shaped value: JSON Schema describing something else. Typing it
 * would mean embedding a meta-schema, which is what `$schema` already says. */
const EMBEDDED_JSON_SCHEMA =
  "an embedded JSON Schema document, described by its own $schema rather than by ours";

/** Deliberately unconstrained, and the gates enforce that no ROUTE serves it:
 * validate-openapi.ts and validate-contract-drift.ts both reject a route whose
 * data schema is one of these. */
const DELIBERATELY_GENERIC =
  "the deliberately generic shape; validate-openapi + validate-contract-drift reject any route that serves it";

/** Whatever the third party chose to publish about itself, keyed by who it is. */
const CALLER_DEFINED_EXTENSION =
  "an extension block whose content each adapter defines for itself";

/** Caller-supplied, echoed back. The server does not define the shape because
 * the caller does. */
const CALLER_SUPPLIED =
  "supplied by the caller and echoed back; the server does not define its shape";

/** Whatever the node or the query returned. A GraphQL result is shaped by the
 * query the caller wrote; an RPC error body is shaped by the node. */
const CALLER_SHAPED_RESULT =
  "shaped by the caller's own query or by the upstream node, not by us";

/** Standing debt, not a decision. Every one of these is an MCP tool schema
 * that has not been derived from its route yet (#9796/#9797). They are listed
 * so a NEW opaque site still fails this gate -- the list may only shrink. */
const NOT_YET_TYPED =
  "NOT YET TYPED -- #9797, this entry must be deleted, not kept";

// ---- allowlists ------------------------------------------------------------

/** Paths use `.prop` for a property, `[]` for array items and `{}` for a
 * record value, so an entry survives an `anyOf` branch being reordered. */
const ROUTE_OPEN_SITES: Record<string, string> = {
  "AdapterArtifact.extensions{}": CALLER_DEFINED_EXTENSION,
  "ApiIndexArtifact.routes[].query_parameters[].schema": EMBEDDED_JSON_SCHEMA,
  "BlockChainEventsArtifact.events[].args": DECODED_CHAIN_PAYLOAD,
  "BlockExtrinsicsArtifact.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  "ChainEventsFeedArtifact.events[].args": DECODED_CHAIN_PAYLOAD,
  "ExtrinsicDetailArtifact.extrinsic.call_args": DECODED_CHAIN_PAYLOAD,
  "ExtrinsicsFeedArtifact.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  JsonObject: DELIBERATELY_GENERIC,
  "OpenApiArtifact.components": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "OpenApiArtifact.info": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "OpenApiArtifact.paths": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "OpenApiArtifact.servers[]": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "OpenApiArtifact.x-metagraphed": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "SuccessEnvelope.data": DELIBERATELY_GENERIC,
};

/** Every MCP tool schema site still open because the tool has not been derived
 * from its route yet. One entry per site, so a NEW opaque site still fails
 * this gate -- the list may only shrink, and it is the honest count of what
 * #9797 has left to do. */
const MCP_NOT_YET_TYPED: string[] = [
  "compare_validators.validators[]",
  "find_subnet_for_task.results[]",
  "get_account.activity",
  "get_account_counterparties.relationship",
  "get_adapter.snapshot",
  "get_agent_catalog.subnets[]",
  "get_block.block",
  "get_domain_summary.domains[]",
  "get_domain_summary.emission_concentration",
  "get_economics.subnets[]",
  "get_economics.summary",
  "get_extrinsic.extrinsic",
  "get_health_history.summary",
  "get_health_history.surfaces[]",
  "get_neuron.neuron",
  "get_subnet_economics.economics",
  "get_subnet_economics.summary",
  "get_subnet_gaps.enrichment_queue[]",
  "get_subnet_gaps.priorities[]",
  "get_subnet_health.summary",
  "get_subnet_metagraph.neurons[]",
  "get_subnet_trajectory.deltas",
  "get_subnet_trajectory.points[]",
  "how_do_i_call.services[]",
  "list_enrichment_targets.filters",
  "list_enrichment_targets.targets[].dimensions",
  "list_enrichment_targets.targets[].top_gaps[]",
  "list_profiles.profiles[]",
  "list_search.documents[]",
  "list_subnet_apis.services[]",
  "list_subnet_health.surfaces[]",
  "list_subnet_validators.validators[]",
  "list_surface_credentials.credentials[]",
];

/** MCP sites that are open on purpose, same three categories as the REST list
 * above. Kept separate from the debt below so the two never blur. */
const MCP_REASONED_OPEN_SITES: Record<string, string> = {
  "call_rpc.error": CALLER_SHAPED_RESULT,
  "decode_evm_call.args": DECODED_CHAIN_PAYLOAD,
  "get_adapter.extensions": CALLER_DEFINED_EXTENSION,
  "get_api_schema.document": EMBEDDED_THIRD_PARTY_DOCUMENT,
  "get_governance_config_changes.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  "get_sudo.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  "get_webhook_subscription.filters": CALLER_SUPPLIED,
  "list_block_extrinsics.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  "list_chain_events.events[].args": DECODED_CHAIN_PAYLOAD,
  "list_extrinsics.extrinsics[].call_args": DECODED_CHAIN_PAYLOAD,
  "query_graphql.data": CALLER_SHAPED_RESULT,
  "query_graphql.errors[]": CALLER_SHAPED_RESULT,
  "run_saved_query.params": CALLER_SUPPLIED,
};

const MCP_OPEN_SITES: Record<string, string> = {
  ...Object.fromEntries(MCP_NOT_YET_TYPED.map((site) => [site, NOT_YET_TYPED])),
  ...MCP_REASONED_OPEN_SITES,
};

// ---- the walk --------------------------------------------------------------

function openSites(root: unknown, name: string): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, at);
      return;
    }
    if (!node || typeof node !== "object") return;
    const row = node as Row;
    if (row.type === "object" || row.properties !== undefined) {
      const properties = row.properties as Row | undefined;
      const hasProperties = properties && Object.keys(properties).length > 0;
      const additional = row.additionalProperties;
      const typedRecord =
        additional &&
        typeof additional === "object" &&
        Object.keys(additional as Row).length > 0;
      if (!hasProperties && !typedRecord) found.push(at);
    }
    for (const [key, value] of Object.entries(row)) {
      // Annotations, not shape.
      if (["examples", "enum", "description", "default", "title"].includes(key))
        continue;
      if (key === "properties") {
        for (const [name, child] of Object.entries(value as Row))
          walk(child, `${at}.${name}`);
        continue;
      }
      if (key === "items") {
        walk(value, `${at}[]`);
        continue;
      }
      if (key === "additionalProperties") {
        walk(value, `${at}{}`);
        continue;
      }
      // A union branch is the SAME site: which branch an open object landed in
      // is an implementation detail of how the schema was written.
      if (["anyOf", "oneOf", "allOf"].includes(key)) {
        for (const branch of value as unknown[]) walk(branch, at);
        continue;
      }
      if (value && typeof value === "object") walk(value, at);
    }
  };
  walk(root, name);
  return [...new Set(found)];
}

// ---- the check -------------------------------------------------------------

const errors: string[] = [];

function audit(
  label: string,
  sites: string[],
  allowlist: Record<string, string>,
) {
  const present = new Set(sites);
  const unlisted = sites.filter((site) => !(site in allowlist)).sort();
  if (unlisted.length > 0) {
    errors.push(
      `${label}: ${unlisted.length} object site(s) are open with no declared reason:\n` +
        unlisted.map((site) => `    ${site}`).join("\n") +
        `\n  Type the site, make it a typed record (declare the VALUE schema), or add it to ` +
        `scripts/validate-schema-opacity.ts with a written reason.`,
    );
  }
  const stale = Object.keys(allowlist)
    .filter((site) => !present.has(site))
    .sort();
  if (stale.length > 0) {
    errors.push(
      `${label}: ${stale.length} allowlist entr(y/ies) no longer match an open site — delete them:\n` +
        stale.map((site) => `    ${site}`).join("\n"),
    );
  }
}

const openapi = (await readJson(
  path.join(repoRoot, "public/metagraph/openapi.json"),
)) as Row;
const routeSites: string[] = [];
for (const [name, schema] of Object.entries(
  ((openapi.components as Row)?.schemas as Row) ?? {},
)) {
  if (name === "GeneratedOpenApiMarker") continue;
  routeSites.push(...openSites(schema, name));
}
audit("REST contract", [...new Set(routeSites)], ROUTE_OPEN_SITES);

const mcpSites: string[] = [];
for (const tool of listToolDefinitions() as Row[]) {
  if (!tool.outputSchema) continue;
  mcpSites.push(...openSites(tool.outputSchema, tool.name as string));
}
audit("MCP contract", [...new Set(mcpSites)], MCP_OPEN_SITES);

if (errors.length > 0) {
  console.error(
    `Schema-opacity validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const debt = Object.values(MCP_OPEN_SITES).filter(
  (reason) => reason === NOT_YET_TYPED,
).length;
console.log(
  `Schema-opacity validation passed: ${new Set(routeSites).size} open REST site(s), all reasoned; ` +
    `${new Set(mcpSites).size} open MCP site(s), ${debt} of them standing debt against #9797.`,
);
