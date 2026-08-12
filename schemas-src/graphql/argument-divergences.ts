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

/**
 * ONE argument's codec: the spelling GraphQL publishes, and who validates it.
 *
 * ── Why this is one table and was two ──────────────────────────────────────
 *
 * `DECLARED_ARGUMENTS` said an argument's PRESENCE was GraphQL's and
 * `DECLARED_ARGUMENT_TYPES` said its TYPE was, and they were the same fact
 * written twice: every one of the ten keys in the first list was already in
 * the second. #10772 shipped the failure that shape guarantees -- the runtime
 * parse read one list while the generator and the gate read the other, so
 * `providers(cursor: "<opaque string>")` was rejected by a route parameter it
 * was never given. A list not consumed by every acting component will be
 * half-fed; a list that restates a sibling will be half-fed by construction.
 *
 * ── Why `owner` is almost never written ────────────────────────────────────
 *
 * Ownership is DERIVED, from this entry against the route's own schema: the
 * route keeps the argument when its schema can hold the published value, and
 * GraphQL takes it when it cannot. Measured against the ten declarations that
 * list held, the derivation already answered NINE -- the six epoch-ms bounds
 * (`String` over an `integer`), both opaque cursors, and `agent_catalog.netuid`
 * (a path parameter on a sibling route, so there is no query parameter at all).
 *
 * The tenth is `compare.netuids`, and it is declared because the CODEC is what
 * hides it: the array is joined into the route's comma-joined string a line
 * later, so the route's schema can hold it and the derivation says so. See its
 * entry for why the route must not be the one to reject it.
 */
