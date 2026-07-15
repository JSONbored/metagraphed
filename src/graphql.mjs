import {
  GraphQLError,
  buildSchema,
  execute,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import { readArtifact, readHealthKv } from "../workers/storage.mjs";
import { contractVersion } from "../workers/responses.mjs";
import { tryPostgresTier } from "../workers/postgres-tier.mjs";
import {
  BLOCK_PAGINATION,
  clampLimit,
  clampOffset,
} from "../workers/request-params.mjs";
import {
  buildGlobalHealth,
  formatLeaderboards,
  resolveLiveEconomics,
  resolveLiveHealth,
  subnetBadgeStatus,
} from "./health-serving.mjs";
import {
  loadCompareSubnets,
  parseCompareDimensionList,
  parseCompareNetuidList,
} from "./analytics-live.mjs";
import { buildExtrinsic, buildExtrinsicFeed } from "./extrinsics.mjs";
import {
  DEFAULT_GLOBAL_VALIDATOR_SORT,
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
  GLOBAL_VALIDATOR_SORTS,
  buildGlobalValidators,
  buildValidatorDetail,
  overlayFeaturedValidators,
} from "./metagraph-neurons.mjs";
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
  ACCOUNTS_LIST_SORTS,
  DEFAULT_ACCOUNTS_LIST_SORT,
  buildAccountsList,
} from "./accounts-list.mjs";
import { buildAccountSummary } from "./account-events.mjs";
import { KV_HEALTH_META } from "./kv-keys.mjs";
import { SS58_ADDRESS_PATTERN } from "../workers/config.mjs";

export const GRAPHQL_MAX_DEPTH = 7;
export const GRAPHQL_MAX_COMPLEXITY = 50;
export const GRAPHQL_MAX_BODY_BYTES = 64 * 1024;
export const GRAPHQL_MAX_QUERY_BYTES = 16 * 1024;

