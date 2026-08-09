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
