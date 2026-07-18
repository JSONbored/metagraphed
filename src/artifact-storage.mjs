export const ARTIFACT_STORAGE_TIERS = {
  dual: "dual",
  git: "git",
  r2: "r2",
};

export const R2_STAGING_RELATIVE_ROOT = "dist/metagraph-r2/metagraph";

export const R2_ONLY_PATTERNS = [
  /^adapters\/[^/]+\.json$/,
  /^candidates\.json$/,
  /^candidates\/(?:\d+|\{netuid\})\.json$/,
  /^endpoint-incidents\.json$/,
  /^endpoint-pools\.json$/,
  // Global cross-subnet incident ledger, computed live from D1 at
  // /api/v1/incidents — never written as a file.
  /^incidents\.json$/,
  // Global validator/operator leaderboard, computed live from the neurons D1 tier.
  /^validators\.json$/,
  // Site-wide accounts leaderboard (#4324/5.3), computed live from the neurons
  // D1 tier — the collection-level counterpart to validators.json above.
  /^accounts\.json$/,
  // Cross-subnet validator detail (#4334/7.1): computed live from the neurons D1 tier.
  /^validators\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{hotkey\})\.json$/,
  // Validator nominator list (#4334/7.2): computed live from account_events.
  /^validators\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{hotkey\})\/nominators\.json$/,
  // Validator staked-over-time + rewards history (#4334/7.3): computed live
  // from the neuron_daily D1 rollup.
  /^validators\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{hotkey\})\/history\.json$/,
  /^endpoints\.json$/,
  /^endpoints\/(?:\d+|\{netuid\})\.json$/,
  /^evidence\/(?:\d+|\{netuid\})\.json$/,
  /^overview\/(?:\d+|\{netuid\})\.json$/,
  /^health\/badges\/(?:\d+|\{netuid\})\.json$/,
  /^health\/history\/(?:\d{4}-\d{2}-\d{2}|\{date\})\.json$/,
  /^health\/latest\.json$/,
  /^health\/summary\.json$/,
  /^health\/subnets\/(?:\d+|\{netuid\})\.json$/,
  // Health trends are computed live from D1 by the Worker, never written as a
  // file. Marked R2-only so the contract maps a schema to the route without the
  // build expecting a committed/staged artifact.
  /^health\/trends\.json$/,
  /^health\/trends\/(?:\d+|\{netuid\})\.json$/,
  // AI-4 analytics: also computed live from D1, never written as files.
  /^health\/percentiles\/(?:\d+|\{netuid\})\.json$/,
  /^health\/incidents\/(?:\d+|\{netuid\})\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/trajectory\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/uptime\.json$/,
  // Stake/emission concentration (#2106): computed live from the neurons D1 tier.
  /^subnets\/(?:\d+|\{netuid\})\/concentration\.json$/,
  // Per-day concentration history: computed live from the neuron_daily rollup.
  /^subnets\/(?:\d+|\{netuid\})\/concentration\/history\.json$/,
  // Reward distribution & score spread: computed live from the neurons D1 tier.
  /^subnets\/(?:\d+|\{netuid\})\/performance\.json$/,
  // Per-day performance history: computed live from the neuron_daily rollup.
  /^subnets\/(?:\d+|\{netuid\})\/performance\/history\.json$/,
  // Validator-set / registration turnover: computed live from neuron_daily.
  /^subnets\/(?:\d+|\{netuid\})\/turnover\.json$/,
  // Net stake flow: computed live from account_events.
  /^subnets\/(?:\d+|\{netuid\})\/stake-flow\.json$/,
  // Rolling 24h buy/sell alpha volume (#4339/8.1): computed live from the same
  // account_events stream as stake-flow.
  /^subnets\/(?:\d+|\{netuid\})\/volume\.json$/,
  // OHLC price/volume candlesticks (#5655, Phase 1 of #5304): bucketed in pure
  // JS from the same account_events stream as volume/stake-flow, never a file.
  /^subnets\/(?:\d+|\{netuid\})\/ohlc\.json$/,
  // Constant-product stake/unstake slippage quote (#5235): computed live from
  // the economics-tier AMM pool reserves.
  /^subnets\/(?:\d+|\{netuid\})\/stake-quote\.json$/,
  // Validator weight-setting activity: computed live from the account_events WeightsSet stream.
  /^subnets\/(?:\d+|\{netuid\})\/weights\.json$/,
  // Per-subnet weight-setter leaderboard: computed live from the account_events WeightsSet stream.
  /^subnets\/(?:\d+|\{netuid\})\/weights\/setters\.json$/,
  // Axon-serving announcement activity: computed live from the account_events AxonServed stream.
  /^subnets\/(?:\d+|\{netuid\})\/serving\.json$/,
  // Prometheus-endpoint serving activity: computed live from the account_events PrometheusServed stream.
  /^subnets\/(?:\d+|\{netuid\})\/prometheus\.json$/,
  // Stake-movement (re-delegation) activity: computed live from the account_events StakeMoved stream.
  /^subnets\/(?:\d+|\{netuid\})\/stake-moves\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/stake-transfers\.json$/,
  // Neuron-registration activity: computed live from the account_events NeuronRegistered stream.
  /^subnets\/(?:\d+|\{netuid\})\/registrations\.json$/,
  // Axon-removal activity: computed live from the account_events AxonInfoRemoved stream.
  /^subnets\/(?:\d+|\{netuid\})\/axon-removals\.json$/,
  // Neuron-deregistration activity: computed live from the account_events NeuronDeregistered stream.
  /^subnets\/(?:\d+|\{netuid\})\/deregistrations\.json$/,
  // Per-UID emission yield distribution: computed live from the neurons snapshot.
  /^subnets\/(?:\d+|\{netuid\})\/yield\.json$/,
  // Per-day yield-distribution history: computed live from the neuron_daily rollup.
  /^subnets\/(?:\d+|\{netuid\})\/yield\/history\.json$/,
  // Cross-subnet movers leaderboard: computed live from neuron_daily.
  /^subnets\/movers\.json$/,
  // Per-UID metagraph (#1303/#1304/#1305): computed live from the neurons D1
  // tier at /api/v1/subnets/{netuid}/metagraph, /neurons/{uid}, /validators —
  // never written as files.
  /^subnets\/(?:\d+|\{netuid\})\/metagraph\.json$/,
  // Subnet hyperparameters (#4303/1.4): computed live from the
  // subnet_hyperparams D1 tier, refreshed daily — never written as a file.
  /^subnets\/(?:\d+|\{netuid\})\/hyperparameters\.json$/,
  // Historical hyperparameter change tracking (#4309/1.6): computed live from
  // the subnet_hyperparams_history D1 tier — never written as a file.
  /^subnets\/(?:\d+|\{netuid\})\/hyperparameters\/history\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/neurons\/(?:\d+|\{uid\})\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/neurons\/(?:\d+|\{uid\})\/history\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/history\.json$/,
  // On-chain identity timeline (#1647): computed live from subnet_identity_history D1.
  /^subnets\/(?:\d+|\{netuid\})\/identity-history\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\/validators\.json$/,
  // Per-subnet chain-event stream (#1345): account_events filtered by netuid at
  // /api/v1/subnets/{netuid}/events — live D1, never written as a file.
  /^subnets\/(?:\d+|\{netuid\})\/events\.json$/,
  // Per-subnet event summary: computed live from account_events.
  /^subnets\/(?:\d+|\{netuid\})\/event-summary\.json$/,
  // Account entity tiers (#1347): computed live from account_events + neurons at
  // /api/v1/accounts/{ss58}(/events|/subnets) — never written as files.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/events\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/history\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/extrinsics\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/transfers\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/counterparties\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/stake-flow\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/stake-moves\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/weight-setters\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/registrations\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/serving\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/axon-removals\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/prometheus\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/deregistrations\.json$/,
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/subnets\.json$/,
  // Cross-subnet neuron portfolio, computed live from the neurons D1 tier at
  // /api/v1/accounts/{ss58}/portfolio — never a file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/portfolio\.json$/,
  // Nominator-side (coldkey) position reconstruction (#5233), computed live
  // from nominator_positions joined against the neurons D1 tier at
  // /api/v1/accounts/{ss58}/positions — never a file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/positions\.json$/,
  // Per-account, per-subnet position history (#4329/6.2), computed live from the
  // account_position_daily D1 rollup tier at
  // /api/v1/accounts/{ss58}/subnets/{netuid}/history — never a file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/subnets\/(?:\d+|\{netuid\})\/history\.json$/,
  // Live TAO balance query (#1818): computed from RPC at request time, never a static file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/balance\.json$/,
  // Personal chain identity (epic #4301/5.4), computed live from the
  // account_identity D1 tier at /api/v1/accounts/{ss58}/identity — never a file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/identity\.json$/,
  // Personal chain identity diff-tracking history (epic #4301/5.2), computed
  // live from the account_identity_history D1 tier at
  // /api/v1/accounts/{ss58}/identity-history — never a file.
  /^accounts\/(?:[1-9A-HJ-NP-Za-km-z]{47,48}|\{ss58\})\/identity-history\.json$/,
  // Current Sudo::Key holder (#4310/2.4): computed from RPC at request time,
  // never a static file.
  /^sudo\/key\.json$/,
  // Live global Subtensor protocol/governance parameters (#6343): computed
  // from RPC at request time, never a static file.
  /^network\/parameters\.json$/,
  // Live cumulative TAO recycled for registration on one subnet (#4339/8.4):
  // computed from RPC at request time, never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/recycled\.json$/,
  // Live current registration/burn cost for one subnet (#6321): computed
  // from RPC at request time, never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/burn\.json$/,
  // Subnet ownership-change history (#6637): served live from the
  // Postgres-backed all-events tier (ADR 0013), never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/ownership-history\.json$/,
  // Subnet conviction leaderboard (#6638): served live from the Postgres-
  // backed all-events tier + a live RPC rate lookup, never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/conviction\.json$/,
  // Live subnet-lease state (#6719): computed from RPC at request time,
  // never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/lease\.json$/,
  // Lease-lifecycle history (#6719): served live from the Postgres-backed
  // all-events tier (ADR 0013), never a static file.
  /^subnets\/(?:\d+|\{netuid\})\/lease\/history\.json$/,
  // Block-explorer tiers (#1345): computed live from the blocks D1 tier at
  // /api/v1/blocks (recent feed) + /api/v1/blocks/{ref} (numeric block_number or
  // 0x block_hash) — never written as files.
  /^blocks\.json$/,
  // Block-production analytics summary, computed live from the blocks D1 tier at
  // /api/v1/blocks/summary — never a file.
  /^blocks\/summary\.json$/,
  // Spec-version transition timeline (#4316/3.1), computed live from the blocks
  // D1 tier at /api/v1/runtime — never a file.
  /^runtime\.json$/,
  /^blocks\/(?:\d+|0x[0-9a-fA-F]{64}|\{ref\})\.json$/,
  // Per-block extrinsics sub-resource (#1845): computed live from the extrinsics
  // D1 tier at /api/v1/blocks/{ref}/extrinsics — never written as a file.
  /^blocks\/(?:\d+|0x[0-9a-fA-F]{64}|\{ref\})\/extrinsics\.json$/,
  // Per-block events sub-resource (#1852): computed live from the account_events
  // D1 tier at /api/v1/blocks/{ref}/events — never written as a file.
  /^blocks\/(?:\d+|0x[0-9a-fA-F]{64}|\{ref\})\/events\.json$/,
  // Block-explorer extrinsic tiers (#1345 second slice): computed live from the
  // extrinsics D1 tier at /api/v1/extrinsics (recent feed) + /api/v1/extrinsics/{hash}
  // (0x extrinsic_hash or composite block-index ref) — never written as files.
  /^extrinsics\.json$/,
  /^extrinsics\/(?:0x[0-9a-fA-F]{64}|\d+-\d+|\{hash\})\.json$/,
  // Sudo-call feed (#4310/2.2): the extrinsics feed hardcoded to
  // call_module='Sudo' — computed live from the same D1 tier, never a file.
  /^sudo\.json$/,
  // AdminUtils config-change feed (#4310/2.3): the extrinsics feed hardcoded
  // to call_module='AdminUtils' — computed live from the same D1 tier, never
  // a file.
  /^governance\/config-changes\.json$/,
  // Chain analytics (#1987-#1990): network-activity / call-mix / signer-leaderboard
  // / fee-market aggregates computed live from the extrinsics + blocks D1 tiers at
  // /api/v1/chain/* — never files.
  /^chain\/activity\.json$/,
  /^chain\/calls\.json$/,
  /^chain\/signers\.json$/,
  /^chain\/fees\.json$/,
  /^chain\/transfers\.json$/,
  /^chain\/transfer-pairs\.json$/,
  // Network-wide cross-subnet capital flow, computed live from the account_events
  // stake stream at /api/v1/chain/stake-flow — never a file.
  /^chain\/stake-flow\.json$/,
  // Network-wide rolling 24h buy/sell alpha-volume leaderboard, computed live from the
  // account_events stake stream at /api/v1/chain/alpha-volume — never a file.
  /^chain\/alpha-volume\.json$/,
  // Network-wide validator weight-setting activity across every subnet, computed live from
  // the account_events WeightsSet stream at /api/v1/chain/weights — never a file.
  /^chain\/weights\.json$/,
  // Network-wide weight-setter leaderboard, computed live from the account_events WeightsSet
  // stream at /api/v1/chain/weights/setters — never a file.
  /^chain\/weights\/setters\.json$/,
  // Network-wide axon-serving announcement activity across every subnet, computed live from
  // the account_events AxonServed stream at /api/v1/chain/serving — never a file.
  /^chain\/serving\.json$/,
  // Network-wide Prometheus-endpoint serving activity across every subnet, computed live from
  // the account_events PrometheusServed stream at /api/v1/chain/prometheus — never a file.
  /^chain\/prometheus\.json$/,
  // Network-wide axon-removal activity across every subnet, computed live from
  // the account_events AxonInfoRemoved stream at /api/v1/chain/axon-removals — never a file.
  /^chain\/axon-removals\.json$/,
  // Network-wide neuron-registration activity across every subnet, computed live from
  // the account_events NeuronRegistered stream at /api/v1/chain/registrations — never a file.
  /^chain\/registrations\.json$/,
  // Network-wide neuron-deregistration activity across every subnet, computed live from
  // the account_events NeuronDeregistered stream at /api/v1/chain/deregistrations — never a file.
  /^chain\/deregistrations\.json$/,
  // Network-wide stake-movement (re-delegation) activity across every subnet, computed live from
  // the account_events StakeMoved stream at /api/v1/chain/stake-moves — never a file.
  /^chain\/stake-moves\.json$/,
  // Network-wide stake-transfer (between-coldkeys) activity across every subnet, computed live from
  // the account_events StakeTransferred stream at /api/v1/chain/stake-transfers — never a file.
  /^chain\/stake-transfers\.json$/,
  // Network-wide concentration aggregated across every subnet's neurons, computed
  // live from the neurons D1 tier at /api/v1/chain/concentration — never a file.
  /^chain\/concentration\.json$/,
  // Network-wide reward distribution & score spread, computed live from the
  // neurons D1 tier at /api/v1/chain/performance — never a file.
  /^chain\/performance\.json$/,
  // Network-wide recent subnet-identity-change feed, computed live from the
  // subnet_identity_history D1 tier at /api/v1/chain/identity-history — never a file.
  /^chain\/identity-history\.json$/,
  // Network-wide emission yield (return rate), computed live from the neurons D1
  // tier at /api/v1/chain/yield — never a file.
  /^chain\/yield\.json$/,
  // Network-wide validator-set turnover across every subnet, computed live from the
  // neuron_daily D1 rollup at /api/v1/chain/turnover — never a file.
  /^chain\/turnover\.json$/,
  // Postgres-backed all-events tier (ADR 0013): the recent-events feed, the
  // per-block all-events list, and the activity-stats aggregate are served live
  // by the dedicated data Worker at /api/v1/chain-events* — never written as
  // files. R2-only so the contract maps a schema without the build expecting a
  // committed/staged artifact (mirrors the sibling live D1 routes).
  /^chain-events\.json$/,
  /^chain-events\/stats\.json$/,
  /^blocks\/(?:\d+|0x[0-9a-fA-F]{64}|\{ref\})\/chain-events\.json$/,
  // Network-wide economics time series (#1307): aggregated live per UTC day from
  // the subnet_snapshots D1 rollup at /api/v1/economics/trends — never a file.
  /^economics\/trends\.json$/,
  /^registry\/leaderboards\.json$/,
  // Cross-subnet comparison (#1664), composed live from registry projections +
  // the economics tier + D1 at /api/v1/compare — never written as a file. R2-only
  // like its sibling live routes so the contract maps a schema to the route
  // without the build expecting a committed/staged artifact.
  /^compare\.json$/,
  // Validator-side comparison (#6325), composed live from the neurons tier at
  // /api/v1/compare/validators — never written as a file. Same R2-only
  // reasoning as its subnet-side sibling above.
  /^compare\/validators\.json$/,
  // RPC reverse-proxy usage analytics (B3), computed live from D1 telemetry at
  // /api/v1/rpc/usage — never written as a file.
  /^rpc\/usage\.json$/,
  // Per-subnet agent capability catalog (full service detail) — large, built.
  /^agent-catalog\/(?:\d+|\{netuid\})\.json$/,
  /^metagraph\/latest\.json$/,
  /^profiles\/(?:\d+|\{netuid\})\.json$/,
  /^providers\/[^/]+\.json$/,
  /^providers\/[^/]+\/endpoints\.json$/,
  /^review-queue\.json$/,
  /^review\/enrichment-evidence\.json$/,
  /^review\/enrichment-targets\.json$/,
  /^review\/gaps\/(?:\d+|\{netuid\})\.json$/,
  /^rpc\/pools\.json$/,
  /^rpc-endpoints\.json$/,
  /^schemas\/(?!index\.json$).+\.json$/,
  // Per-surface captured live fixtures (issue #352) — R2-only like the schema
  // detail. The fixtures.json INDEX is R2-only too: it's only ever populated by
  // the production capture step, so a committed/dual copy is always the empty
  // no-capture build — and dual artifacts serve ASSETS-first, so the populated R2
  // index was never read (the index served fixture_count:0 while the R2 bodies
  // served fine). R2-only makes the index serve from R2 like the bodies.
  /^fixtures\/.+\.json$/,
  /^fixtures\.json$/,
  /^source-health\.json$/,
  /^source-snapshots\.json$/,
  /^subnets\/(?:\d+|\{netuid\})\.json$/,
  /^surfaces\/(?:\d+|\{netuid\})\.json$/,
  /^verification\/latest\.json$/,
  /^verification\/subnets\/(?:\d+|\{netuid\})\.json$/,
  // High-churn data moved out of git (ADR 0001): derived from committed inputs +
  // live enrichment, built to dist/, served from R2 + edge cache, never
  // committed. ~4.3 MB of per-refresh churn eliminated. Their readers are
  // tier-aware (artifactFilePath / kv-publish) or tolerate a null (sync-summary).
  // (build-summary/r2-manifest and subnets/coverage stay dual — they feed
  // ci-verify/publish against a committed baseline.)
  // changelog.json (#1003): a diff-against-self "what changed since last publish"
  // feed. Committing it made bulk seed-refreshes non-reproducible (#998 v2) —
  // its content is a diff of the (live-enriched, non-deterministic) data seeds,
  // so a fresh rebuild never matched the committed copy. Now R2-only: built to
  // dist/, served from R2; its diff baseline is still the committed subnets/
  // coverage seeds (unchanged), and dispatch-webhooks reads it tier-aware.
  /^changelog\.json$/,
  // Agent-facing data indexes moved out of git (#1003, ADR-0006 end state): the
  // capability catalog, the AI-resources index, and the cross-network lineage
  // map. Live-data/registry-derived and served tier-aware from R2; only the
  // reproducible contract (openapi/types/contracts/api-index/schemas-index) and
  // the prober's operational-surfaces list (DUAL — see below) stay committed.
  /^agent-catalog\.json$/,
  /^agent-resources\.json$/,
  /^lineage\.json$/,
  // The live-data seeds (#1003): the chain-snapshot subnet index + the coverage
  // rollup. Non-reproducible (live-enriched), so they drove the bulk-refresh
  // reproducibility wall (#998). Now R2-only; the changelog's "since last
  // publish" diff is computed at publish time against the previous R2 publish
  // (scripts/build-changelog.mjs), not a committed baseline.
  /^subnets\.json$/,
  /^coverage\.json$/,
  /^coverage-depth\.json$/,
  // #1009: per-subnet validator/economic entity. Pure chain-state (stake,
  // emission share, registration cost) that changes every block — republished
  // each sync, never a committed seed.
  /^economics\.json$/,
  // Build STATS digest (#1003): machine-derived counts/sizes/inventory — not
  // infra-critical (nothing requires it committed); served at /api/v1/build from
  // R2. (r2-manifest.json stays committed as publish infrastructure — the
  // upload/kv/verify pipeline reads it like a lockfile.)
  /^build-summary\.json$/,
  /^curation\.json$/,
  /^evidence-ledger\.json$/,
  /^freshness\.json$/,
  /^gaps\.json$/,
  /^profiles\.json$/,
  /^providers\.json$/,
  /^registry-summary\.json$/,
  /^review\/adapter-candidates\.json$/,
  /^review\/curation\.json$/,
  /^review\/enrichment-queue\.json$/,
  /^review\/gap-priorities\.json$/,
  /^review\/maintainer-decisions\.json$/,
  // Per-subnet completeness scores + gaps (#1010): build-generated, large
  // (350 KB–1 MB), high-churn — R2-only like its review/ siblings above. It was
  // mis-tiered as git (committed) only because it was absent from BOTH pattern
  // lists, so the reproducibility gate treated its rebuild as an unexpected
  // committed change and rejected the refresh (#998 v1). Now R2-only: built to
  // dist/ + served from R2, never committed.
  /^review\/profile-completeness\.json$/,
  /^schema-drift\.json$/,
  /^search\.json$/,
  // Slim companion to search.json: the same documents without the per-document
  // `tokens` keyword blobs, for fast browser typeahead/listing. Derived from the
  // same live-enriched registry data as search.json, so it is R2-only too.
  /^search-index\.json$/,
  /^surface-aliases\.json$/,
  /^surfaces\.json$/,
  // The rendered Open Graph card (#6502): built at publish time
  // (scripts/refresh-og-image.mjs, Node context) from the same live stats as
  // registry-summary.json above, so it's R2-only too -- served by the live
  // Worker's /og.png route via a plain binary R2 read (src/og-image.mjs).
  /^og-image\.png$/,
];

