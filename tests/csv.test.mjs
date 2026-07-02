import assert from "node:assert/strict";
import { test } from "vitest";
import { csvRequested, csvResponse, rowsToCsv } from "../workers/csv.mjs";

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

test("rowsToCsv escapes RFC 4180 cells", () => {
  const csv = rowsToCsv([
    { a: "plain", b: "comma,value", c: 'quote "value"' },
    { b: "line\nfeed", d: "carriage\rreturn" },
  ]);

  assert.equal(
    csv,
    'a,b,c,d\r\nplain,"comma,value","quote ""value""",\r\n,"line\nfeed",,"carriage\rreturn"',
  );
});

test("csvRequested honors ?format=csv and Accept negotiation", () => {
  assert.equal(csvRequested(url("?format=csv"), req()), true);
  assert.equal(csvRequested(url("?format=json"), req()), false);
  assert.equal(
    csvRequested(url(), req({ accept: "application/json, text/csv" })),
    true,
  );
});

test("csvResponse sets CSV headers and supports HEAD", async () => {
  const res = await csvResponse(
    [{ netuid: 7, name: "Allways" }],
    "subnet-movers",
    "short",
    req({}, "HEAD"),
    ["netuid", "name"],
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(
    res.headers.get("content-disposition"),
    'attachment; filename="subnet-movers.csv"',
  );
  assert.equal(await res.text(), "");
});
