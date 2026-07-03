// Supplemental OpenAPI CSV examples for routes whose handlers live outside
// analytics-routes.mjs. Kept in a dedicated module so parallel CSV PRs can add
// examples without contending on the csvExampleForRoute if-chain in contracts.mjs.
export const ROUTE_CSV_EXAMPLES = {
  "subnet-yield": [
    "uid,hotkey,role,stake_tao,emission_tao,yield,vs_median",
    "0,hk_sample,validator,1000,22.1,0.0221,above",
  ].join("\r\n"),
};
