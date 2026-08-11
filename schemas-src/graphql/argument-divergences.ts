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

const SURFACES_UNFORWARDED =
  "the route publishes this surface filter and `Subnet.surfaces`'s resolver " +
  "does not forward it -- the name appears nowhere in src/graphql.ts. " +
  "Publishing it would let a caller filter and silently receive the " +
  "unfiltered list, which is worse than being unable to ask.";

const HEALTH_IGNORES_ARGUMENTS =
  "`health` takes no arguments at all: its resolver is " +
  "`async health(_args: unknown, context)` and calls " +
  "`buildGlobalHealth(snapshot, {})` with an empty options object. " +
  "Publishing this filter would let a caller send it and silently receive " +
  "the unfiltered rollup, which is worse than being unable to ask. The " +
  "route's six filters are a capability GraphQL does not have yet.";

const INTEGER_BOUND =
  "the route declares this `z.number()` and it bounds an INTEGRAL quantity " +
  "(a block height, a count, a tempo), so `Float` is the derivation's answer " +
  "and `Int` is the right published one -- GraphQL has no integer that is " +
  "not `Int`. Narrowing the Zod would 400 a REST caller sending a fractional " +
  "bound today, for a quantity that is integral either way.";

const READINESS_BOUND =
  "the integration-readiness score is integral -- 129 of 129 rows on " +
  "/api/v1/subnets carry a whole number -- and the alias `min_readiness` has " +
  "always published `Int`, so the canonical name matching it is what keeps " +
  "the two spellings of ONE field interchangeable. The route's `z.number()` " +
  "derives to Float; see INTEGER_BOUND for why the Zod is not narrowed.";

const READINESS_ALIAS =
  "the shorter name `list_subnets` shipped with, kept beside the canonical " +
  "`*_integration_readiness` the route publishes so existing callers are " +
  "unaffected. Both are now published here, which is the point: the SDL had " +
  "only this one, so an agent reading our OpenAPI and sending the canonical " +
  "name to GraphQL was rejected.";

const NEGATION_FILTER =
  "a categorical NEGATION filter GraphQL has and the route does not. " +
  'Verified live: subnets(not_status: "active") answers {"total":0,"items":[]} ' +
  'where GET /api/v1/subnets?not_status=active answers 400 "not_status is ' +
  'not supported for this route." The resolver reaches the same shared ' +
  "`listPage` filters the list_subnets MCP tool does, so this is a capability " +
  "GraphQL adds, not a claim about the route.";

const OPAQUE_KEYSET =
  "an OPAQUE id keyset, not REST's integer offset -- the GraphQL-only " +
  "pagination contract #7920 established for `providers` and `endpoints`. " +
  "This field's own binding description already states it. Typing it `Int` " +
  "to match the route would break the only pagination the field has.";

const NETUID_RANGE =
  "a RANGE bound on netuid, which no route parameter expresses: #10014 gave " +
  "both surfaces `netuid` (exactly one subnet) and neither a range. A " +
  "capability GraphQL adds, not a claim about the route.";

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

/**
 * Fields whose route has a `/{network}/` twin but which do not publish the
 * `network` argument, each because the resolver cannot honour it (#10394).
 *
 * Lives here rather than in the gate for the reason the header gives:
 * `schemas-src/` cannot import from `scripts/`, and the GENERATOR needs this
 * judgement as much as the check does. While it lived in the gate the two
 * disagreed -- the gate accepted the omission and the generator published the
 * argument anyway, which is the drift these declarations exist to stop.
 */
export const DECLARED_MISSING_NETWORK: readonly string[] = [
  // `/api/v1/extrinsics/{hash}` has a twin, so `network` derives -- but the
  // resolver destructures `{ ref }` and nothing else (src/graphql.ts
  // `extrinsic`), so publishing it would let a caller ask for testnet and
  // silently receive mainnet.
  "extrinsic",
];

/**
 * Route parameters GraphQL deliberately does NOT publish, each with the reason
 * (#10772).
 *
 * THE THIRD DIRECTION, and the one nothing could state. `DECLARED_ARGUMENTS`
 * says an argument's PRESENCE is intentional and `DECLARED_ARGUMENT_TYPES`
 * says its TYPE is; an OMISSION had no slot but `DECLARED_MISSING_NETWORK`,
 * which holds one argument name. So this direction never had to justify
 * itself, and twelve of them accumulated behind a gate that could not see
 * them -- six on `health` alone.
 *
 * That matters more here than on the other two, because `buildSchema(SDL)`
 * builds a schema with no resolver map: there is no per-field hook that could
 * accept an argument the schema omits, so an omission is a route capability a
 * GraphQL caller simply CANNOT REACH. Every entry below is a capability gap,
 * recorded rather than hidden.
 *
 * Read by `deriveQueryArguments`, so an entry does not merely excuse the
 * difference -- it is why the generated schema omits the argument, the same
 * way `DECLARED_ARGUMENT_TYPES` is why it publishes the spelling it does. And
 * like its siblings the list only SHRINKS: an entry naming a parameter the
 * route stopped publishing, or one GraphQL has since published, fails
 * `validate:graphql-query-arguments` as stale.
 */
