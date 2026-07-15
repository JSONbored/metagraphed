/**
 * Static reference copy for the `/graphql` docs page (#3513).
 *
 * Numbers and root fields mirror `src/graphql.mjs` — keep them in sync when
 * the Worker GraphQL contract changes. The UI cannot import Worker `.mjs`
 * modules, so these are intentional literals.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3513
 */

/** Keep aligned with GRAPHQL_MAX_DEPTH in src/graphql.mjs */
export const GRAPHQL_DOCS_MAX_DEPTH = 7;

/** Keep aligned with GRAPHQL_MAX_COMPLEXITY in src/graphql.mjs */
export const GRAPHQL_DOCS_MAX_COMPLEXITY = 50;

/** Keep aligned with GRAPHQL_MAX_BODY_BYTES in src/graphql.mjs */
export const GRAPHQL_DOCS_MAX_BODY_BYTES = 64 * 1024;

/** Keep aligned with GRAPHQL_MAX_QUERY_BYTES in src/graphql.mjs */
export const GRAPHQL_DOCS_MAX_QUERY_BYTES = 16 * 1024;

/** Keep aligned with DEFAULT_PAGE_LIMIT in src/graphql.mjs */
export const GRAPHQL_DOCS_DEFAULT_PAGE_LIMIT = 20;

/** Keep aligned with MAX_PAGE_LIMIT in src/graphql.mjs */
export const GRAPHQL_DOCS_MAX_PAGE_LIMIT = 100;

/**
 * Shared rate limit with the RPC proxy — see workers/request-handlers/rpc-proxy.mjs
 * (`gql:${ip}` / 100 requests per 60s).
 */
export const GRAPHQL_DOCS_RATE_LIMIT_REQUESTS = 100;
export const GRAPHQL_DOCS_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Relationship roots carry complexity weight 5 in src/graphql.mjs. */
export const GRAPHQL_DOCS_RELATIONSHIP_FIELD_COST = 5;

export const GRAPHQL_ENDPOINT_PATH = "/api/v1/graphql";

export type GraphQLRootQueryDoc = {
  name: string;
  args: string;
  returns: string;
  summary: string;
};

/** Root Query fields from the published SDL (src/graphql.mjs). */
export const GRAPHQL_ROOT_QUERIES: readonly GraphQLRootQueryDoc[] = [
  {
    name: "subnets",
    args: "limit, cursor",
    returns: "SubnetList!",
    summary: "Paginated active-subnet index.",
  },
  {
    name: "subnet",
    args: "netuid!",
    returns: "Subnet",
    summary: "One subnet with health, surfaces, endpoints, and economics.",
  },
  {
    name: "providers",
    args: "limit, cursor",
    returns: "ProviderList!",
    summary: "Paginated provider/source registry.",
  },
  {
    name: "provider",
    args: "id!",
    returns: "Provider",
    summary: "One provider with its subnets.",
  },
  {
    name: "economics",
    args: "limit, cursor",
    returns: "EconomicsList!",
    summary: "Paginated per-subnet economic + validator metrics.",
  },
  {
    name: "surfaces",
    args: "netuid, limit, cursor",
    returns: "SurfaceList!",
    summary: "Curated public surfaces, optionally scoped to one subnet.",
  },
  {
    name: "endpoints",
    args: "netuid, limit, cursor",
    returns: "EndpointList!",
    summary: "Endpoint/resource registry, optionally scoped to one subnet.",
  },
  {
    name: "health",
    args: "—",
    returns: "GlobalHealth",
    summary: "Global operational health rollup with per-subnet summaries.",
  },
  {
    name: "opportunity_boards",
    args: "limit",
    returns: "OpportunityBoards!",
    summary: "Cross-subnet economic opportunity boards.",
  },
  {
    name: "compare",
    args: "netuids!, dimensions",
    returns: "Compare!",
    summary: "Side-by-side registry / economics / health for requested netuids.",
  },
] as const;

export type GraphQLLimitRow = {
  label: string;
  value: string;
  detail: string;
};

/** Format a byte budget for the limits table (e.g. 65536 → "64 KiB"). */
export function formatGraphqlByteBudget(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}

export function buildGraphqlLimitRows(): GraphQLLimitRow[] {
  return [
    {
      label: "Max depth",
      value: String(GRAPHQL_DOCS_MAX_DEPTH),
      detail: "Nested selection sets beyond this fail validation.",
    },
    {
      label: "Max complexity",
      value: String(GRAPHQL_DOCS_MAX_COMPLEXITY),
      detail: `Default field cost 1; relationship roots cost ${GRAPHQL_DOCS_RELATIONSHIP_FIELD_COST}.`,
    },
    {
      label: "Max POST body",
      value: formatGraphqlByteBudget(GRAPHQL_DOCS_MAX_BODY_BYTES),
      detail: "HTTP request body size cap for POST /api/v1/graphql.",
    },
    {
      label: "Max query document",
      value: formatGraphqlByteBudget(GRAPHQL_DOCS_MAX_QUERY_BYTES),
      detail: "Raw query string / document length cap.",
    },
    {
      label: "Page size",
      value: `${GRAPHQL_DOCS_DEFAULT_PAGE_LIMIT} default · ${GRAPHQL_DOCS_MAX_PAGE_LIMIT} max`,
      detail: "Cursor pagination on list roots (subnets, providers, …).",
    },
    {
      label: "Rate limit",
      value: `${GRAPHQL_DOCS_RATE_LIMIT_REQUESTS} / ${GRAPHQL_DOCS_RATE_LIMIT_WINDOW_SECONDS}s`,
      detail: "Per-client IP, shared policy with the RPC proxy (429 + retry-after).",
    },
  ];
}

/** Example shaped query from README / machine surfaces. */
export const GRAPHQL_EXAMPLE_QUERY =
  "{ subnet(netuid: 7) { name health { status } surfaces { kind url } economics { emission_share } } }";

export function buildGraphqlCurlExample(apiBase: string): string {
  const base = apiBase.replace(/\/$/, "");
  return [
    `curl -X POST ${base}${GRAPHQL_ENDPOINT_PATH} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"query":"${GRAPHQL_EXAMPLE_QUERY}"}'`,
  ].join("\n");
}

/** Expected root query count — guards accidental drift from the Worker SDL. */
export const GRAPHQL_ROOT_QUERY_COUNT = 10;
