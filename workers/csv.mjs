import { apiHeaders, ifNoneMatchSatisfied, weakEtag } from "./http.mjs";

function normalizeColumns(rows, columns) {
  if (Array.isArray(columns) && columns.length > 0) {
    return columns.map((column) => String(column));
  }

  const seen = new Set();
  const names = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

function stringifyCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        entry && typeof entry === "object" ? JSON.stringify(entry) : entry,
      )
      .join(";");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeCell(value) {
  const text = stringifyCell(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function csvFilename(filename) {
  const stem =
    String(filename || "export")
      .replace(/\.csv$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  return `${stem}.csv`;
}

export function rowsToCsv(rows, columns) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = normalizeColumns(safeRows, columns);
  if (header.length === 0) {
    return "";
  }

  const lines = [
    header.map(escapeCell).join(","),
    ...safeRows.map((row) =>
      header
        .map((column) =>
          escapeCell(
            row && typeof row === "object" && !Array.isArray(row)
              ? row[column]
              : undefined,
          ),
        )
        .join(","),
    ),
  ];
  return lines.join("\r\n");
}

export function validateCsvFormatParam(url) {
  const format = url.searchParams.get("format");
  if (format === null || format === "") {
    return null;
  }
  const normalized = format.toLowerCase();
  if (normalized === "csv" || normalized === "json") {
    return null;
  }
  return {
    parameter: "format",
    message: `"${format}" is not a supported format. Pass format=csv for text/csv, or omit format for JSON.`,
  };
}

export function csvRequested(url, request) {
  const format = url.searchParams.get("format")?.toLowerCase();
  if (format === "csv") {
    return true;
  }
  if (format === "json") {
    return false;
  }
  return /\btext\/csv\b/i.test(request.headers.get("accept") || "");
}

export async function csvResponse(
  rows,
  filename,
  cacheProfile,
  request = null,
  columns = null,
) {
  const body = rowsToCsv(rows, columns);
  const headers = apiHeaders(cacheProfile);
  const etag = await weakEtag(body);
  headers.set("content-type", "text/csv; charset=utf-8");
  headers.set(
    "content-disposition",
    `attachment; filename="${csvFilename(filename)}"`,
  );
  headers.set("etag", etag);
  headers.set("vary", "Accept, Accept-Encoding");

  if (request && ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request?.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
