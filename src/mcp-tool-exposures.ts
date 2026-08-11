// Which OPERATION each MCP tool exposes (#10781).
//
// THE TOOL NAMES AN OPERATION ID, NOT A PATH. This map used to spell the route
// as a string, independently of the identical spelling in
// `schemas-src/graphql/query-exposures.ts` and of the route table itself -- one
// operation named three times, in three vocabularies, with nothing able to tell
// a typo from a rename. An id resolves through `OPERATIONS`, whose lookup
// throws on a miss, so a bad reference fails at load with the tool named.
//
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

export interface McpExposure {
  /**
   * The id of the operation this tool exposes -- a key into `OPERATIONS`,
   * resolved there, never a path.
   */
  operation: string | null;
  /** Why null. Required when `operation` is null, read by whoever asks "why". */
  reason?: string;
  /**
   * Further routes the same tool answers.
   *
   * Two tools genuinely serve a LIST form and a DETAIL form off one name --
   * `get_domain_summary` returns every domain without `domain` and one with
   * it, and `list_review_gaps` reads both gap feeds. Collapsing that to a
   * single route would make the other look agent-unreachable when it is not.
   */
  additionalOperations?: string[];
}

/** Every MCP tool, and the route it mirrors. */
export const MCP_EXPOSURES: Readonly<Record<string, McpExposure>> = {
  search_subnets: { operation: "search" },
  list_subnets: { operation: "subnets" },
  find_subnets_by_capability: { operation: "agent-catalog" },
  get_subnet: { operation: "subnet-profile" },
  get_subnet_detail: { operation: "subnet-detail" },
  get_subnet_snapshot: {
    operation: null,
    reason:
      "Composes five subnet routes in one round trip; no single route answers it.",
  },
  get_more_tools: {
    operation: null,
    reason:
      "Reports a capability this server lacks; it reads no data and has no " +
      "REST equivalent, because the caller is an MCP agent telling us what " +
      "the catalogue is missing rather than asking for anything.",
  },
  get_network_health: { operation: "health" },
  get_health_history: { operation: "health-history" },
  get_subnet_health: { operation: "subnet-health" },
  get_subnet_health_trends: { operation: "subnet-health-trends" },
  get_health_trends: { operation: "health-trends-bulk" },
  get_subnet_health_percentiles: {
    operation: "subnet-health-percentiles",
  },
  get_subnet_health_incidents: {
    operation: "subnet-health-incidents",
  },
  get_subnet_economics: { operation: "economics" },
  get_subnet_stake_quote: { operation: "subnet-stake-quote" },
  get_subnet_validator_economics: {
    operation: "subnet-validator-economics",
  },
  get_subnet_validator_economics_history: {
    operation: "subnet-validator-economics-history",
  },
  list_validator_economics: { operation: "validator-economics-ranking" },
  get_stake_action_preview: {
    operation: null,
    reason:
      "Computed from get_subnet_stake_quote's AMM math; publishes no artifact of its own.",
  },
  get_economics: { operation: "economics" },
  get_subnet_trajectory: { operation: "subnet-trajectory" },
  get_economics_trends: { operation: "economics-trends" },
  get_emission_pipeline: { operation: "emission-pipeline" },
  get_deregistration_ranking: {
    operation: "deregistration-ranking",
  },
  get_subnet_concentration: { operation: "subnet-concentration" },
  get_subnet_performance: { operation: "subnet-performance" },
  get_subnet_idle_stake: { operation: "subnet-idle-stake" },
  get_chain_concentration: { operation: "chain-concentration" },
  get_chain_concentration_subnets: {
    operation: "chain-concentration-subnets",
  },
  get_chain_performance: { operation: "chain-performance" },
  get_chain_idle_stake: { operation: "chain-idle-stake" },
  get_chain_identity_history: { operation: "chain-identity-history" },
  get_chain_yield: { operation: "chain-yield" },
  get_chain_turnover: { operation: "chain-turnover" },
  get_chain_stake_flow: { operation: "chain-stake-flow" },
  get_chain_alpha_volume: { operation: "chain-alpha-volume" },
  get_chain_weights: { operation: "chain-weights" },
  get_chain_weight_setters: { operation: "chain-weight-setters" },
  get_chain_stake_moves: { operation: "chain-stake-moves" },
  get_chain_stake_transfers: { operation: "chain-stake-transfers" },
  get_chain_axon_removals: { operation: "chain-axon-removals" },
  get_chain_serving: { operation: "chain-serving" },
  get_chain_prometheus: { operation: "chain-prometheus" },
  get_blocks_summary: { operation: "blocks-summary" },
  get_subnet_concentration_history: {
    operation: "subnet-concentration-history",
  },
  get_subnet_turnover: { operation: "subnet-turnover" },
  get_subnet_yield: { operation: "subnet-yield" },
  get_subnet_yield_history: { operation: "subnet-yield-history" },
  get_subnet_stake_flow: { operation: "subnet-stake-flow" },
  get_subnet_event_summary: { operation: "subnet-event-summary" },
  get_subnet_weights: { operation: "subnet-weights" },
  get_subnet_weight_setters: {
    operation: "subnet-weight-setters",
  },
  get_subnet_registrations: { operation: "subnet-registrations" },
  get_subnet_stake_moves: { operation: "subnet-stake-moves" },
  get_subnet_stake_transfers: {
    operation: "subnet-stake-transfers",
  },
  get_subnet_axon_removals: { operation: "subnet-axon-removals" },
  get_subnet_serving: { operation: "subnet-serving" },
  get_subnet_prometheus: { operation: "subnet-prometheus" },
  get_subnet_deregistrations: {
    operation: "subnet-deregistrations",
  },
  get_subnet_performance_history: {
    operation: "subnet-performance-history",
  },
  get_subnet_movers: { operation: "subnet-movers" },
  get_subnet_uptime: { operation: "subnet-uptime" },
  get_registry_leaderboards: { operation: "registry-leaderboards" },
  get_domain_summary: {
    operation: "domain-summary",
    additionalOperations: ["domains"],
  },
  list_profiles: { operation: "profiles" },
  get_subnet_profile: { operation: "subnet-profile" },
  compare_subnets: { operation: "compare" },
  get_global_incidents: { operation: "incidents" },
  get_subnet_metagraph: { operation: "subnet-metagraph" },
  list_subnet_validators: { operation: "subnet-validators" },
  list_global_validators: { operation: "global-validators" },
  get_validator_detail: { operation: "validator-detail" },
  compare_validators: { operation: "compare-validators" },
  get_webhook_subscription: {
    operation: "webhook-subscription",
  },
  get_alert_trigger: { operation: "alert-trigger" },
  get_validator_nominators: { operation: "validator-nominators" },
  get_validator_history: { operation: "validator-history" },
  get_neuron: { operation: "subnet-neuron" },
  get_subnet_history: { operation: "subnet-history" },
  get_subnet_identity_history: {
    operation: "subnet-identity-history",
  },
  get_neuron_history: {
    operation: "subnet-neuron-history",
  },
  get_subnet_events: { operation: "subnet-events" },
  get_subnet_hyperparams: { operation: "subnet-hyperparameters" },
  get_subnet_hyperparams_history: {
    operation: "subnet-hyperparameters-history",
  },
  get_subnet_lifecycle: { operation: "subnet-lifecycle" },
  get_chain_subnet_lifecycle: { operation: "chain-subnet-lifecycle" },
  get_subnet_volume: { operation: "subnet-alpha-volume" },
  get_subnet_ohlc: { operation: "subnet-ohlc" },
  get_subnet_ownership_history: {
    operation: "subnet-ownership-history",
  },
  get_subnet_conviction: { operation: "subnet-conviction" },
  get_subnet_recycled: { operation: "subnet-recycled" },
  get_subnet_wallets: { operation: "subnet-wallets" },
  get_subnet_owner_cut: { operation: "subnet-owner-cut" },
  get_subnet_revenue: { operation: "subnet-revenue" },
  list_revenue_coverage: { operation: "chain-revenue-coverage" },
  get_subnet_burn: { operation: "subnet-burn" },
  get_subnet_burn_history: { operation: "subnet-burn-history" },
  get_tao_usd: { operation: "tao-usd" },
  get_subnet_surface_history: {
    operation: "subnet-surface-history",
  },
  get_emission_changes: { operation: "emission-gate-changes" },
  get_chain_holders: { operation: "chain-holders" },
  get_failure_reasons: { operation: "failure-reasons" },
  get_indexer_lag: { operation: "indexer-lag" },
  get_chain_concentration_history: {
    operation: "chain-concentration-history",
  },
  get_emission_pipeline_history: {
    operation: "subnet-emission-pipeline-history",
  },
  get_subnet_holders: { operation: "subnet-holders" },
  get_chain_burn: { operation: "chain-burn" },
  list_crowdloans: { operation: "crowdloans" },
  get_crowdloan: { operation: "crowdloan-detail" },
  get_subnet_lease: { operation: "subnet-lease" },
  get_subnet_lease_history: { operation: "subnet-lease-history" },
  get_account: { operation: "account-summary" },
  get_account_entities: { operation: "account-entities" },
  get_account_balance: { operation: "account-balance" },
  get_account_root_claim: { operation: "account-root-claim" },
  get_account_children: { operation: "account-children" },
  get_account_parents: { operation: "account-parents" },
  get_account_events: { operation: "account-events" },
  get_account_subnets: { operation: "account-subnets" },
  get_account_portfolio: { operation: "account-portfolio" },
  get_account_positions: { operation: "account-positions" },
  get_account_snapshot: {
    operation: null,
    reason:
      "Composes five account routes in one round trip; no single route answers it.",
  },
  get_account_identity: { operation: "account-identity" },
  get_account_identity_history: {
    operation: "account-identity-history",
  },
  get_account_position_history: {
    operation: "account-subnet-position-history",
  },
  get_account_stake_flow: { operation: "account-stake-flow" },
  get_account_stake_moves: { operation: "account-stake-moves" },
  get_account_axon_removals: { operation: "account-axon-removals" },
  get_account_prometheus: { operation: "account-prometheus" },
  get_account_registrations: { operation: "account-registrations" },
  get_account_weight_setters: {
    operation: "account-weight-setters",
  },
  get_account_serving: { operation: "account-serving" },
  get_account_deregistrations: {
    operation: "account-deregistrations",
  },
  get_account_history: { operation: "account-history" },
  get_account_extrinsics: { operation: "account-extrinsics" },
  get_account_transfers: { operation: "account-transfers" },
  get_account_counterparties: {
    operation: "account-counterparties",
  },
  list_blocks: { operation: "blocks-feed" },
  get_block: { operation: "block-detail" },
  list_block_extrinsics: { operation: "block-extrinsics" },
  get_block_events: { operation: "block-events" },
  list_extrinsics: { operation: "extrinsics-feed" },
  get_extrinsic: { operation: "extrinsic-detail" },
  get_sudo: { operation: "sudo-calls" },
  get_sudo_key: { operation: "sudo-key" },
  get_network_parameters: { operation: "network-parameters" },
  get_randomness_status: { operation: "randomness" },
  get_governance_config_changes: { operation: "governance-config-changes" },
  get_networks: { operation: "network-capabilities" },
  get_runtime: { operation: "runtime-versions" },
  list_accounts: { operation: "accounts-list" },
  get_top_holders: { operation: "top-holders" },
  get_block_chain_events: { operation: "block-chain-events" },
  get_extrinsic_chain_events: { operation: "chain-events-feed" },
  get_chain_activity: { operation: "chain-events-stats" },
  list_chain_events: { operation: "chain-events-feed" },
  get_chain_calls: { operation: "chain-calls" },
  get_chain_signers: { operation: "chain-signers" },
  get_chain_fees: { operation: "chain-fees" },
  get_chain_registrations: { operation: "chain-registrations" },
  get_chain_deregistrations: { operation: "chain-deregistrations" },
  get_chain_transfers: { operation: "chain-transfers" },
  get_chain_transfer_pairs: { operation: "chain-transfer-pairs" },
  get_network_activity: { operation: "chain-activity" },
  list_subnet_apis: { operation: "agent-catalog-subnet" },
  get_api_schema: { operation: "schemas" },
  get_fixture: { operation: "fixture-detail" },
  get_provider_detail: { operation: "provider-detail" },
  list_providers: { operation: "providers" },
  list_surfaces: { operation: "surfaces" },
  list_candidates: { operation: "candidates" },
  list_endpoints: { operation: "endpoints" },
  list_evidence: { operation: "evidence" },
  list_rpc_endpoints: { operation: "rpc-endpoints" },
  list_source_snapshots: { operation: "source-snapshots" },
  list_profile_completeness: { operation: "review-profile-completeness" },
  list_rpc_pools: { operation: "rpc-pools" },
  get_subnet_endpoints: { operation: "subnet-endpoints" },
  list_subnet_endpoints: { operation: "subnet-endpoints" },
  list_subnet_surfaces: { operation: "subnet-surfaces" },
  list_subnet_health: { operation: "subnet-health" },
  get_subnet_candidates: { operation: "subnet-candidates" },
  list_subnet_candidates: { operation: "subnet-candidates" },
  get_subnet_evidence: { operation: "subnet-evidence" },
  list_subnet_evidence: { operation: "subnet-evidence" },
  get_subnet_surfaces: { operation: "subnet-surfaces" },
  list_fixtures: { operation: "fixtures" },
  list_schemas: { operation: "schemas" },
  list_search_index: { operation: "search-index" },
  list_search: { operation: "search" },
  list_curation: { operation: "curation" },
  list_gaps: { operation: "gaps" },
  list_enrichment_queue: { operation: "review-enrichment-queue" },
  list_adapter_candidates: { operation: "review-adapter-candidates" },
  list_enrichment_evidence: { operation: "review-enrichment-evidence" },
  list_review_gaps: {
    operation: "gaps",
    additionalOperations: ["review-gaps"],
  },
  list_review_enrichment_targets: {
    operation: "review-enrichment-targets",
  },
  list_endpoint_pools: { operation: "endpoint-pools" },
  list_endpoint_incidents: { operation: "endpoint-incidents" },
  list_provider_endpoints: { operation: "provider-endpoints" },
  get_lineage: { operation: "lineage" },
  get_freshness: { operation: "freshness" },
  get_contracts: { operation: "contracts" },
  get_source_health: { operation: "source-health" },
  get_changelog: { operation: "changelog" },
  get_feed: {
    operation: "feed-registry",
    // `kind` selects the feed, so ONE tool serves five feed operations
    // (FEED_KINDS in schemas-src/mcp-tools/feed.ts). Naming only the registry
    // feed left the other four reading as agent-unreachable when a caller
    // reaches them by passing `kind` (#10781).
    additionalOperations: [
      "feed-incidents",
      "feed-gaps",
      "feed-upgrades",
      "feed-subnet",
    ],
  },
  get_build: { operation: "build" },
  get_self_health: { operation: "self-health" },
  get_adapter: { operation: "adapter" },
  get_agent_catalog: { operation: "agent-catalog" },
  get_agent_resources: { operation: "agent-resources" },
  get_rpc_usage: { operation: "rpc-usage" },
  get_best_rpc_endpoint: { operation: "rpc-pools" },
  call_rpc: {
    operation: null,
    reason:
      "A read-only proxy to an allowlisted Substrate JSON-RPC method, not a registry read.",
  },
  query_graphql: {
    operation: null,
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
  registry_summary: { operation: "registry-summary" },
  get_coverage: { operation: "coverage" },
  get_coverage_depth: { operation: "coverage-depth" },
  list_enrichment_targets: { operation: "coverage-depth" },
  get_subnet_gaps: { operation: "subnet-gaps" },
  list_subnet_gaps: { operation: "subnet-gaps" },
  find_subnet_opportunities: { operation: "economics" },
  semantic_search: { operation: "search-semantic" },
  ask: { operation: "ask" },
  find_subnet_for_task: { operation: "agent-catalog" },
  how_do_i_call: { operation: "agent-catalog-subnet" },
  verify_integration: { operation: "surface-verify" },
  call_subnet_surface: {
    operation: null,
    reason:
      "Calls a catalogued third-party surface and returns ITS body; the shape is the subnet's, not ours.",
  },
  store_surface_credential: {
    operation: null,
    reason:
      "Writes to the authenticated per-identity credential store; there is no public route and there should not be.",
  },
  list_surface_credentials: {
    operation: null,
    reason: "Reads the authenticated credential store; no public route.",
  },
  delete_surface_credential: {
    operation: null,
    reason: "Deletes from the authenticated credential store; no public route.",
  },
  run_saved_query: {
    operation: null,
    reason:
      "SERVED at /api/v1/queries/{id} but absent from openapi.json -- see #9967. " +
      "The other paths in its description (/api/v1/registry/leaderboards, " +
      "/api/v1/chain/registrations) are EXAMPLES of what a saved query reads, " +
      "not routes this tool mirrors -- resolving from prose alone picked one of " +
      "those, which is why the map is hand-checked rather than generated.",
  },
  decode_evm_call: {
    operation: null,
    reason:
      "A pure function over calldata against the fixed EVM precompile registry; touches no route.",
  },
  get_evm_address_mapping: { operation: "evm-address-mapping" },
};
