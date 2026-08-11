// Which API route each MCP tool mirrors (#9880).
//
// WHY A DECLARATION AND NOT A HEURISTIC. Deriving tool names from route paths
// was tried and abandoned: it reported /api/v1/self-health, /api/v1/build,
// /api/v1/coverage, /api/v1/changelog and /api/v1/validators as uncovered when
// get_self_health, get_build, get_coverage, get_changelog and
// list_global_validators all exist. The naming is regular enough to tempt a
// heuristic and irregular enough that one cannot be trusted -- `list_` vs
// `get_`, singular vs plural, and tools whose name shares no token with their
// path.
//
// `route: null` IS A CLASSIFICATION, NOT AN OMISSION, and it carries a reason
// -- exactly as TABLE_FRESHNESS treats `maxAgeMs: null`. `ask`,
// `call_subnet_surface` and `decode_evm_call` genuinely mirror no route.
// The test beside this file fails on a tool that is ABSENT, so every tool must
// be classified.
//
// NETWORK-ADDRESSED FORMS ARE NOT LISTED SEPARATELY. Every one of the 42
// `/api/v1/{network}/X` paths has a plain `/api/v1/X` twin (verified: zero
// orphans), because they are the same handler behind a network prefix. The map
// names the plain form and the gate derives the twin.
//
// HOW EACH ENTRY WAS RESOLVED, in order of preference: the route named in the
// tool's own description (181 tools); the route whose published component the
// tool's outputSchema is derived from, resolved through openapi.json's
// `responses.200.…data.$ref` and schemas-src/openapi-registry.ts (4); and
// hand-classification against openapi.json for the rest (40). Nothing here was
// guessed from a filename -- that mistake cost a wrong "not derivable" verdict
// earlier in this epic.

export interface McpToolRoute {
  /** The plain (non-network-prefixed) route path, or null. */
  route: string | null;
  /** Why null. Required when route is null, read by whoever asks "why". */
  reason?: string;
  /**
   * Further routes the same tool answers.
   *
   * Two tools genuinely serve a LIST form and a DETAIL form off one name --
   * `get_domain_summary` returns every domain without `domain` and one with
   * it, and `list_review_gaps` reads both gap feeds. Collapsing that to a
   * single route would make the other look agent-unreachable when it is not.
   */
  additionalRoutes?: string[];
}

