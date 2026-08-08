// Supplemental OpenAPI CSV examples for routes whose handlers live outside
// workers/request-handlers/analytics-routes.ts. Kept in a dedicated module so parallel CSV PRs can add
// examples without contending on the csvExampleForRoute if-chain in contracts.ts.
// Shared header/example for the two event-stream feeds (subnet + account), which
// serialize the same formatAccountEvent row shape.
// price_at_tx / price_basis close #9537: both are on every JSON event row and
// were missing from this projection. The sample row now carries a real
// alpha_amount too -- a StakeAdded with an empty alpha leg was never a shape
// production emits, and it made the derived price columns un-illustratable.
// price_at_tx is amount_tao / alpha_amount at rao precision (12.5 / 440,
// resolvePriceAtTx -> roundUnit), so the example stays arithmetically true.
const EVENTS_CSV_EXAMPLE = [
  "block_number,event_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at,extrinsic_index,price_at_tx,price_basis",
  "8454388,3,StakeAdded,5Hotkey_sample,5Coldkey_sample,7,3,12.5,440,2026-07-03T00:00:00.000Z,2,0.028409091,trade_exact",
].join("\r\n");

export const ROUTE_CSV_EXAMPLES: Record<string, string> = {
  "subnet-concentration-history": [
    "snapshot_date,neuron_count,stake_gini,stake_nakamoto_coefficient,stake_top_10pct_share,emission_gini,emission_nakamoto_coefficient,emission_top_10pct_share",
    "2026-06-27,2,0.490099,1,0.990099,0.409091,1,0.909091",
  ].join("\r\n"),
  "subnet-yield": [
    "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    "0,hk_sample,validator,1000,22.1,0.0221,above",
  ].join("\r\n"),
  "subnet-yield-history": [
    "snapshot_date,neuron_count,validator_count,yield_count,subnet_yield,mean_yield,median_yield,p25_yield,p75_yield,p90_yield",
    "2026-06-27,2,1,2,0.075,0.075,0.075,0.05,0.1,0.1",
  ].join("\r\n"),
  "subnet-performance-history": [
    "snapshot_date,neuron_count,validator_count,active_count,incentive_gini,incentive_nakamoto_coefficient,incentive_top_10pct_share,dividends_gini,dividends_nakamoto_coefficient,dividends_top_10pct_share,trust_mean,trust_median,consensus_mean,consensus_median,validator_trust_mean,validator_trust_median",
    "2026-06-27,2,1,2,0.490099,1,0.990099,0.409091,1,0.909091,0.5,0.5,0.4,0.4,0.6,0.6",
  ].join("\r\n"),
  "subnet-hyperparameters-history": [
    "block_number,observed_at,hyperparameters,hyperparams_hash",
    '8454388,2026-06-27T00:00:00.000Z,"{""kappa"":0.5}",hash_sample',
  ].join("\r\n"),
  // The formatIdentityHistoryEntry row shape (src/subnet-identity-history.ts):
  // one SubnetIdentitiesV3 snapshot per row.
  "subnet-identity-history": [
    "block_number,observed_at,subnet_name,symbol,description,github_repo,subnet_url,discord,logo_url,identity_hash",
    "8454388,2026-06-27T00:00:00.000Z,Apex,APEX,Sample subnet,https://github.com/example/apex,https://apex.example,https://discord.gg/apex,https://apex.example/logo.png,hash_sample",
  ].join("\r\n"),
  // The formatAccountIdentityHistoryEntry row shape
  // (src/account-identity-history.ts): keyed by account, so no block_number and
  // the account_identity field names (name/url/github/image/additional).
  "account-identity-history": [
    "observed_at,name,url,github,image,discord,description,additional,identity_hash",
    "2026-06-27T00:00:00.000Z,Alice,https://alice.example,https://github.com/alice,https://alice.example/avatar.png,https://discord.gg/alice,Sample account,extra,hash_sample",
  ].join("\r\n"),
  "subnet-events": EVENTS_CSV_EXAMPLE,
  "account-events": EVENTS_CSV_EXAMPLE,
  // #10090: the block-level event feed serializes the SAME formatChainEvent row
  // shape as the two feeds above, so it shares their example rather than
  // carrying a third copy of the same header. It has served this CSV since it
  // was written; it just never published `format`, so nothing generated from
  // openapi.json could discover the export.
  "block-events": EVENTS_CSV_EXAMPLE,
  "block-extrinsics": [
    "extrinsic_id,block_number,signer,call_module,call_function,success",
    "1000000-4,1000000,5Signer_sample,SubtensorModule,set_weights,true",
  ].join("\r\n"),
  // The DAILY rollup, not the raw events: one row per (day, netuid) with the
  // kinds seen that day joined by `;`, which is why event_kinds is a single
  // column rather than one per kind.
  "account-history": [
    "day,netuid,event_count,event_kinds,first_block,last_block",
    "2026-08-07,0,4,StakeRemoved;StakeAdded,8788696,8791411",
  ].join("\r\n"),
  // One row per (surface, day). uptime_ratio is 0..1, and the latency columns
  // are success-only -- latency_sample_count is their denominator, which is why
  // it rides alongside `samples` rather than being derivable from it.
  "subnet-uptime": [
    "surface_id,day,samples,uptime_ratio,avg_latency_ms,latency_sample_count,p50,p95,p99,status",
    "sn-1-apex-healthcheck,2026-07-21,17,1,632,17,668,691,702,ok",
  ].join("\r\n"),
  // VALIDATOR_NOMINATOR_CSV_COLUMNS (workers/request-handlers/entities.ts). The
  // internal `last_observed_ms` sort key is dropped before the response, so it
  // is deliberately absent here too.
  "validator-nominators": [
    "coldkey,staked_tao,unstaked_tao,net_staked_tao,gross_staked_tao,event_count,last_observed_at",
    "ck_sample,4,0,4,4,1,2026-08-07T21:17:12.000Z",
  ].join("\r\n"),
  // The Postgres all-events feed: flat scalar columns of each raw pallet.method
  // event (the nested `args` object is omitted from the CSV projection).
  "chain-events-feed": [
    "block_number,event_index,pallet,method,phase,extrinsic_index,observed_at",
    "8454388,3,Balances,Transfer,ApplyExtrinsic,2,1751500800000",
  ].join("\r\n"),
  // The /chain/weights per-subnet weight-setting leaderboard rows.
  "chain-weights": [
    "netuid,distinct_setters,weight_sets,sets_per_setter",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/weights/setters network-wide weight-setter leaderboard rows.
  "chain-weight-setters": [
    "hotkey,netuid,uid,weight_sets,share,first_set_at,last_set_at",
    "5Grw_sample,,3,40,0.5714,2026-06-01T00:00:00.000Z,2026-06-07T00:00:00.000Z",
  ].join("\r\n"),
  // The /chain/serving per-subnet axon-serving leaderboard rows.
  "chain-serving": [
    "netuid,distinct_servers,announcements,announcements_per_server",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/prometheus per-subnet Prometheus-endpoint serving leaderboard rows.
  "chain-prometheus": [
    "netuid,distinct_exporters,announcements,announcements_per_exporter",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/axon-removals per-subnet axon-removal leaderboard rows.
  "chain-axon-removals": [
    "netuid,distinct_removers,removals,removals_per_remover",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/registrations per-subnet neuron-registration leaderboard rows.
  "chain-registrations": [
    "netuid,distinct_registrants,registrations,registrations_per_registrant",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/stake-moves per-subnet stake-movement (re-delegation) leaderboard rows.
  "chain-stake-moves": [
    "netuid,distinct_movers,movements,movements_per_mover",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/stake-transfers per-subnet stake-transfer (between-coldkeys) leaderboard rows.
  "chain-stake-transfers": [
    "netuid,distinct_senders,transfers,transfers_per_sender",
    "1,4,40,10",
  ].join("\r\n"),
  // The /chain/transfer-pairs top sender -> receiver corridors.
  "chain-transfer-pairs": [
    "from,to,volume_tao,transfer_count,last_block,last_observed_at",
    "5Sender_sample,5Receiver_sample,1250.5,42,8454388,2026-07-03T00:00:00.000Z",
  ].join("\r\n"),
  // The /chain/turnover per-subnet validator-churn leaderboard rows.
  "chain-turnover": [
    "netuid,validators_start,validators_end,validators_entered,validators_exited,validator_retention,stability_score",
    "1,64,60,8,12,0.8125,81",
  ].join("\r\n"),
};
