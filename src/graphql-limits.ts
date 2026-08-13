// The GraphQL surface's request-shape limits and validation rules, extracted
// from src/graphql.ts so the ONE module that needs them at Durable Object
// construction time (workers/chain-firehose-hub.ts) can import them without
// paying for the whole schema module. src/graphql.ts's eager evaluation --
// the 312KB SDL, buildSchema, and every resolver wired at module scope -- was
// the largest single block of Worker startup CPU, and startup sat at the
// 400ms platform limit, failing deploys intermittently with code 10021
// (#10900). Everything here is pure over graphql-js's AST types: no schema,
// no resolvers, no SDL.
//
// src/graphql.ts re-exports all of it, so every pre-existing importer and
// test keeps working unchanged.
import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValidationContext,
} from "graphql";

export const GRAPHQL_MAX_DEPTH = 7;
export const GRAPHQL_MAX_COMPLEXITY = 50;
export const GRAPHQL_MAX_BODY_BYTES = 64 * 1024;
export const GRAPHQL_MAX_QUERY_BYTES = 16 * 1024;
export const GRAPHQL_SUBSCRIPTION_CONTEXT_KEY = "chainFirehose";

// Per-field weight against GRAPHQL_MAX_COMPLEXITY: read/fan-out fields cost more
// than scalars so the guard stays meaningful — one subnet with all its
// relationships fits, while greedily pulling many relationships across a page
// trips it. Keyed by field name; everything else defaults to 1.
export const DEFAULT_FIELD_COMPLEXITY = 1;
const RELATIONSHIP_FIELD_COMPLEXITY = 5;
// Live chain RPC (not the cached Postgres tier) -- costs more per-call than a
// relationship read, so it's weighted double.
const LIVE_RPC_FIELD_COMPLEXITY = 10;
export const FIELD_COMPLEXITY = {
  subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet: RELATIONSHIP_FIELD_COMPLEXITY,
  providers: RELATIONSHIP_FIELD_COMPLEXITY,
  provider: RELATIONSHIP_FIELD_COMPLEXITY,
  adapter: RELATIONSHIP_FIELD_COMPLEXITY,
  economics: RELATIONSHIP_FIELD_COMPLEXITY,
  surfaces: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  provider_endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoint_pools: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_pools: RELATIONSHIP_FIELD_COMPLEXITY,
  endpoint_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  source_snapshots: RELATIONSHIP_FIELD_COMPLEXITY,
  gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  block_extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  block_events: RELATIONSHIP_FIELD_COMPLEXITY,
  block_chain_events: RELATIONSHIP_FIELD_COMPLEXITY,
  profiles: RELATIONSHIP_FIELD_COMPLEXITY,
  review_adapter_candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_queue: RELATIONSHIP_FIELD_COMPLEXITY,
  review_enrichment_targets: RELATIONSHIP_FIELD_COMPLEXITY,
  review_gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  review_profile_completeness: RELATIONSHIP_FIELD_COMPLEXITY,
  registry_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  source_health: RELATIONSHIP_FIELD_COMPLEXITY,
  lineage: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  changelog: RELATIONSHIP_FIELD_COMPLEXITY,
  contracts: RELATIONSHIP_FIELD_COMPLEXITY,
  build: RELATIONSHIP_FIELD_COMPLEXITY,
  self_health: RELATIONSHIP_FIELD_COMPLEXITY,
  health_history: RELATIONSHIP_FIELD_COMPLEXITY,
  health: RELATIONSHIP_FIELD_COMPLEXITY,
  opportunity_boards: RELATIONSHIP_FIELD_COMPLEXITY,
  compare: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_events: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_events_stats: RELATIONSHIP_FIELD_COMPLEXITY,
  sudo: RELATIONSHIP_FIELD_COMPLEXITY,
  extrinsic: RELATIONSHIP_FIELD_COMPLEXITY,
  governance_config_changes: RELATIONSHIP_FIELD_COMPLEXITY,
  validators: RELATIONSHIP_FIELD_COMPLEXITY,
  validator: RELATIONSHIP_FIELD_COMPLEXITY,
  validator_history: RELATIONSHIP_FIELD_COMPLEXITY,
  accounts: RELATIONSHIP_FIELD_COMPLEXITY,
  account: RELATIONSHIP_FIELD_COMPLEXITY,
  account_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  account_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  account_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  account_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  account_identity: RELATIONSHIP_FIELD_COMPLEXITY,
  account_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  account_counterparties: RELATIONSHIP_FIELD_COMPLEXITY,
  account_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  account_extrinsics: RELATIONSHIP_FIELD_COMPLEXITY,
  account_events: RELATIONSHIP_FIELD_COMPLEXITY,
  account_history: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks: RELATIONSHIP_FIELD_COMPLEXITY,
  // A single latest-only row -- but it fans out into the full hyperparameter
  // block, so it is priced with the other per-subnet relationship fields.
  subnet_hyperparameters: RELATIONSHIP_FIELD_COMPLEXITY,
  // Paginated fan-out: one hyperparameter block per recorded change.
  subnet_hyperparameters_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_uptime: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health_percentiles: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_health: RELATIONSHIP_FIELD_COMPLEXITY,
  agent_resources: RELATIONSHIP_FIELD_COMPLEXITY,
  curation: RELATIONSHIP_FIELD_COMPLEXITY,
  candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  saved_query: RELATIONSHIP_FIELD_COMPLEXITY,
  fixtures: RELATIONSHIP_FIELD_COMPLEXITY,
  fixture: RELATIONSHIP_FIELD_COMPLEXITY,
  agent_catalog: RELATIONSHIP_FIELD_COMPLEXITY,
  freshness: RELATIONSHIP_FIELD_COMPLEXITY,
  top_holders: RELATIONSHIP_FIELD_COMPLEXITY,
  search: RELATIONSHIP_FIELD_COMPLEXITY,
  search_index: RELATIONSHIP_FIELD_COMPLEXITY,
  domains: RELATIONSHIP_FIELD_COMPLEXITY,
  domain_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  compare_validators: RELATIONSHIP_FIELD_COMPLEXITY,
  coverage: RELATIONSHIP_FIELD_COMPLEXITY,
  schemas: RELATIONSHIP_FIELD_COMPLEXITY,
  coverage_depth: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_volume: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_ohlc: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_quote: RELATIONSHIP_FIELD_COMPLEXITY,
  // Same tier as its siblings: one subnet's neuron rows plus a handful of
  // cached reads, not a fan-out.
  subnet_validator_economics: RELATIONSHIP_FIELD_COMPLEXITY,
  // A full cross-subnet scan, so it costs more than a single-subnet lookup.
  validator_economics: LIVE_RPC_FIELD_COMPLEXITY,
  subnet_validator_economics_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_validators: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_event_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_gaps: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_evidence: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_candidates: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_endpoints: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_idle_stake: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_events: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_yield_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_performance_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_concentration_history: RELATIONSHIP_FIELD_COMPLEXITY,
  // #9595: two D1 statements, both bounded -- the ranked page by `limit` and the
  // aggregate to a single row -- so it costs what its siblings do.
  subnet_holders: RELATIONSHIP_FIELD_COMPLEXITY,
  // #9607: one bounded statement over the same two tables.
  chain_holders: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_concentration_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_emission_pipeline_history: RELATIONSHIP_FIELD_COMPLEXITY,
  // #9615: one bounded union over three small append-only tables.
  emission_changes: RELATIONSHIP_FIELD_COMPLEXITY,
  failure_reasons: RELATIONSHIP_FIELD_COMPLEXITY,
  indexer_lag: RELATIONSHIP_FIELD_COMPLEXITY,
  // #9609: one bounded window read off an indexed column.
  tao_usd: RELATIONSHIP_FIELD_COMPLEXITY,
  // #9612: one indexed, bounded read of the registry history table.
  subnet_surface_history: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron: RELATIONSHIP_FIELD_COMPLEXITY,
  neuron_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_trajectory: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_metagraph: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_overview: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_profile: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_identity_history: RELATIONSHIP_FIELD_COMPLEXITY,
  incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  global_incidents: RELATIONSHIP_FIELD_COMPLEXITY,
  blocks_summary: RELATIONSHIP_FIELD_COMPLEXITY,
  runtime: RELATIONSHIP_FIELD_COMPLEXITY,
  block: RELATIONSHIP_FIELD_COMPLEXITY,
  economics_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  emission_pipeline: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_revenue: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_revenue_coverage: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_movers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_turnover: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_ownership_history: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_conviction: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_lease_history: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_calls: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_fees: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_activity: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weights: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_serving: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_deregistrations: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_registrations: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_axon_removals: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_signers: RELATIONSHIP_FIELD_COMPLEXITY,
  health_trends: RELATIONSHIP_FIELD_COMPLEXITY,
  rpc_usage: RELATIONSHIP_FIELD_COMPLEXITY,
  validator_nominators: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_performance: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_yield: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_concentration: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_alpha_volume: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_idle_stake: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_moves: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_stake_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_transfer_pairs: RELATIONSHIP_FIELD_COMPLEXITY,
  chain_transfers: RELATIONSHIP_FIELD_COMPLEXITY,
  account_prometheus: RELATIONSHIP_FIELD_COMPLEXITY,
  account_stake_flow: RELATIONSHIP_FIELD_COMPLEXITY,
  account_position_history: RELATIONSHIP_FIELD_COMPLEXITY,
  account_portfolio: RELATIONSHIP_FIELD_COMPLEXITY,
  account_positions: RELATIONSHIP_FIELD_COMPLEXITY,
  account_subnets: RELATIONSHIP_FIELD_COMPLEXITY,
  account_weight_setters: RELATIONSHIP_FIELD_COMPLEXITY,
  account_entities: RELATIONSHIP_FIELD_COMPLEXITY,
  // Fans out into leaderboardProfilesProjection plus several store reads and the
  // economics tier -- same cost class as the other relationship fields.
  registry_leaderboards: RELATIONSHIP_FIELD_COMPLEXITY,
  subnet_recycled: LIVE_RPC_FIELD_COMPLEXITY,
  subnet_burn: LIVE_RPC_FIELD_COMPLEXITY,
  subnet_lease: LIVE_RPC_FIELD_COMPLEXITY,
  account_balance: LIVE_RPC_FIELD_COMPLEXITY,
  account_root_claim: LIVE_RPC_FIELD_COMPLEXITY,
  account_children: LIVE_RPC_FIELD_COMPLEXITY,
  account_parents: LIVE_RPC_FIELD_COMPLEXITY,
  sudo_key: LIVE_RPC_FIELD_COMPLEXITY,
  network_parameters: LIVE_RPC_FIELD_COMPLEXITY,
  network_randomness: LIVE_RPC_FIELD_COMPLEXITY,
  randomness_status: LIVE_RPC_FIELD_COMPLEXITY,
  evm_address: LIVE_RPC_FIELD_COMPLEXITY,
  evm_address_mapping: LIVE_RPC_FIELD_COMPLEXITY,
};

