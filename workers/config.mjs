// Module-scope configuration constants for the API Worker — pure literals,
// regexes, and lookup sets with no runtime dependencies. Extracted from
// workers/api.mjs (issue #510, de-monolith) so handlers can share them without
// the entry file owning every constant. Import-free by design: this module must
// stay a leaf so api.mjs and any future request-handler module can depend on it
// without cycles.

// Cron schedule strings (must match wrangler.jsonc `triggers.crons`). The hourly
// trigger prunes the D1 time-series; every other trigger runs the 15-minute
// probe. The former fast (*/3) staged-batch-drain trigger (#1346 Option A,
// EVENTS_LOAD_CRON) is retired: its last consumer (loadStagedAccountIdentity)
// was removed once refresh-account-identity moved to a direct-to-Postgres sync.
export const HEALTH_PRUNE_CRON = "0 * * * *";
// Daily embedding-sync trigger (Worker-runtime, since CI has no AI bindings).
// Distinct minute (odd) so it never collides with the 15-minute probe or the
// top-of-hour prune. Must match a wrangler.jsonc `triggers.crons` entry.
export const EMBEDDING_SYNC_CRON = "37 3 * * *";
// Hourly account_events_daily rollup (#4832 gap-closure), moved off the
// former rollup-account-events-daily.yml GitHub Actions workflow onto this
// Worker-native cron -- offset from the top-of-hour prune (0) so the two
// don't tick on the same minute. Must match a wrangler.jsonc cron entry.
export const ACCOUNT_EVENTS_ROLLUP_CRON = "17 * * * *";
// Trend windows for /api/v1/subnets/{netuid}/health/trends and
// /api/v1/health/trends.
export const RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN =
  /^\/metagraph\/health\/(?:latest\.json|summary\.json|subnets\/\d+\.json)$/;