// The read-only registry graph. Field names mirror the artifact JSON keys
// (snake_case) so the graphql-js default field resolver reads them straight off
// the artifact rows — relationship fields (the ones that resolve a *fresh*
// artifact and so cost a read / fan out per parent) are the only ones backed by
// explicit resolver thunks, and each carries a complexity weight below.
export const SDL = `
  type Query {
    "Paginated active-subnet index."
    subnets(limit: Int, cursor: String): SubnetList!
    "One subnet with its health, surfaces, endpoints, and economics."
    subnet(netuid: Int!): Subnet
    "Paginated provider/source registry."
    providers(limit: Int, cursor: String): ProviderList!
    "One provider with its subnets."
    provider(id: String!): Provider
    "Paginated per-subnet economic + validator metrics."
    economics(limit: Int, cursor: String): EconomicsList!
    "Curated public interface surfaces, optionally scoped to one subnet."
    surfaces(netuid: Int, limit: Int, cursor: String): SurfaceList!
    "Endpoint/resource registry, optionally scoped to one subnet."
    endpoints(netuid: Int, limit: Int, cursor: String): EndpointList!
    "Global operational health rollup with per-subnet summaries."
    health: GlobalHealth
    "Cross-subnet economic opportunity boards (where to register, what it costs, where the emission and validator headroom are)."
    opportunity_boards(limit: Int): OpportunityBoards!
    "Cross-subnet comparison: registry structure, live economics, and live health placed side by side for the requested netuids, in requested order. Mirrors GET /api/v1/compare."
    compare(netuids: [Int!]!, dimensions: [String!]): Compare!
    "Recent-extrinsic feed (newest first), optionally filtered. Mirrors GET /api/v1/extrinsics."
    extrinsics(limit: Int, offset: Int, cursor: String, block: Int, signer: String, call_module: String, call_function: String, success: Boolean): ExtrinsicList!
    "One extrinsic by hash or composite block_number-extrinsic_index ref; extrinsic is null when the ref doesn't resolve (schema-stable, never a GraphQL error). Mirrors GET /api/v1/extrinsics/{ref}."
    extrinsic(ref: String!): ExtrinsicDetail
    "Network-wide validator/operator leaderboard, grouped by hotkey across every subnet it operates in. Mirrors GET /api/v1/validators."
    validators(sort: String, limit: Int): ValidatorList!
    "One validator's cross-subnet aggregate by hotkey; a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null. Mirrors GET /api/v1/validators/{hotkey}."
    validator(hotkey: String!): Validator
    "Site-wide accounts leaderboard -- every currently-registered hotkey, aggregated cross-subnet from the current neurons snapshot. Mirrors GET /api/v1/accounts."
    accounts(sort: String, limit: Int): AccountList!
    "One account's cross-subnet event-history summary by ss58 address; an address with no matching account_events rows resolves to a schema-stable zero summary, never null. Mirrors GET /api/v1/accounts/{ss58}."
    account(ss58: String!): AccountSummary
  }

  type SubnetList {
    items: [Subnet!]!
    total: Int!
    next_cursor: String
  }

  type Subnet {
    netuid: Int!
    name: String
    slug: String
    description: String
    categories: [String!]
    status: String
    subnet_type: String
    lifecycle: String
    coverage_level: String
    curation_level: String
    integration_readiness: Int
    surface_count: Int
    official_surface_count: Int
    probed_surface_count: Int
    gap_count: Int
    first_party: Boolean
    symbol: String
    logo_url: String
    website_url: String
    docs_url: String
    "Live operational health summary for this subnet."
    health: SubnetHealth
    "Per-subnet economic + validator metrics."
    economics: SubnetEconomics
    "Curated public interface surfaces of this subnet."
    surfaces: [Surface!]!
    "Endpoint/resource registry rows for this subnet."
    endpoints: [Endpoint!]!
  }

  type ProviderList {
    items: [Provider!]!
    total: Int!
    next_cursor: String
  }

  type Provider {
    id: String!
    name: String
    kind: String
    authority: String
    docs_url: String
    github_url: String
    website_url: String
    contact_url: String
    logo_url: String
    notes: String
    public_notes: String
    endpoint_count: Int
    surface_count: Int
    subnet_count: Int
    netuids: [Int]!
    "The subnets this provider operates surfaces on."
    subnets: [Subnet!]!
  }

  type EconomicsList {
    subnets: [SubnetEconomics!]!
    total: Int!
    next_cursor: String
  }

  type SubnetEconomics {
    netuid: Int!
    name: String
    slug: String
    emission_share: Float
    alpha_price_tao: Float
    alpha_market_cap_tao: Float
    alpha_fdv_tao: Float
    registration_allowed: Boolean
    registration_cost_tao: Float
    open_slots: Int
    max_uids: Int
    miner_count: Int
    miner_readiness: Int
    validator_count: Int
    max_validators: Int
    total_stake_tao: Float
    max_stake_tao: Float
    subnet_volume_tao: Float
    tao_in_pool_tao: Float
    alpha_in_pool: Float
    alpha_out_pool: Float
    owner_coldkey: String
    owner_hotkey: String
  }

  type SurfaceList {
    items: [Surface!]!
    total: Int!
    next_cursor: String
  }

  type Surface {
    id: String!
    key: String
    netuid: Int
    name: String
    kind: String
    status: String
    classification: String
    authority: String
    provider: String
    url: String
    auth_required: Boolean
    public_safe: Boolean
    schema_status: String
    schema_url: String
    last_verified_at: String
    stale: Boolean
    subnet_name: String
    subnet_slug: String
    source_urls: [String!]
    notes: String
  }

  type EndpointList {
    items: [Endpoint!]!
    total: Int!
    next_cursor: String
  }

  type Endpoint {
    id: String!
    surface_id: String
    surface_key: String
    netuid: Int
    kind: String
    layer: String
    network: String
    status: String
    classification: String
    authority: String
    provider: String
    operator: String
    url: String
    auth_required: Boolean
    public_safe: Boolean
    latency_ms: Int
    latest_block: Int
    last_checked: String
    last_ok: String
    health_source: String
    score: Int
    pool_eligible: Boolean
    monitoring_status: String
    subnet_name: String
    subnet_slug: String
    source_urls: [String!]
  }

  type GlobalHealth {
    status: String
    surface_count: Int
    ok_count: Int
    degraded_count: Int
    failed_count: Int
    unknown_count: Int
    avg_latency_ms: Int
    latency_sample_count: Int
    last_checked: String
    last_ok: String
    generated_at: String
    operational_observed_at: String
    health_source: String
    scope: String
    subnets: [SubnetHealth!]!
  }

  type SubnetHealth {
    netuid: Int
    name: String
    slug: String
    status: String
    surface_count: Int
    ok_count: Int
    degraded_count: Int
    failed_count: Int
    unknown_count: Int
    avg_latency_ms: Int
    latency_sample_count: Int
    last_checked: String
    last_ok: String
  }

  type OpportunityBoards {
    observed_at: String
    with_economics_count: Int!
    open_slots: [OpportunityEntry!]!
    cheapest_registration: [OpportunityEntry!]!
    highest_emission: [OpportunityEntry!]!
    validator_headroom: [OpportunityEntry!]!
  }

  type OpportunityEntry {
    netuid: Int!
    slug: String
    name: String
    open_slots: Int
    max_uids: Int
    registration_cost_tao: Float
    registration_allowed: Boolean
    emission_share: Float
    total_stake_tao: Float
    validator_count: Int
    miner_count: Int
    validator_headroom: Int
    max_validators: Int
  }

  type Compare {
    schema_version: Int!
    source: String
    observed_at: String
    dimensions: [String!]!
    requested_netuids: [Int!]!
    subnets: [CompareSubnet!]!
  }

  type CompareSubnet {
    netuid: Int!
    name: String
    slug: String
    found: Boolean!
    structure: CompareStructure
    economics: CompareEconomics
    health: CompareHealth
  }

  type CompareStructure {
    completeness_score: Float
    surface_count: Int
    operational_interface_count: Int
  }

  type CompareEconomics {
    registration_cost_tao: Float
    registration_allowed: Boolean
    open_slots: Int
    emission_share: Float
    alpha_price_tao: Float
    validator_count: Int
    miner_count: Int
    total_stake_tao: Float
    miner_readiness: Int
  }

  type CompareHealth {
    surface_count: Int
    ok_count: Int
    avg_latency_ms: Int
  }

  type ExtrinsicList {
    items: [Extrinsic!]!
    "Page count -- this feed has no cheap grand total, matching REST's extrinsic_count."
    total: Int!
    next_cursor: String
  }

  type Extrinsic {
    block_number: Int
    extrinsic_index: Int
    extrinsic_hash: String
    signer: String
    call_module: String
    call_function: String
    "JSON-encoded decoded call arguments."
    call_args: String
    success: Boolean
    fee_tao: Float
    tip_tao: Float
    observed_at: String
  }

  type ExtrinsicDetail {
    ref: String
    extrinsic: Extrinsic
  }

  type ValidatorList {
    items: [Validator!]!
    total: Int!
    sort: String!
    captured_at: String
    block_number: Int
  }

  type Validator {
    hotkey: String!
    featured: Boolean!
    coldkey: String
    coldkey_identity: Identity
    coldkey_count: Int
    subnet_count: Int
    uid_count: Int
    take: Float
    total_stake_tao: Float
    root_stake_tao: Float
    alpha_stake_tao: Float
    total_emission_tao: Float
    nominator_count: Int
    apy_estimate: Float
    apy_estimate_eligible_subnet_count: Int
    avg_validator_trust: Float
    max_validator_trust: Float
    captured_at: String
    block_number: Int
    "Per-subnet membership rows for this validator. The global leaderboard entry caps this at the top 10 by stake; the single-validator lookup carries every subnet."
    subnets: [ValidatorSubnet!]!
  }

  type ValidatorSubnet {
    netuid: Int!
    uid: Int
    stake_tao: Float
    emission_tao: Float
    validator_trust: Float
  }

  "Self-reported on-chain identity (SubtensorModule::set_identity) for a coldkey."
  type Identity {
    has_identity: Boolean!
    name: String
    url: String
    github: String
    image: String
    discord: String
    description: String
    additional: String
    captured_at: String
  }

  type AccountList {
    items: [AccountEntry!]!
    total: Int!
    sort: String!
    captured_at: String
    block_number: Int
  }

  type AccountEntry {
    hotkey: String!
    coldkey: String
    coldkey_count: Int
    subnet_count: Int
    uid_count: Int
    validator_count: Int
    miner_count: Int
    total_stake_tao: Float
    total_emission_tao: Float
    stake_dominance: Float
    latest_captured_at: String
    latest_block_number: Int
    "Per-subnet stake/emission rows for this account, capped at the top 10 by stake."
    subnets: [AccountSubnet!]!
  }

  type AccountSubnet {
    netuid: Int!
    uid: Int
    stake_tao: Float
    emission_tao: Float
  }

  type AccountSummary {
    ss58: String!
    event_count: Int!
    subnet_count: Int!
    "True when this account has more events than the summary's scan window -- event_count/subnet_count/event_kinds are then a lower bound and first_block/first_seen_at are null."
    event_scan_capped: Boolean!
    first_block: Int
    last_block: Int
    first_seen_at: String
    last_seen_at: String
    event_kinds: [AccountEventKind!]!
    "Where this hotkey is currently registered + staked (the live cross-subnet footprint)."
    registrations: [AccountRegistration!]!
    recent_events: [AccountEvent!]!
    activity: AccountActivity!
  }

  type AccountEventKind {
    kind: String!
    count: Int!
  }

  type AccountRegistration {
    netuid: Int
    uid: Int
    stake_tao: Float
    validator_permit: Boolean!
    active: Boolean!
  }

  type AccountEvent {
    block_number: Int
    event_index: Int
    event_kind: String
    hotkey: String
    coldkey: String
    netuid: Int
    uid: Int
    amount_tao: Float
    alpha_amount: Float
    observed_at: String
    extrinsic_index: Int
  }

  "Signing-activity aggregate from the extrinsics tier, matched by signer only -- an account queried by a key that did not sign returns tx_count 0, other fields null/empty."
  type AccountActivity {
    tx_count: Int!
    last_tx_block: Int
    last_tx_at: String
    total_fee_tao: Float
    modules_called: [AccountModuleCall!]!
  }

  type AccountModuleCall {
    call_module: String!
    count: Int!
  }

  # Realtime chain-event firehose (#4983, ADR 0015) -- a thin protocol adapter
  # over the SAME ChainFirehoseHub Durable Object connection #4982's SSE/WS
  # transports use, not a second event pipeline. Reached over WebSocket only
  # (Sec-WebSocket-Protocol: graphql-transport-ws at this same /api/v1/graphql
  # path) -- POSTing a subscription operation to the regular query endpoint
  # returns a standard GraphQL error, same as any other GraphQL server.
  type Subscription {
    "Live chain events as they land (blocks/extrinsics/chain_events/account_events), optionally filtered to one or more tables. Field shape mirrors the #4980 NOTIFY payload -- only the fields relevant to the event's table are populated."
    chainEvents(tables: [ChainFirehoseTable!]): ChainEvent!
  }

  enum ChainFirehoseTable {
    blocks
    extrinsics
    chain_events
    account_events
  }

  type ChainEvent {
    table: ChainFirehoseTable!
    block_number: Int!
    observed_at: String
    "blocks only"
    block_hash: String
    "blocks only"
    extrinsic_count: Int
    "blocks only"
    event_count: Int
    "extrinsics only"
    extrinsic_index: Int
    "extrinsics only"
    call_module: String
    "extrinsics only"
    call_function: String
    "extrinsics only"
    signer: String
    "extrinsics only"
    success: Boolean
    "chain_events / account_events (event index within the block)"
    event_index: Int
    "chain_events only"
    pallet: String
    "chain_events only"
    method: String
    "account_events only -- the curated kind (e.g. Transfer, StakeAdded)"
    event_kind: String
    "account_events only"
    hotkey: String
    "account_events only"
    coldkey: String
    "account_events only"
    netuid: Int
    "account_events only"
    amount_tao: Float
  }
`;

