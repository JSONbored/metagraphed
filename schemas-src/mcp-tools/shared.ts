// Shared building blocks for schemas-src/mcp-tools/*.ts (types-epic E,
// #7863). Every hand-written MCP output schema this epic has converted so
// far leaves nested objects/arrays shallow (bare `{type:"object"}` /
// `{type:"array", items:{type:"object"}}`, no per-field constraints) even on
// tools whose description says they "mirror" a REST route -- reusing a
// deeper schemas-src/routes/ schema for those fields would silently accept
// LESS than the original wire contract did, a regression per #7863's "hard
// wire-compatibility constraint" (see e.g. get-network-health.ts's header
// for the fuller rationale, first established in the pilot batch). These
// two helpers are the Zod equivalent of that same shallow-on-purpose shape.
import { z } from "zod";
import { distributionStatsSchema } from "../shared.ts";
import { QUERY_ENUMS } from "../query-enums.ts";
import { NeuronSchema } from "../routes/subnet-metagraph.ts";
import {
  fieldsSchema,
  limitSchema,
  numericCursorSchema,
  offsetSchema,
  orderSchema,
} from "../query-params.ts";
import { MAX_LIMIT } from "../../workers/request-params.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../../src/route-limits.ts";

// The query-parameter vocabulary now lives in schemas-src/query-params.ts so the
// REST route schemas can use it too (#9986). Re-exported here because ~100 MCP
// tool modules already import these names from this file.
export * from "../query-params.ts";

/** Shared across MCP tools that have no single route owner (#9799). */
export const EVIDENCE_ENTRY_SORT_VALUES = [
  "claim",
  "source_url",
  "subject",
  "verified_at",
] as const;

/** Shared across MCP tools that have no single route owner (#9799). */
export const CANDIDATE_SORT_VALUES = [
  "confidence",
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
  "state",
] as const;

/** Shared across MCP tools that have no single route owner (#9799). */
export const SURFACE_SORT_VALUES = [
  "id",
  "kind",
  "name",
  "netuid",
  "provider",
] as const;

/** Shared across MCP tools that have no single route owner (#9799). */
export const HEALTH_SURFACE_SORT_VALUES = [
  "classification",
  "kind",
  "last_checked",
  "last_ok",
  "latency_ms",
  "netuid",
  "provider",
  "status",
  "status_code",
  "surface_id",
  "verified_at",
] as const;

/** Shared across MCP tools that have no single route owner (#9799). */
export const HEALTH_CLASSIFICATION_VALUES = QUERY_ENUMS.healthClassification;

/** Shared across MCP tools that have no single route owner (#9799). */
/**
 * Mirrors API_QUERY_COLLECTIONS["coverage-depth"].sort_fields (#10011).
 *
 * A copy because schemas-src imports from neither src/ nor workers/;
 * validate:schema-vocabularies asserts it still matches (#10005).
 */
export const COVERAGE_DEPTH_SORT_VALUES = [
  "agent_status",
  "blocker_level",
  "name",
  "netuid",
  "priority_score",
  "score",
  "tier",
] as const;

export const ENDPOINT_SORT_VALUES = [
  "kind",
  "last_checked",
  "latency_ms",
  "layer",
  "netuid",
  "pool_eligible",
  "provider",
  "publication_state",
  "score",
  "status",
] as const;

/** Shared across MCP tools that have no single route owner (#9799). */
export const ENDPOINT_POOL_SORT_VALUES = [
  "eligible_count",
  "endpoint_count",
  "id",
  "kind",
] as const;

// --- Bounded input primitives --------------------------------------
//
// Every tool author wrote `z.int().min(0)` inline, so no parameter declared a real
// upper bound and all of them inherited `z.int()`'s safe-integer sentinel — see
// src/mcp-input-schema.ts for why that made the published schema unreadable. These
// helpers put the bound where the fact lives: `limitSchema` takes the same constant
// from `src/route-limits.ts` that the handler enforces and the OpenAPI `maximum`
// publishes, so an MCP tool can no longer advertise a ceiling its own route rejects.
// `scripts/validate-mcp.ts` asserts the two agree.