export const HEALTH_TREND_WINDOWS = { "7d": 7, "30d": 30 };
export const BULK_TRENDS_PATH_PATTERN = /^\/api\/v1\/health\/trends$/;
export const TRENDS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/trends$/;
export const PERCENTILES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/percentiles$/;
export const INCIDENTS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/incidents$/;
export const TRAJECTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/trajectory$/;
// Subnet hyperparameters (#4303/1.4): one row per netuid, computed live from
// the subnet_hyperparams D1 tier, no static file.
export const SUBNET_HYPERPARAMS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/hyperparameters$/;
// Historical hyperparameter change tracking (#4309/1.6): append-only timeline
// read from the subnet_hyperparams_history D1 tier, no static file. Detail
// (more specific) before the base pattern above — both are anchored.
export const SUBNET_HYPERPARAMS_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/hyperparameters\/history$/;
// Stake/emission concentration metrics (#2106): computed live from the neurons
// D1 tier, no static file.
export const SUBNET_CONCENTRATION_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/concentration$/;
// Per-day concentration history (decentralization trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_CONCENTRATION_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/concentration\/history$/;
// Per-day performance history (reward-flow & trust trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_PERFORMANCE_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/performance\/history$/;
// Validator-set & registration turnover (churn) from the neuron_daily rollup,
// no static file.
export const SUBNET_TURNOVER_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/turnover$/;
// Net stake flow (StakeAdded vs StakeRemoved) for one subnet, summed live from the
// account_events tier, no static file.
export const SUBNET_STAKE_FLOW_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-flow$/;
// Rolling 24h buy/sell alpha volume (#4339/8.1) — unsigned, distinct from
// stake-flow's netted capital-flow framing — summed live from the same
// account_events tier, no static file.
export const SUBNET_ALPHA_VOLUME_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/volume$/;
// OHLC price/volume candlesticks (#5655, Phase 1 of #5304) — open/high/low/
// close/volume bucketed by ?interval=, computed live from the same
// account_events tier as /volume and /stake-flow, no static file.
export const SUBNET_OHLC_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/ohlc$/;
// Read-only constant-product stake/unstake slippage quote (#5235) — pure math
// over the subnet's live economics-artifact pool reserves, no chain write.
export const SUBNET_STAKE_QUOTE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-quote$/;
// Live cumulative TAO recycled for registration on one subnet (#4339/8.4),
// queried from the chain's own RAORecycledForRegistration storage map at
// request time — not a D1/account_events tier, no static file.
export const SUBNET_RECYCLED_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/recycled$/;
// Live current registration/burn cost for one subnet (#6321) — the dynamic
// price between min_burn_tao/max_burn_tao's static bounds, queried from the
// chain's own Burn storage map at request time — not a D1/account_events
// tier, no static file. Dispatched separately from SUBNET_RECYCLED (a
// different storage item, different route).
export const SUBNET_BURN_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/burn$/;
// Live subnet-lease state (#6719) — whether a subnet is currently under a
// lease and, if so, its terms, queried from the chain's own SubnetUidTo-
// LeaseId/SubnetLeases/AccumulatedLeaseDividends storage maps at request
// time — not a D1/account_events tier, no static file. The companion
// /lease/history route (lease-lifecycle events, Postgres-tier via the
// DATA_API service binding) is dispatched separately in api.mjs's
// handleRequest, matching ownership-history/conviction's own inline-regex
// convention rather than a config.mjs pattern constant.
export const SUBNET_LEASE_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/lease$/;
// Validator weight-setting activity over the window, live from account_events, no static file.
export const SUBNET_WEIGHTS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/weights$/;
// Per-subnet weight-setter leaderboard (the individual validators behind /weights) over the
// window, live from account_events, no static file. Dispatched BEFORE SUBNET_WEIGHTS.
export const SUBNET_WEIGHT_SETTERS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/weights\/setters$/;
// Axon-serving announcement activity over the window, live from account_events, no static file.
export const SUBNET_SERVING_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/serving$/;
// Prometheus-endpoint serving activity over the window, live from account_events, no static file.
export const SUBNET_PROMETHEUS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/prometheus$/;
// Stake-movement (re-delegation) activity over the window, live from account_events, no static file.
export const SUBNET_STAKE_MOVES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-moves$/;
// Stake-transfer (between-coldkeys) activity over the window, live from account_events, no static file.
export const SUBNET_STAKE_TRANSFERS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-transfers$/;
// Neuron-registration activity over the window, live from account_events, no static file.
export const SUBNET_REGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/registrations$/;
// Axon-removal activity over the window, live from account_events, no static file.
export const SUBNET_AXON_REMOVALS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/axon-removals$/;
// Neuron-deregistration activity over the window, live from account_events, no static file.
export const SUBNET_DEREGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/deregistrations$/;
// Per-UID emission yield distribution over the current neurons snapshot, no static file.
export const SUBNET_YIELD_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/yield$/;
// Per-day yield-distribution history (return-rate trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_YIELD_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/yield\/history$/;
// Reward-distribution + score-spread metrics over the current neurons snapshot
// (reward concentration + trust/consensus percentiles), no static file.
export const SUBNET_PERFORMANCE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/performance$/;
// Stake sitting on a currently-zero-dividends hotkey (#6789), computed live
// from the neurons D1/Postgres tier, no static file.
export const SUBNET_IDLE_STAKE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/idle-stake$/;
export const UPTIME_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/uptime$/;
// Per-UID metagraph routes (#1304/#1305): computed live from the neurons D1 tier.
export const SUBNET_METAGRAPH_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/metagraph$/;
export const SUBNET_NEURON_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/;
export const SUBNET_VALIDATORS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/validators$/;
// Cross-subnet validator detail route (#4334/7.1): a single validator's
// validator_permit=1 rows aggregated across every subnet it operates in —
// the single-entity drill-in of the bare /api/v1/validators leaderboard.
export const VALIDATOR_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})$/;
// Nominator list for one validator (#4334/7.2): StakeAdded/StakeRemoved
// account_events grouped by coldkey, no static file. Dispatched separately
// from VALIDATOR_DETAIL_PATH_PATTERN above (disjoint — that one is $-anchored
// right after the hotkey, this one requires the /nominators suffix).
export const VALIDATOR_NOMINATORS_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})\/nominators$/;
// Cross-subnet staked-over-time + rewards-per-1000-TAO history for one
// validator (#4334/7.3), rolled up from the neuron_daily tier.
export const VALIDATOR_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})\/history$/;
// Per-subnet chain-event stream (#1345 block explorer): account_events filtered
// by netuid, served live from the event tier.
export const SUBNET_EVENT_SUMMARY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/event-summary$/;
export const SUBNET_EVENTS_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/events$/;
// Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345): time
// series read from the neuron_daily rollup tier.
export const SUBNET_NEURON_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)\/history$/;
export const SUBNET_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/history$/;
export const SUBNET_IDENTITY_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/identity-history$/;
// Account entity routes (#1347): computed live from the account_events + neurons
// D1 tiers. SS58 addresses are base58 (no 0/O/I/l), 47-48 chars.
// A bare, anchored SS58 address — the same shape the route patterns capture,
// reused by the MCP account tools so REST and MCP validate the address identically.
export const SS58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{47,48}$/;
export const ACCOUNT_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})$/;
export const ACCOUNT_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/events$/;
// Per-account daily-history series (#1854): the durable per-day activity from the
// account_events_daily rollup. Dispatched BEFORE the bare ACCOUNT_PATH_PATTERN.
export const ACCOUNT_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/history$/;
// Account entity routes (#1347):
export const ACCOUNT_SUBNETS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/subnets$/;
// Cross-subnet neuron portfolio for one wallet (full position economics + yield
// + aggregates), richer than the bare /subnets registration footprint.
export const ACCOUNT_PORTFOLIO_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/portfolio$/;
// Nominator-side (coldkey) position reconstruction (#5233): what this
// account holds delegated across every hotkey/subnet, distinct from
// /portfolio above (hotkey-scoped).
export const ACCOUNT_POSITIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/positions$/;
// Per-account, per-subnet position HISTORY (block-explorer Tier-1, #4329/6.2):
// time series read from the account_position_daily rollup tier — the "Alpha
// Holdings chart" for one wallet's position on one subnet.
export const ACCOUNT_SUBNET_POSITION_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/subnets\/(\d+)\/history$/;
// Per-account signed extrinsics (#1844): the extrinsics this account signed,
// matched by extrinsics.signer (a single column, not the hotkey or coldkey union).
export const ACCOUNT_EXTRINSICS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/extrinsics$/;
// Per-account native-TAO transfers (#1850): the Balances.Transfer feed for this
// account, from account_events (event_kind='Transfer'); ?direction=all|sent|received.
export const ACCOUNT_TRANSFERS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/transfers$/;
// Per-account counterparty / fund-flow rollup: aggregates the account's
// account_events Transfers into per-counterparty sent/received/net.
export const ACCOUNT_COUNTERPARTIES_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/counterparties$/;
// Per-account stake flow: aggregates the account's account_events StakeAdded/StakeRemoved
// per subnet into a net/gross flow + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_STAKE_FLOW_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/stake-flow$/;
// Per-account stake-movement footprint: aggregates the account's account_events StakeMoved
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_STAKE_MOVES_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/stake-moves$/;
// Per-account weight-setting footprint: aggregates the account's (hotkey/validator's)
// account_events WeightsSet per subnet into a count + concentration scorecard over a 7d/30d window.
export const ACCOUNT_WEIGHT_SETTERS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/weight-setters$/;
// Per-account registration footprint: aggregates the account's account_events NeuronRegistered
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_REGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/registrations$/;
// Per-account serving footprint: aggregates the account's account_events AxonServed
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_SERVING_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/serving$/;
// Per-account axon-removal footprint: aggregates the account's account_events AxonInfoRemoved
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_AXON_REMOVALS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/axon-removals$/;
// Per-account Prometheus-serving footprint: aggregates the account's account_events PrometheusServed
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_PROMETHEUS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/prometheus$/;
// Per-account deregistration footprint: aggregates the account's account_events NeuronDeregistered
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_DEREGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/deregistrations$/;
// Live TAO balance query (#1818): captures any non-slash segment; the handler
// applies a stricter ^5[a-zA-Z0-9]{46,47}$ guard before making the RPC call.
export const ACCOUNT_BALANCE_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([^/]+)\/balance$/;
// Personal chain identity (epic #4301/5.4): the latest-only
// account_identity row for one account, and its append-only diff-tracking
// timeline. Mirrors SUBNET_IDENTITY_HISTORY_PATH_PATTERN's shape, keyed by
// ss58 instead of netuid.
export const ACCOUNT_IDENTITY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/identity$/;
export const ACCOUNT_IDENTITY_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/identity-history$/;
// Live child-hotkey delegation graph (#6723, part of epic #6721): who this
// hotkey delegates stake-weight to (children) / who delegates to it
// (parents), per subnet — queried from the chain's own ChildKeys/ParentKeys
// storage maps at request time, not a D1/account_events tier, no static
// file. Mirrors ACCOUNT_IDENTITY_PATH_PATTERN's ss58-keyed shape.
export const ACCOUNT_CHILDREN_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/children$/;
export const ACCOUNT_PARENTS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/parents$/;
// Block-explorer routes (#1345): recent feed + per-block detail, computed live
// from the `blocks` D1 tier. {ref} is a numeric block_number OR a 0x block_hash
// (32-byte hex = 64 chars).
export const BLOCKS_FEED_PATH_PATTERN = /^\/api\/v1\/blocks$/;
export const BLOCK_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})$/;
// Per-block extrinsics sub-resource (#1845): the extrinsics in one block, by the
// same {ref} (numeric block_number or 0x block_hash). Dispatched BEFORE the
// detail pattern (which is $-anchored, so it won't swallow the sub-path).
export const BLOCK_EXTRINSICS_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/extrinsics$/;
// Per-block events sub-resource (#1852): the decoded chain events in one block,
// by the same {ref} (numeric block_number or 0x block_hash). Dispatched BEFORE
// the detail pattern (which is $-anchored, so it won't swallow the sub-path).
export const BLOCK_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/events$/;
// Block-explorer extrinsic routes (#1345 second slice): recent feed + per-extrinsic
// detail, computed live from the `extrinsics` D1 tier. {hash} is a 0x extrinsic_hash
// (32-byte blake2b = 64 hex chars).
export const EXTRINSICS_FEED_PATH_PATTERN = /^\/api\/v1\/extrinsics$/;
// Sudo-call feed (#4310/2.2): the extrinsics feed hardcoded to call_module='Sudo'
// (subtensor has no Council/Senate — see #4310's audit). Same D1 tier as
// EXTRINSICS_FEED_PATH_PATTERN, just a dedicated, discoverable path.
export const SUDO_CALLS_PATH_PATTERN = /^\/api\/v1\/sudo$/;
// Current Sudo::Key holder (#4310/2.4, re-scoped from the original Senate/
// Council membership framing — see #4310's audit): a live finney RPC read,
// not a D1 tier — distinct from SUDO_CALLS_PATH_PATTERN's extrinsic feed.
export const SUDO_KEY_PATH_PATTERN = /^\/api\/v1\/sudo\/key$/;
// Live global Subtensor protocol/governance parameters (#6343) -- TaoWeight,
// StakeThreshold, PendingChildKeyCooldown -- a live finney RPC read, same
// shape as SUDO_KEY_PATH_PATTERN just above (no path params, no D1 tier).
export const NETWORK_PARAMETERS_PATH_PATTERN =
  /^\/api\/v1\/network\/parameters$/;
