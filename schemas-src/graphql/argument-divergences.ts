// The GraphQL arguments the mirrored route does not publish, each with the
// reason (#10316).
//
// MOVED HERE FROM THE GATE, and the move is the point. These declarations were
// private to `scripts/validate-graphql-route-parity.ts`, which meant only the
// gate knew them -- and `src/` cannot import from `scripts/`. The dispatch-level
// argument parse needs the same judgement at run time: it parses a field's
// arguments with the route's own Zod object, and an argument the two surfaces
// legitimately spell differently must be skipped rather than rejected.
//
// Two readers, one list. Before this, turning the runtime parse on rejected
// `endpoints(cursor: "x1")` -- a GraphQL-only opaque keyset the gate had
// already declared as correct, verified live, three months ago. The parse was
// right about the route and wrong about the field, because it could not see
// what the gate knew.
//
// THE LIST MUST SHRINK. An entry that no longer names a live divergence fails
// `validate:graphql-route-parity`, so a fix cannot leave a stale exemption
// behind -- the same idiom the MCP input-parity, vocabulary and cross-surface
// gates use.

/**
 * A GraphQL Int is 32 bits signed (max 2,147,483,647) where JSON's integer is
 * not, so an epoch-ms bound has to cross as a String. `src/graphql.ts`'s
 * `blocks` resolver states it at the source: "from/to are observed_at epoch-ms
 * and overflow GraphQL Int's 32 bits, so they are String args passed
 * verbatim". Not drift -- the only spelling GraphQL has for the value.
 */
const EPOCH_MS_BOUND =
  "observed_at epoch-ms bound; overflows GraphQL's 32-bit Int, so the SDL " +
  "passes it as a String verbatim (see the `blocks` resolver's own comment). " +
  "The route's `integer` and the SDL's `String` are the same value in the two " +
  "type systems that can each hold it.";

/** SDL arguments the mirrored route does not publish, each with the reason. */
export const DECLARED_ARGUMENTS: Readonly<Record<string, string>> = {
  "agent_catalog.netuid":
    "the field merges TWO routes: netuid absent reads /api/v1/agent-catalog, " +
    "netuid present reads the sibling detail route /api/v1/agent-catalog/{netuid} " +
    "(src/graphql.ts `agent_catalog`), where it is a path parameter. The doc " +
    "annotation can only name one of the two.",
  "validators.cursor":
    "GraphQL-only pagination. /api/v1/validators publishes sort+limit and 400s " +
    "on cursor (verified live: 'cursor is not supported for this route'); the " +
    "resolver fetches GLOBAL_VALIDATOR_LIMIT_MAX once and paginates in-process, " +
    "keyed by hotkey, the way providers/economics do. A capability GraphQL adds, " +
    "not a claim about the route.",
  "endpoints.cursor":
    "an OPAQUE id keyset, not REST's integer offset -- the same GraphQL-only " +
    "pagination contract #7920 established for `providers`. Verified live: " +
    'endpoints(limit:1) answers next_cursor "endpoint-srf-2d3306d2cfa2223e" ' +
    'and endpoints(cursor:"abc") is accepted, where the four sibling list ' +
    'fields answer "cursor must be a non-negative integer". Typing this Int ' +
    "to match the route would break the only pagination the field has.",
  "compare.netuids":
    "/api/v1/compare takes a comma-joined string (pattern ^\\d{1,5}(,\\d{1,5}){0,127}$) " +
    "because a query string has no list type. GraphQL does, so the SDL takes " +
    "[Int!]! and the resolver joins -- the stricter spelling of the same input, " +
    "with the arity bound enforced by the schema instead of a regex.",
  "extrinsics.from": EPOCH_MS_BOUND,
  "extrinsics.to": EPOCH_MS_BOUND,
  "blocks.from": EPOCH_MS_BOUND,
  "blocks.to": EPOCH_MS_BOUND,
  "sudo.from": EPOCH_MS_BOUND,
  "sudo.to": EPOCH_MS_BOUND,
};