export const DECLARED_UNPUBLISHED_ARGUMENTS: Readonly<Record<string, string>> =
  {
    // ── the resolver ignores its arguments entirely ─────────────────────────
    //
    // `async health(_args: unknown, context)` -- it calls
    // `buildGlobalHealth(snapshot, {})` with an empty options object and reads
    // nothing off `_args`. Publishing the route's six filters would be a LIE
    // rather than a fix: a caller would send `netuid: 7` and receive the
    // unfiltered rollup, which is worse than being unable to ask. Implementing
    // them is a feature and belongs in its own issue.
    "health.netuid": HEALTH_IGNORES_ARGUMENTS,
    "health.status": HEALTH_IGNORES_ARGUMENTS,
    "health.sort": HEALTH_IGNORES_ARGUMENTS,
    "health.order": HEALTH_IGNORES_ARGUMENTS,
    "health.limit": HEALTH_IGNORES_ARGUMENTS,
    "health.cursor": HEALTH_IGNORES_ARGUMENTS,

    // ── the selection set already does the job ──────────────────────────────
    "opportunity_boards.board":
      "GraphQL publishes the six economic boards as FIELDS (open_slots, " +
      "cheapest_registration, …), so choosing one is the selection set's job. " +
      "The route needs the parameter because a JSON envelope has no way to " +
      "ask for part of itself; a GraphQL caller selects the board it wants " +
      "and pays for nothing else.",

    // ── a nested field whose resolver reads only some of the route's ───────
    //
    // `Subnet.surfaces` filters the per-subnet surface list, and its resolver
    // forwards the arguments it names. These three appear nowhere in
    // src/graphql.ts, so publishing them would let a caller filter on
    // `auth_required` and receive the unfiltered list.
    "Subnet.surfaces.auth_required": SURFACES_UNFORWARDED,
    "Subnet.surfaces.public_safe": SURFACES_UNFORWARDED,
    "Subnet.surfaces.rate_limited": SURFACES_UNFORWARDED,

    // ── published under a wider or narrower name ────────────────────────────
    "extrinsic.hash":
      "published as `ref`, which accepts this hash AND a composite " +
      "block_number-extrinsic_index the path parameter's name does not " +
      "suggest. Declared in DECLARED_ARGUMENT_TYPES as `extrinsic.ref`.",
    "block_chain_events.ref":
      "published as `block_number`, typed `Int!`: this field takes the " +
      "numeric block number only, where the route's `{ref}` also accepts the " +
      "string forms. The narrower input under the name that says so.",

    // ── published under another name ────────────────────────────────────────
    "provider.slug":
      "published as `id`, the name this field has always taken and the one " +
      "`providers(id:)` filters by -- the same path parameter under the " +
      "spelling the rest of the GraphQL surface uses. Declared in " +
      "DECLARED_ARGUMENT_TYPES as `provider.id`.",

    // ── the route can express what a selection set cannot, and vice versa ───
    "subnets.q":
      "free-text search over the registry, which GraphQL exposes as its own " +
      "`search`/`semantic_search` fields rather than as a filter on the " +
      "index -- the resolver's `listPage` path takes the categorical and " +
      "range filters and never reads `q`.",
    "subnets.netuids":
      "the route takes a comma-joined string because a query string has no " +
      "list type; this field's `netuid` takes ONE subnet and `compare` takes " +
      "the list ([Int!]!, see compare.netuids). Publishing a comma-joined " +
      "String here would add the one spelling GraphQL exists to avoid.",
  };

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

  // ── a bound on a COUNT is an Int ──────────────────────────────────────────
  //
  // `list-subnets.ts` declares these `z.number()`, so the route's parameter is
  // `number` and derives to `Float`. Every one bounds an integral quantity --
  // a block height, a count of candidates/mechanisms/participants/probed
  // surfaces/surfaces, a tempo -- and GraphQL has no integer that is not
  // `Int`. Narrowing the Zod instead would 400 a REST caller sending
  // `min_tempo=99.5` today for no gain: the quantity is integral either way,
  // and GraphQL already refuses fractions here.
  "subnets.min_block": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_block": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_candidate_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_candidate_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_mechanism_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_mechanism_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_participant_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_participant_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_probed_surface_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_probed_surface_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_surface_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_surface_count": { type: "Int", reason: INTEGER_BOUND },
  "subnets.min_tempo": { type: "Int", reason: INTEGER_BOUND },
  "subnets.max_tempo": { type: "Int", reason: INTEGER_BOUND },

  // ── the canonical readiness names, and the aliases beside them ────────────
  //
  // `list-subnets.ts` declares BOTH pairs and says which is which: the
  // `*_integration_readiness` pair carries "The route's published names
  // (#10018) -- GET /api/v1/subnets documents these, so an agent reading our
  // OpenAPI sends them. Canonical", and the short pair is "kept so existing
  // callers are unaffected". The SDL published only the alias, so an agent
  // that read our own OpenAPI and sent the canonical name to GraphQL was
  // rejected -- the exact failure that comment was written to prevent,
  // reappearing on the surface nothing was checking. The canonical pair now
  // derives from the route; these two are the aliases kept beside them.
  "subnets.min_integration_readiness": {
    type: "Int",
    reason: READINESS_BOUND,
  },
  "subnets.max_integration_readiness": {
    type: "Int",
    reason: READINESS_BOUND,
  },
  "subnets.min_readiness": {
    type: "Int",
    reason: READINESS_ALIAS,
    addedByGraphql: true,
  },
  "subnets.max_readiness": {
    type: "Int",
    reason: READINESS_ALIAS,
    addedByGraphql: true,
  },

  // ── negation filters GraphQL has and the route does not ───────────────────
  //
  // Verified live, both directions: `subnets(not_status: "active", limit: 2)`
  // answers `{"total":0,"items":[]}`, and GET /api/v1/subnets?not_status=active
  // answers 400 "not_status is not supported for this route." GraphQL is AHEAD
  // of REST here rather than drifted from it -- the resolver reaches the same
  // shared `listPage` filters the list_subnets MCP tool does.
  "subnets.not_coverage_level": {
    type: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_curation_level": {
    type: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_domain": {
    type: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_status": {
    type: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_subnet_type": {
    type: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },

  // ── one path parameter, a WIDER name ──────────────────────────────────────
  //
  // Not a rename: `ref` accepts what `hash` does and more. The route's path
  // parameter is `{hash}`; this field takes a hash OR a composite
  // "<block_number>-<extrinsic_index>", which its description states and the
  // resolver implements (a composite ref routes through `answerBlockDetail`).
  // ── a latency bound is whole milliseconds ─────────────────────────────────
  //
  // The per-subnet endpoints route declares these `z.number()`; the probe
  // measures whole milliseconds, and the sibling root field `endpoints`
  // publishes `Int` from a route that says integer. Same reasoning as
  // INTEGER_BOUND, on the one nested field that takes arguments.
  "Subnet.endpoints.min_latency_ms": { type: "Int", reason: INTEGER_BOUND },
  "Subnet.endpoints.max_latency_ms": { type: "Int", reason: INTEGER_BOUND },

  // ── the Subscription root's only argument ─────────────────────────────────
  "chainEvents.tables": {
    type: "[ChainFirehoseTable!]",
    addedByGraphql: true,
    reason:
      "the firehose topics to subscribe to. No REST route serves the " +
      "WebSocket transport at all, so nothing derives this -- and the " +
      "Subscription root was built with derivation switched OFF entirely, " +
      "which dropped it from the generated schema (#10772).",
  },

  // ── a field that mirrors no route at all ──────────────────────────────────
  //
  // `/api/v1/queries/{id}` does not exist -- absent from API_ROUTES, 404 live
  // -- so `saved_query` has no parameters to derive from and these two ARE the
  // declaration.
  "saved_query.id": {
    type: "String!",
    addedByGraphql: true,
    reason:
      "the saved query to run, by id. No REST route serves this field, so " +
      "nothing derives the argument and this entry is where it is published.",
  },
  "saved_query.params": {
    type: "JSON",
    addedByGraphql: true,
    reason:
      "the saved query's bound parameters, an opaque record keyed by the " +
      "query's own placeholder names -- which is what JSON is for here. No " +
      "REST route serves this field.",
  },

  "extrinsic.ref": {
    type: "String!",
    addedByGraphql: true,
    reason:
      "accepts a transaction hash OR a composite block_number-extrinsic_index " +
      "ref, where the route's path parameter is named for the hash alone. The " +
      "wider name for the wider input, not a second spelling of the same one.",
  },
  "block_chain_events.block_number": {
    type: "Int!",
    addedByGraphql: true,
    reason:
      "the route's path parameter is `{ref}`; this field takes the NUMERIC " +
      "block number only, which its description states -- so the argument is " +
      "typed `Int!` rather than accepting the string forms `ref` allows.",
  },

  // ── one path parameter, two names ─────────────────────────────────────────
  "provider.id": {
    type: "String!",
    addedByGraphql: true,
    reason:
      "the route's path parameter is `slug`; this field has always taken " +
      "`id`, which is also what `providers(id:)` filters by. One parameter " +
      "under the spelling the rest of the GraphQL surface uses; the route's " +
      "name is declared in DECLARED_UNPUBLISHED_ARGUMENTS.",
  },

  // ── the two remaining opaque keysets ──────────────────────────────────────
  //
  // The same contract #7920 established for `providers` and `endpoints`: an
  // opaque id keyset where REST takes an integer offset. Both bindings say so
  // in prose already -- `providers`' description reads "Cursor remains the
  // pre-existing opaque string id-keyset (not REST's integer offset)".
  "subnets.cursor": { type: "String", reason: OPAQUE_KEYSET },
  "providers.cursor": { type: "String", reason: OPAQUE_KEYSET },

  // ── projection the selection set cannot replace ───────────────────────────
  "providers.fields": {
    type: "String",
    addedByGraphql: true,
    reason:
      "same reason as `endpoints.fields` and `surfaces.fields`: `fields` is " +
      "dropped wherever a selection set already projects the return type, and " +
      "kept where it does not. Spelled String rather than a list, the older " +
      "of the two spellings on this surface.",
  },

  // ── a RANGE over netuid, which the route has no parameter for ─────────────
  //
  // #10014 added `netuid` (exactly one subnet) to the route and this field.
  // Neither route nor field has a range, and GraphQL published one first.
  "subnets.min_netuid": {
    type: "Int",
    reason: NETUID_RANGE,
    addedByGraphql: true,
  },
  "subnets.max_netuid": {
    type: "Int",
    reason: NETUID_RANGE,
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
 * The JSON kind a published GraphQL type carries.
 *
 * Deliberately coarse: it answers "can the route's schema hold this value",
 * not "is it the same type". `Int` against a route's `z.number()` is the SAME
 * kind, which is what keeps the fourteen integral bounds owned by the route --
 * they still get its clamping and its published defaults. A GraphQL enum is a
 * name rather than a scalar, and crosses as a string like `String` and `ID`.
 */
function graphqlJsonKind(type: string): string {
  if (type.trimStart().startsWith("[")) return "array";
  const named = type.replace(/[![\]\s]/g, "");
  if (named === "Int" || named === "Float") return "number";
  if (named === "Boolean") return "boolean";
  return "string";
}

/**
 * The kind GraphQL publishes for an argument whose TYPE is declared, or null.
 *
 * THE SECOND READER OF ONE LIST, and the reason this exists (#10772).
 * `DECLARED_ARGUMENTS` says an argument's presence is GraphQL's; the runtime
 * parse read only that, so `providers(cursor: "<opaque string>")` was rejected
 * by the route's integer `cursor` -- a divergence declared, correctly, in
 * `DECLARED_ARGUMENT_TYPES` instead. Two lists for one concept is the trap
 * this file's own header records from last time; the fix is a second reader,
 * not a third list. The caller compares this against the route's declared kind
 * and skips only where the route's schema genuinely cannot hold the value.
 */
/**
 * Is this argument's TYPE declared -- including the `addedByGraphql` case,
 * where the route publishes no such parameter at all?
 *
 * `validate:graphql-route-parity` asks the same question from the other side:
 * an SDL argument with no route parameter behind it. That is precisely what an
 * `addedByGraphql` entry records, so the gate reads this rather than keeping a
 * list of its own (#10772).
 */
export function isDeclaredArgumentType(
  field: string,
  argument: string,
): boolean {
  return `${field}.${argument}` in DECLARED_ARGUMENT_TYPES;
}

export function declaredArgumentKind(
  field: string,
  argument: string,
): string | null {
  const entry = DECLARED_ARGUMENT_TYPES[`${field}.${argument}`];
  return entry ? graphqlJsonKind(entry.type) : null;
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