// Exported so workers/chain-firehose-hub.mjs's graphql-ws server (#4983) can
// execute against the SAME schema -- not a copy, so the two transports never
// drift.
export const schema = buildSchema(SDL);

// SDL-only schemas (buildSchema) carry no resolver functions -- Query/Mutation
// fields read straight off rootValue/artifacts via the default field resolver,
// but a subscription root field needs an explicit `subscribe` (an
// AsyncIterable source), which SDL has no syntax for. Attached here, once, at
// module load, the same graphql-js technique used by every SDL-first server
// that also needs subscriptions. context.chainFirehose is supplied by
// whichever Durable Object drives the graphql-ws server (workers/chain-firehose-hub.mjs)
// -- see GRAPHQL_SUBSCRIPTION_CONTEXT_KEY below.
export const GRAPHQL_SUBSCRIPTION_CONTEXT_KEY = "chainFirehose";
schema.getSubscriptionType().getFields().chainEvents.subscribe =
  async function* chainEventsSubscribe(_source, args, context) {
    const hub = context?.[GRAPHQL_SUBSCRIPTION_CONTEXT_KEY];
    if (!hub) {
      throw new GraphQLError(
        "chainEvents is only reachable over the WebSocket transport (Sec-WebSocket-Protocol: graphql-transport-ws) at /api/v1/graphql.",
      );
    }
    // Distinguish omitted (undefined -> null, no filter, matches everything)
    // from an EXPLICIT empty list (tables: [] -> an empty Set, matches
    // nothing) -- consistent with the SSE/WS firehose's own
    // parseChainFirehoseTopics semantics (an all-unrecognized topics= string
    // also collapses to an empty Set, never silently falling back to
    // "everything"). Previously both cases collapsed to null.
    const topics = args.tables === undefined ? null : new Set(args.tables);
    // context.clientIp/context.graphqlWsConnection are set by
    // workers/chain-firehose-hub.mjs's graphqlWsServer context() callback
    // from ctx.extra.ip/ctx.extra.graphqlWsConnection (populated by
    // handleSubscribe's opened(adapterSocket, { ip, graphqlWsConnection })
    // call) -- threaded through so subscribeChainEvents can enforce its
    // per-IP (#5004 item 2) and per-socket subscription-count caps alongside
    // the global one.
    const repeater = hub.subscribeChainEvents(
      topics,
      context.clientIp,
      context.graphqlWsConnection,
    );
    if (!repeater) {
      throw new GraphQLError(
        "The realtime chain firehose has reached its maximum number of " +
          "concurrent GraphQL subscriptions; try again later.",
      );
    }
    try {
      for await (const payload of repeater) {
        yield { chainEvents: payload };
      }
    } finally {
      hub.unsubscribeChainEvents(repeater);
    }
  };

