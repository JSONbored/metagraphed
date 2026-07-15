/**
 * Static reference copy for the `/chain` docs page.
 *
 * Paths, windows, enums, and limits mirror `workers/api.mjs` +
 * `workers/request-handlers/analytics.mjs` + `workers/config.mjs` — keep them in
 * sync when the Worker chain-analytics contract changes. The UI cannot import
 * Worker `.mjs` modules, so these are intentional literals.
 */

/** Keep aligned with ANALYTICS_WINDOWS in workers/config.mjs */
export const CHAIN_DOCS_WINDOWS = ["7d", "30d"] as const;

export type ChainDocsWindow = (typeof CHAIN_DOCS_WINDOWS)[number];

/** Keep aligned with DEFAULT_ANALYTICS_WINDOW in workers/config.mjs */
export const CHAIN_DOCS_DEFAULT_WINDOW: ChainDocsWindow = "7d";

/** Keep aligned with ANALYTICS_WINDOW_PARAM in workers/config.mjs */
export const CHAIN_DOCS_WINDOW_PARAM = "window";

/** Keep aligned with CHAIN_SIGNERS_SORTS in src/chain-query-loaders.mjs */
export const CHAIN_DOCS_SIGNERS_SORTS = ["tx_count", "total_fee_tao"] as const;

/** Keep aligned with the group_by enum on handleChainCalls */
export const CHAIN_DOCS_CALLS_GROUP_BY = ["module", "module_function"] as const;

/** Keep aligned with validateFormatParam in workers/request-handlers/analytics.mjs */
export const CHAIN_DOCS_FORMATS = ["json", "csv"] as const;

/** Keep aligned with the parseLimitParam maxLimit shared by calls/signers/fees */
export const CHAIN_DOCS_MAX_LIMIT = 100;

/** Keep aligned with parseLimitParam defaultLimit on handleChainCalls / handleChainSigners */
export const CHAIN_DOCS_DEFAULT_LIMIT = 50;

/** Keep aligned with parseLimitParam defaultLimit on handleChainFees */
export const CHAIN_DOCS_FEES_DEFAULT_LIMIT = 25;

/** Keep aligned with the validateMaxLength(url, "call_module", 100) guard */
export const CHAIN_DOCS_CALL_MODULE_MAX_LENGTH = 100;

export const CHAIN_ACTIVITY_PATH = "/api/v1/chain/activity";
export const CHAIN_CALLS_PATH = "/api/v1/chain/calls";
export const CHAIN_SIGNERS_PATH = "/api/v1/chain/signers";
export const CHAIN_FEES_PATH = "/api/v1/chain/fees";

export type ChainAnalyticsParamDoc = {
  name: string;
  values: string;
  detail: string;
};

export type ChainAnalyticsRouteDoc = {
  path: string;
  method: "GET";
  title: string;
  summary: string;
  params: readonly ChainAnalyticsParamDoc[];
  responseFields: readonly string[];
  csvColumns: readonly string[];
};

const WINDOW_PARAM: ChainAnalyticsParamDoc = {
  name: "window",
  values: CHAIN_DOCS_WINDOWS.join(" | "),
  detail: `Rolling UTC window. Defaults to ${CHAIN_DOCS_DEFAULT_WINDOW}; any other value is rejected.`,
};

const FORMAT_PARAM: ChainAnalyticsParamDoc = {
  name: "format",
  values: CHAIN_DOCS_FORMATS.join(" | "),
  detail: "csv returns the row-shaped table below; json returns the full envelope.",
};

const CALL_MODULE_PARAM: ChainAnalyticsParamDoc = {
  name: "call_module",
  values: `string ≤ ${CHAIN_DOCS_CALL_MODULE_MAX_LENGTH}`,
  detail: "Optional pallet scope, backed by idx_extrinsics_module_block.",
};

