// List-query transform helpers for the API Worker — filtering, search, sort,
// and cursor pagination over in-memory artifact collections. Extracted from
// workers/api.mjs (issue #510, de-monolith) as a leaf module: it imports only
// the query-collection contract and nothing from api.mjs, so there is no cycle.
// `applyQueryFilters` is the main public entry; route preflight uses the same
// validator before artifact/cache reads.
import {
  API_QUERY_COLLECTIONS,
  SEARCH_TEXT_MAX_LENGTH,
} from "../src/contracts.ts";
import { linkHeader } from "./http.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT } from "./request-params.ts";

const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Row = Record<string, unknown>;

export interface QueryError {
  parameter: string;
  message: string;
}

export interface FilterSchema {
  type?: string;
  enum?: string[];
  maxLength?: number;
  pattern?: string;
}

export interface QueryCollectionConfig {
  data_key: string;
  filters?: Record<string, FilterSchema>;
  csv_filters?: Record<string, string>;
  array_filters?: Record<string, string[]>;
  range_filters?: string[];
  search_keys?: string[];
  sort_fields?: string[];
}

export interface ApplyQueryFiltersResult {
  data?: unknown;
  meta?: Record<string, unknown>;
  error?: QueryError;
}

export function applyQueryFilters(
  data: Record<string, unknown> | null | undefined,
  url: URL,
  queryCollection: string,
  queryFilterNames: string[] = [],
  { csvResponse = false }: { csvResponse?: boolean } = {},
): ApplyQueryFiltersResult {
  const params = url.searchParams;
  const config = (
    API_QUERY_COLLECTIONS as Record<string, QueryCollectionConfig>
  )[queryCollection];
  if (!config) {
    return { data, meta: {} };
  }
  if (!Array.isArray(data?.[config.data_key])) {
    return { data, meta: {} };
  }
  return applyListTransform(
    data,
    params,
    listQueryConfig(config, queryFilterNames),
    { csvResponse },
  );
}

export function validateListQueryParams(
  url: URL,
  queryCollection: string,
  queryFilterNames: string[] = [],
  { csvResponse = false }: { csvResponse?: boolean } = {},
): QueryError | null {
  const config = (
    API_QUERY_COLLECTIONS as Record<string, QueryCollectionConfig>
  )[queryCollection];
  if (!config) {
    return null;
  }
  return validateListQuery(
    url.searchParams,
    listQueryConfig(config, queryFilterNames),
    { csvResponse },
  );
}

function listQueryConfig(
  config: QueryCollectionConfig,
  queryFilterNames: string[] = [],
): QueryCollectionConfig {
  return {
    ...config,
    filters: Object.fromEntries(
      effectiveFilterNames(config, queryFilterNames).map((name) => [
        name,
        (config.filters || {})[name],
      ]),
    ),
  };
}

function effectiveFilterNames(
  config: QueryCollectionConfig,
  queryFilterNames: string[] = [],
): string[] {
  const filters = config.filters || {};
  return queryFilterNames.length > 0
    ? queryFilterNames.filter((name) => Object.hasOwn(filters, name))
    : Object.keys(filters);
}

// RFC 8288 Link header for a cursor-paginated response (window from
// `paginateRows`): `first`/`prev` when an earlier page exists, `next`/`last`
// when a later one does. Each link is an absolute URL that keeps the active
// query and pins the resolved cursor + limit, so a client can walk pages without
// rebuilding the request. Null when no relation applies (unpaged, single page,
// or empty) so the caller omits the header.
export function listQueryParamNames(
  queryCollection: string,
  queryFilterNames: string[] = [],
): string[] {
  const config = (
    API_QUERY_COLLECTIONS as Record<string, QueryCollectionConfig>
  )[queryCollection];
  if (!config) return [];
  return listQueryParamNamesForConfig(config, queryFilterNames);
}