// --- Complexity weights ---

// Per-field weight against GRAPHQL_MAX_COMPLEXITY: read/fan-out fields cost more
// than scalars so the guard stays meaningful — one subnet with all its
// relationships fits, while greedily pulling many relationships across a page
// trips it. Keyed by field name; everything else defaults to 1.
export const DEFAULT_FIELD_COMPLEXITY = 1;
const RELATIONSHIP_FIELD_COMPLEXITY = 5;
export const FIELD_COMPLEXITY = {
  subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet: RELATIONSHIP_FIELD_COMPLEXITY,
  providers: RELATIONSHIP_FIELD_COMPLEXITY,
  provider: RELATIONSHIP_FIELD_COMPLEXITY,
  economics: RELATIONSHIP_FIELD_COMPLEXITY,
  surfaces: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  health: RELATIONSHIP_FIELD_COMPLEXITY,
  opportunity_boards: RELATIONSHIP_FIELD_COMPLEXITY,
  compare: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsic: RELATIONSHIP_FIELD_COMPLEXITY,
  validators: RELATIONSHIP_FIELD_COMPLEXITY,
  validator: RELATIONSHIP_FIELD_COMPLEXITY,
  accounts: RELATIONSHIP_FIELD_COMPLEXITY,
  account: RELATIONSHIP_FIELD_COMPLEXITY,
};

function fieldComplexity(fieldName) {
  return FIELD_COMPLEXITY[fieldName] ?? DEFAULT_FIELD_COMPLEXITY;
}

// --- Validation rules ---

function buildFragmentMap(documentNode) {
  const fragments = new Map();
  for (const def of documentNode.definitions) {
    if (def.kind === "FragmentDefinition") {
      fragments.set(def.name.value, def);
    }
  }
  return fragments;
}

// Introspection root meta-fields (`__schema` / `__type`) resolve against the
// schema document only — they have no per-row data fan-out — so they carry none
// of the DoS risk the depth/complexity weights were sized for. Exempt them (and
// their subtree) from both counters so the standard getIntrospectionQuery() that
// every GraphQL tool sends (intrinsically deeper/wider than the data limits)
// stays enabled over POST, matching the documented contract. Sibling data fields
// in the same operation are still measured, so a mixed query stays bounded.
const INTROSPECTION_ROOT_FIELDS = new Set(["__schema", "__type"]);
function isIntrospectionRootField(sel) {
  return sel.kind === "Field" && INTROSPECTION_ROOT_FIELDS.has(sel.name?.value);
}

// Depth/complexity must follow named fragment spreads. Otherwise a client moves
// the whole (expensive) selection into a fragment and the operation's own
// selection set is just a single transparent spread — counting as depth 0 /
// complexity 1 and fully bypassing both limits. `visited` guards against
// fragment cycles: validate() reports those, but our rules run in the same pass
// and would otherwise recurse forever.
//
// Inline fragments (`... on Type { ... }`, or a bare `... @include(if:) { ... }`)
// are likewise transparent: a type condition is not a nesting level or an extra
// field. Counting them would over-measure a query relative to its equivalent
// inlined or named-fragment form, wrongly rejecting valid queries.
function selectionDepth(selectionSet, fragments, visited, memo, max) {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: depth 0
    let depth = 0;
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          depth = memo.get(fragName);
        } else {
          depth = selectionDepth(
            frag.selectionSet,
            fragments,
            new Set(visited).add(fragName),
            memo,
            max,
          );
          memo.set(fragName, depth);
        }
      }
    } else if (sel.kind === "InlineFragment") {
      // Transparent: recurse at the same depth (the type condition is not a level).
      depth = selectionDepth(sel.selectionSet, fragments, visited, memo, max);
    } else if (sel.selectionSet) {
      depth =
        1 + selectionDepth(sel.selectionSet, fragments, visited, memo, max);
    }
    if (depth > deepest) deepest = depth;
    if (deepest > max) return max + 1;
  }
  return deepest;
}