/** Every MCP tool, and the route it mirrors. */
export const MCP_TOOL_ROUTES: Readonly<Record<string, McpToolRoute>> = {
  search_subnets: { route: "/api/v1/search" },
  list_subnets: { route: "/api/v1/subnets" },
  find_subnets_by_capability: { route: "/api/v1/agent-catalog" },
  get_subnet: { route: "/api/v1/subnets/{netuid}/profile" },
  get_subnet_detail: { route: "/api/v1/subnets/{netuid}" },
  get_subnet_snapshot: {
    route: null,
    reason:
      "Composes five subnet routes in one round trip; no single route answers it.",
  },
  get_network_health: { route: "/api/v1/health" },
  get_health_history: { route: "/api/v1/health/history/{date}" },
  get_subnet_health: { route: "/api/v1/subnets/{netuid}/health" },
  get_subnet_health_trends: { route: "/api/v1/subnets/{netuid}/health/trends" },
  get_health_trends: { route: "/api/v1/health/trends" },
  get_subnet_health_percentiles: {
    route: "/api/v1/subnets/{netuid}/health/percentiles",
  },
  get_subnet_health_incidents: {
    route: "/api/v1/subnets/{netuid}/health/incidents",
  },
  get_subnet_economics: { route: "/api/v1/economics" },
  get_subnet_stake_quote: { route: "/api/v1/subnets/{netuid}/stake-quote" },
  get_subnet_validator_economics: {
    route: "/api/v1/subnets/{netuid}/validator-economics",
  },
  get_subnet_validator_economics_history: {
    route: "/api/v1/subnets/{netuid}/validator-economics/history",
  },
  list_validator_economics: { route: "/api/v1/validators/economics" },
  get_stake_action_preview: {
    route: null,
    reason:
      "Computed from get_subnet_stake_quote's AMM math; publishes no artifact of its own.",
  },
  get_economics: { route: "/api/v1/economics" },
  get_subnet_trajectory: { route: "/api/v1/subnets/{netuid}/trajectory" },
  get_economics_trends: { route: "/api/v1/economics/trends" },
  get_emission_pipeline: { route: "/api/v1/chain/emission-pipeline" },
  get_deregistration_ranking: {
    route: "/api/v1/chain/deregistration-ranking",
  },
  get_subnet_concentration: { route: "/api/v1/subnets/{netuid}/concentration" },
  get_subnet_performance: { route: "/api/v1/subnets/{netuid}/performance" },
  get_subnet_idle_stake: { route: "/api/v1/subnets/{netuid}/idle-stake" },
  get_chain_concentration: { route: "/api/v1/chain/concentration" },
  get_chain_concentration_subnets: {
    route: "/api/v1/chain/concentration/subnets",
  },
  get_chain_performance: { route: "/api/v1/chain/performance" },
  get_chain_idle_stake: { route: "/api/v1/chain/idle-stake" },
  get_chain_identity_history: { route: "/api/v1/chain/identity-history" },
  get_chain_yield: { route: "/api/v1/chain/yield" },
  get_chain_turnover: { route: "/api/v1/chain/turnover" },
  get_chain_stake_flow: { route: "/api/v1/chain/stake-flow" },
  get_chain_alpha_volume: { route: "/api/v1/chain/alpha-volume" },
  get_chain_weights: { route: "/api/v1/chain/weights" },
  get_chain_weight_setters: { route: "/api/v1/chain/weights/setters" },
  get_chain_stake_moves: { route: "/api/v1/chain/stake-moves" },
  get_chain_stake_transfers: { route: "/api/v1/chain/stake-transfers" },
  get_chain_axon_removals: { route: "/api/v1/chain/axon-removals" },
  get_chain_serving: { route: "/api/v1/chain/serving" },
  get_chain_prometheus: { route: "/api/v1/chain/prometheus" },
  get_blocks_summary: { route: "/api/v1/blocks/summary" },
  get_subnet_concentration_history: {
    route: "/api/v1/subnets/{netuid}/concentration/history",
  },
  get_subnet_turnover: { route: "/api/v1/subnets/{netuid}/turnover" },
  get_subnet_yield: { route: "/api/v1/subnets/{netuid}/yield" },
  get_subnet_yield_history: { route: "/api/v1/subnets/{netuid}/yield/history" },
  get_subnet_stake_flow: { route: "/api/v1/subnets/{netuid}/stake-flow" },
  get_subnet_event_summary: { route: "/api/v1/subnets/{netuid}/event-summary" },
  get_subnet_weights: { route: "/api/v1/subnets/{netuid}/weights" },
  get_subnet_weight_setters: {
    route: "/api/v1/subnets/{netuid}/weights/setters",
  },
  get_subnet_registrations: { route: "/api/v1/subnets/{netuid}/registrations" },
  get_subnet_stake_moves: { route: "/api/v1/subnets/{netuid}/stake-moves" },
  get_subnet_stake_transfers: {
    route: "/api/v1/subnets/{netuid}/stake-transfers",
  },
  get_subnet_axon_removals: { route: "/api/v1/subnets/{netuid}/axon-removals" },
  get_subnet_serving: { route: "/api/v1/subnets/{netuid}/serving" },
  get_subnet_prometheus: { route: "/api/v1/subnets/{netuid}/prometheus" },
  get_subnet_deregistrations: {
    route: "/api/v1/subnets/{netuid}/deregistrations",
  },
  get_subnet_performance_history: {
    route: "/api/v1/subnets/{netuid}/performance/history",
  },
  get_subnet_movers: { route: "/api/v1/subnets/movers" },
  get_subnet_uptime: { route: "/api/v1/subnets/{netuid}/uptime" },
  get_registry_leaderboards: { route: "/api/v1/registry/leaderboards" },
  get_domain_summary: {
    route: "/api/v1/domains/{tag}/summary",
    additionalRoutes: ["/api/v1/domains"],
  },
  list_profiles: { route: "/api/v1/profiles" },
  get_subnet_profile: { route: "/api/v1/subnets/{netuid}/profile" },
  compare_subnets: { route: "/api/v1/compare" },
  get_global_incidents: { route: "/api/v1/incidents" },
  get_subnet_metagraph: { route: "/api/v1/subnets/{netuid}/metagraph" },
  list_subnet_validators: { route: "/api/v1/subnets/{netuid}/validators" },
  list_global_validators: { route: "/api/v1/validators" },
  get_validator_detail: { route: "/api/v1/validators/{hotkey}" },
  compare_validators: { route: "/api/v1/compare/validators" },
  get_webhook_subscription: {
    route: "/api/v1/webhooks/subscriptions/{id}",
  },
  get_alert_trigger: { route: "/api/v1/alerts/triggers/{id}" },
  get_validator_nominators: { route: "/api/v1/validators/{hotkey}/nominators" },
  get_validator_history: { route: "/api/v1/validators/{hotkey}/history" },
  get_neuron: { route: "/api/v1/subnets/{netuid}/neurons/{uid}" },
  get_subnet_history: { route: "/api/v1/subnets/{netuid}/history" },
  get_subnet_identity_history: {
    route: "/api/v1/subnets/{netuid}/identity-history",
  },
  get_neuron_history: {
    route: "/api/v1/subnets/{netuid}/neurons/{uid}/history",
  },
  get_subnet_events: { route: "/api/v1/subnets/{netuid}/events" },
  get_subnet_hyperparams: { route: "/api/v1/subnets/{netuid}/hyperparameters" },
  get_subnet_hyperparams_history: {
    route: "/api/v1/subnets/{netuid}/hyperparameters/history",
  },
  get_subnet_lifecycle: { route: "/api/v1/subnets/{netuid}/lifecycle" },
  get_chain_subnet_lifecycle: { route: "/api/v1/chain/subnet-lifecycle" },
  get_subnet_volume: { route: "/api/v1/subnets/{netuid}/volume" },
  get_subnet_ohlc: { route: "/api/v1/subnets/{netuid}/ohlc" },
  get_subnet_ownership_history: {
    route: "/api/v1/subnets/{netuid}/ownership-history",
  },
  get_subnet_conviction: { route: "/api/v1/subnets/{netuid}/conviction" },
  get_subnet_recycled: { route: "/api/v1/subnets/{netuid}/recycled" },
  get_subnet_wallets: { route: "/api/v1/subnets/{netuid}/wallets" },
  get_subnet_owner_cut: { route: "/api/v1/subnets/{netuid}/owner-cut" },
  get_subnet_revenue: { route: "/api/v1/subnets/{netuid}/revenue" },
  list_revenue_coverage: { route: "/api/v1/chain/revenue-coverage" },
  get_subnet_burn: { route: "/api/v1/subnets/{netuid}/burn" },
  get_subnet_burn_history: { route: "/api/v1/subnets/{netuid}/burn/history" },
  get_tao_usd: { route: "/api/v1/network/tao-usd" },
  get_subnet_surface_history: {
    route: "/api/v1/subnets/{netuid}/surface-history",
  },
  get_emission_changes: { route: "/api/v1/chain/governance/emission-changes" },
  get_chain_holders: { route: "/api/v1/chain/holders" },
  get_failure_reasons: { route: "/api/v1/health/failure-reasons" },
  get_indexer_lag: { route: "/api/v1/chain/indexer-lag" },
  get_chain_concentration_history: {
    route: "/api/v1/chain/concentration/history",
  },
  get_emission_pipeline_history: {
    route: "/api/v1/subnets/{netuid}/emission-pipeline/history",
  },
  get_subnet_holders: { route: "/api/v1/subnets/{netuid}/holders" },
  get_chain_burn: { route: "/api/v1/chain/burn" },
  list_crowdloans: { route: "/api/v1/crowdloans" },
  get_crowdloan: { route: "/api/v1/crowdloans/{crowdloan_id}" },
  get_subnet_lease: { route: "/api/v1/subnets/{netuid}/lease" },
  get_subnet_lease_history: { route: "/api/v1/subnets/{netuid}/lease/history" },
  get_account: { route: "/api/v1/accounts/{ss58}" },
  get_account_entities: { route: "/api/v1/accounts/{ss58}/entities" },
  get_account_balance: { route: "/api/v1/accounts/{ss58}/balance" },
  get_account_root_claim: { route: "/api/v1/accounts/{ss58}/root-claim" },
  get_account_children: { route: "/api/v1/accounts/{ss58}/children" },
  get_account_parents: { route: "/api/v1/accounts/{ss58}/parents" },
  get_account_events: { route: "/api/v1/accounts/{ss58}/events" },
  get_account_subnets: { route: "/api/v1/accounts/{ss58}/subnets" },
  get_account_portfolio: { route: "/api/v1/accounts/{ss58}/portfolio" },
  get_account_positions: { route: "/api/v1/accounts/{ss58}/positions" },
  get_account_snapshot: {
    route: null,
    reason:
      "Composes five account routes in one round trip; no single route answers it.",
  },
  get_account_identity: { route: "/api/v1/accounts/{ss58}/identity" },
  get_account_identity_history: {
    route: "/api/v1/accounts/{ss58}/identity-history",
  },
  get_account_position_history: {
    route: "/api/v1/accounts/{ss58}/subnets/{netuid}/history",
  },
  get_account_stake_flow: { route: "/api/v1/accounts/{ss58}/stake-flow" },
  get_account_stake_moves: { route: "/api/v1/accounts/{ss58}/stake-moves" },
  get_account_axon_removals: { route: "/api/v1/accounts/{ss58}/axon-removals" },
  get_account_prometheus: { route: "/api/v1/accounts/{ss58}/prometheus" },
  get_account_registrations: { route: "/api/v1/accounts/{ss58}/registrations" },
  get_account_weight_setters: {
    route: "/api/v1/accounts/{ss58}/weight-setters",
  },
  get_account_serving: { route: "/api/v1/accounts/{ss58}/serving" },
  get_account_deregistrations: {
    route: "/api/v1/accounts/{ss58}/deregistrations",
  },
  get_account_history: { route: "/api/v1/accounts/{ss58}/history" },
  get_account_extrinsics: { route: "/api/v1/accounts/{ss58}/extrinsics" },
  get_account_transfers: { route: "/api/v1/accounts/{ss58}/transfers" },
  get_account_counterparties: {
    route: "/api/v1/accounts/{ss58}/counterparties",
  },
  list_blocks: { route: "/api/v1/blocks" },
  get_block: { route: "/api/v1/blocks/{ref}" },
  list_block_extrinsics: { route: "/api/v1/blocks/{ref}/extrinsics" },
  get_block_events: { route: "/api/v1/blocks/{ref}/events" },
  list_extrinsics: { route: "/api/v1/extrinsics" },
  get_extrinsic: { route: "/api/v1/extrinsics/{hash}" },
  get_sudo: { route: "/api/v1/sudo" },
  get_sudo_key: { route: "/api/v1/sudo/key" },
  get_network_parameters: { route: "/api/v1/network/parameters" },
  get_randomness_status: { route: "/api/v1/network/randomness" },
  get_governance_config_changes: { route: "/api/v1/governance/config-changes" },
  get_networks: { route: "/api/v1/networks" },
  get_runtime: { route: "/api/v1/runtime" },
  list_accounts: { route: "/api/v1/accounts" },
  get_top_holders: { route: "/api/v1/accounts/top-holders" },
  get_block_chain_events: { route: "/api/v1/blocks/{ref}/chain-events" },
  get_extrinsic_chain_events: { route: "/api/v1/chain-events" },
  get_chain_activity: { route: "/api/v1/chain-events/stats" },
  list_chain_events: { route: "/api/v1/chain-events" },
  get_chain_calls: { route: "/api/v1/chain/calls" },
  get_chain_signers: { route: "/api/v1/chain/signers" },
  get_chain_fees: { route: "/api/v1/chain/fees" },
  get_chain_registrations: { route: "/api/v1/chain/registrations" },
  get_chain_deregistrations: { route: "/api/v1/chain/deregistrations" },
  get_chain_transfers: { route: "/api/v1/chain/transfers" },
  get_chain_transfer_pairs: { route: "/api/v1/chain/transfer-pairs" },
  get_network_activity: { route: "/api/v1/chain/activity" },
  list_subnet_apis: { route: "/api/v1/agent-catalog/{netuid}" },
  get_api_schema: { route: "/api/v1/schemas" },
  get_fixture: { route: "/api/v1/fixtures/{surface_id}" },
  get_provider_detail: { route: "/api/v1/providers/{slug}" },
  list_providers: { route: "/api/v1/providers" },
  list_surfaces: { route: "/api/v1/surfaces" },
  list_candidates: { route: "/api/v1/candidates" },
  list_endpoints: { route: "/api/v1/endpoints" },
  list_evidence: { route: "/api/v1/evidence" },
  list_rpc_endpoints: { route: "/api/v1/rpc/endpoints" },
  list_source_snapshots: { route: "/api/v1/source-snapshots" },
  list_profile_completeness: { route: "/api/v1/review/profile-completeness" },
  list_rpc_pools: { route: "/api/v1/rpc/pools" },
  get_subnet_endpoints: { route: "/api/v1/subnets/{netuid}/endpoints" },
  list_subnet_endpoints: { route: "/api/v1/subnets/{netuid}/endpoints" },
  list_subnet_surfaces: { route: "/api/v1/subnets/{netuid}/surfaces" },
  list_subnet_health: { route: "/api/v1/subnets/{netuid}/health" },
  get_subnet_candidates: { route: "/api/v1/subnets/{netuid}/candidates" },
  list_subnet_candidates: { route: "/api/v1/subnets/{netuid}/candidates" },
  get_subnet_evidence: { route: "/api/v1/subnets/{netuid}/evidence" },
  list_subnet_evidence: { route: "/api/v1/subnets/{netuid}/evidence" },
  get_subnet_surfaces: { route: "/api/v1/subnets/{netuid}/surfaces" },
  list_fixtures: { route: "/api/v1/fixtures" },
  list_schemas: { route: "/api/v1/schemas" },
  list_search_index: { route: "/api/v1/search-index" },
  list_search: { route: "/api/v1/search" },
  list_curation: { route: "/api/v1/curation" },
  list_gaps: { route: "/api/v1/gaps" },
  list_enrichment_queue: { route: "/api/v1/review/enrichment-queue" },
  list_adapter_candidates: { route: "/api/v1/review/adapter-candidates" },
  list_enrichment_evidence: { route: "/api/v1/review/enrichment-evidence" },
  list_review_gaps: {
    route: "/api/v1/gaps",
    additionalRoutes: ["/api/v1/review/gaps"],
  },
  list_review_enrichment_targets: {
    route: "/api/v1/review/enrichment-targets",
  },
  list_endpoint_pools: { route: "/api/v1/endpoint-pools" },
  list_endpoint_incidents: { route: "/api/v1/endpoint-incidents" },
  list_provider_endpoints: { route: "/api/v1/providers/{slug}/endpoints" },
  get_lineage: { route: "/api/v1/lineage" },
  get_freshness: { route: "/api/v1/freshness" },
  get_contracts: { route: "/api/v1/contracts" },
  get_source_health: { route: "/api/v1/source-health" },
  get_changelog: { route: "/api/v1/changelog" },
  get_feed: { route: "/api/v1/feeds/registry" },
  get_build: { route: "/api/v1/build" },
  get_self_health: { route: "/api/v1/self-health" },
  get_adapter: { route: "/api/v1/adapters/{slug}" },
  get_agent_catalog: { route: "/api/v1/agent-catalog" },
  get_agent_resources: { route: "/api/v1/agent-resources" },
  get_rpc_usage: { route: "/api/v1/rpc/usage" },
  get_best_rpc_endpoint: { route: "/api/v1/rpc/pools" },
  call_rpc: {
    route: null,
    reason:
      "A read-only proxy to an allowlisted Substrate JSON-RPC method, not a registry read.",
  },
  query_graphql: {
    route: null,
    // NOT a gap, and #9967 settled it on evidence rather than leaving the
    // question open. /api/v1/graphql answers with
    // `content-type: application/graphql-response+json` and a bare
    // `{ data, errors }` -- the GraphQL-over-HTTP protocol, not this
    // contract's `{ ok, schema_version, data }` envelope, and with neither an
    // ETag nor a contract-version header. Modelling it as a REST route would
    // publish a response shape production does not serve. Its schema is
    // introspectable through the endpoint itself, which is the document that
    // actually describes it.
    reason:
      "Speaks GraphQL-over-HTTP (application/graphql-response+json), not this contract's envelope; described by its own introspectable schema rather than by openapi.json.",
  },
  registry_summary: { route: "/api/v1/registry/summary" },
  get_coverage: { route: "/api/v1/coverage" },
  get_coverage_depth: { route: "/api/v1/coverage-depth" },
  list_enrichment_targets: { route: "/api/v1/coverage-depth" },
  get_subnet_gaps: { route: "/api/v1/subnets/{netuid}/gaps" },
  list_subnet_gaps: { route: "/api/v1/subnets/{netuid}/gaps" },
  find_subnet_opportunities: { route: "/api/v1/economics" },
  semantic_search: { route: "/api/v1/search/semantic" },
  ask: { route: "/api/v1/ask" },
  find_subnet_for_task: { route: "/api/v1/agent-catalog" },
  how_do_i_call: { route: "/api/v1/agent-catalog/{netuid}" },
  verify_integration: { route: "/api/v1/surfaces/{surface_id}/verify" },
  call_subnet_surface: {
    route: null,
    reason:
      "Calls a catalogued third-party surface and returns ITS body; the shape is the subnet's, not ours.",
  },
  store_surface_credential: {
    route: null,
    reason:
      "Writes to the authenticated per-identity credential store; there is no public route and there should not be.",
  },
  list_surface_credentials: {
    route: null,
    reason: "Reads the authenticated credential store; no public route.",
  },
  delete_surface_credential: {
    route: null,
    reason: "Deletes from the authenticated credential store; no public route.",
  },
  run_saved_query: {
    route: null,
    reason:
      "SERVED at /api/v1/queries/{id} but absent from openapi.json -- see #9967. " +
      "The other paths in its description (/api/v1/registry/leaderboards, " +
      "/api/v1/chain/registrations) are EXAMPLES of what a saved query reads, " +
      "not routes this tool mirrors -- resolving from prose alone picked one of " +
      "those, which is why the map is hand-checked rather than generated.",
  },
  decode_evm_call: {
    route: null,
    reason:
      "A pure function over calldata against the fixed EVM precompile registry; touches no route.",
  },
  get_evm_address_mapping: { route: "/api/v1/evm/address/{h160}" },
};
