// List-query transform helpers for the API Worker — filtering, search, sort,
// and cursor pagination over in-memory artifact collections. Extracted from
// workers/api.mjs (issue #510, de-monolith) as a leaf module: it imports only
// the query-collection contract and nothing from api.mjs, so there is no cycle.
// `applyQueryFilters` is the single public entry; the rest are internal helpers.
import { API_QUERY_COLLECTIONS } from "../src/contracts.mjs";

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

function filterRows(rows, params, keys, csvFilters = {}, arrayFilters = {}) {
  return rows.filter((row) =>
    keys.every((key) => {
      if (!params.has(key)) {
        return true;
      }
      const expected = params.get(key);
      // CSV membership filter (e.g. ?netuids=1,7,74 -> match row.netuid).
      const csvField = csvFilters[key];
      if (csvField) {
        const wanted = new Set(
          expected
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        );
        return wanted.has(String(row[csvField]));
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

function applyListTransform(data, params, config) {
  const queryError = validateListQuery(params, config);
  if (queryError) {
    return { error: queryError };
  }
  const key = config.data_key;
  const filterKeys = Object.keys(config.filters);
  const filtered = filterRows(
    searchRows(data[key], params, config.search_keys),
    params,
    filterKeys,
    config.csv_filters,
    config.array_filters,
  );
  const sorted = sortRows(filtered, params);
  const paginated = paginateRows(sorted, params);
  return {
    data: {
      ...data,
      [key]: paginated.rows,
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
    },
  };
}

function searchRows(rows, params, keys) {
  const q = params.get("q");
  if (!q || keys.length === 0) {
    return rows;
  }
  const needle = q.toLowerCase();
  return rows.filter((row) =>
    keys
      .flatMap((key) => {
        const value = row[key];
        return Array.isArray(value) ? value : [value];
      })
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

function sortRows(rows, params) {
  const key = params.get("sort");
  if (!key) {
    return rows;
  }
  const direction = params.get("order") === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => compareValues(a[key], b[key]) * direction);
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
    order: params.get("order") === "desc" ? "desc" : "asc",
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
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      return {
        parameter: key,
        message: `${key} is not in the expected format.`,
      };
    }
  }

  return null;
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
