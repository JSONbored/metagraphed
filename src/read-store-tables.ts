// What each shared loader reads, so its callers can ask readStore for the right
// store (#10155).
//
// ## Why these live here and not beside each loader
//
// Twenty-two loaders are called from `src/mcp-server.ts`, `src/graphql.ts` and
// `workers/request-handlers/entities.ts` -- 45 call sites for 22 loaders, so
// most sets are needed in two or three files. The loaders themselves take an
// injected `db` and have no opinion about which store it is; that is the whole
// reason they are shared. Putting the answer next to each loader would mean 22
// new exports whose only consumer is this indirection, and putting it inline at
// each call site would mean the same set written out three times, drifting
// independently.
//
// ## What keeps them honest
//
// tests/read-store-tables-match-the-sql.test.ts reads each loader's module and
// checks the constant against the SQL actually in it. That is the property
// co-location would have bought, without the 22 exports: a loader that grows a
// JOIN fails the test rather than quietly reading a table its caller never
// declared. readStore is all-or-nothing, so an under-declared set is not a
// smaller check -- it sends the loader to Neon on the strength of the tables it
// DID name, and the missing one comes back as an empty result rather than an
// error.
//
// ## The unions are deliberate
//
// Two loaders vary their FROM list by argument. Both declare every table any
// branch can reach, because the caller supplies that argument at request time:
// a narrower set would route a request to a store that does not own one leg of
// it. `loadCompareSubnets` is the opposite case -- it reads NOTHING unless the
// caller asks for the health dimension -- and declaring its one table anyway
// costs a store choice that is then unused.

/** The alpha-pricing trio, which must move together.
 *
 * `nominator_positions JOIN hotkey_alpha` split across stores does not error --
 * it returns no rows, and a holder list that is empty because the join found
 * nothing looks exactly like an account with no positions. hotkey_alpha_passes
 * is in the same set because the pricing read gates on the newest COMPLETE
 * pass; reading that from the other store would price against a scan the alpha
 * rows do not belong to. */
export const ALPHA_PRICING_TABLES = [
  "nominator_positions",
  "hotkey_alpha",
  "hotkey_alpha_passes",
] as const;

/** topHoldersHoldings -- the alpha-pricing set, plus the balances leg and the
 * snapshot prices its SQL joins against.
 *
 * ALL SIX OR NONE, and that is not conservatism: the statement is one query
 * with a CTE per leg, so a set split across stores would run a JOIN whose other
 * side is missing and answer an empty result rather than an error. Both pass
 * ledgers are in because each leg gates on its own newest COMPLETE pass --
 * pricing against a scan the rows do not belong to is the failure #9832 was. */
export const TOP_HOLDERS_HOLDINGS_TABLES = [
  ...ALPHA_PRICING_TABLES,
  "account_balances",
  "account_balances_passes",
  "subnet_snapshots",
] as const;

/** loadSubnetTempo, in the weight-setters loader. */
export const SUBNET_HYPERPARAMS_TEMPO_TABLES = ["subnet_hyperparams"] as const;

/** loadSubnetBurnHistory */
export const SUBNET_BURN_HISTORY_TABLES = ["subnet_burn_history"] as const;

/** loadRevenueObservations, and the probe lane's own write (#10566).
 *
 * Both tables, because the lane writes both in one pass and producerStore gates
 * on every table it is handed -- declaring only the observations table would
 * hand the lane a store that can record a figure and not a failure, which is
 * the one asymmetry this pair exists to avoid. */
export const REVENUE_OBSERVATION_TABLES = [
  "revenue_observations",
  "revenue_probe_failures",
] as const;

/** loadTaoUsdSeries */
export const TAO_USD_TABLES = ["tao_usd_index"] as const;

/** loadSurfaceHistory.
 *
 * The four registry tables (surface_history, subnets, surfaces, providers) are
 * declared in NEON_SOLE_STORE_TABLES as of #10179. They were the last holdout,
 * and leaving them out would not have been neutral: readStore refuses a table
 * it is not told about, so once D1 was dropped this reader -- which catches its
 * own throw -- would have served an EMPTY trail for every subnet, which is a
 * real answer for a stable subnet and therefore indistinguishable. */
export const SURFACE_HISTORY_TABLES = ["surface_history"] as const;

/** loadEmissionChanges.
 *
 * The UNION of all three arms. `kind` picks one table, or all three joined by
 * UNION ALL when it is unset, and `kind` is caller-supplied at request time. */
export const EMISSION_CHANGES_TABLES = [
  "emission_gate_param_history",
  "subnet_emission_enabled_history",
  "emission_flow_watch",
] as const;

/** loadFailureReasons */
export const FAILURE_REASONS_TABLES = ["surface_failure_daily"] as const;

/** loadIndexerLag */
export const INDEXER_LAG_TABLES = ["chain_detail_blocks"] as const;

/** loadChainConcentrationHistory */
export const CHAIN_CONCENTRATION_HISTORY_TABLES = [
  "chain_concentration_daily",
] as const;

/** loadPipelineHistory, loadSubnetTrajectory, loadEconomicsTrends.
 *
 * PIPELINE_HISTORY_TABLE in src/emission-pipeline-history.ts is named for the
 * lane, not the table: its value is "subnet_snapshots". */
export const SUBNET_SNAPSHOT_TABLES = ["subnet_snapshots"] as const;

/** loadSubnetHealthTrends, loadSubnetPercentiles, loadSubnetIncidents,
 *  loadGlobalIncidents -- all four read the per-probe check log. */
export const HEALTH_CHECK_TABLES = ["surface_checks"] as const;

/** loadBulkHealthTrends, loadSubnetUptime */
export const UPTIME_DAILY_TABLES = ["surface_uptime_daily"] as const;

/** loadRegistryLeaderboards, which issues four statements across three tables
 *  unconditionally. */
export const LEADERBOARD_TABLES = [
  "surface_status",
  "subnet_snapshots",
  "surface_uptime_daily",
] as const;

/** loadCompareSubnets -- read ONLY when the caller asks for the health
 *  dimension. Declared anyway: the alternative is choosing a store from a
 *  request parameter, which would make the store depend on the query. */
export const COMPARE_SUBNETS_TABLES = ["surface_status"] as const;

/** entities.ts's buildSubnetValidatorEconomicsPayload, whose SQL is inline
 *  rather than in a loader module. */
export const VALIDATOR_ECONOMICS_TABLES = [
  "neurons",
  "subnet_hyperparams",
] as const;

/** entities.ts's buildSubnetValidatorEconomicsHistoryPayload, likewise inline.
 *
 *  NOT the observation family. This read used to go through observationsReadDb,
 *  which gates on the five surface_* tables and additionally requires a `ctx` to
 *  park the connection teardown on -- and none of the three surfaces calling it
 *  (REST, MCP, GraphQL) passes one. That answered `undefined`, which every
 *  reader here treats as zero rows, so the route published an empty series for
 *  every subnet. Declaring the tables it actually names puts the gate on the
 *  right question and drops the ctx requirement, matching its per-subnet
 *  sibling above. */
export const VALIDATOR_ECONOMICS_HISTORY_TABLES = [
  "neuron_daily",
  "subnet_snapshots",
  "subnet_hyperparams_history",
] as const;

/** entities.ts's buildValidatorEconomicsRankingPayload, likewise inline. */
export const VALIDATOR_ECONOMICS_RANKING_TABLES = [
  "neurons",
  "subnet_burn_history",
  "subnet_hyperparams",
] as const;
