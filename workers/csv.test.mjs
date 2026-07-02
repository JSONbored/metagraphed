import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  columnsFromRows,
  contentDispositionFilename,
  csvRequested,
  csvResponse,
  rowsToCsv,
} from "./csv.mjs";

describe("rowsToCsv", () => {
  test("serializes headers, escaping, empty values, arrays, and objects", () => {
    const rows = [
      {
        id: 1,
        name: "alpha,beta",
        note: 'he said "hi"',
        tags: ["a", "b"],
        meta: { ok: true },
      },
      { id: 2, name: null, note: "line1\nline2", tags: [], meta: undefined },
    ];

    assert.equal(
      rowsToCsv(rows, ["id", "name", "note", "tags", "meta"]),
      [
        "id,name,note,tags,meta",
        '1,"alpha,beta","he said ""hi""",a; b,"{""ok"":true}"',
        '2,,"line1\nline2",,',
        "",
      ].join("\n"),
    );
  });

  test("uses first-seen union column order when columns are omitted", () => {
    assert.equal(
      rowsToCsv([
        { a: 1, b: 2 },
        { c: 3, a: 4 },
      ]),
      "a,b,c\n1,2,\n4,,3\n",
    );
  });

  test("escapes header cells and keeps object serialization failures bounded", () => {
    const circular = {};
    circular.self = circular;

    assert.equal(
      rowsToCsv([{ "bad,name": 1, meta: circular }]),
      '"bad,name",meta\n1,[object Object]\n',
    );
  });

  test("hardens spreadsheet formula values after leading spaces", () => {
    assert.equal(
      rowsToCsv([{ value: " =SUM(1,1)", safe: "plain" }], ["value", "safe"]),
      'value,safe\n"\' =SUM(1,1)",plain\n',
    );
  });

  test("skips malformed rows while deriving columns", () => {
    assert.deepEqual(
      columnsFromRows([null, ["bad"], "bad", { a: 1 }, { b: 2, a: 3 }]),
      ["a", "b"],
    );
  });
});

describe("csvRequested", () => {
  const req = (accept) =>
    new Request("https://api.metagraph.sh/api/v1/subnets", {
      headers: accept ? { accept } : {},
    });

  test("honors trimmed, case-insensitive ?format=csv", () => {
    const url = new URL(
      "https://api.metagraph.sh/api/v1/subnets?format=%20CSV",
    );
    assert.equal(csvRequested(url, req()), true);
  });

  test("treats ?format=json and absent negotiation as JSON", () => {
    assert.equal(
      csvRequested(
        new URL("https://api.metagraph.sh/api/v1/subnets?format=json"),
        req(),
      ),
      false,
    );
    assert.equal(
      csvRequested(
        new URL("https://api.metagraph.sh/api/v1/subnets?format=json"),
        req("text/csv"),
      ),
      false,
    );
    assert.equal(
      csvRequested(new URL("https://api.metagraph.sh/api/v1/subnets"), req()),
      false,
    );
  });

  test("matches exact text/csv accept entries with q not zero", () => {
    const url = new URL("https://api.metagraph.sh/api/v1/subnets");
    assert.equal(
      csvRequested(url, req("application/json, text/csv;q=0.8")),
      true,
    );
    assert.equal(csvRequested(url, req("text/csvx")), false);
    assert.equal(csvRequested(url, req("text/csv;q=0")), false);
  });
});

describe("csvResponse", () => {
  test("returns text/csv with content disposition, ETag, CORS, and HEAD support", async () => {
    const get = await csvResponse([{ a: 1 }], "../subnets", "standard");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(
      get.headers.get("content-disposition"),
      'attachment; filename="..-subnets.csv"',
    );
    assert.ok(get.headers.get("etag"));
    assert.match(
      get.headers.get("access-control-expose-headers"),
      /\bcontent-disposition\b/,
    );
    assert.equal(await get.text(), "a\n1\n");

    const withHeaders = await csvResponse([{ a: 1 }], "subnets", "standard", {
      extraHeaders: { "x-keep": "yes", "x-skip": null },
    });
    assert.equal(withHeaders.headers.get("x-keep"), "yes");
    assert.equal(withHeaders.headers.has("x-skip"), false);

    const head = await csvResponse([{ a: 1 }], "subnets", "standard", {
      request: new Request("https://api.metagraph.sh/api/v1/subnets", {
        method: "HEAD",
      }),
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("returns 304 when If-None-Match matches", async () => {
    const first = await csvResponse([{ a: 1 }], "subnets", "standard");
    const second = await csvResponse([{ a: 1 }], "subnets", "standard", {
      request: new Request("https://api.metagraph.sh/api/v1/subnets", {
        headers: { "if-none-match": first.headers.get("etag") },
      }),
    });

    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
  });

  test("sanitizes unsafe filename characters", () => {
    assert.equal(
      contentDispositionFilename('nested/"bad"\x00name.csv'),
      "nested-_bad_name.csv",
    );
    assert.equal(contentDispositionFilename(), "export.csv");
    assert.equal(contentDispositionFilename(""), "export.csv");
    assert.equal(contentDispositionFilename("\x00"), "export.csv");
    assert.equal(contentDispositionFilename("report"), "report.csv");
  });
});
