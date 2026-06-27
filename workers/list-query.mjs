// List-query transform helpers for the API Worker — filtering, search, sort,
// and cursor pagination over in-memory artifact collections. Extracted from
// workers/api.mjs (issue #510, de-monolith) as a leaf module: it imports only
// the query-collection contract and nothing from api.mjs, so there is no cycle.
// `applyQueryFilters` is the single public entry; the rest are internal helpers.
import { API_QUERY_COLLECTIONS } from "../src/contracts.mjs";
import { linkHeader } from "./http.mjs";

const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function applyQueryFilters(
  data,
  url,
  queryCollection,
  queryFilterNames = [],
) {
  const params = url.searchParams;
  const config = API_QUERY_COLLECTIONS[queryCollection];
  if (!config) {
    return { data, meta: {} };
  }
  if (!Array.isArray(data?.[config.data_key])) {
    return { data, meta: {} };
  }
  return applyListTransform(data, params, {
    ...config,
    filters: Object.fromEntries(
      (queryFilterNames.length > 0
        ? queryFilterNames
        : Object.keys(config.filters)
      ).map((name) => [name, config.filters[name]]),
    ),
  });
}

// RFC 8288 Link header for a cursor-paginated response (window from
// `paginateRows`): `first`/`prev` when an earlier page exists, `next`/`last`
// when a later one does. Each link is an absolute URL that keeps the active
// query and pins the resolved cursor + limit, so a client can walk pages without
// rebuilding the request. Null when no relation applies (unpaged, single page,
// or empty) so the caller omits the header.
function listQueryParamNames(queryCollection, queryFilterNames = []) {
  const config = API_QUERY_COLLECTIONS[queryCollection];
  if (!config) return [];
  const filterNames =
    queryFilterNames.length > 0
      ? queryFilterNames
      : Object.keys(config.filters);
  const rangeNames = (config.range_filters || []).flatMap((field) => [
    `min_${field}`,
    `max_${field}`,
  ]);
  const csvNames = Object.keys(config.csv_filters || {});
  const arrayNames = Object.keys(config.array_filters || {});
  return [
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
}

export function canonicalListSearch(
  url,
  queryCollection,
  queryFilterNames = [],
) {
  const canonicalUrl = new URL("https://edge-cache.metagraph.sh/");
  for (const name of listQueryParamNames(queryCollection, queryFilterNames)) {
    const value = url.searchParams.get(name);
    if (value !== null) canonicalUrl.searchParams.set(name, value);
  }
  return canonicalUrl.search;
}

export function paginationLinkHeader(url, pagination, options = {}) {
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
  const pageUri = (offset) => {
    const target = new URL(url.href);
    target.search = canonicalSearch;
    target.searchParams.set("cursor", String(offset));
    target.searchParams.set("limit", String(limit));
    return target.href;
  };
  const links = [];
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

function filterRows(rows, params, keys, csvFilters = {}, arrayFilters = {}) {
  const csvWantedByKey = new Map(
    Object.keys(csvFilters)
      .filter((key) => params.has(key))
      .map((key) => [key, new Set(params.get(key).split(","))]),
  );

  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      const expected = params.get(key);
      // CSV membership filter (e.g. ?netuids=1,7,74 -> match row.netuid).
      const csvField = csvFilters[key];
      if (csvField) {
        return csvWantedByKey.get(key)?.has(String(row[csvField])) ?? false;
      }
      // Array-membership filter over the UNION of one or more array fields
      // (e.g. ?domain=inference -> match row.categories or row.derived_categories).
      const arrayFields = arrayFilters[key];
      if (arrayFields) {
        return arrayFields.some(
          (field) =>
            Array.isArray(row[field]) &&
            row[field].map(String).includes(expected),
        );
      }
      const value = row[key];
      if (Array.isArray(value)) {
        return value.map(String).includes(expected);
      }
      return String(value) === expected;
    }),
  );
}

// Inclusive numeric range filter: for each configured field F, `?min_F=` keeps
// rows where row[F] >= n and `?max_F=` keeps rows where row[F] <= n. A row whose
// F is absent / non-numeric can't satisfy a bound, so it is excluded once any
// bound on F is set. Validation (validateListQuery) has already confirmed every
// present min_/max_ param is a finite number, so Number() here is safe.
function rangeFilterRows(rows, params, rangeFields) {
  const bounds = [];
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

function applyListTransform(data, params, config) {
  const queryError = validateListQuery(params, config);
  if (queryError) {
    return { error: queryError };
  }
  const key = config.data_key;
  const projection = parseProjection(params, data[key], key);
  if (projection.error) {
    return { error: projection.error };
  }
  const filterKeys = Object.keys(config.filters);
  const filtered = rangeFilterRows(
    filterRows(
      searchRows(data[key], params, config.search_keys),
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

function searchRows(rows, params, keys) {
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

function sortRows(rows, params) {
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
  const present = [];
  const missing = [];
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
    if (a.netuid != null && b.netuid != null) return a.netuid - b.netuid;
    return 0;
  });
  return [...present, ...missing];
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function paginateRows(rows, params) {
  const requestedLimit = integerParam(params.get("limit"));
  const requestedCursor = integerParam(params.get("cursor"));
  const shouldPage = requestedLimit !== null || requestedCursor !== null;
  const limit = shouldPage
    ? Math.min(Math.max(requestedLimit ?? 100, 1), 1000)
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

function validateListQuery(params, config) {
  const limit = params.get("limit");
  if (limit !== null && (integerParam(limit) === null || Number(limit) < 1)) {
    return {
      parameter: "limit",
      message: "limit must be an integer between 1 and 1000.",
    };
  }
  if (limit !== null && Number(limit) > 1000) {
    return {
      parameter: "limit",
      message: "limit must be an integer between 1 and 1000.",
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
  if (sort !== null && !config.sort_fields.includes(sort)) {
    return {
      parameter: "sort",
      message: `sort is not supported for ${config.data_key}.`,
    };
  }

  for (const [key, schema] of Object.entries(config.filters)) {
    if (!params.has(key)) {
      continue;
    }
    const value = params.get(key);
    if (schema.type === "integer" && integerParam(value) === null) {
      return {
        parameter: key,
        message: `${key} must be a non-negative integer.`,
      };
    }
    if (schema.enum && !schema.enum.includes(value)) {
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

  for (const field of config.range_filters) {
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

function parseProjection(params, rows, dataKey) {
  if (!params.has("fields")) {
    return { fields: null };
  }
  const requested = params.get("fields").split(",");
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

function projectRows(rows, fields) {
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

function integerParam(value) {
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
function numberParam(value) {
  if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
