// Unit tests for workers/csv.mjs (issue #2519).
// Covers: empty rows, RFC 4180 escaping for every special character, both sides
// of the ?format=csv vs Accept negotiation (branch coverage), null/array/object
// cell values, and the Content-Disposition filename header.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { rowsToCsv, csvRequested, csvResponse } from "./csv.mjs";

// ── rowsToCsv ─────────────────────────────────────────────────────────────

describe("rowsToCsv", () => {
  test("returns only the header row for an empty rows array", () => {
    // No columns can be inferred; the result is an empty string (no header
    // to emit because there are no keys to discover).
    assert.equal(rowsToCsv([]), "");
  });

  test("header row reflects first-seen key order across all rows", () => {
    const rows = [
      { b: 2, a: 1 },
      { c: 3, a: 4 },
    ];
    const csv = rowsToCsv(rows);
    const [header] = csv.split("\r\n");
    assert.equal(header, "b,a,c");
  });

  test("explicit columns parameter overrides auto-detection order", () => {
    const rows = [{ a: 1, b: 2, c: 3 }];
    const csv = rowsToCsv(rows, ["c", "a"]);
    const [header, data] = csv.split("\r\n");
    assert.equal(header, "c,a");
    assert.equal(data, "3,1");
  });

  test("uses CRLF line endings per RFC 4180", () => {
    const csv = rowsToCsv([{ x: 1 }]);
    assert.ok(csv.includes("\r\n"), "must use \\r\\n");
  });

  test("plain values are serialized without quoting", () => {
    const csv = rowsToCsv([{ name: "alice", score: 42 }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "alice,42");
  });

  // ── RFC 4180 escaping ──────────────────────────────────────────────────

  test("wraps a field in double-quotes when it contains a comma", () => {
    const csv = rowsToCsv([{ v: "a,b" }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, '"a,b"');
  });

  test("doubles embedded double-quotes and wraps the field", () => {
    const csv = rowsToCsv([{ v: 'say "hi"' }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, '"say ""hi"""');
  });

  test("wraps a field in double-quotes when it contains a newline (LF)", () => {
    const csv = rowsToCsv([{ v: "line1\nline2" }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, '"line1\nline2"');
  });

  test("wraps a field in double-quotes when it contains a carriage return (CR)", () => {
    const csv = rowsToCsv([{ v: "line1\rline2" }]);
    // The row is the second CRLF-split segment only when CR alone isn't
    // present in the first segment — use a targeted check instead.
    assert.ok(csv.includes('"line1\rline2"'));
  });

  test("column headers containing commas are quoted", () => {
    const csv = rowsToCsv([{ "a,b": 1 }]);
    const [header] = csv.split("\r\n");
    assert.equal(header, '"a,b"');
  });

  // ── Null / special value serialization ────────────────────────────────

  test("null value serializes as an empty field", () => {
    const csv = rowsToCsv([{ x: null }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "");
  });

  test("undefined value serializes as an empty field", () => {
    const csv = rowsToCsv([{ x: undefined }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "");
  });

  test("missing column value for a row serializes as an empty field", () => {
    const rows = [{ a: 1, b: 2 }, { a: 3 }];
    const csv = rowsToCsv(rows);
    const lines = csv.split("\r\n");
    assert.equal(lines[2], "3,");
  });

  test("array value is joined with semicolons", () => {
    const csv = rowsToCsv([{ tags: ["x", "y", "z"] }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "x;y;z");
  });

  test("array containing a comma-bearing element is quoted after join", () => {
    const csv = rowsToCsv([{ tags: ["a,b", "c"] }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, '"a,b;c"');
  });

  test("object value is serialized as compact JSON", () => {
    const csv = rowsToCsv([{ meta: { k: 1 } }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, '"{""k"":1}"');
  });

  test("boolean values are serialized as true/false strings", () => {
    const csv = rowsToCsv([{ flag: true, off: false }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "true,false");
  });

  test("zero is serialized as '0', not treated as falsy/empty", () => {
    const csv = rowsToCsv([{ n: 0 }]);
    const [, row] = csv.split("\r\n");
    assert.equal(row, "0");
  });

  test("multiple rows are each on their own CRLF-delimited line", () => {
    const csv = rowsToCsv([{ x: 1 }, { x: 2 }, { x: 3 }]);
    const lines = csv.split("\r\n");
    assert.equal(lines.length, 4); // header + 3 rows
    assert.equal(lines[0], "x");
    assert.equal(lines[1], "1");
    assert.equal(lines[2], "2");
    assert.equal(lines[3], "3");
  });
});

// ── csvRequested ──────────────────────────────────────────────────────────

describe("csvRequested", () => {
  const makeReq = (accept = "") =>
    new Request("https://metagraph.sh/api/v1/something", {
      headers: accept ? { accept } : {},
    });

  test("returns true for ?format=csv", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo?format=csv");
    assert.ok(csvRequested(url, makeReq()));
  });

  test("returns true for case-insensitive ?format=CSV and with whitespace", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo?format=  CSV  ");
    assert.ok(csvRequested(url, makeReq()));
  });

  test("?format param wins over Accept header — format=json beats Accept:text/csv", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo?format=json");
    assert.ok(!csvRequested(url, makeReq("text/csv")));
  });

  test("returns true for Accept: text/csv (no format param)", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(csvRequested(url, makeReq("text/csv")));
  });

  test("returns true for Accept: text/csv; charset=utf-8 (supports media type parameters)", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(csvRequested(url, makeReq("text/csv; charset=utf-8")));
  });

  test("returns false for partial matches like Accept: text/csvx or Accept: text/csv-bogus", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(!csvRequested(url, makeReq("text/csvx")));
    assert.ok(!csvRequested(url, makeReq("text/csv-bogus")));
  });

  test("returns true for Accept: text/csv, */* (multi-type accept)", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(csvRequested(url, makeReq("application/json, text/csv")));
  });

  test("returns false when format param is absent and Accept is application/json", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(!csvRequested(url, makeReq("application/json")));
  });

  test("returns false when format param is absent and no Accept header present", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo");
    assert.ok(!csvRequested(url, makeReq()));
  });

  test("returns false for ?format= (blank value, not 'csv')", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo?format=");
    assert.ok(!csvRequested(url, makeReq()));
  });

  test("returns false for ?format=xml (unknown format)", () => {
    const url = new URL("https://metagraph.sh/api/v1/foo?format=xml");
    assert.ok(!csvRequested(url, makeReq("text/csv")));
  });
});