// Live drand randomness-beacon status (#6731) -- LastStoredRound/
// OldestStoredRound -- a live finney RPC read, same shape as
// NETWORK_PARAMETERS_PATH_PATTERN just above (no path params, no D1 tier).
export const RANDOMNESS_PATH_PATTERN = /^\/api\/v1\/network\/randomness$/;
// AdminUtils config-change feed (#4310/2.3, re-scoped from the original
// Council/Senate framing — see #4310's audit): the extrinsics feed hardcoded
// to call_module='AdminUtils', subtensor's own root-origin hyperparameter/
// network-config change pathway. Same D1 tier as EXTRINSICS_FEED_PATH_PATTERN.
export const GOVERNANCE_CONFIG_CHANGES_PATH_PATTERN =
  /^\/api\/v1\/governance\/config-changes$/;
// Runtime spec-version transition timeline (#4316/3.1): the earliest known
// block at each distinct spec_version seen on the blocks D1 tier. Same D1
// tier as BLOCKS_FEED_PATH_PATTERN, a site-wide aggregate, not per-block.
export const RUNTIME_VERSIONS_PATH_PATTERN = /^\/api\/v1\/runtime$/;
// Per-extrinsic detail (#1345/#1848): ref is a 0x extrinsic_hash OR the canonical
// composite id "<block_number>-<extrinsic_index>" (the guaranteed-present id, since
// the hash is best-effort/nullable). Single capture group; the handler branches.
export const EXTRINSIC_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/extrinsics\/(0x[0-9a-fA-F]{64}|\d+-\d+)$/;
// Per-domain rollup (#6749/#6750): total stake/emission-share/concentration
// across one domain/capability tag's member subnets. `tag` is captured loosely
// (any lowercase-hyphen token) -- the handler validates it against the real
// fixed DOMAIN_TAGS enum, matching how other enum-shaped path segments in this
// file defer their real validation to the handler rather than the regex.
export const DOMAIN_SUMMARY_PATH_PATTERN =
  /^\/api\/v1\/domains\/([a-z-]+)\/summary$/;