// DESCRIPTIONS BELONG ON THE PRIMITIVE, NOT IN THE TOOL PARAGRAPH (#9645).
// Measured before writing these: of 773 published tool parameters, exactly ONE
// carried a `description` — `fields`, below, the only one of these primitives
// that had one. The guidance was not missing, it was in prose inside each
// tool's own description, where a client cannot render it per field, a model
// filling one argument does not attend to it, and nothing checks it against
// the schema. Put on the shared primitive rather than at ~260 call sites, so
// one sentence covers every tool and the wording cannot drift between them.

// `FIELDS_PATTERN` / `fieldsSchema()` moved to ../query-params.ts with the rest
// of the vocabulary (#10073): REST publishes them too now, and importing them
// out of an mcp-tools/ module from src/contracts.ts is the exact layering
// mistake #10061 fixed. Still reachable from here via the `export *` above.

// Bare `{type:"object"}` (hand-written, no `properties`/`additionalProperties`
// declared -- JSON Schema's own default for an omitted additionalProperties
// is `true`, i.e. "any object, any keys").
//
// GENUINELY OPEN, and the one place in this migration where that is the answer
// rather than the excuse (#10790). Every other `.passthrough()` in the tree
// named a shape somebody had simply not written down; this one names the
// absence of a shape on purpose -- `get_adapter.extensions` is whatever that
// adapter tracks, `get_fixture`'s payload is whatever the surface returned. It
// says so with `.catchall`, which reads as a decision and carries an entry in
// `scripts/validate-schema-opacity.ts`.
export const OpenObjectSchema = z.object({}).catchall(z.unknown());

// Bare `{type:"array"}` or `{type:"array", items:{type:"object"}}` (no
// items-shape constraint beyond "each item is some object", or none at all).
export const OpenArraySchema = z.array(z.unknown());
export const OpenObjectArraySchema = z.array(OpenObjectSchema);

export const AccountEventItemSchema = z
  .object({
    block_number: z.int().nullable().optional(),
    event_index: z.int().nullable().optional(),
    event_kind: z.string().nullable().optional(),
    hotkey: z.string().nullable().optional(),
    coldkey: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    uid: z.int().nullable().optional(),
    amount_tao: z.unknown().optional(),
    alpha_amount: z.unknown().optional(),
    observed_at: z.string().nullable().optional(),
    extrinsic_index: z.int().nullable().optional(),
  })
  .strict();

// The 8-field distribution-stats shape (count/mean/min/p25/median/p75/p90/
// max) 10 of types-epic E batch 9's (#8072) "chain leaderboard" tools use
// identically for their `*_distribution` field (get_chain_turnover's
// stability_distribution, get_chain_stake_flow's net_flow_distribution,
// get_chain_alpha_volume's volume_distribution, and the intensity_distribution
// on get_chain_weights/stake_moves/stake_transfers/axon_removals/serving/
// prometheus/deregistrations) -- hoisted here rather than defined 10 times,
// unlike every other nested shape in this epic which stayed tool-local
// (those never repeated verbatim across more than 2 tools).
export const DistributionStatsSchema = distributionStatsSchema(z.number());

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- 10 of
// types-epic E batch 10's (#8074) list_* tools declare this exact shape for
// their output `notes` field (list_search_index, list_search,
// list_enrichment_queue, list_adapter_candidates, list_enrichment_evidence,
// list_review_gaps, list_review_enrichment_targets, list_endpoint_pools,
// list_endpoint_incidents, list_provider_endpoints), well past the
// established "reused 3+ times within a batch" hoisting threshold this
// epic's shared item shapes above already follow.
export const NotesFieldSchema = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional();

// --- `fields=` projection over the Neuron row (#9082) -----------------------
//
// Read off the published NeuronSchema rather than listed here, so the enum the
// tools advertise and the fields the routes can actually project cannot drift
// apart -- the same reason MCP_NETWORK_VALUES reads McpNetworkSchema.options
// instead of carrying a hand-copied list (#8804, src/mcp-server.ts).
//
// Published as an enum rather than a free string because an agent reading
// tools/list should be able to see which fields exist without a round trip. It
// is enforced at dispatch too: the schema alone is decorative at runtime
// (#8942), so src/mcp-server.ts validates every element against this same
// array before it reaches the projector.
export const NEURON_FIELD_NAMES = Object.keys(NeuronSchema.shape) as [
  string,
  ...string[],
];

