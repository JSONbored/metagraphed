// List-query transform helpers for the API Worker — filtering, search, sort,
// and cursor pagination over in-memory artifact collections. Extracted from
// workers/api.ts (issue #510, de-monolith) as a leaf module: it imports only
// the query-collection contract and nothing from api.ts, so there is no cycle.
// `applyQueryFilters` is the main public entry. It TRANSFORMS only: validation
// belongs to the router's single parse against the route's Zod schema
// (src/route-query.ts, #10218), which runs before any handler.
import { API_QUERY_COLLECTIONS } from "../src/contracts.ts";
import {
  validateCollectionQuery,
  type QueryError,
} from "../src/route-query.ts";
import { linkHeader } from "./http.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT } from "./request-params.ts";
import {
  parseFieldsParam,
  projectionMeta,
  projectRows,
  unknownAgainstRows,
  type FieldProjectionResult,
} from "../src/field-projection.ts";

export type Row = Record<string, unknown>;

// Declared in src/route-query.ts, with the check that produces it (#10218);
// re-exported so the ~20 existing import sites keep working.
export type { QueryError };

export interface FilterSchema {
  type?: string;
  enum?: string[];
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface QueryCollectionConfig {
  data_key: string;
  filters?: Record<string, FilterSchema>;
  csv_filters?: Record<string, string>;
  array_filters?: Record<string, string[]>;
  range_filters?: string[];
  /** Param name -> the row field whose PRESENCE it tests. */
  presence_filters?: Record<string, string>;
  /** Boolean param -> membership of a row field in a canonical value set. */
  value_set_filters?: Record<
    string,
    { field: string; values: readonly string[] }
  >;
  search_keys?: string[];
  sort_fields?: string[];
}

/**
 * The window `applyListTransform` emits, and the ONLY thing that emits it.
 *
 * Every member is required because the producer sets every member on every
 * paginated result -- there is no branch that omits one. The Worker read
 * `meta.pagination.collection` to pick the CSV data key and
 * `meta.pagination` to build the RFC 8288 Link header off a
 * `Record<string, unknown>`, which typed both as `unknown` and let the
 * `as Row` cast one line up put them back (#10782).
 */
export interface ListPaginationMeta {
  /** The data key the windowed rows live under. */
  collection: string;
  total: number;
  returned: number;
  limit: number;
  cursor: number;
  next_cursor: number | null;
  sort: string | null;
  order: "asc" | "desc";
}

/** Present only when `fields` narrowed the rows -- `projectionMeta` returns an
 *  EMPTY object otherwise, which is why this member is optional and its own
 *  `fields` is not. */
export interface ListProjectionMeta {
  fields: string[];
}

/** What a list transform reports about the window it produced. Spread whole
 *  into the REST envelope's `meta`, so a member added here is published. */
export interface ApplyQueryFiltersMeta {
  pagination?: ListPaginationMeta;
  projection?: ListProjectionMeta;
}

/**
 * A transform either REJECTED the query or WINDOWED the rows -- never both,
 * and never neither.
 *
 * A discriminated union rather than three optional members, because the three
 * were not independent: every caller checks `error` first and then reads
 * `data` and `meta` as though they are there, which they are, and the type
 * said they might not be. Optional members made `if (transformed.error)
 * return` prove nothing, so the reads afterwards each needed their own `?.` --
 * a null check for a case the function cannot produce, which is how a real one
 * stops being distinguishable (#10782).
 */
export type ApplyQueryFiltersResult =
  | { error: QueryError; data?: undefined; meta?: undefined }
  | { error?: undefined; data: unknown; meta: ApplyQueryFiltersMeta };

/**
 * One query collection's declared config, or null.
 *
 * THE SINGLE LOOKUP. `API_QUERY_COLLECTIONS` is a generated record whose value
 * type TypeScript widens per entry, so every reader was writing its own
 * `as Record<string, ...>` to index it -- three of them, one of which
 * (`workers/api.ts`'s CSV branch) then read `.data_key` off the result with no
 * null check at all, because the cast said the miss could not happen (#10782).
 *
 * A route with no collection is the routine case, not an error: the pure
 * static artifacts declare `query_collection: null`.
 */
export function queryCollectionConfig(
  queryCollection: string | null | undefined,
): QueryCollectionConfig | null {
  if (!queryCollection) return null;
  return (
    (API_QUERY_COLLECTIONS as Record<string, QueryCollectionConfig>)[
      queryCollection
    ] ?? null
  );
}

export function applyQueryFilters(
  data: Record<string, unknown> | null | undefined,
  url: URL,
  queryCollection: string | null | undefined,
  queryFilterNames: string[] = [],
  {
    csvResponse = false,
    defaultLimit,
  }: { csvResponse?: boolean; defaultLimit?: number } = {},
): ApplyQueryFiltersResult {
  const params = url.searchParams;
  // A route with no collection funnels into the SAME miss branch as an unknown
  // one -- `queryCollectionConfig("")` is null -- so accepting the nullable
  // costs no second exit, and `collection` is a string for the check below.
  const collection = queryCollection ?? "";
  const config = queryCollectionConfig(collection);
  if (!config) {
    return { data, meta: {} };
  }
  if (!Array.isArray(data?.[config.data_key])) {
    return { data, meta: {} };
  }
  // The check, from the collection's own Zod object -- the same one
  // `listQuerySchema()` composes for the REST route (#10218). REST callers have
  // already met it at the router; the MCP list tools come through here, and
  // this is their handler guard.
  const queryError =
    validateCollectionQuery(params, collection, queryFilterNames, {
      csvResponse,
    }) ?? contradictoryRange(params, config.range_filters || []);
  if (queryError) return { error: queryError };
  return applyListTransform(
    data,
    params,
    listQueryConfig(config, queryFilterNames),
    { csvResponse, defaultLimit },
  );
}

/**
 * `validateListQueryParams` / `validateListQuery` lived here until #10218.
 *
 * They were the SIXTH statement of the query contract -- ~120 lines checking,
 * for the 34 collection routes, the parameter names, the `format` enum, the
 * `limit` range, the `cursor` type, `order`, `sort`, and each filter's type /
 * enum / maxLength / pattern. Every one of those constraints is composed into
 * the route's Zod object by `listQuerySchema()` from the SAME
 * `API_QUERY_COLLECTIONS` config, and the router now parses against it before
 * dispatch, so these could only ever fire on input already rejected.
 *
 * The one behaviour that was NOT in the schema came with them: enum matching
 * was case-insensitive here (#2073 -- `?status=Active` matches, so a REST
 * caller is not stricter than the MCP tool, which lowercases its args). That
 * rule now lives in `src/route-query.ts`, applied at the REST boundary to every
 * route rather than only to the collection-backed ones.
 */

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
  queryCollection: string | null | undefined,
  queryFilterNames: string[] = [],
): string[] {
  // A route with NO query collection is the routine case, not an error: the
  // pure static artifacts declare `query_collection: null` and honour no
  // params at all. Saying so in the signature is what lets `matchRoute`'s
  // `string | null` reach here without a cast -- the lookup already answered
  // `[]` for it, but only by missing (#10782).
  const config = queryCollectionConfig(queryCollection);
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
  queryCollection: string | null | undefined,
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
  presenceFilters: Record<string, string> = {},
  valueSetFilters: Record<
    string,
    { field: string; values: readonly string[] }
  > = {},
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
      const valueSet = valueSetFilters[key];
      if (valueSet) {
        const value = row[valueSet.field];
        const matches =
          typeof value === "string" && valueSet.values.includes(value);
        return matches === (expectedCi === "true");
      }
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
      // Presence filter: "does this row have the field at all", not "what is
      // its value". `?rate_limited=true` keeps rows documenting a limit; the
      // engine could not express this before, which is why /apis filtered it
      // client-side over one page (#9117). Empty string counts as absent -- a
      // blank note documents nothing.
      const presenceField = presenceFilters[key];
      if (presenceField) {
        const present = row[presenceField] != null && row[presenceField] !== "";
        return present === (expectedCi === "true");
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
// bound on F is set. Validation (the router's single parse, #10218) has
// already confirmed every
// present min_/max_ param is a finite number, so Number() here is safe.
/**
 * `?min_F=9&max_F=2` -- a range that can match nothing, on purpose or by typo.
 *
 * The one list-query rule that survived #10218's deletion of the hand-written
 * validator, because it is the one JSON Schema cannot state: both bounds are
 * individually valid numbers and the contradiction is between them. Rejecting
 * it is the same judgement as #9916's -- an empty page a caller cannot
 * distinguish from "nothing matched" is worse than an error naming the
 * mistake.
 */
function contradictoryRange(
  params: URLSearchParams,
  rangeFields: string[],
): QueryError | null {
  for (const field of rangeFields) {
    const min = Number(params.get(`min_${field}`));
    const max = Number(params.get(`max_${field}`));
    if (!params.has(`min_${field}`) || !params.has(`max_${field}`)) continue;
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
      return {
        parameter: `min_${field}`,
        message: `min_${field} must not be greater than max_${field}.`,
      };
    }
  }
  return null;
}

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
  options: { csvResponse?: boolean; defaultLimit?: number } = {},
): ApplyQueryFiltersResult {
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
      config.presence_filters,
      config.value_set_filters,
    ),
    params,
    config.range_filters,
  );
  const sorted = sortRows(filtered, params);
  const paginated = paginateRows(sorted, params, options.defaultLimit);
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
      ...projectionMeta(projection.fields),
    },
  };
}