/** The four chain-analytics routes, as routed in workers/api.mjs. */
export const CHAIN_ANALYTICS_ROUTES: readonly ChainAnalyticsRouteDoc[] = [
  {
    path: CHAIN_ACTIVITY_PATH,
    method: "GET",
    title: "Activity",
    summary:
      "Daily network aggregates — block/extrinsic/event counts, success rate, and unique signers, newest day first.",
    params: [WINDOW_PARAM, FORMAT_PARAM],
    responseFields: ["schema_version", "window", "day_count", "days[]", "observed_at"],
    csvColumns: [
      "day",
      "block_count",
      "extrinsic_count",
      "event_count",
      "successful_extrinsics",
      "success_rate",
      "unique_signers",
    ],
  },
  {
    path: CHAIN_CALLS_PATH,
    method: "GET",
    title: "Calls",
    summary:
      "Extrinsic call-mix breakdown — count and share per pallet, or per pallet/function with group_by=module_function.",
    params: [
      WINDOW_PARAM,
      {
        name: "group_by",
        values: CHAIN_DOCS_CALLS_GROUP_BY.join(" | "),
        detail: "Defaults to module. module_function adds call_function to every row.",
      },
      {
        name: "limit",
        values: `1–${CHAIN_DOCS_MAX_LIMIT}`,
        detail: `Defaults to ${CHAIN_DOCS_DEFAULT_LIMIT}. Shares use the full-window denominator, so a truncated tail never skews them.`,
      },
      CALL_MODULE_PARAM,
      FORMAT_PARAM,
    ],
    responseFields: [
      "schema_version",
      "window",
      "group_by",
      "total_extrinsics",
      "call_count",
      "calls[]",
      "observed_at",
    ],
    csvColumns: ["call_module", "count", "share"],
  },
  {
    path: CHAIN_SIGNERS_PATH,
    method: "GET",
    title: "Signers",
    summary:
      "Most-active-account leaderboard — signers ranked by extrinsic count or total fees paid, with the newest signed block.",
    params: [
      WINDOW_PARAM,
      {
        name: "sort",
        values: CHAIN_DOCS_SIGNERS_SORTS.join(" | "),
        detail: "Defaults to tx_count.",
      },
      {
        name: "limit",
        values: `1–${CHAIN_DOCS_MAX_LIMIT}`,
        detail: `Defaults to ${CHAIN_DOCS_DEFAULT_LIMIT}.`,
      },
      CALL_MODULE_PARAM,
      FORMAT_PARAM,
    ],
    responseFields: [
      "schema_version",
      "window",
      "sort",
      "signer_count",
      "signers[]",
      "observed_at",
    ],
    csvColumns: ["signer", "tx_count", "total_fee_tao", "total_tip_tao", "last_tx_block"],
  },
  {
    path: CHAIN_FEES_PATH,
    method: "GET",
    title: "Fees",
    summary:
      "Fee/tip market — a per-UTC-day series with totals, averages, and exact medians, plus a windowed top-fee-payer list.",
    params: [
      WINDOW_PARAM,
      {
        name: "limit",
        values: `1–${CHAIN_DOCS_MAX_LIMIT}`,
        detail: `Defaults to ${CHAIN_DOCS_FEES_DEFAULT_LIMIT}. Bounds top_fee_payers only — the daily series always covers the window.`,
      },
      CALL_MODULE_PARAM,
      FORMAT_PARAM,
    ],
    responseFields: [
      "schema_version",
      "window",
      "day_count",
      "daily[]",
      "top_fee_payers[]",
      "observed_at",
    ],
    csvColumns: [
      "day",
      "extrinsic_count",
      "total_fee_tao",
      "avg_fee_tao",
      "median_fee_tao",
      "total_tip_tao",
      "avg_tip_tao",
      "median_tip_tao",
    ],
  },
] as const;

export type ChainBehaviourRow = {
  label: string;
  value: string;
  detail: string;
};

/** Render a default/max pair for the behaviour table (e.g. "50 default · 100 max"). */
export function formatChainLimitRange(defaultLimit: number, maxLimit: number): string {
  if (!Number.isFinite(defaultLimit) || !Number.isFinite(maxLimit)) return "—";
  return `${defaultLimit} default · ${maxLimit} max`;
}

export function buildChainBehaviourRows(): ChainBehaviourRow[] {
  return [
    {
      label: "Window",
      value: CHAIN_DOCS_WINDOWS.join(" | "),
      detail: `Defaults to ${CHAIN_DOCS_DEFAULT_WINDOW}. An unsupported window is a 400, not a clamp.`,
    },
    {
      label: "Result limit",
      value: formatChainLimitRange(CHAIN_DOCS_DEFAULT_LIMIT, CHAIN_DOCS_MAX_LIMIT),
      detail: `calls and signers. fees defaults to ${CHAIN_DOCS_FEES_DEFAULT_LIMIT} payers.`,
    },
    {
      label: "Unknown params",
      value: "400",
      detail: "Every route allowlists its params, and each may be supplied only once.",
    },
    {
      label: "Cold store",
      value: "schema-stable",
      detail: "Empty lists with zeroed counts rather than an error before the first snapshot.",
    },
    {
      label: "Caching",
      value: "edge, short",
      detail:
        "Keyed on the resolved window, so a bare request and an explicit default share one entry.",
    },
    {
      label: "Source tier",
      value: "Postgres → D1",
      detail: "Falls back to the first-party D1 chain tiers when the Postgres tier is unavailable.",
    },
  ];
}

export function chainAnalyticsUrl(
  apiBase: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const base = apiBase.replace(/\/$/, "");
  const search = new URLSearchParams(params).toString();
  return `${base}${path}${search ? `?${search}` : ""}`;
}

export function buildChainCurlExample(apiBase: string): string {
  const url = chainAnalyticsUrl(apiBase, CHAIN_ACTIVITY_PATH, {
    [CHAIN_DOCS_WINDOW_PARAM]: CHAIN_DOCS_DEFAULT_WINDOW,
  });
  return `curl -s '${url}'`;
}

export function buildChainCsvCurlExample(apiBase: string): string {
  const url = chainAnalyticsUrl(apiBase, CHAIN_FEES_PATH, {
    [CHAIN_DOCS_WINDOW_PARAM]: "30d",
    format: "csv",
  });
  return `curl -s '${url}'`;
}

/** Expected route count — guards accidental drift from the Worker router. */
export const CHAIN_ANALYTICS_ROUTE_COUNT = 4;
