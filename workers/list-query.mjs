// List-query transform helpers for the API Worker — filtering, search, sort,
// and cursor pagination over in-memory artifact collections. Extracted from
// workers/api.mjs (issue #510, de-monolith) as a leaf module: it imports only
// the query-collection contract and nothing from api.mjs, so there is no cycle.
// `applyQueryFilters` is the single public entry; the rest are internal helpers.
import { API_QUERY_COLLECTIONS } from "../src/contracts.mjs";

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
    let min = null;
    let max = null;
    for (const bound of ["min", "max"]) {
      const key = `${bound}_${field}`;
      if (!params.has(key)) {
        continue;
      }
      const parsed = numberParam(params.get(key));
      if (parsed === null) {
        return {
          parameter: key,
          message: `${key} must be a number.`,
        };
      }
      if (bound === "min") {
        min = parsed;
      } else {
        max = parsed;
      }
    }
    // A lower bound above its matching upper bound can never select a row, so it
    // is a contradictory request. Rejecting it turns a silently-always-empty
    // response into an explicit, debuggable 400 (mirrors how out-of-range and
    // malformed bounds are already rejected, rather than guessed at).
    if (min !== null && max !== null && min > max) {
      return {
        parameter: `min_${field}`,
        message: `min_${field} must not exceed max_${field}.`,
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