export const NeuronFieldsInputSchema = z
  .array(z.enum(NEURON_FIELD_NAMES))
  .min(1)
  .describe(
    "Narrow each returned neuron row to these fields. An ARRAY of names, " +
      "unlike the comma-separated string `fields` takes elsewhere. Omit for " +
      "the full row; the enum lists every projectable field.",
  )
  .optional();

// --- sorting the Neuron row (#9872) -----------------------------------------
//
// Derived from NeuronSchema the same way NEURON_FIELD_NAMES above is, and for
// the same reason: a numeric field added to the contract becomes sortable the
// day it lands, with no second list to remember. The predicate is "what is
// this field's type once optional/nullable are peeled off" -- `incentive` is
// declared `z.number().nullable().optional()`, so a bare `.def.type` check
// would see "optional" and conclude nothing is sortable.
//
// Every numeric field qualifies, including the ones where most rows are null
// (`rank` is assigned only to non-zero-incentive neurons; the immunity fields
// exist only inside the immunity window). Excluding them would be a judgment
// call baked into a list, which is the thing this derivation exists to avoid
// -- and the null-ordering rule below makes them behave predictably anyway.
function neuronFieldBaseType(schema: unknown): string {
  let cur = schema as {
    _zod?: { def?: { type?: string; innerType?: unknown } };
  };
  // optional/nullable/default nest at most a few deep in practice; the bound
  // makes a malformed schema return "" rather than spin.
  for (let depth = 0; depth < 8; depth += 1) {
    const type = cur?._zod?.def?.type;
    if (type === "optional" || type === "nullable" || type === "default") {
      cur = cur._zod!.def!.innerType as typeof cur;
      continue;
    }
    return type ?? "";
  }
  return "";
}

/** Every numeric field of the published Neuron contract, in declaration order. */
export const NEURON_SORT_FIELD_NAMES = Object.entries(NeuronSchema.shape)
  .filter(([, schema]) => neuronFieldBaseType(schema) === "number")
  .map(([name]) => name) as [string, ...string[]];

/**
 * `null` sorts LAST in both directions, deliberately.
 *
 * A null here means "this neuron has no value for that field" -- unranked,
 * outside its immunity window, no Delegates entry -- not "the lowest value".
 * Ordering ascending would otherwise put the entire unranked population ahead
 * of rank 1, which reads as a leaderboard and is the opposite of the truth.
 */
export const NEURON_SORT_NULLS_LAST_NOTE =
  "Rows whose sort field is null are returned LAST in both directions — a " +
  "null means the neuron has no value for that field (unranked, outside " +
  "immunity, no delegate take), never a low one. Ties break by `uid` " +
  "ascending, so the order is stable across calls.";

// ---------------------------------------------------------------------------
// The paginated-list projection (#9796).
//
// Nineteen artifact-backed `list_*` tools share one deliberate reshaping of
// the route artifact they serve, in ~27 handlers that all build it the same
// way (see src/curation-mcp.ts's loadCurationList for the canonical one):
//
//   - `schema_version` is dropped -- the tool result is not an artifact.
//   - the whole pagination block is lifted OUT of the envelope's `meta` and
//     onto the top level, so a model reading one object can see where it is in
//     the collection without being told about envelopes.
//   - `generated_at` and `notes` are null-coalesced rather than omitted, so a
//     caller can always read them.
//
// That is a projection, not drift, and it is why these tools could not simply
// derive from their route schema the way the other 149 did. Declaring it ONCE
// here, and composing it with an explicit `.pick()` of the route's own fields
// at each call site, keeps the derivation a derivation: every field that
// survives still comes from the route, so a rename there is still a compile
// error here.
export const McpListPageFields = {
  total: z
    .int()
    .min(0)
    .describe("Rows in the whole collection, not just this page."),
  returned: z.int().min(0),
  limit: z.int().min(0),
  cursor: z.int().min(0),
  next_cursor: z
    .int()
    .min(0)
    .nullable()
    .describe("Null on the last page -- absence of a next page, not zero."),
  sort: z.string().nullable(),
  order: z.string().nullable(),
};

