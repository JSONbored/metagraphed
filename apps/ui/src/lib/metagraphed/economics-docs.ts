/**
 * Static reference copy for the `/economics` docs page (#3509).
 *
 * Paths, filters, sort fields, and windows mirror the `economics` /
 * `economics-trends` route contracts in `src/contracts.mjs` — keep them in sync
 * when the Worker contract changes. The UI cannot import Worker `.mjs` modules,
 * so these are intentional literals.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3509
 */

export const ECONOMICS_PATH = "/api/v1/economics";
export const ECONOMICS_TRENDS_PATH = "/api/v1/economics/trends";

/** Static artifact backing the list route (trends is computed live). */
export const ECONOMICS_ARTIFACT_PATH = "/metagraph/economics.json";

/** Keep aligned with the `limit` schema in listQuery (src/contracts.mjs). */
export const ECONOMICS_MAX_LIMIT = 1000;

/** Keep aligned with the `window` enum on the economics-trends route. */
export const ECONOMICS_TRENDS_WINDOWS = ["7d", "30d", "90d", "1y", "all"] as const;

export type EconomicsTrendsWindow = (typeof ECONOMICS_TRENDS_WINDOWS)[number];

export const ECONOMICS_TRENDS_DEFAULT_WINDOW: EconomicsTrendsWindow = "30d";

/** Keep aligned with API_QUERY_COLLECTIONS.economics.search in src/contracts.mjs. */
export const ECONOMICS_SEARCH_KEYS = ["name", "slug"] as const;

/** Keep aligned with API_QUERY_COLLECTIONS.economics.sort in src/contracts.mjs. */
export const ECONOMICS_SORT_FIELDS = [
  "alpha_fdv_tao",
  "alpha_market_cap_tao",
  "alpha_price_tao",
  "block",
  "emission_share",
  "max_stake_tao",
  "max_uids",
  "max_validators",
  "miner_count",
  "miner_readiness",
  "name",
  "netuid",
  "open_slots",
  "registration_cost_tao",
  "subnet_volume_tao",
  "total_stake_tao",
  "validator_count",
] as const;

export type EconomicsSurfaceDoc = {
  method: string;
  path: string;
  summary: string;
  notes: string;
};

export const ECONOMICS_SURFACES: readonly EconomicsSurfaceDoc[] = [
  {
    method: "GET",
    path: ECONOMICS_PATH,
    summary: "Per-subnet economic metrics",
    notes:
      "Counts, stake, registration cost, alpha price, alpha market-cap and FDV proxies, emission share, and registration block. Served from the economics artifact; ordered by emission share descending by default.",
  },
  {
    method: "GET",
    path: ECONOMICS_TRENDS_PATH,
    summary: "Network-wide time series",
    notes:
      "One row per UTC day across all subnets, aggregated live from the daily subnet_snapshots rollup — the same source the per-subnet /trajectory reads. No static file; returns day_count 0 and an empty days[] while the rollup is cold.",
  },
] as const;

export type EconomicsParamDoc = {
  param: string;
  value: string;
  detail: string;
};

/** Query params on GET /api/v1/economics (filters + search + list controls). */
export const ECONOMICS_PARAMS: readonly EconomicsParamDoc[] = [
  {
    param: "q",
    value: "<text>",
    detail: `Search across ${ECONOMICS_SEARCH_KEYS.join(" and ")}.`,
  },
  { param: "netuid", value: "<integer>", detail: "Restrict to a single subnet." },
  {
    param: "registration_allowed",
    value: "true | false",
    detail: "Only subnets whose registration is currently open (or closed).",
  },
  {
    param: "sort",
    value: "<field>",
    detail:
      "The bare field name only (see the sortable fields below). A combined `field:desc` token is NOT supported — pair it with `order`.",
  },
  { param: "order", value: "asc | desc", detail: "Direction for `sort`. Defaults to desc." },
  {
    param: "limit",
    value: `1..${ECONOMICS_MAX_LIMIT}`,
    detail: "Page size.",
  },
  { param: "cursor", value: "<integer>", detail: "Offset cursor for the next page." },
  { param: "fields", value: "<a,b,c>", detail: "Project a comma-separated subset of fields." },
  {
    param: "format",
    value: "json | csv",
    detail: "`csv` downloads the transformed list as text/csv; `json` keeps the response envelope.",
  },
] as const;

/** Per-day metrics returned by the trends route. */
export const ECONOMICS_TRENDS_METRICS = [
  "total stake",
  "stake-weighted alpha price",
  "median alpha price",
  "total validator count",
  "total miner count",
  "mean emission share",
] as const;

export function buildEconomicsCurlExample(apiBase: string): string {
  const base = apiBase.replace(/\/$/, "");
  return `curl -s '${base}${ECONOMICS_PATH}?sort=alpha_market_cap_tao&order=desc&limit=5'`;
}

export function buildEconomicsTrendsCurlExample(
  apiBase: string,
  window: EconomicsTrendsWindow = ECONOMICS_TRENDS_DEFAULT_WINDOW,
): string {
  const base = apiBase.replace(/\/$/, "");
  return `curl -s '${base}${ECONOMICS_TRENDS_PATH}?window=${window}'`;
}

/** Expected surface count — guards accidental drift. */
export const ECONOMICS_SURFACE_COUNT = 2;

/** Expected sortable-field count — guards drift against the Worker contract. */
export const ECONOMICS_SORT_FIELD_COUNT = 17;
