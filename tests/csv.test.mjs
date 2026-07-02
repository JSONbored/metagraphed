import assert from "node:assert/strict";
import { test } from "vitest";
import {
  csvRequested,
  csvResponse,
  rowsToCsv,
  validateCsvFormatParam,
} from "../workers/csv.mjs";

function url(search = "") {
  return new URL(`https://api.metagraph.sh/api/v1/subnets/movers${search}`);
}

function req(headers = {}, method = "GET") {
  return new Request("https://api.metagraph.sh/api/v1/subnets/movers", {
    method,
    headers,
  });
}

test("rowsToCsv returns an empty body for empty rows without explicit columns", () => {
  assert.equal(rowsToCsv([]), "");
});

test("rowsToCsv emits explicit columns for empty rows", () => {
  assert.equal(rowsToCsv([], ["netuid", "name"]), "netuid,name");
});

test("rowsToCsv accepts explicit columns with a non-array row input", () => {
  assert.equal(rowsToCsv(null, ["netuid"]), "netuid");
});

test("rowsToCsv skips malformed rows when deriving columns", () => {
  assert.equal(
    rowsToCsv([null, ["bad"], { netuid: 7 }]),
    "netuid\r\n\r\n\r\n7",
  );
});

test("rowsToCsv uses first-seen union column order and escapes RFC 4180 cells", () => {
  const csv = rowsToCsv([
    { a: "plain", b: "comma,value", c: 'quote "value"' },
    { b: "line\nfeed", d: "carriage\rreturn" },
  ]);

  assert.equal(
    csv,
    'a,b,c,d\r\nplain,"comma,value","quote ""value""",\r\n,"line\nfeed",,"carriage\rreturn"',
  );
});

test("rowsToCsv serializes nulls, arrays, and objects predictably", () => {
  const csv = rowsToCsv([
    {
      missing: null,
      tags: ["inference", "validators", { nested: true }],
      metadata: { ok: true, count: 2 },
      empty: undefined,
    },
  ]);

  assert.equal(
    csv,
    'missing,tags,metadata,empty\r\n,"inference;validators;{""nested"":true}","{""ok"":true,""count"":2}",',
  );
});

test("validateCsvFormatParam accepts absent, csv, and json values", () => {
  assert.equal(validateCsvFormatParam(url()), null);
  assert.equal(validateCsvFormatParam(url("?format=csv")), null);
  assert.equal(validateCsvFormatParam(url("?format=JSON")), null);
  assert.equal(validateCsvFormatParam(url("?format=json")), null);
});

test("validateCsvFormatParam rejects unsupported format values", () => {
  const error = validateCsvFormatParam(url("?format=xml"));
  assert.equal(error.parameter, "format");
  assert.match(error.message, /xml/);
  assert.match(error.message, /format=csv/);
});

test("csvRequested honors format and Accept negotiation", () => {
  assert.equal(csvRequested(url("?format=csv"), req()), true);
  assert.equal(
    csvRequested(url(), req({ accept: "application/json, text/csv" })),
    true,
  );
  assert.equal(
    csvRequested(url("?format=json"), req({ accept: "text/csv" })),
    false,
  );
  assert.equal(csvRequested(url(), req({ accept: "application/json" })), false);
  assert.equal(csvRequested(url(), req()), false);
});

test("csvResponse emits CSV download headers and a conditional ETag", async () => {
  const first = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnet-movers",
    "short",
  );
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /^text\/csv/);
  assert.equal(
    first.headers.get("content-disposition"),
    'attachment; filename="subnet-movers.csv"',
  );
  assert.ok(first.headers.get("etag"));
  assert.equal(await first.text(), "netuid,name\r\n7,Allways");

  const matched = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnet-movers",
    "short",
    req({ "if-none-match": first.headers.get("etag") }),
  );
  assert.equal(matched.status, 304);
  assert.equal(await matched.text(), "");
});

test("csvResponse sanitizes download filenames", async () => {
  const withExtension = await csvResponse([], "subnet-movers.csv", "short");
  assert.equal(
    withExtension.headers.get("content-disposition"),
    'attachment; filename="subnet-movers.csv"',
  );

  const withSpaces = await csvResponse([], "unsafe report", "short");
  assert.equal(
    withSpaces.headers.get("content-disposition"),
    'attachment; filename="unsafe-report.csv"',
  );

  const emptyStem = await csvResponse([], "///", "short");
  assert.equal(
    emptyStem.headers.get("content-disposition"),
    'attachment; filename="export.csv"',
  );

  const missingName = await csvResponse([], "", "short");
  assert.equal(
    missingName.headers.get("content-disposition"),
    'attachment; filename="export.csv"',
  );
});

test("csvResponse suppresses the body on HEAD", async () => {
  const response = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnet-movers",
    "short",
    req({}, "HEAD"),
    ["netuid", "name"],
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("csvResponse honors explicit columns for empty exports", async () => {
  const response = await csvResponse(
    [],
    "subnet-movers",
    "short",
    null,
    ["netuid", "name"],
  );
  assert.equal(await response.text(), "netuid,name");
});