/**
 * The same page block MINUS `sort`/`order`, for the tools whose loader emits
 * five of the seven (#10790).
 *
 * Nine tools page a collection that declares no sort, and their loaders return
 * exactly `{total, returned, limit, cursor, next_cursor}` -- so declaring the
 * full seven would publish two fields that never arrive. Derived from
 * `McpListPageFields` rather than retyped, so the two cannot disagree about
 * what `total` means.
 */
export const McpUnsortedPageFields = {
  total: McpListPageFields.total,
  returned: McpListPageFields.returned,
  limit: McpListPageFields.limit,
  cursor: McpListPageFields.cursor,
  next_cursor: McpListPageFields.next_cursor,
};

/** The artifact stamp as the list handlers emit it: coalesced to null rather
 * than omitted when the artifact does not carry one. The route schemas declare
 * `generated_at` non-nullable and `notes` optional, which is right for the
 * ROUTE -- it serves the artifact untouched. */
export const McpListArtifactStamp = {
  generated_at: z.string().nullable(),
  notes: z.union([z.string(), z.array(z.string())]).nullable(),
};

/** The same stamp for the SUBNET-SCOPED list tools, which carry no `notes` at
 * all: their handlers echo the requested `netuid` in its place, because a
 * per-subnet slice's provenance is the subnet, not a note about the whole
 * artifact. Kept separate rather than making `notes` optional everywhere --
 * the thirteen network-wide tools always send it, and a contract that says
 * "maybe" where the answer is "always" is the weaker one. */
export const McpSubnetListArtifactStamp = {
  generated_at: z.string().nullable(),
};

/**
 * The row shape a tool publishes when it also advertises a `fields`
 * projection (#9880).
 *
 * A tool with a `fields` parameter lets the CALLER decide which columns come
 * back, so its published row cannot require any of them -- do that and the
 * tool fails its own contract the moment someone uses the parameter it
 * advertises. That is not hypothetical: 25 of the 32 tools that take `fields`
 * were doing exactly this, because deriving their rows from the route schemas
 * (#9796) replaced an open object, which a projected row trivially satisfied,
 * with a strict one that it cannot.
 *
 * Takes the ARRAY off the route schema and returns the same array with every
 * row field optional, so the derivation is still a derivation: the field NAMES
 * and their types still come from the route, and a rename there is still a
 * compile error here. Only the requiredness changes, and it changes because
 * the caller controls it.
 */
export function projectableRows<Row extends z.ZodObject<z.ZodRawShape>>(
  rows: z.ZodArray<Row>,
) {
  return z.array(rows.element.partial());
}

/**
 * The offset page every document-collection tool takes -- ONE declaration
 * (#10790).
 *
 * Six tools carried this pair, each under the same twelve-line comment copied
 * verbatim. Both numbers come from the constants that actually decide them:
 * `MAX_LIMIT` is the ceiling `listQuerySchema` gives every list route, and
 * `MCP_LIST_LIMIT_DEFAULT` is the default `applyMcpQueryFilters` really
 * applies -- published rather than hidden, because #10101 found 83 tools whose
 * schema left a caller unable to tell what an omitted `limit` returns.
 * Publishing the ceiling while hiding the default would recreate that gap.
 *
 * `cursor` is an integer OFFSET, which is what these routes publish
 * (`{minimum: 0, type: integer}`), NOT the keyset cursor. Conflating the two is
 * the mistake `query-params.ts` calls out by name.
 */
export const McpOffsetPageInput = {
  limit: limitSchema(MAX_LIMIT, MCP_LIST_LIMIT_DEFAULT).optional(),
  cursor: offsetSchema().optional(),
};

/**
 * The projection + keyset page every SORTABLE list tool takes -- ONE
 * declaration (#10790).
 *
 * `order`, `fields`, `limit` and `cursor` are identical on every one of them;
 * only `sort` differs, because its allowed values are the collection's own
 * sort fields. So `sort` stays declared per site, beside the collection it
 * belongs to, and the four that never vary come from here.
 *
 * The `limit` ceiling is the tools' 100, not the route's 1000: MCP caps pages
 * for the context window, deliberately (#9981). That is a declaration, not
 * drift, and `validate:mcp-input-parity` records it as one.
 */
export const McpSortableListPage = {
  order: orderSchema().optional(),
  fields: fieldsSchema().optional(),
  limit: limitSchema(100, 20).optional(),
  cursor: numericCursorSchema().optional(),
};