function fieldComplexity(fieldName: string) {
  return (
    (FIELD_COMPLEXITY as Record<string, number>)[fieldName] ??
    DEFAULT_FIELD_COMPLEXITY
  );
}

// --- Validation rules ---

// The AST types below are graphql-js's own. They were `Row`, and `Row` was
// `Record<string, any>` -- so this whole walker read as typed while every
// `.kind`, `.selections` and `.name.value` was unchecked. A renamed AST field,
// or a wrong string in a `kind` comparison, would have compiled and silently
// measured every query as depth 0, disabling both limits (#10782).
function buildFragmentMap(documentNode: DocumentNode) {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of documentNode.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
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
function isIntrospectionRootField(sel: SelectionNode) {
  return (
    sel.kind === Kind.FIELD && INTROSPECTION_ROOT_FIELDS.has(sel.name.value)
  );
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
function selectionDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  visited: Set<string>,
  memo: Map<string, number>,
  max: number,
) {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: depth 0
    let depth = 0;
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          depth = memo.get(fragName)!;
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
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
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

export function maxDepthRule(max: number) {
  return (context: ValidationContext): ASTVisitor => ({
    Document: {
      leave(node: DocumentNode) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === Kind.OPERATION_DEFINITION) {
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

function selectionComplexity(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  visited: Set<string>,
  memo: Map<string, number>,
  max: number,
) {
  let count = 0;
  for (const sel of selectionSet.selections) {
    if (isIntrospectionRootField(sel)) continue; // schema-only: no complexity cost
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const fragName = sel.name.value;
      const frag = fragments.get(fragName);
      if (frag && !visited.has(fragName)) {
        if (memo.has(fragName)) {
          count += memo.get(fragName)!;
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
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
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

export function maxComplexityRule(max: number) {
  return (context: ValidationContext): ASTVisitor => ({
    Document: {
      leave(node: DocumentNode) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === Kind.OPERATION_DEFINITION) {
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

/**
 * Reject a netuid a subnet cannot have.
 *
 * TWENTY-EIGHT resolvers carried this check inline, character-identical, which
 * is why `validate-graphql-hand-written-checks` counted 247 BAD_USER_INPUT
 * throws in one file. `netuid` is a PATH parameter, so `resolveRouteArgs` --
 * which resolves a field's arguments against the route's QUERY schema -- never
 * sees it, and nothing parses it before a resolver runs. The check is real; it
 * did not need 28 copies.
 *
 * Lives here rather than in src/graphql.ts so the throw has ONE definition,
 * and so adding a subnet-scoped field costs no new hand-written check.
 */
export function assertNetuidArgument(netuid: unknown): void {
  if (!Number.isInteger(netuid) || (netuid as number) < 0) {
    throw new GraphQLError("netuid must be a non-negative integer.", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
}

/**
 * The same rule where the argument is OPTIONAL -- absent means "do not filter",
 * which is a different contract from "0". Two resolvers carried this variant
 * inline; splitting it from the required form keeps the distinction visible
 * rather than collapsing an absent filter into a subnet id.
 */
export function assertOptionalNetuidArgument(netuid: unknown): void {
  if (netuid == null) return;
  assertNetuidArgument(netuid);
}