function listQueryParamNamesForConfig(
  config: QueryCollectionConfig,
  queryFilterNames: string[] = [],
  { csvResponse = false }: { csvResponse?: boolean } = {},
): string[] {
  const filterNames =
    queryFilterNames.length > 0
      ? effectiveFilterNames(config, queryFilterNames)
      : Object.keys(config.filters || {});
  const rangeNames = (config.range_filters || []).flatMap((field) => [
    `min_${field}`,
    `max_${field}`,
  ]);
  const csvNames = Object.keys(config.csv_filters || {});
  const arrayNames = Object.keys(config.array_filters || {});
  const names = [
    "q",
    "fields",
    "limit",
    "cursor",
    "sort",
    "order",
    ...filterNames,
    ...csvNames,
    ...arrayNames,
    ...rangeNames,
  ];
  if (csvResponse) {
    names.push("format");
  }
  return names;
}

export function canonicalListSearch(
  url: URL,
  queryCollection: string,
  queryFilterNames: string[] = [],
): string {
  const canonicalUrl = new URL("https://edge-cache.metagraph.sh/");
  for (const name of listQueryParamNames(queryCollection, queryFilterNames)) {
    const value = url.searchParams.get(name);
    if (value !== null) canonicalUrl.searchParams.set(name, value);
  }
  return canonicalUrl.search;
}

export interface Pagination {
  cursor: number;
  limit: number;
  next_cursor?: number | null;
  total: number;
}

export interface PaginationLinkOptions {
  queryCollection?: string;
  queryFilterNames?: string[];
  searchParams?: Record<string, unknown>;
}

export function paginationLinkHeader(
  url: URL,
  pagination: Pagination | null | undefined,
  options: PaginationLinkOptions = {},
): string | null {
  if (!pagination || typeof pagination.limit !== "number") {
    return null;
  }
  const { cursor, limit, next_cursor: nextCursor, total } = pagination;
  const canonicalSearch = options.queryCollection
    ? canonicalListSearch(
        url,
        options.queryCollection,
        options.queryFilterNames,
      )
    : url.search;
  const pageUri = (offset: number): string => {
    const target = new URL(url.href);
    target.search = canonicalSearch;
    for (const [name, value] of Object.entries(options.searchParams || {})) {
      target.searchParams.set(name, String(value));
    }
    target.searchParams.set("cursor", String(offset));
    target.searchParams.set("limit", String(limit));
    return target.href;
  };
  const links: Array<{ uri: string; rel: string }> = [];
  if (cursor > 0) {
    links.push({ uri: pageUri(0), rel: "first" });
    links.push({ uri: pageUri(Math.max(0, cursor - limit)), rel: "prev" });
  }
  if (typeof nextCursor === "number") {
    links.push({ uri: pageUri(nextCursor), rel: "next" });
    // Final-page start: last whole-limit stride below `total`. The "- 1" keeps
    // an exact multiple on the prior stride, not an empty page past the end.
    links.push({
      uri: pageUri(Math.floor((total - 1) / limit) * limit),
      rel: "last",
    });
  }
  return links.length > 0 ? linkHeader(links) : null;
}

function filterRows(
  rows: Row[],
  params: URLSearchParams,
  keys: string[],
  csvFilters: Record<string, string> = {},
  arrayFilters: Record<string, string[]> = {},
): Row[] {
  const csvWantedByKey = new Map(
    Object.keys(csvFilters)
      .filter((key) => params.has(key))
      .map((key) => [key, new Set((params.get(key) as string).split(","))]),
  );

  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      const expected = params.get(key) as string;
      // CSV membership filter (e.g. ?netuids=1,7,74 -> match row.netuid). Numeric
      // vocabulary - left case-sensitive (the issue scopes netuids out).
      const csvField = csvFilters[key];
      if (csvField) {
        return csvWantedByKey.get(key)?.has(String(row[csvField])) ?? false;
      }
      // Enum/string filters match case-insensitively (#2073): the configured
      // vocabularies and stored values are lowercase, so lowercasing the input
      // restores parity with the MCP list_subnets tool (?domain=Inference,
      // ?status=Active) without touching the stored row value.
      const expectedCi = expected.toLowerCase();
      // Array-membership filter over the UNION of one or more array fields
      // (e.g. ?domain=inference -> match row.categories or row.derived_categories).
      const arrayFields = arrayFilters[key];
      if (arrayFields) {
        return arrayFields.some((field) => {
          const fieldValue = row[field];
          return (
            Array.isArray(fieldValue) &&
            fieldValue.map((v) => String(v).toLowerCase()).includes(expectedCi)
          );
        });
      }
      const value = row[key];
      // A row missing the filtered field can't satisfy a value filter — exclude
      // it rather than letting String(undefined)/String(null) coerce into a
      // matchable "undefined"/"null" token (mirrors the absent-field exclusion in
      // rangeFilterRows, where a non-numeric/absent field fails every bound).
      if (value == null) return false;
      if (Array.isArray(value)) {
        return value.map((v) => String(v).toLowerCase()).includes(expectedCi);
      }
      return String(value).toLowerCase() === expectedCi;
    }),
  );
}