/**
 * What `?q=` MEANS, separated from where it arrives (#10793).
 *
 * EXPORTED so a hand-rolled loader can search the way the engine does. Two MCP
 * tools (`list_subnets`, `list_enrichment_targets`) filter and page their rows
 * themselves rather than through `applyQueryFilters`, so exposing `q` on them
 * meant either a second matcher or this. A second matcher is how the two
 * surfaces start disagreeing about what a search is -- and they would disagree
 * on real cases, not hypothetical ones: every term must match (AND, not OR),
 * matching is case-insensitive substring rather than word or prefix, an array
 * field is flattened and joined so a match may span two of its entries, and
 * falsy values are dropped before the join so `0` and `false` are not
 * searchable text. Nobody writing the second copy guesses all five.
 */
export function searchMatchingRows(
  rows: Row[],
  q: string | null | undefined,
  keys: readonly string[],
): Row[] {
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

function searchRows(
  rows: Row[],
  params: URLSearchParams,
  keys: string[],
): Row[] {
  return searchMatchingRows(rows, params.get("q"), keys);
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

function paginateRows(
  rows: Row[],
  params: URLSearchParams,
  // #9730. Without this, omitting BOTH `limit` and `cursor` returns every row,
  // and DEFAULT_LIMIT below is unreachable because it only applies once the
  // caller has already opted into paging. That is correct for REST -- a browser
  // can stream 9 MB -- and catastrophic for MCP, where the same seam served
  // list_endpoints as 9,059,868 bytes to a tool call that took no arguments.
  //
  // Passed explicitly by the caller rather than inferred (from the mcp.internal
  // hostname, say), because which surface is asking is the caller's fact to
  // state, and a hostname test would silently mis-serve any future caller that
  // used a different one.
  defaultLimit?: number,
): PaginatedRows {
  const requestedLimit = integerParam(params.get("limit"));
  const requestedCursor = integerParam(params.get("cursor"));
  const shouldPage =
    requestedLimit !== null || requestedCursor !== null || defaultLimit != null;
  const limit = shouldPage
    ? Math.min(
        Math.max(requestedLimit ?? defaultLimit ?? DEFAULT_LIMIT, MIN_LIMIT),
        MAX_LIMIT,
      )
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

// A field is "known" here if it appears on at least one row: an artifact
// collection can be heterogeneous and has no single row schema to ask.
// src/field-projection.ts owns the parse, the messages, and the projector --
// this passes it the row-union resolver, so list routes behave exactly as they
// did while the neuron routes (#9082) get the same parameter with the same
// syntax and the same errors, from the same code.
function parseProjection(
  params: URLSearchParams,
  rows: Row[],
  dataKey: string,
): FieldProjectionResult {
  return parseFieldsParam(params, unknownAgainstRows(rows), dataKey);
}

/**
 * Reject an integer filter above the ceiling its published schema declares
 * (#10073), or null when it is within bounds.
 *
 * `maximum` used to be published and never checked: `?netuid=70000` came back
 * 200 with zero rows, which is indistinguishable from "that subnet exists and
 * matches nothing" for a value no u16 netuid can hold. Same rule as #9916
 * applied to a filter instead of a page size -- an out-of-range value is
 * rejected, never answered with a confident empty set.
 *
 * Only the ceiling: `integerParam` already rejects anything that is not a
 * non-negative safe integer, so `minimum: 0` is enforced before this is
 * reached and a `minimum` check here would be unreachable.
 *
 * Exported for its own unit test. A filter that declares no ceiling is the
 * branch production data does not currently exercise -- every integer filter
 * is `netuid` today -- and pinning it here is what keeps it honest when the
 * next one is added.
 */
export function integerCeilingError(
  key: string,
  parsed: number,
  schema: FilterSchema,
): QueryError | null {
  const { maximum } = schema;
  if (typeof maximum !== "number" || parsed <= maximum) return null;
  return {
    parameter: key,
    message: `${key} must be an integer between 0 and ${maximum}.`,
  };
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
