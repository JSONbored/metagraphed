// Supplemental OpenAPI CSV examples for routes whose handlers live outside
// analytics-routes.mjs. Kept in a dedicated module so parallel CSV PRs can add
// examples without contending on the csvExampleForRoute if-chain in contracts.mjs.
// Shared header/example for the two event-stream feeds (subnet + account), which
// serialize the same formatAccountEvent row shape.
const EVENTS_CSV_EXAMPLE = [
  "block_number,event_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at,extrinsic_index",
  "8454388,3,StakeAdded,5Hotkey_sample,5Coldkey_sample,7,3,12.5,,2026-07-03T00:00:00.000Z,2",
].join("\r\n");

export const ROUTE_CSV_EXAMPLES = {
  "subnet-yield": [
    "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    "0,hk_sample,validator,1000,22.1,0.0221,above",
  ].join("\r\n"),
  "subnet-events": EVENTS_CSV_EXAMPLE,
  "account-events": EVENTS_CSV_EXAMPLE,
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
