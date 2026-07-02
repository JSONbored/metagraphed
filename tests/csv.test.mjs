import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildCsvExample,
  csvRequested,
  csvResponse,
  GLOBAL_VALIDATORS_CSV_COLUMNS,
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

test("validateCsvFormatParam accepts absent and csv values", () => {
  assert.equal(validateCsvFormatParam(url()), null);
  assert.equal(validateCsvFormatParam(url("?format=csv")), null);
  assert.equal(validateCsvFormatParam(url("?format=CSV")), null);
});

test("validateCsvFormatParam rejects unsupported format values", () => {
  for (const format of ["xml", "json"]) {
    const error = validateCsvFormatParam(url(`?format=${format}`));
    assert.equal(error.parameter, "format");
    assert.match(error.message, new RegExp(format));
    assert.match(error.message, /format=csv/);
  }
});

test("csvRequested only honors format=csv", () => {
  assert.equal(csvRequested(url("?format=csv")), true);
  assert.equal(csvRequested(url("?format=json")), false);
  assert.equal(csvRequested(url()), false);
});

test("rowsToCsv neutralizes spreadsheet formula trigger prefixes", () => {
  const csv = rowsToCsv([
    {
      name: "=cmd",
      delta: "+100",
      note: "@SUM(A1)",
      tab: "\tleak",
      plain: "safe",
    },
  ]);

  assert.equal(
    csv,
    "name,delta,note,tab,plain\r\n'=cmd,'+100,'@SUM(A1),'\tleak,safe",
  );
});

test("buildCsvExample matches rowsToCsv output for route examples", () => {
  const example = buildCsvExample(GLOBAL_VALIDATORS_CSV_COLUMNS, [
    {
      hotkey: "5HotkeyA",
      coldkey: "5ColdkeyA",
      subnet_count: 3,
      uid_count: 5,
      total_stake_tao: 1200.5,
      total_emission_tao: 45.2,
      avg_validator_trust: 0.91,
      max_validator_trust: 0.95,
      stake_dominance: 0.12,
    },
  ]);
  assert.match(example, /^hotkey,coldkey,/);
  assert.equal(
    example,
    rowsToCsv(
      [
        {
          hotkey: "5HotkeyA",
          coldkey: "5ColdkeyA",
          subnet_count: 3,
          uid_count: 5,
          total_stake_tao: 1200.5,
          total_emission_tao: 45.2,
          avg_validator_trust: 0.91,
          max_validator_trust: 0.95,
          stake_dominance: 0.12,
        },
      ],
      GLOBAL_VALIDATORS_CSV_COLUMNS,
    ),
  );
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
  const response = await csvResponse([], "subnet-movers", "short", null, [
    "netuid",
    "name",
  ]);
  assert.equal(await response.text(), "netuid,name");
});