export interface ArgumentCodec {
  /** The spelling the SDL publishes. */
  graphql: string;
  /** Why the route's own parameter does not derive to it. */
  reason: string;
  /** True when the route publishes no such parameter at all. */
  addedByGraphql?: boolean;
  /**
   * Declared only where the derivation cannot see the divergence.
   *
   * One entry uses it. An entry that merely restates what the derivation
   * already answers is the second list coming back under a new name.
   */
  owner?: "graphql";
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

export const ARGUMENT_CODECS: Readonly<Record<string, ArgumentCodec>> = {
  // ── an epoch-ms bound cannot be an Int ────────────────────────────────────
  "blocks.from": { graphql: "String", reason: EPOCH_MS_BOUND },
  "blocks.to": { graphql: "String", reason: EPOCH_MS_BOUND },
  "extrinsics.from": { graphql: "String", reason: EPOCH_MS_BOUND },
  "extrinsics.to": { graphql: "String", reason: EPOCH_MS_BOUND },
  "sudo.from": { graphql: "String", reason: EPOCH_MS_BOUND },
  "sudo.to": { graphql: "String", reason: EPOCH_MS_BOUND },

  // ── a comma-joined string is a list ───────────────────────────────────────
  //
  // THE ONE DECLARED OWNER (#10787). Every other entry's ownership derives from
  // this table against the route's schema; this one cannot, because the codec
  // is what hides it -- the array is joined into the route's comma-joined
  // string a line later, so the route's schema CAN hold the value and the
  // derivation says the route keeps it.
  //
  // It must not. The route's parameter is a regex over a comma-joined string,
  // and its rejection message describes a spelling a GraphQL caller cannot
  // send. `parseCompareNetuidList` in the resolver bounds the same arity (1-128
  // distinct, non-negative) and says so in the caller's own terms, which is why
  // `compare(netuids: [])` and `compare(netuids: [-1])` answer what they do.
  "compare.netuids": {
    graphql: "[Int!]!",
    owner: "graphql",
    reason: COMMA_JOINED_LIST,
  },
  "compare.dimensions": { graphql: "[String!]", reason: COMMA_JOINED_LIST },
  "compare_validators.hotkeys": {
    graphql: "[String!]!",
    reason: COMMA_JOINED_LIST,
  },
  "rpc_endpoints.fields": { graphql: "[String!]", reason: COMMA_JOINED_LIST },
  // `endpoints.fields` and `surfaces.fields` lived here until #10214, each
  // justifying itself by a JSON member its return type no longer carries --
  // `EndpointList` DROPS `notes`, the member the entry named. The expired
  // reason left a published capability that contradicts the schema: project
  // out a column the selection set asks for and a non-null row field has
  // nothing to answer with. `fieldsArgumentApplies` now states the rule once,
  // for the generator and the gate both: `fields` earns an argument only on a
  // return the selection set cannot project at all (the opaque JSON scalar).

  // ── a bound on a COUNT is an Int ──────────────────────────────────────────
  //
  // `list-subnets.ts` declares these `z.number()`, so the route's parameter is
  // `number` and derives to `Float`. Every one bounds an integral quantity --
  // a block height, a count of candidates/mechanisms/participants/probed
  // surfaces/surfaces, a tempo -- and GraphQL has no integer that is not
  // `Int`. Narrowing the Zod instead would 400 a REST caller sending
  // `min_tempo=99.5` today for no gain: the quantity is integral either way,
  // and GraphQL already refuses fractions here.
  "subnets.min_block": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_block": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_candidate_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_candidate_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_mechanism_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_mechanism_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_participant_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_participant_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_probed_surface_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_probed_surface_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_surface_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_surface_count": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.min_tempo": { graphql: "Int", reason: INTEGER_BOUND },
  "subnets.max_tempo": { graphql: "Int", reason: INTEGER_BOUND },

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
    graphql: "Int",
    reason: READINESS_BOUND,
  },
  "subnets.max_integration_readiness": {
    graphql: "Int",
    reason: READINESS_BOUND,
  },
  "subnets.min_readiness": {
    graphql: "Int",
    reason: READINESS_ALIAS,
    addedByGraphql: true,
  },
  "subnets.max_readiness": {
    graphql: "Int",
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
    graphql: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_curation_level": {
    graphql: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_domain": {
    graphql: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_status": {
    graphql: "String",
    reason: NEGATION_FILTER,
    addedByGraphql: true,
  },
  "subnets.not_subnet_type": {
    graphql: "String",
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
  "Subnet.endpoints.min_latency_ms": { graphql: "Int", reason: INTEGER_BOUND },
  "Subnet.endpoints.max_latency_ms": { graphql: "Int", reason: INTEGER_BOUND },

  // ── the Subscription root's only argument ─────────────────────────────────
  "chainEvents.tables": {
    graphql: "[ChainFirehoseTable!]",
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
    graphql: "String!",
    addedByGraphql: true,
    reason:
      "the saved query to run, by id. No REST route serves this field, so " +
      "nothing derives the argument and this entry is where it is published.",
  },
  "saved_query.params": {
    graphql: "JSON",
    addedByGraphql: true,
    reason:
      "the saved query's bound parameters, an opaque record keyed by the " +
      "query's own placeholder names -- which is what JSON is for here. No " +
      "REST route serves this field.",
  },

  "extrinsic.ref": {
    graphql: "String!",
    addedByGraphql: true,
    reason:
      "accepts a transaction hash OR a composite block_number-extrinsic_index " +
      "ref, where the route's path parameter is named for the hash alone. The " +
      "wider name for the wider input, not a second spelling of the same one.",
  },
  "block_chain_events.block_number": {
    graphql: "Int!",
    addedByGraphql: true,
    reason:
      "the route's path parameter is `{ref}`; this field takes the NUMERIC " +
      "block number only, which its description states -- so the argument is " +
      "typed `Int!` rather than accepting the string forms `ref` allows.",
  },

  // ── one path parameter, two names ─────────────────────────────────────────
  "provider.id": {
    graphql: "String!",
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
  "subnets.cursor": { graphql: "String", reason: OPAQUE_KEYSET },
  "providers.cursor": { graphql: "String", reason: OPAQUE_KEYSET },

  // `providers.fields` sat here too, justified by reference to the
  // `endpoints.fields`/`surfaces.fields` entries deleted above -- the same
  // expired reason at one remove. `ProviderList` is a named object type, so
  // the selection set is its projection; `fieldsArgumentApplies` owns the rule.

  // ── a RANGE over netuid, which the route has no parameter for ─────────────
  //
  // #10014 added `netuid` (exactly one subnet) to the route and this field.
  // Neither route nor field has a range, and GraphQL published one first.
  "subnets.min_netuid": {
    graphql: "Int",
    reason: NETUID_RANGE,
    addedByGraphql: true,
  },
  "subnets.max_netuid": {
    graphql: "Int",
    reason: NETUID_RANGE,
    addedByGraphql: true,
  },

  // ── pagination GraphQL owns ───────────────────────────────────────────────
  "endpoints.cursor": {
    graphql: "String",
    reason:
      "an OPAQUE id keyset, not REST's integer offset -- the GraphQL-only " +
      "pagination contract #7920 established for `providers`. Verified live: " +
      'endpoints(limit:1) answers next_cursor "endpoint-srf-2d3306d2cfa2223e". ' +
      "Typing it Int to match the route would break the only pagination the " +
      "field has.",
  },
  "validators.cursor": {
    graphql: "String",
    reason:
      "GraphQL-only pagination. /api/v1/validators publishes sort+limit and " +
      "400s on cursor; the resolver fetches GLOBAL_VALIDATOR_LIMIT_MAX once " +
      "and paginates in-process, keyed by hotkey. A capability GraphQL adds, " +
      "not a claim about the route.",
    addedByGraphql: true,
  },

  // ── one field, two routes ─────────────────────────────────────────────────
  "agent_catalog.netuid": {
    graphql: "Int",
    reason:
      "the field merges TWO routes: netuid absent reads /api/v1/agent-catalog, " +
      "netuid present reads the sibling detail route " +
      "/api/v1/agent-catalog/{netuid}, where it is a path parameter. The " +
      "binding can only name one of the two.",
    addedByGraphql: true,
  },

  // ── the four true/false arguments that are gone from here (#10787) ────────
  //
  // `subnet_endpoints.pool_eligible` and the three review filters published
  // `String` while ~20 siblings published `Boolean`, and the reason was not a
  // divergence at all: their resolvers hand the argument to an MCP loader that
  // validated it with `optionalEnum(args, name, ["true","false"])`, so a JS
  // boolean was rejected where the string was accepted. NOTHING PREVENTED THAT
  // BUT THIS PARAGRAPH, which said "the spelling cannot move without moving
  // the forwarding with it" and left both where they were.
  //
  // The forwarding moved. `withBooleanWords` in src/mcp-list-query.ts is the
  // one decoder for the route's query-string spelling of a boolean, the four
  // arguments publish `Boolean` like their siblings, and `scalarFor` derives
  // that from the route's own `["true","false"]` enum -- so there is nothing
  // left to declare.

  // `subnet_stake_quote.amount` was declared here as `Float!` while the route
  // called it optional and rejected every request without it. #10401 fixed the
  // route instead, so the generator now derives the non-null from the schema
  // and the declaration is gone -- which is the outcome a divergence entry is
  // supposed to reach. Nothing replaces it: an entry kept after its divergence
  // closes is a lie that validate:graphql-query-arguments would fail on.
};

/** The codec declared for one field's argument, or null. */
export function argumentCodec(
  field: string,
  argument: string,
): ArgumentCodec | null {
  return ARGUMENT_CODECS[`${field}.${argument}`] ?? null;
}

/**
 * Is this argument's spelling declared -- including the `addedByGraphql` case,
 * where the route publishes no such parameter at all?
 *
 * `validate:graphql-route-parity` asks the same question from the other side:
 * an SDL argument with no route parameter behind it. That is precisely what an
 * `addedByGraphql` entry records, so the gate reads this rather than keeping a
 * list of its own (#10772).
 */
export function hasArgumentCodec(field: string, argument: string): boolean {
  return `${field}.${argument}` in ARGUMENT_CODECS;
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
 * The kind GraphQL publishes for an argument whose spelling is declared, or
 * null.
 *
 * The caller compares this against the route's declared kind and takes the
 * argument away from the route only where the route's schema genuinely cannot
 * hold the value -- so `Int` over a `z.number()` bound stays the route's,
 * keeping its clamping and its published default, while `String` over that
 * same bound does not. Skipping every declared spelling instead would strip
 * the bounds off fourteen arguments to fix two.
 */
export function publishedArgumentKind(
  field: string,
  argument: string,
): string | null {
  const codec = argumentCodec(field, argument);
  return codec ? graphqlJsonKind(codec.graphql) : null;
}

/**
 * Does this entry take the argument away from the route outright?
 *
 * Declared, not derived, and used ONCE -- see `ArgumentCodec.owner` and the
 * `compare.netuids` entry for why that one cannot be derived.
 */
export function codecOwnsArgument(field: string, argument: string): boolean {
  return argumentCodec(field, argument)?.owner === "graphql";
}
