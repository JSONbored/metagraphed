import { apiHeaders, ifNoneMatchSatisfied, weakEtag } from "./http.ts";
import type { CacheProfile } from "./http.ts";

const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r\n]/;
// Keep each stream pull bounded without fragmenting typical endpoint exports
// into overly small chunks.
const CSV_STREAM_ROWS_PER_CHUNK = 128;

function normalizeColumns(
  rows: unknown[],
  columns: string[] | null | undefined,
): string[] {
  if (Array.isArray(columns) && columns.length > 0) {
    return columns.map((column) => String(column));
  }

  const seen = new Set<string>();
  const names: string[] = [];
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

function stringifyCell(value: unknown): string {
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

function escapeCell(value: unknown): string {
  const text = stringifyCell(value);
  const safeText = SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;
  if (!/[",\r\n]/.test(safeText)) {
    return safeText;
  }
  return `"${safeText.replaceAll('"', '""')}"`;
}

function csvFilename(filename: string | null | undefined): string {
  const stem =
    String(filename || "export")
      .replace(/\.csv$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  return `${stem}.csv`;
}

export function rowsToCsv(
  rows: unknown[],
  columns: string[] | null | undefined,
): string {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = normalizeColumns(safeRows, columns);
  if (header.length === 0) {
    return "";
  }

  const lines = [
    header.map(escapeCell).join(","),
    ...safeRows.map((row) => csvLineForRow(row, header)),
  ];
  return lines.join("\r\n");
}

function csvLineForRow(row: unknown, header: string[]): string {
  return header
    .map((column) =>
      escapeCell(
        row && typeof row === "object" && !Array.isArray(row)
          ? (row as Record<string, unknown>)[column]
          : undefined,
      ),
    )
    .join(",");
}

export function csvBodyStream(
  rows: unknown[],
  columns: string[] | null | undefined,
): ReadableStream {
  const safeRows = Array.isArray(rows) ? rows : [];
  const header = normalizeColumns(safeRows, columns);
  const encoder = new TextEncoder();

  if (header.length === 0) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }

  const headerLine = header.map(escapeCell).join(",");
  let index = 0;
  let sentHeader = false;

  return new ReadableStream({
    pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(
          encoder.encode(
            safeRows.length > 0 ? `${headerLine}\r\n` : headerLine,
          ),
        );
        if (safeRows.length === 0) {
          controller.close();
        }
        return;
      }

      const lines = [];
      while (
        index < safeRows.length &&
        lines.length < CSV_STREAM_ROWS_PER_CHUNK
      ) {
        lines.push(csvLineForRow(safeRows[index], header));
        index += 1;
      }
      const chunkText =
        index < safeRows.length
          ? `${lines.join("\r\n")}\r\n`
          : lines.join("\r\n");
      if (chunkText.length > 0) {
        controller.enqueue(encoder.encode(chunkText));
      }
      if (index >= safeRows.length) {
        controller.close();
      }
    },
  });
}

export function csvRequested(url: URL, request: Request): boolean {
  const format = url.searchParams.get("format")?.toLowerCase();
  if (format === "csv") {
    return true;
  }
  if (format === "json") {
    return false;
  }
  return acceptsCsv(request.headers.get("accept") || "");
}

function acceptsCsv(header: string): boolean {
  let csvQuality = 0;
  let jsonQuality = 0;

  for (const part of header.split(",")) {
    const [mediaType, ...params] = part
      .split(";")
      .map((value) => value.trim().toLowerCase());
    if (mediaType === "text/csv") {
      csvQuality = Math.max(csvQuality, acceptQuality(params));
    } else if (mediaType === "application/json") {
      jsonQuality = Math.max(jsonQuality, acceptQuality(params));
    }
  }

  return csvQuality > 0 && csvQuality >= jsonQuality;
}

function acceptQuality(params: string[]): number {
  const qParam = params.find((param) => param.startsWith("q="));
  if (!qParam) {
    return 1;
  }
  const q = Number(qParam.slice(2));
  if (!Number.isFinite(q)) {
    return 0;
  }
  if (q < 0 || q > 1) {
    return 0;
  }
  return q;
}

export async function csvResponse(
  rows: unknown[],
  filename: string | null | undefined,
  cacheProfile: CacheProfile,
  request: Request | null = null,
  columns: string[] | undefined = undefined,
  extraHeaders: Record<string, string> = {},
  options: { stream?: boolean } = {},
): Promise<Response> {
  const headers = apiHeaders(cacheProfile);
  headers.set("content-type", "text/csv; charset=utf-8");
  headers.set(
    "content-disposition",
    `attachment; filename="${csvFilename(filename)}"`,
  );
  headers.set("vary", "Accept, Accept-Encoding");
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  const shouldStream =
    options.stream === true &&
    request?.method !== "HEAD" &&
    !request?.headers?.get("if-none-match");
  if (shouldStream) {
    // Stream plain GET exports without precomputing the full body; that skips
    // issuing a weak ETag on those large downloads, so HEAD and conditional
    // requests stay buffered and keep the validator path.
    return new Response(csvBodyStream(rows, columns), {
      status: 200,
      headers,
    });
  }

  const body = rowsToCsv(rows, columns);
  const etag = await weakEtag(body);
  headers.set("etag", etag);

  if (request && ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request?.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