/**
 * The published GraphQL type for an argument the route's parameter does not
 * derive to (#10214).
 *
 * `DECLARED_ARGUMENTS` above says an argument's PRESENCE is intentional; this
 * says its TYPE is. The generator reads it, so an entry here is not an
 * exemption from a check -- it is the spelling that gets published.
 */
export interface DeclaredArgumentType {
  /** The published GraphQL spelling. */
  type: string;
  /** Why the route's own parameter does not derive to it. */
  reason: string;
  /** True when the route publishes no such parameter at all. */
  addedByGraphql?: boolean;
}

const BOOLEAN_STRING_FORWARDING =
  'the route publishes a ["true","false"] STRING enum and GraphQL has a ' +
  "real Boolean, which is the stricter spelling -- but this field's resolver " +
  "hands the argument to an MCP loader that validates it with " +
  "`optionalEnum(args, name, BOOLEAN_STRINGS)`, so a JS boolean is rejected " +
  "where the string is accepted. Moving the spelling means moving the " +
  "forwarding with it.";

const COMMA_JOINED_LIST =
  "a query string has no list type, so the route takes the values comma-" +
  "joined and bounds the arity with a regex. GraphQL has a list, so the SDL " +
  "takes one and the resolver joins -- the same input, with the arity bound " +
  "enforced by the schema instead of a pattern.";

export const DECLARED_ARGUMENT_TYPES: Readonly<
  Record<string, DeclaredArgumentType>
> = {
  // ── an epoch-ms bound cannot be an Int ────────────────────────────────────
  "blocks.from": { type: "String", reason: EPOCH_MS_BOUND },
  "blocks.to": { type: "String", reason: EPOCH_MS_BOUND },
  "extrinsics.from": { type: "String", reason: EPOCH_MS_BOUND },
  "extrinsics.to": { type: "String", reason: EPOCH_MS_BOUND },
  "sudo.from": { type: "String", reason: EPOCH_MS_BOUND },
  "sudo.to": { type: "String", reason: EPOCH_MS_BOUND },

  // ── a comma-joined string is a list ───────────────────────────────────────
  "compare.netuids": { type: "[Int!]!", reason: COMMA_JOINED_LIST },
  "compare.dimensions": { type: "[String!]", reason: COMMA_JOINED_LIST },
  "compare_validators.hotkeys": {
    type: "[String!]!",
    reason: COMMA_JOINED_LIST,
  },
  "rpc_endpoints.fields": { type: "[String!]", reason: COMMA_JOINED_LIST },
  "endpoints.fields": {
    type: "[String!]",
    reason:
      COMMA_JOINED_LIST +
      " Kept at all -- unlike the fields whose `fields` is dropped -- because " +
      "this field's return type carries a JSON member a selection set cannot " +
      "reach inside, so the caller has no projection without it.",
    addedByGraphql: true,
  },
  "surfaces.fields": {
    type: "String",
    reason:
      "same reason as `endpoints.fields`: the return type is not fully " +
      "projectable, so REST's projection parameter still has work to do. " +
      "Spelled String here rather than a list, which is the older of the two " +
      "spellings on this surface and a difference worth collapsing separately.",
    addedByGraphql: true,
  },

  // ── pagination GraphQL owns ───────────────────────────────────────────────
  "endpoints.cursor": {
    type: "String",
    reason:
      "an OPAQUE id keyset, not REST's integer offset -- the GraphQL-only " +
      "pagination contract #7920 established for `providers`. Verified live: " +
      'endpoints(limit:1) answers next_cursor "endpoint-srf-2d3306d2cfa2223e". ' +
      "Typing it Int to match the route would break the only pagination the " +
      "field has.",
  },
  "validators.cursor": {
    type: "String",
    reason:
      "GraphQL-only pagination. /api/v1/validators publishes sort+limit and " +
      "400s on cursor; the resolver fetches GLOBAL_VALIDATOR_LIMIT_MAX once " +
      "and paginates in-process, keyed by hotkey. A capability GraphQL adds, " +
      "not a claim about the route.",
    addedByGraphql: true,
  },

  // ── one field, two routes ─────────────────────────────────────────────────
  "agent_catalog.netuid": {
    type: "Int",
    reason:
      "the field merges TWO routes: netuid absent reads /api/v1/agent-catalog, " +
      "netuid present reads the sibling detail route " +
      "/api/v1/agent-catalog/{netuid}, where it is a path parameter. The " +
      "binding can only name one of the two.",
    addedByGraphql: true,
  },

  // ── a true/false enum the resolver's forwarding still expects as text ─────
  //
  // `Boolean` is the honest spelling and ~20 sibling arguments already use it
  // -- but these four reach an MCP loader that validates with
  // `optionalEnum(args, name, BOOLEAN_STRINGS)`, which wants the STRING
  // "true". `endpoints.pool_eligible` is Boolean and safe only because ITS
  // resolver takes a different path (`endpointsListQueryUrl`'s `set()`, which
  // does `String(value)`). So the spelling cannot move without moving the
  // forwarding with it, per field -- an input-type change that needs its own
  // verification rather than a rename inside a generator change.
  "subnet_endpoints.pool_eligible": {
    type: "String",
    reason: BOOLEAN_STRING_FORWARDING,
  },
  "review_enrichment_queue.manual_review_required": {
    type: "String",
    reason: BOOLEAN_STRING_FORWARDING,
  },
  "review_enrichment_targets.auto_review_candidate": {
    type: "String",
    reason: BOOLEAN_STRING_FORWARDING,
  },
  "review_enrichment_targets.manual_review_required": {
    type: "String",
    reason: BOOLEAN_STRING_FORWARDING,
  },

  // `subnet_stake_quote.amount` was declared here as `Float!` while the route
  // called it optional and rejected every request without it. #10401 fixed the
  // route instead, so the generator now derives the non-null from the schema
  // and the declaration is gone -- which is the outcome a divergence entry is
  // supposed to reach. Nothing replaces it: an entry kept after its divergence
  // closes is a lie that validate:graphql-query-arguments would fail on.
};

