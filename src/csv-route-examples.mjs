// Supplemental OpenAPI CSV examples for routes whose handlers live outside
// analytics-routes.mjs. Kept in a dedicated module so parallel CSV PRs can add
// examples without contending on the csvExampleForRoute if-chain in contracts.mjs.
export const ROUTE_CSV_EXAMPLES = {
  "chain-events-feed": [
    "block_number,event_index,pallet,method,args,phase,extrinsic_index,observed_at",
    '123,0,System,ExtrinsicSuccess,"{""x"":1}",ApplyExtrinsic,2,100',
  ].join("\r\n"),
  "subnet-yield": [
    "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    "0,hk_sample,validator,1000,22.1,0.0221,above",
  ].join("\r\n"),
};