export function maxDepthRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const depth = selectionDepth(
              def.selectionSet,
              fragments,
              new Set(),
              new Map(),
              max,
            );
            if (depth > max) {
              context.reportError(
                new GraphQLError(
                  `Query depth ${depth} exceeds the limit of ${max}.`,
                  { extensions: { code: "DEPTH_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

function selectionComplexity(selectionSet, fragments, visited, memo, max) {
  let count = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: no complexity cost
    if (sel.kind === "FragmentSpread") {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          count += memo.get(fragName);
        } else {
          const fragCount = selectionComplexity(
            frag.selectionSet,
            fragments,
            new Set(visited).add(fragName),
            memo,
            max,
          );
          memo.set(fragName, fragCount);
          count += fragCount;
        }
      }
    } else if (sel.kind === "InlineFragment") {
      // Transparent like a named spread: count the contained fields, not the
      // inline type condition itself.
      count += selectionComplexity(
        sel.selectionSet,
        fragments,
        visited,
        memo,
        max,
      );
    } else {
      count += fieldComplexity(sel.name.value);
      if (sel.selectionSet) {
        count += selectionComplexity(
          sel.selectionSet,
          fragments,
          visited,
          memo,
          max,
        );
      }
    }
    if (count > max) return max + 1;
  }
  return count;
}

export function maxComplexityRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const complexity = selectionComplexity(
              def.selectionSet,
              fragments,
              new Set(),
              new Map(),
              max,
            );
            if (complexity > max) {
              context.reportError(
                new GraphQLError(
                  `Query complexity ${complexity} exceeds the limit of ${max}.`,
                  { extensions: { code: "COMPLEXITY_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

// --- Pagination ---

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function paginate(items, limit, cursor, keyFn) {
  // A missing/blank/<1 limit falls back to the default — it must NOT clamp UP to
  // 1. An explicit `limit: 0` reaching `Math.max(1, …)` would return a single
  // result, which reads to an agent as "this registry knows one subnet" (the same
  // reasoning as clampLimit in src/mcp-server.mjs and src/ai-search.mjs).
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 1
      ? Math.min(MAX_PAGE_LIMIT, Math.floor(limit))
      : DEFAULT_PAGE_LIMIT;
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((item) => String(keyFn(item)) === cursor);
    if (idx >= 0) start = idx + 1;
  }
  const page = items.slice(start, start + safeLimit);
  const nextCursor =
    start + page.length < items.length
      ? String(keyFn(page[page.length - 1]))
      : null;
  return { page, total: items.length, nextCursor };
}

// --- Reads (per-request memoized) ---

// Registry-wide artifacts read by more than one resolver; named so the memo keys
// stay byte-identical. Per-subnet/provider detail paths are templated inline.
const ARTIFACT = {
  subnets: "/metagraph/subnets.json",
  providers: "/metagraph/providers.json",
  economics: "/metagraph/economics.json",
  surfaces: "/metagraph/surfaces.json",
  endpoints: "/metagraph/endpoints.json",
  profiles: "/metagraph/profiles.json",
};
const LIVE_HEALTH_KEY = "live:health";
const LIVE_ECONOMICS_KEY = "live:economics";

// Resolve an async value at most once per query: a page of subnets each pulling
// a relationship shares one read of each registry artifact (and one live health
// snapshot). The promise is cached so concurrent thunks collapse onto one read.
function once(context, key, load) {
  let pending = context.cache.get(key);
  if (!pending) {
    pending = load();
    context.cache.set(key, pending);
  }
  return pending;
}

// Artifact data, or null when cold/absent — resolvers degrade to empty shapes
// rather than erroring, like the REST handlers.
function loadArtifact(context, path) {
  return once(context, path, () =>
    readArtifact(context.env, path).then((res) => (res.ok ? res.data : null)),
  );
}

// Rows under `key`, filtered to one subnet when `netuid` is given.
async function loadRows(context, path, key, netuid) {
  const data = await loadArtifact(context, path);
  const rows = data?.[key];
  if (!Array.isArray(rows)) return [];
  return netuid == null ? rows : rows.filter((row) => row?.netuid === netuid);
}

// Live operational health (KV health:current → D1) — the build no longer
// publishes static health, so this mirrors the REST /api/v1/health source.
// Null when the live store is cold.
function loadLiveHealth(context) {
  return once(context, LIVE_HEALTH_KEY, () =>
    resolveLiveHealth({
      readHealthKv,
      env: context.env,
      db: context.env?.METAGRAPH_HEALTH_DB,
    }),
  );
}

// Economics blob, preferring the fresh KV tier over the committed R2 artifact —
// the same source REST (/api/v1/economics, registry leaderboards) serves, so the
// GraphQL rows and opportunity boards never lag it. Null when both are cold.
function loadEconomics(context) {
  return once(context, LIVE_ECONOMICS_KEY, async () => {
    const live = await resolveLiveEconomics({
      readHealthKv,
      env: context.env,
      contractVersion: contractVersion(context.env),
    });
    if (Array.isArray(live?.data?.subnets)) return live.data;
    const res = await readArtifact(context.env, ARTIFACT.economics);
    return res.ok ? res.data : null;
  });
}

// A (sql, params) => Promise<rows[]> runner over the health DB, mirroring REST's
// d1All and the MCP compare runner: a cold DB or query error yields [] so the
// compare health dimension degrades to null rows instead of erroring.
function graphqlD1(context) {
  return async (sql, params) => {
    const db = context.env?.METAGRAPH_HEALTH_DB;
    if (!db?.prepare) return [];
    try {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all();
      return result?.results || [];
    } catch {
      return [];
    }
  };
}

// Cron snapshot freshness stamp (KV health:meta) — the same observed_at REST
// compare stamps its envelope with. Null when the live store is cold.
function loadObservedAt(context) {
  return once(context, KV_HEALTH_META, async () => {
    const meta = await readHealthKv(context.env, KV_HEALTH_META);
    return meta?.last_run_at || null;
  });
}

// Economics subnet rows for compare, reusing the live-preferring economics memo
// (same source the `economics` root + opportunity boards serve).
async function loadEconomicsRows(context) {
  const data = await loadEconomics(context);
  return Array.isArray(data?.subnets) ? data.subnets : [];
}

// Synthesize the GET request tryPostgresTier forwards to the DATA_API service
// binding, keyed off the same origin as the inbound GraphQL POST (GraphQL has
// no REST-shaped request of its own to forward, unlike every REST handler
// that already owns one matching its own route). Same technique
// handleCompare's health dimension uses for its own internal compare-health
// forward (workers/request-handlers/analytics-routes.mjs) rather than
// forwarding the caller's request unchanged.
function postgresTierRequest(context, pathname, params) {
  const pgUrl = new URL(context.request.url);
  pgUrl.pathname = pathname;
  pgUrl.search = params ? params.toString() : "";
  return new Request(pgUrl);
}

// --- Node builders (attach lazy relationship resolvers to artifact rows) ---

// graphql-js' default field resolver invokes a source property when it is a
// function: `subnet.health(args, context, info)`. So a node is just the artifact
// row spread over lazy thunks for its relationships — scalar fields resolve
// straight off the row, relationships resolve on demand through the shared memo.
// `prefetch` lets the single-subnet path serve surfaces/endpoints from the
// detail artifact it already read; economics + health are not in that artifact.
function subnetNode(identity, prefetch = {}) {
  const netuid = identity.netuid;
  const bundledOr = (rows, load) =>
    rows !== undefined
      ? () => rows ?? []
      : (_args, context) => load(context, netuid);
  return {
    ...identity,
    health: (_args, context) => loadSubnetHealth(context, netuid),
    economics: (_args, context) => loadSubnetEconomics(context, netuid),
    surfaces: bundledOr(prefetch.surfaces, loadSubnetSurfaces),
    endpoints: bundledOr(prefetch.endpoints, loadSubnetEndpoints),
  };
}

// formatExtrinsic's call_args is a decoded JS value (object/array/null), but
// the SDL exposes it as an opaque JSON-encoded String (no custom JSON scalar
// exists in this schema yet) -- stringify it here rather than letting
// graphql-js' default String serializer coerce the object via `String(...)`
// (which would silently produce "[object Object]").
function extrinsicNode(extrinsic) {
  if (!extrinsic) return null;
  return {
    ...extrinsic,
    call_args:
      extrinsic.call_args == null ? null : JSON.stringify(extrinsic.call_args),
  };
}

// buildGlobalValidators' per-hotkey entries carry featured/uid_count/
// latest_captured_at/latest_block_number; buildValidatorDetail's single-hotkey
// aggregate has no featured/uid_count and names the same timestamps
// captured_at/block_number -- normalized here so both resolvers return the
// same Validator shape. Both builders always return an object (rows=[]
// degrades to a zeroed aggregate, never null/undefined), so there is no null
// case to guard. `subnets` entries are passed through as-is: the leaderboard's
// compact 5-field rows and the detail's full formatNeuron rows share the
// fields ValidatorSubnet declares, and graphql-js' default field resolver
// reads them straight off each row, the same technique this file's other node
// builders use for rows with more columns than any one GraphQL type exposes.
function validatorNode(validator) {
  return {
    ...validator,
    featured: validator.featured === true,
    captured_at: validator.latest_captured_at ?? validator.captured_at ?? null,
    block_number:
      validator.latest_block_number ?? validator.block_number ?? null,
  };
}

// buildAccountSummary always returns a full-shaped object (a cold/absent store
// still yields a zeroed summary, never a partial one), but a malformed
// Postgres-tier response body degrades to `{}` -- normalized here the same way
// extrinsicNode/ExtrinsicDetail's `data.ref ?? ref` fallback degrades a
// malformed extrinsic-detail body, so a bad upstream body still resolves to
// the same schema-stable zero shape as a genuinely cold store, not a
// Non-Null-field error.
function accountSummaryNode(data, ss58) {
  return {
    ss58: data.ss58 ?? ss58,
    event_count: data.event_count ?? 0,
    subnet_count: data.subnet_count ?? 0,
    event_scan_capped: data.event_scan_capped === true,
    first_block: data.first_block ?? null,
    last_block: data.last_block ?? null,
    first_seen_at: data.first_seen_at ?? null,
    last_seen_at: data.last_seen_at ?? null,
    event_kinds: data.event_kinds || [],
    registrations: data.registrations || [],
    recent_events: data.recent_events || [],
    activity: data.activity || { tx_count: 0, modules_called: [] },
  };
}

function providerNode(provider) {
  const netuids = provider?.netuids || [];
  return {
    ...provider,
    netuids,
    subnets: (_args, context) => loadProviderSubnets(context, netuids),
  };
}

async function loadSubnetHealth(context, netuid) {
  return subnetBadgeStatus(await loadLiveHealth(context), netuid);
}

async function loadSubnetEconomics(context, netuid) {
  const data = await loadEconomics(context);
  return data?.subnets?.find((row) => row?.netuid === netuid) ?? null;
}

function loadSubnetSurfaces(context, netuid) {
  return loadRows(context, ARTIFACT.surfaces, "surfaces", netuid);
}

function loadSubnetEndpoints(context, netuid) {
  return loadRows(context, ARTIFACT.endpoints, "endpoints", netuid);
}

async function loadProviderSubnets(context, netuids) {
  if (!netuids.length) return [];
  const rows = await loadRows(context, ARTIFACT.subnets, "subnets");
  const byNetuid = new Map(rows.map((row) => [row.netuid, row]));
  return netuids
    .map((netuid) => byNetuid.get(netuid))
    .filter(Boolean)
    .map((row) => subnetNode(row));
}

// --- Resolvers ---

// Shared list shape: load → optional netuid filter → paginate → wrap. `map`
// node-wraps rows; `resultKey` is the list field's name (economics uses
// `subnets`, the rest use `items`).
async function listPage(
  context,
  path,
  key,
  { limit, cursor, keyFn, netuid, map, resultKey = "items" },
) {
  const all = await loadRows(context, path, key, netuid);
  const { page, total, nextCursor } = paginate(all, limit, cursor, keyFn);
  return {
    [resultKey]: map ? page.map(map) : page,
    total,
    next_cursor: nextCursor,
  };
}

// readArtifact's static-asset tier resolves the path through a URL parser that
// collapses "../", so an unvalidated provider id could escape the providers/
// namespace. Constrain it to the safe slug charset the other id-bearing artifact
// paths use; subnet(netuid) is Int-typed and needs no guard.
const VALID_PROVIDER_ID = /^[A-Za-z0-9._:-]+$/;

const rootValue = {
  subnets({ limit, cursor }, context) {
    return listPage(context, ARTIFACT.subnets, "subnets", {
      limit,
      cursor,
      keyFn: (s) => s.netuid,
      map: subnetNode,
    });
  },

  async subnet({ netuid }, context) {
    const data = await loadArtifact(
      context,
      `/metagraph/subnets/${netuid}.json`,
    );
    if (!data) return null;
    // The detail artifact nests identity under `subnet` (flat shapes fall back)
    // and bundles surfaces/endpoints, so those resolve from this one read;
    // economics is overlaid live at serve time, so it loads lazily.
    const identity = data.subnet ?? data;
    // The detail artifact omits the list artifact's computed registry metrics
    // (integration_readiness, official_surface_count, gap_count, first_party),
    // so without this backfill the single-subnet path returns them null while
    // `subnets` populates them. Read the matching subnets.json row — memoized and
    // shared per request, so at most one extra read; the detail identity still
    // wins on any shared key.
    const listRow = (
      await loadRows(context, ARTIFACT.subnets, "subnets", netuid)
    )[0];
    return subnetNode(listRow ? { ...listRow, ...identity } : identity, {
      surfaces: data.surfaces,
      endpoints: data.endpoints,
    });
  },

  providers({ limit, cursor }, context) {
    return listPage(context, ARTIFACT.providers, "providers", {
      limit,
      cursor,
      keyFn: (p) => p.id,
      map: providerNode,
    });
  },

  async provider({ id }, context) {
    if (typeof id !== "string" || !VALID_PROVIDER_ID.test(id)) return null;
    const data = await loadArtifact(context, `/metagraph/providers/${id}.json`);
    if (!data) return null;
    return providerNode(data.provider ?? data);
  },

  async economics({ limit, cursor }, context) {
    // Live-preferring source (not the static-only listPage), paginated like it.
    const data = await loadEconomics(context);
    const { page, total, nextCursor } = paginate(
      data?.subnets || [],
      limit,
      cursor,
      (s) => s.netuid,
    );
    return { subnets: page, total, next_cursor: nextCursor };
  },

  surfaces({ netuid, limit, cursor }, context) {
    return listPage(context, ARTIFACT.surfaces, "surfaces", {
      limit,
      cursor,
      netuid,
      keyFn: (s) => s.id ?? s.key,
    });
  },

  endpoints({ netuid, limit, cursor }, context) {
    return listPage(context, ARTIFACT.endpoints, "endpoints", {
      limit,
      cursor,
      netuid,
      keyFn: (e) => e.id ?? e.surface_id,
    });
  },

  async health(_args, context) {
    const snapshot = await loadLiveHealth(context);
    const result = snapshot ? buildGlobalHealth(snapshot, {}) : null;
    if (!result) return null;
    // GlobalHealth exposes the rollup counts flat; buildGlobalHealth nests them
    // under `global`.
    return {
      ...(result.global || {}),
      generated_at: result.generated_at,
      operational_observed_at: result.operational_observed_at,
      health_source: result.health_source,
      scope: result.scope,
      subnets: result.subnets || [],
    };
  },

  async opportunity_boards({ limit }, context) {
    const data = await loadEconomics(context);
    const rows = Array.isArray(data?.subnets) ? data.subnets : [];
    // Reuse the live economics tier + the leaderboard ranking, so the boards
    // match /api/v1/registry/leaderboards. With no health/rpc inputs, only the
    // economic boards are populated.
    const ranked = formatLeaderboards({
      limit,
      observedAt: data?.captured_at || data?.generated_at || null,
      economicsRows: rows,
      subnetMeta: new Map(),
    });
    const boards = ranked.boards;
    return {
      observed_at: ranked.observed_at,
      with_economics_count: rows.length,
      open_slots: boards["open-slots"] || [],
      cheapest_registration: boards["cheapest-registration"] || [],
      highest_emission: boards["highest-emission"] || [],
      validator_headroom: boards["validator-headroom"] || [],
    };
  },

  async compare({ netuids, dimensions }, context) {
    // Reuse the REST/MCP shared parsers so the GraphQL contract matches
    // /api/v1/compare and the compare_subnets MCP tool exactly (distinctness +
    // range + the dimension whitelist), then the shared loader composes the rows.
    const parsedNetuids = parseCompareNetuidList(netuids);
    if (!parsedNetuids) {
      throw new GraphQLError(
        "netuids must be a non-empty array of 1-128 distinct non-negative subnet ids.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const parsedDimensions = parseCompareDimensionList(dimensions);
    if (dimensions != null && parsedDimensions === null) {
      throw new GraphQLError(
        "dimensions must be a non-empty subset of structure, economics, health.",
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const profilesData = await loadArtifact(context, ARTIFACT.profiles);
    const profiles = Array.isArray(profilesData?.profiles)
      ? profilesData.profiles
      : [];
    return loadCompareSubnets(graphqlD1(context), {
      profiles,
      economicsRows: parsedDimensions.includes("economics")
        ? await loadEconomicsRows(context)
        : [],
      netuids: parsedNetuids,
      dimensions: parsedDimensions,
      observedAt: await loadObservedAt(context),
    });
  },

  async extrinsics(
    {
      limit,
      offset,
      cursor,
      block,
      signer,
      call_module: callModule,
      call_function: callFunction,
      success,
    },
    context,
  ) {
    if (block != null && (!Number.isInteger(block) || block < 0)) {
      throw new GraphQLError("block must be a non-negative integer.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const safeLimit = clampLimit(limit, BLOCK_PAGINATION);
    const safeOffset = clampOffset(offset);
    const params = new URLSearchParams();
    params.set("limit", String(safeLimit));
    params.set("offset", String(safeOffset));
    if (cursor) params.set("cursor", cursor);
    if (block != null) params.set("block", String(block));
    if (signer) params.set("signer", signer);
    if (callModule) params.set("call_module", callModule);
    if (callFunction) params.set("call_function", callFunction);
    if (success != null) params.set("success", String(success));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/extrinsics", params),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ??
      buildExtrinsicFeed([], {
        limit: safeLimit,
        offset: safeOffset,
        nextCursor: null,
      });
    return {
      items: (data.extrinsics || []).map(extrinsicNode),
      total: data.extrinsic_count ?? 0,
      next_cursor: data.next_cursor ?? null,
    };
  },

  async extrinsic({ ref }, context) {
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/extrinsics/${encodeURIComponent(ref)}`,
        ),
        "METAGRAPH_EXTRINSICS_SOURCE",
      )) ?? buildExtrinsic(undefined, ref);
    return {
      ref: data.ref ?? ref,
      extrinsic: extrinsicNode(data.extrinsic),
    };
  },

  async validators({ sort, limit }, context) {
    const requestedSort = sort ?? DEFAULT_GLOBAL_VALIDATOR_SORT;
    if (!GLOBAL_VALIDATOR_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${GLOBAL_VALIDATOR_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: GLOBAL_VALIDATOR_LIMIT_DEFAULT,
      maxLimit: GLOBAL_VALIDATOR_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(safeLimit));
    const data = overlayFeaturedValidators(
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/validators", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
        buildGlobalValidators([], {
          sort: requestedSort,
          limit: safeLimit,
        }),
    );
    return {
      items: (data.validators || []).map(validatorNode),
      total: data.validator_count ?? 0,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async validator({ hotkey }, context) {
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/validators/${encodeURIComponent(hotkey)}`,
        ),
        "METAGRAPH_NEURONS_SOURCE",
      )) ?? buildValidatorDetail([], hotkey);
    return validatorNode(data);
  },

  async accounts({ sort, limit }, context) {
    const requestedSort = sort ?? DEFAULT_ACCOUNTS_LIST_SORT;
    if (!ACCOUNTS_LIST_SORTS.includes(requestedSort)) {
      throw new GraphQLError(
        `"${requestedSort}" is not a supported sort. Supported: ${ACCOUNTS_LIST_SORTS.join(", ")}.`,
        { extensions: { code: "BAD_USER_INPUT" } },
      );
    }
    const safeLimit = clampLimit(limit, {
      defaultLimit: ACCOUNTS_LIST_LIMIT_DEFAULT,
      maxLimit: ACCOUNTS_LIST_LIMIT_MAX,
    });
    const params = new URLSearchParams();
    params.set("sort", requestedSort);
    params.set("limit", String(safeLimit));
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(context, "/api/v1/accounts", params),
        "METAGRAPH_NEURONS_SOURCE",
      )) ??
      buildAccountsList([], {
        sort: requestedSort,
        limit: safeLimit,
      });
    return {
      items: data.accounts || [],
      total: data.account_count ?? 0,
      sort: data.sort ?? requestedSort,
      captured_at: data.captured_at ?? null,
      block_number: data.block_number ?? null,
    };
  },

  async account({ ss58 }, context) {
    if (!SS58_ADDRESS_PATTERN.test(ss58)) {
      throw new GraphQLError("ss58 must be a valid SS58 address.", {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const data =
      (await tryPostgresTier(
        context.env,
        postgresTierRequest(
          context,
          `/api/v1/accounts/${encodeURIComponent(ss58)}`,
        ),
        "METAGRAPH_ACCOUNT_EVENTS_SOURCE",
      )) ?? buildAccountSummary(ss58, {});
    return accountSummaryNode(data, ss58);
  },
};

// --- Response helpers ---

const GRAPHQL_CONTENT_TYPE = "application/graphql-response+json";
const SDL_CONTENT_TYPE = "application/graphql; charset=utf-8";

const graphqlError = (message, status = 400, extraHeaders = {}) =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: graphqlHeaders(extraHeaders),
  });

const graphqlHeaders = (extra = {}) => ({
  "content-type": GRAPHQL_CONTENT_TYPE,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  ...extra,
});

// --- Handler ---

async function readLimitedJson(request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) {
      return {
        error: graphqlError("Invalid Content-Length header."),
      };
    }
    if (length > GRAPHQL_MAX_BODY_BYTES) {
      return {
        error: graphqlError("GraphQL request body is too large.", 413),
      };
    }
  }

  if (!request.body) {
    return { value: null };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GRAPHQL_MAX_BODY_BYTES) {
        await reader.cancel();
        return {
          error: graphqlError("GraphQL request body is too large.", 413),
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      error: graphqlError("Request body must be valid JSON."),
    };
  }
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

// GET publishes the schema document so the shape is discoverable without a
// playground or introspection round-trip (a browser/curl GET used to 405).
// Introspection over POST stays enabled for tooling.
function sdlResponse() {
  return new Response(SDL.trim() + "\n", {
    status: 200,
    headers: graphqlHeaders({
      "content-type": SDL_CONTENT_TYPE,
      "cache-control": "public, max-age=300, stale-while-revalidate=300",
      allow: "GET, POST",
    }),
  });
}

export async function handleGraphQLRequest(request, env) {
  if (request.method === "GET") {
    return sdlResponse();
  }

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        errors: [{ message: "GraphQL endpoint accepts GET (SDL) or POST." }],
      }),
      {
        status: 405,
        headers: graphqlHeaders({ allow: "GET, POST" }),
      },
    );
  }

  const { value: body, error: bodyError } = await readLimitedJson(request);
  if (bodyError) return bodyError;

  const { query, variables, operationName } = body || {};
  if (typeof query !== "string" || !query.trim()) {
    return new Response(
      JSON.stringify({
        errors: [{ message: "Missing required field: query." }],
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  if (utf8ByteLength(query) > GRAPHQL_MAX_QUERY_BYTES) {
    return graphqlError("GraphQL query is too large.", 413);
  }

  let document;
  try {
    document = parse(query);
  } catch (err) {
    return new Response(
      JSON.stringify({ errors: [{ message: err.message }] }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const validationErrors = validate(schema, document, [
    ...specifiedRules,
    maxDepthRule(GRAPHQL_MAX_DEPTH),
    maxComplexityRule(GRAPHQL_MAX_COMPLEXITY),
  ]);
  if (validationErrors.length > 0) {
    return new Response(
      JSON.stringify({
        errors: validationErrors.map((e) => ({
          message: e.message,
          extensions: e.extensions,
        })),
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const result = await execute({
    schema,
    document,
    rootValue,
    contextValue: { env, cache: new Map(), request },
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: graphqlHeaders({
      // A GraphQL error is a 200 with a populated `errors` array; never advertise
      // it as cacheable, or a fronting cache could pin a transient backend failure.
      "cache-control": result.errors?.length
        ? "no-store"
        : "public, max-age=60, stale-while-revalidate=300",
      vary: "Accept-Encoding",
    }),
  });
}