// Committed to git (and mirrored to R2): the low-churn, consumer-facing API
// contract plus the small coverage "shop window". These only change when the
// API/schema changes — exactly what belongs in version control.
export const DUAL_PATTERNS = [
  /^api-index\.json$/,
  // r2-manifest.json: the publish MANIFEST (what's in R2 + per-artifact hashes),
  // read by the upload/kv/verify pipeline — kept committed as publish
  // infrastructure (like a lockfile). build-summary (build stats) + changelog
  // moved to R2-only (#1003); only the reproducible contract + this manifest
  // remain committed.
  /^r2-manifest\.json$/,
  /^contracts\.json$/,
  /^openapi\.json$/,
  /^schemas\/index\.json$/,
  /^types\.d\.ts$/,
  // The cron prober's own input list. It is deterministic (probe-enabled overlay
  // surfaces, sorted, with a fixed-epoch generated_at), so it is committable like
  // the contract files. #1017 made it R2-only, which created a SPOF: the prober
  // reads it ASSETS-first then R2, but with no committed copy the ASSETS read
  // 404s and the prober depends on the data publish's R2 latest/ surviving — so a
  // publish outage eventually freezes the *live* health tier too. DUAL (committed
  // + R2-mirrored) decouples the prober from the publish: its ASSETS read always
  // succeeds from the deployed bundle. The #1025 freshness gate keeps it current.
  /^operational-surfaces\.json$/,
];

