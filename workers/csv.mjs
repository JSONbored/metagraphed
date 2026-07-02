// Shared CSV serializer + content-negotiation helpers for list responses
// (issue #2519). Foundational toolkit that per-route CSV export issues consume.
// Leaf module: imports only from http.mjs — no import from api.mjs to avoid
// cycles. Wire NOTHING into routes here; per-route issues do that.

import { apiHeaders } from "./http.mjs";

// ── RFC 4180 serializer ────────────────────────────────────────────────────

// Serialize a single cell value per RFC 4180:
//  - null/undefined → empty string
//  - arrays → elements joined with ";" (inner values are not re-quoted here;
//    the outer quoteField wraps the joined result when needed)
//  - objects → compact JSON
//  - everything else → String(value)
function cellString(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(cellString).join(";");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Wrap a cell string in double-quotes when it contains a comma, double-quote,
// CR, or LF. Embedded double-quotes are doubled per RFC 4180 §2.7.
function quoteField(raw) {
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

// Build a stable column list from the union of row keys in first-seen order.
// An explicit `columns` array overrides auto-detection when callers need a
// fixed or filtered projection.
function resolveColumns(rows, columns) {
  if (columns && columns.length > 0) return columns;
  const seen = new Set();
  const order = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }
  return order;
}

/**
 * Serialize an array of plain objects to an RFC 4180 CSV string.
 *
 * @param {object[]} rows     - Row objects; extra keys beyond `columns` are
 *                              silently ignored when `columns` is supplied.
 * @param {string[]} [columns] - Explicit column order; defaults to the union
 *                              of all row keys in first-seen order.
 * @returns {string} A UTF-8 CSV string including a header row.
 */
export function rowsToCsv(rows, columns) {
  const cols = resolveColumns(rows, columns);
  const lines = [];
  // Header row
  lines.push(cols.map(quoteField).join(","));
  // Data rows
  for (const row of rows) {
    lines.push(cols.map((col) => quoteField(cellString(row[col]))).join(","));
  }
  // RFC 4180 §2.4: each record on its own line; trailing CRLF optional.
  // Use "\r\n" for strict RFC 4180 compliance — widely accepted by spreadsheets.
  return lines.join("\r\n");
}

/**
 * Return true when the client has requested CSV output via either:
 *   - `?format=csv` query parameter, OR
 *   - `Accept: text/csv` (or `Accept: text/csv, *`)
 *
 * `?format=json` (or an absent/blank `format` param) explicitly opts back
 * into JSON. The query parameter wins over the Accept header so a browser
 * link appending `?format=csv` always triggers a download.
 *
 * @param {URL}     url     - Parsed request URL (for searchParams).
 * @param {Request} request - Fetch Request (for the Accept header).
 * @returns {boolean}
 */
export function csvRequested(url, request) {
  const fmt = url.searchParams.get("format")?.trim().toLowerCase();
  if (fmt != null) return fmt === "csv";
  const accept = request.headers.get("accept") || "";
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0].trim().toLowerCase();
    return mediaType === "text/csv";
  });
}

// ── Response builder ───────────────────────────────────────────────────────

const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/**
 * Sanitize or constrain the filename before interpolating it into Content-Disposition
 * to avoid malformed headers or Headers.set throwing on CR/LF.
 * Strips path separators and control characters, and escapes double quotes and backslashes.
 */
export function contentDispositionFilename(filename) {
  const clean = String(filename || "export")
    .replace(/[/\\]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "");
  return clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a cacheable `text/csv` Response for a list of rows.
 *
 * Reuses `apiHeaders(cacheProfile)` for cache-control / CORS / ETag parity
 * with the JSON sibling (`envelopeResponse`), then overwrites content-type
 * and adds a Content-Disposition attachment header.
 *
 * @param {object[]} rows         - Plain-object rows to serialize.
 * @param {string}   filename     - Base name (without extension) for the
 *                                  Content-Disposition attachment filename.
 * @param {string}   cacheProfile - One of the named profiles in CACHE_SECONDS
 *                                  (e.g. "standard", "short", "static").
 * @returns {Response}
 */
export function csvResponse(rows, filename, cacheProfile) {
  const body = rowsToCsv(rows);
  const headers = apiHeaders(cacheProfile);
  headers.set("content-type", CSV_CONTENT_TYPE);
  const safeFilename = contentDispositionFilename(filename);
  headers.set(
    "content-disposition",
    `attachment; filename="${safeFilename}.csv"`,
  );
  return new Response(body, { status: 200, headers });
}
