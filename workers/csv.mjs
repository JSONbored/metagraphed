import { apiHeaders, ifNoneMatchSatisfied, weakEtag } from "./http.mjs";

const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";
const SPREADSHEET_FORMULA_PREFIX = /^\s*[=+\-@]/;

export function columnsFromRows(rows = []) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

export function csvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = Array.isArray(value)
    ? value.join("; ")
    : typeof value === "object"
      ? safeJsonCell(value)
      : String(value);
  const safeText = SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText)
    ? `"${safeText.replace(/"/g, '""')}"`
    : safeText;
}

export function rowsToCsv(rows = [], columns = columnsFromRows(rows)) {
  const header = columns.map((column) => csvValue(column)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvValue(row?.[column])).join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

function safeJsonCell(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function csvRequested(url, request) {
  const format = url.searchParams.get("format");
  if (format !== null) {
    return format.trim().toLowerCase() === "csv";
  }
  const accept = request.headers.get("accept");
  if (!accept) {
    return false;
  }
  return accept
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => {
      const [mediaType, ...parameters] = part.split(";").map((v) => v.trim());
      if (mediaType !== "text/csv") {
        return false;
      }
      const q = parameters
        .map((parameter) => parameter.split("=").map((v) => v.trim()))
        .find(([key]) => key === "q")?.[1];
      return q === undefined || Number(q) > 0;
    });
}

export function contentDispositionFilename(filename) {
  const rawName = filename ? String(filename) : "export";
  const safeStem = rawName
    .replace(/[\\/]/g, "-")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  const stem = safeStem ? safeStem : "export";
  const withExtension = stem.toLowerCase().endsWith(".csv")
    ? stem
    : `${stem}.csv`;
  return withExtension.replace(/["\\]/g, "_");
}

export async function csvResponse(
  rows,
  filename,
  cacheProfile,
  { columns, extraHeaders = {}, request = null } = {},
) {
  const body = rowsToCsv(rows, columns);
  const headers = apiHeaders(cacheProfile);
  headers.set("content-type", CSV_CONTENT_TYPE);
  headers.set(
    "content-disposition",
    `attachment; filename="${contentDispositionFilename(filename)}"`,
  );
  headers.set("etag", await weakEtag(body));
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value != null) {
      headers.set(key, value);
    }
  }
  if (request && ifNoneMatchSatisfied(request, headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request?.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