// Inclusive numeric range filter: for each configured field F, `?min_F=` keeps
// rows where row[F] >= n and `?max_F=` keeps rows where row[F] <= n. A row whose
// F is absent / non-numeric can't satisfy a bound, so it is excluded once any
// bound on F is set. Validation (validateListQuery) has already confirmed every
// present min_/max_ param is a finite number, so Number() here is safe.
function rangeFilterRows(
  rows: Row[],
  params: URLSearchParams,
  rangeFields: string[] = [],
): Row[] {
  const bounds: Array<{ field: string; limit: number; kind: "min" | "max" }> =
    [];
  for (const field of rangeFields) {
    const min = params.get(`min_${field}`);
    if (min !== null) bounds.push({ field, limit: Number(min), kind: "min" });
    const max = params.get(`max_${field}`);
    if (max !== null) bounds.push({ field, limit: Number(max), kind: "max" });
  }
  if (bounds.length === 0) {
    return rows;
  }
  return rows.filter((row) =>
    bounds.every(({ field, limit, kind }) => {
      const value = row[field];
      if (typeof value !== "number") {
        return false;
      }
      return kind === "min" ? value >= limit : value <= limit;
    }),
  );
}

function applyListTransform(
  data: Record<string, unknown>,
  params: URLSearchParams,
  config: QueryCollectionConfig,
  options: { csvResponse?: boolean } = {},
): ApplyQueryFiltersResult {
  const queryError = validateListQuery(params, config, options);
  if (queryError) {
    return { error: queryError };
  }
  const key = config.data_key;
  const projection = parseProjection(params, data[key] as Row[], key);
  if (projection.error) {
    return { error: projection.error };
  }
  const filterKeys = Object.keys(config.filters || {});
  const filtered = rangeFilterRows(
    filterRows(
      searchRows(data[key] as Row[], params, config.search_keys || []),
      params,
      filterKeys,
      config.csv_filters,
      config.array_filters,
    ),
    params,
    config.range_filters,
  );
  const sorted = sortRows(filtered, params);
  const paginated = paginateRows(sorted, params);
  return {
    data: {
      ...data,
      [key]: projectRows(paginated.rows, projection.fields),
    },
    meta: {
      pagination: {
        collection: key,
        total: sorted.length,
        returned: paginated.rows.length,
        limit: paginated.limit,
        cursor: paginated.cursor,
        next_cursor: paginated.nextCursor,
        sort: paginated.sort,
        order: paginated.order,
      },
      ...(projection.fields
        ? { projection: { fields: projection.fields } }
        : {}),
    },
  };
}