// R2-preferred dual artifacts: now EMPTY. subnets/coverage were the last
// members; they moved to plain R2-only (#1003), so no committed artifact needs
// R2-first serving anymore — the only remaining dual artifacts are the
// reproducible contract, which is correct to serve ASSETS-first. Kept as an
// (empty) extension point and for the exported isR2PreferredDualArtifactPath()
// contract.
const R2_PREFERRED_DUAL_PATTERNS = [];

export function isR2PreferredDualArtifactPath(artifactPath = "") {
  const normalized = artifactRelativePath(artifactPath);
  if (
    artifactStorageTierForRelativePath(normalized) !==
    ARTIFACT_STORAGE_TIERS.dual
  ) {
    return false;
  }
  return R2_PREFERRED_DUAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function artifactRelativePath(artifactPath = "") {
  const value = String(artifactPath);
  const normalized = value.replace(/^\/+/, "");
  if (value.startsWith("/") && normalized.startsWith("metagraph/")) {
    return normalized.replace(/^metagraph\//, "");
  }
  return normalized;
}

export function isGeneratedPublicArtifactRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  return DUAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Friendly key segments for the non-default Bittensor networks. Their data lives
// under metagraph/{prefix}/... and is R2-only (never committed) — the mainnet
// (finney) registry stays unprefixed and keeps its existing dual/git/r2 tiers.
export const NETWORK_KEY_PREFIXES = ["testnet", "local"];

export function artifactStorageTierForRelativePath(relativePath = "") {
  const normalized = artifactRelativePath(relativePath);
  // Non-default network artifacts (testnet/…, local/…) are R2-only regardless of
  // what the unprefixed equivalent would be — secondary-network data is large and
  // sparse, so it is never committed to git.
  if (
    NETWORK_KEY_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}/`))
  ) {
    return ARTIFACT_STORAGE_TIERS.r2;
  }
  if (R2_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return ARTIFACT_STORAGE_TIERS.r2;
  }
  if (isGeneratedPublicArtifactRelativePath(normalized)) {
    return ARTIFACT_STORAGE_TIERS.dual;
  }
  return ARTIFACT_STORAGE_TIERS.git;
}

export function artifactStorageTierForPath(artifactPath = "") {
  return artifactStorageTierForRelativePath(artifactRelativePath(artifactPath));
}

export function schemaDetailArtifactRelativePath(artifactPath = "") {
  const relativePath = artifactRelativePath(artifactPath);
  if (!relativePath || relativePath === "schemas/index.json") {
    return null;
  }
  if (!relativePath.startsWith("schemas/") || !relativePath.endsWith(".json")) {
    return null;
  }
  if (relativePath.includes("\\")) {
    return null;
  }
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return relativePath;
}

export function isR2OnlyArtifactPath(artifactPath = "") {
  return artifactStorageTierForPath(artifactPath) === ARTIFACT_STORAGE_TIERS.r2;
}