export const UPTIME_WINDOWS = { "90d": 90, "1y": 365 };
export const MAX_UPTIME_ROWS = 10000;
export const MAX_BULK_TREND_ROWS = 10000;
export const ANALYTICS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_ANALYTICS_WINDOW = "7d";
export const ANALYTICS_WINDOW_PARAM = "window";
export const RPC_USAGE_BUCKETS = {
  "7d": { granularity: "1h", bucketMs: 60 * 60 * 1000, maxBuckets: 7 * 24 },
  "30d": {
    granularity: "6h",
    bucketMs: 6 * 60 * 60 * 1000,
    maxBuckets: 30 * 4,
  },
};
export const MAX_INCIDENT_ROWS = 1000;
export const MAX_GLOBAL_INCIDENT_SOURCE_ROWS = 5000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// Fixed bucket used as the rate-limit key (and request-scoped client id) when no
// trustworthy client IP is available.
export const ANONYMOUS_CLIENT_KEY = "anonymous";

// Resolve the client IP for rate-limiting / per-client keys. On Cloudflare,
// `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client.
// `X-Forwarded-For` is fully client-controlled and MUST NOT be trusted here: an
// attacker could rotate it to mint a fresh rate-limit bucket per request and
// evade the limiter. So we read `cf-connecting-ip` ONLY; when it is absent
// (non-CF / local / the test harness) we collapse to a single fixed bucket
// rather than honoring any client-supplied header. A shared fixed bucket is the
// safe failure mode — worst case all such callers share one limit.
export function resolveClientIp(request) {
  return request.headers.get("cf-connecting-ip") || ANONYMOUS_CLIENT_KEY;
}