function searchRows(
  rows: Row[],
  params: URLSearchParams,
  keys: string[],
): Row[] {
  const q = params.get("q");
  if (!q || keys.length === 0) {
    return rows;
  }
  const terms = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());
  if (terms.length === 0) {
    return rows;
  }
  return rows.filter((row) => {
    const haystack = keys
      .flatMap((key) => {
        const value = row[key];
        return Array.isArray(value) ? value : [value];
      })
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function sortRows(rows: Row[], params: URLSearchParams): Row[] {
  const key = params.get("sort");
  if (!key) {
    return rows;
  }
  const direction = params.get("order") === "desc" ? -1 : 1;
  // Keep rows that are missing the sort field (null / undefined) out of the
  // ordered comparison and append them after the sorted rows, so incomplete
  // rows always sink to the end regardless of direction. Otherwise an absent
  // value coerces to "" and sorts *first* in ascending order, putting the least
  // complete rows at the top of the list — and flips to the end on desc, so the
  // same gap shuffles position just by toggling order.
  const present: Row[] = [];
  const missing: Row[] = [];
  for (const row of rows) {
    const value = row == null ? undefined : row[key];
    if (value === null || value === undefined) {
      missing.push(row);
    } else {
      present.push(row);
    }
  }
  present.sort((a, b) => {
    const cmp = compareValues(a[key], b[key]) * direction;
    if (cmp !== 0) return cmp;
    if (a.netuid != null && b.netuid != null) {
      return (a.netuid as number) - (b.netuid as number);
    }
    return 0;
  });
  return [...present, ...missing];
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a ?? "").localeCompare(String(b ?? ""));
}

interface PaginatedRows {
  cursor: number;
  limit: number;
  nextCursor: number | null;
  order: "asc" | "desc";
  rows: Row[];
  sort: string | null;
}

function paginateRows(rows: Row[], params: URLSearchParams): PaginatedRows {
  const requestedLimit = integerParam(params.get("limit"));
  const requestedCursor = integerParam(params.get("cursor"));
  const shouldPage = requestedLimit !== null || requestedCursor !== null;
  const limit = shouldPage
    ? Math.min(Math.max(requestedLimit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT)
    : rows.length;
  const cursor = Math.min(Math.max(requestedCursor ?? 0, 0), rows.length);
  const next = cursor + limit;
  return {
    cursor,
    limit,
    nextCursor: next < rows.length ? next : null,
    // sortRows only orders when a `sort` key is present, so without one the rows
    // are in source order — reporting "desc" here would misdescribe them.
    order:
      params.get("sort") && params.get("order") === "desc" ? "desc" : "asc",
    rows: shouldPage ? rows.slice(cursor, next) : rows,
    sort: params.get("sort") || null,
  };
}

function validateListQuery(
  params: URLSearchParams,
  config: QueryCollectionConfig,
  { csvResponse = false }: { csvResponse?: boolean } = {},
): QueryError | null {
  const allowedParams = new Set(
    listQueryParamNamesForConfig(config, [], { csvResponse }),
  );
  for (const key of params.keys()) {
    if (!allowedParams.has(key)) {
      return {
        parameter: key,
        message: "unknown query parameter.",
      };
    }
  }

  const format = params.get("format");
  if (
    format !== null &&
    csvResponse &&
    !["json", "csv"].includes(format.toLowerCase())
  ) {
    return {
      parameter: "format",
      message: "format must be json or csv.",
    };
  }

  const limit = params.get("limit");
  if (
    limit !== null &&
    (integerParam(limit) === null || Number(limit) < MIN_LIMIT)
  ) {
    return {
      parameter: "limit",
      message: `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
    };
  }
  if (limit !== null && Number(limit) > MAX_LIMIT) {
    return {
      parameter: "limit",
      message: `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.`,
    };
  }

  const cursor = params.get("cursor");
  if (cursor !== null && integerParam(cursor) === null) {
    return {
      parameter: "cursor",
      message: "cursor must be a non-negative integer.",
    };
  }

  const order = params.get("order");
  if (order !== null && !["asc", "desc"].includes(order)) {
    return {
      parameter: "order",
      message: "order must be asc or desc.",
    };
  }

  const sort = params.get("sort");
  if (sort !== null && !(config.sort_fields || []).includes(sort)) {
    return {
      parameter: "sort",
      message: `sort is not supported for ${config.data_key}.`,
    };
  }

  for (const [key, schema] of Object.entries(config.filters || {})) {
    if (!params.has(key)) {
      continue;
    }
    const value = params.get(key) as string;
    if (schema.type === "integer" && integerParam(value) === null) {
      return {
        parameter: key,
        message: `${key} must be a non-negative integer.`,
      };
    }
    // Enum membership is case-insensitive (#2073): the configured vocabularies are
    // all lowercase, so ?status=Active matches like the MCP list_subnets tool
    // (which lowercases its args) instead of returning a 400 the equivalent MCP
    // call would not. A genuinely invalid value still fails after lowercasing.
    if (schema.enum && !schema.enum.includes(value.toLowerCase())) {
      return {
        parameter: key,
        message: `${key} is not supported for this route.`,
      };
    }
    if (schema.maxLength && value.length > schema.maxLength) {
      return {
        parameter: key,
        message: `${key} is too long.`,
      };
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      return {
        parameter: key,
        message: `${key} is not in the expected format.`,
      };
    }
  }

  // The `q` free-text search param isn't in config.filters, so the generic
  // maxLength check above never sees it (#5544). Bound it explicitly from the
  // same searchTextSchema ceiling so an oversized query can't drive unbounded
  // per-term, per-row scan work in searchRows.
  if ((config.search_keys?.length || 0) > 0 && params.has("q")) {
    const value = params.get("q") as string;
    if (value.length > SEARCH_TEXT_MAX_LENGTH) {
      return {
        parameter: "q",
        message: "q is too long.",
      };
    }
  }

  for (const field of config.range_filters || []) {
    for (const bound of ["min", "max"]) {
      const key = `${bound}_${field}`;
      if (params.has(key) && numberParam(params.get(key)) === null) {
        return {
          parameter: key,
          message: `${key} must be a number.`,
        };
      }
    }
    const minKey = `min_${field}`;
    const maxKey = `max_${field}`;
    if (!params.has(minKey) || !params.has(maxKey)) {
      continue;
    }
    const minValue = numberParam(params.get(minKey));
    const maxValue = numberParam(params.get(maxKey));
    if (minValue !== null && maxValue !== null && minValue > maxValue) {
      return {
        parameter: minKey,
        message: `${minKey} must not be greater than ${maxKey}.`,
      };
    }
  }

  return null;
}

interface ProjectionResult {
  fields?: string[] | null;
  error?: QueryError;
}

function parseProjection(
  params: URLSearchParams,
  rows: Row[],
  dataKey: string,
): ProjectionResult {
  if (!params.has("fields")) {
    return { fields: null };
  }
  const requested = (params.get("fields") as string)
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  if (
    requested.length === 0 ||
    requested.some((field) => !FIELD_NAME_PATTERN.test(field))
  ) {
    return {
      error: {
        parameter: "fields",
        message:
          "fields must be a comma-separated list of row field names, e.g. netuid,name,slug.",
      },
    };
  }

  // A field is "known" if it appears on at least one row, so correctness needs
  // the union of all rows' keys (collections can be heterogeneous). But the
  // common case — every requested field present on the first row — only needs
  // one row. Scan lazily: drop each requested field as a row reveals it and stop
  // the moment all are resolved. On the largest collection (~1160 endpoints) a
  // valid ?fields= request now touches ~1 row instead of materializing every
  // row's keys; an unsupported field still scans to the end to confirm it truly
  // appears on no row. Behaviour is identical to the prior full-union check.
  const fields = [...new Set(requested)];
  const unresolved = new Set(fields);
  for (const row of rows) {
    if (unresolved.size === 0) break;
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row)) unresolved.delete(key);
    }
  }
  if (unresolved.size > 0) {
    const unknown = [...unresolved];
    return {
      error: {
        parameter: "fields",
        message: `fields includes unsupported field${unknown.length === 1 ? "" : "s"} for ${dataKey}: ${unknown.join(", ")}.`,
      },
    };
  }

  return { fields };
}

function projectRows(rows: Row[], fields: string[] | null | undefined): Row[] {
  if (!fields) {
    return rows;
  }
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    return Object.fromEntries(
      fields
        .filter((field) => Object.hasOwn(row, field))
        .map((field) => [field, row[field]]),
    );
  });
}

function integerParam(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// A finite decimal (optional sign, optional fraction) for range-filter bounds —
// e.g. "5", "-3", "360.5". Rejects blanks, exponents, hex, and Infinity/NaN so a
// bound is always a plain, predictable number. Returns the number or null.
function numberParam(value: string | null): number | null {
  if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