// ── csvResponse ───────────────────────────────────────────────────────────

describe("csvResponse", () => {
  test("returns a 200 Response", () => {
    const res = csvResponse([{ a: 1 }], "export", "standard");
    assert.equal(res.status, 200);
  });

  test("content-type is text/csv; charset=utf-8", () => {
    const res = csvResponse([{ a: 1 }], "export", "standard");
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  });

  test("Content-Disposition attachment header uses the provided filename with .csv extension", () => {
    const res = csvResponse([{ a: 1 }], "neurons-42", "standard");
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="neurons-42.csv"',
    );
  });

  test("Content-Disposition strips path separators and control characters, and escapes double quotes and backslashes", () => {
    const res = csvResponse(
      [{ a: 1 }],
      'neurons/42\\test"name\r\n',
      "standard",
    );
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="neurons42test\\"name.csv"',
    );
  });

  test("body contains the serialized CSV rows", async () => {
    const rows = [{ name: "alice", score: 100 }];
    const res = csvResponse(rows, "out", "standard");
    const body = await res.text();
    assert.ok(body.startsWith("name,score\r\nalice,100"));
  });

  test("reuses apiHeaders cache-control — standard profile has public max-age", () => {
    const res = csvResponse([], "empty", "standard");
    const cc = res.headers.get("cache-control") || "";
    assert.ok(cc.includes("public"), "cache-control should be public");
    assert.ok(cc.includes("max-age="), "cache-control should include max-age");
  });

  test("short cache profile produces a shorter max-age than standard", () => {
    const stdRes = csvResponse([], "f", "standard");
    const shortRes = csvResponse([], "f", "short");
    const stdMaxAge = Number(
      (stdRes.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1],
    );
    const shortMaxAge = Number(
      (shortRes.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1],
    );
    assert.ok(
      shortMaxAge < stdMaxAge,
      `short (${shortMaxAge}) should be < standard (${stdMaxAge})`,
    );
  });

  test("CORS access-control-allow-origin is * (inherited from apiHeaders)", () => {
    const res = csvResponse([], "out", "standard");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