// Clamp a raw limit/offset (a query-param string or a tool-arg number) into
// [min, max], falling back to `def` when absent/blank/non-finite. Shared by every
// paginated route + tool so they bound page size identically.
export function clampInt(raw, def, min, max) {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Read-only, bounded Substrate/Subtensor methods safe to expose through the
// public proxy. Deliberately excludes heavy/abusable reads (state_getMetadata,
// state_getStorage) and anything mutating — those stay blocked by the allowlist
// plus DENIED_RPC_PREFIXES.
export const SAFE_RPC_METHODS = new Set([
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
]);
// Read-only WebSocket subscriptions — WSS-ONLY. The HTTP proxy uses SAFE_RPC_METHODS
// alone (subscriptions need a persistent connection, so they make no sense over HTTP);
// the wss-lb additionally allows these. Their notifications stream upstream→client.
// Deliberately excludes persistent storage subscriptions, which can create
// unbounded upstream watcher state for arbitrary keys.
// All allowed entries are read-only; author_submitAndWatchExtrinsic stays blocked
// by the author_ prefix.
export const SAFE_RPC_SUBSCRIPTIONS = new Set([
  "chain_subscribeNewHeads",
  "chain_subscribeNewHead",
  "chain_unsubscribeNewHeads",
  "chain_subscribeFinalizedHeads",
  "chain_subscribeFinalisedHeads",
  "chain_unsubscribeFinalizedHeads",
  "chain_unsubscribeFinalisedHeads",
  "chain_subscribeAllHeads",
  "chain_unsubscribeAllHeads",
  "state_subscribeRuntimeVersion",
  "state_unsubscribeRuntimeVersion",
]);
export const DENIED_RPC_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
];
// A second, narrower allowlist for the public RPC proxy (#4344/9.2, design
// spike in docs/block-explorer-data-model.md): storage-key reads take a
// caller-supplied key/prefix with no natural bound, unlike every SAFE_RPC_METHODS
// entry. Membership here is NOT sufficient on its own -- the handler additionally
// requires param-shape validation and a separate, stricter rate-limit budget
// (STATE_QUERY_RATE_LIMITER) before forwarding. state_getPairs is deliberately
// excluded: it has no caller-side pagination at all and can return an entire
// pallet's storage (keys AND values) under a shallow prefix in one response --
// state_getKeysPaged already covers the legitimate "enumerate a prefix" use case
// with a bounded page size.
export const SAFE_RPC_STATE_QUERY_METHODS = new Set([
  "state_getStorage",
  "state_getKeysPaged",
]);
// A real storage key is at most two twox128 hashes (16 bytes each) plus one
// hashed map key -- even a Blake2_128Concat key on a 32-byte AccountId stays
// well under 128 bytes decoded. 256 bytes decoded (512 hex chars + "0x") is a
// generous ceiling above any real key/prefix, not a bound anyone legitimate
// would hit.
export const MAX_STATE_QUERY_KEY_HEX_CHARS = 512;
// state_getKeysPaged's caller-supplied page-size `count` is clamped (not
// rejected) to this ceiling, mirroring how paginated REST routes in this repo
// clamp rather than error on an over-large `?limit` (clampInt above).
export const MAX_STATE_QUERY_KEYS_PAGE_SIZE = 250;
// Post-fetch response-size cap for state-query methods specifically (separate
// from any general proxy behavior): even with the page-size clamped, cap the
// decoded upstream body so a pathological prefix can't relay an oversized
// payload to the client. Same order of magnitude as the general proxy's 64 KB
// *request* cap.
export const MAX_STATE_QUERY_RESPONSE_BYTES = 262144; // 256 KB
export const MAX_RPC_BODY_BYTES = 65536;
export const METAGRAPH_LATEST_KEY = "metagraph:latest";
export const MAX_WEBHOOK_BODY_BYTES = 8192;
export const MAX_ASK_BODY_BYTES = 4096;
export const WEBHOOK_SUBSCRIPTION_TOKEN_HEADER =
  "x-metagraph-webhook-subscription-token";