/** Does the route's parse own this field's argument, or does GraphQL? */
export function isDeclaredDivergence(field: string, argument: string): boolean {
  return `${field}.${argument}` in DECLARED_ARGUMENTS;
}

/**
 * The two shape conversions a resolver performs before it calls the route, and
 * the reason each is a SPELLING rather than a divergence.
 *
 * `validate-graphql-route-parity.ts` documents both and deliberately does not
 * flag them:
 *
 *   BOOLEAN against a published ["true","false"] string enum. A query string
 *   can only carry those two words as text; GraphQL has a real Boolean, so the
 *   SDL is the stricter and more honest of the two spellings. Every resolver on
 *   this shape normalises the same way -- `if (changes === true)
 *   params.set("changes", "true")`.
 *
 *   LIST against a comma-joined string. `/api/v1/compare` takes a bounded
 *   comma-joined pattern because a query string has no list type. GraphQL does,
 *   so the SDL takes [Int!]! and the resolver joins.
 *
 * A dispatch-level parse sees the GraphQL-shaped value while the route's Zod
 * object describes the route-shaped one. Converting first is what lets ONE
 * parse serve both spellings; without it the parse rejects `changes: true`
 * against a string enum and a list against a string -- the parse being wrong
 * about the field rather than the field being wrong.
 *
 * ── It must ask the schema, not the value ──────────────────────────────────
 *
 * The first version of this converted every boolean it saw, which is wrong
 * whenever the route's own parameter is a real boolean rather than the
 * two-word enum: `validator_economics(emission_gate_open: true)` became
 * `"true"` and the parse answered `emission_gate_open must be true or false`.
 * A conversion is only correct when the DESTINATION is the other spelling, so
 * the target type decides, and a value the route already accepts is left alone.
 */
export type RouteShape = "string-enum" | "delimited-string" | "as-is";

export function toRouteShape(value: unknown, target: RouteShape): unknown {
  if (target === "string-enum" && typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (target === "delimited-string" && Array.isArray(value)) {
    return value.join(",");
  }
  return value;
}
