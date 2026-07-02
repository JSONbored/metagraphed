import {
  buildCsvExample,
  csvRequested,
  GLOBAL_VALIDATORS_CSV_COLUMNS,
  rowsToCsv,
  SUBNET_MOVERS_CSV_COLUMNS,
  validateCsvFormatParam,
} from "../src/csv-export.mjs";
import { apiHeaders, ifNoneMatchSatisfied, weakEtag } from "./http.mjs";

export {
  buildCsvExample,
  csvRequested,
  GLOBAL_VALIDATORS_CSV_COLUMNS,
  rowsToCsv,
  SUBNET_MOVERS_CSV_COLUMNS,
  validateCsvFormatParam,
};

function csvFilename(filename) {
  const stem =
    String(filename || "export")
      .replace(/\.csv$/i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export";
  return `${stem}.csv`;
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
  headers.set("vary", "Accept-Encoding");

  if (request && ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request?.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