// account_events_daily rollup trigger (#4832 gap-closure). Shared by
// data-api.mjs's handler (validates it) and api.mjs's Worker-native cron
// dispatch (sets it on the synthetic internal request — the former
// rollup-account-events-daily.yml GitHub Actions workflow used to set it on
// its public curl call instead).
export const ROLLUP_TOKEN_HEADER = "x-rollup-sync-token";
// Dormant subscriptions self-clean after 180 days; the publish-time dispatcher
// refreshes the TTL on each successful delivery.
export const WEBHOOK_TTL_SECONDS = 180 * 24 * 60 * 60;
export const TRUSTED_RPC_UPSTREAM_ORIGINS = new Set([
  "https://archive.chain.opentensor.ai",
  "https://bittensor-finney.api.onfinality.io",
  "https://bittensor-public.nodies.app",
  "https://entrypoint-finney.opentensor.ai",
  "https://lite.chain.opentensor.ai",
  // Bittensor testnet base-layer RPC + WSS (the /rpc/v1/test + test-wss pools);
  // verified testnet genesis 0x8f9cf8…, distinct from finney. WSS endpoints
  // confirmed (101 Switching Protocols). See registry/native/test-base-endpoints.json.
  "https://test.finney.opentensor.ai",
  "https://test.chain.opentensor.ai",
  "wss://test.finney.opentensor.ai",
  "wss://test.chain.opentensor.ai",
  "wss://archive.chain.opentensor.ai",
  "wss://bittensor-finney.api.onfinality.io",
  "wss://entrypoint-finney.opentensor.ai",
  "wss://lite.chain.opentensor.ai",
  // First-party pruned RPC node (#4965), behind a Cloudflare Tunnel --
  // --rpc-methods=safe + node-level rate limiting at the origin, Cloudflare's
  // own edge protection in front of that. Both HTTPS and WSS confirmed live
  // 2026-07-14 (WSS via a real 101 Switching Protocols handshake, same bar as
  // the testnet endpoints above), and an unsafe method (author_insertKey)
  // confirmed rejected through the public URL, not just the private one.
  "https://fullnode-rpc.metagraph.sh",
  "wss://fullnode-rpc.metagraph.sh",
]);
