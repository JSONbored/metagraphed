import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import { applySerializedQuery, serializeDeclaredQuery } from "../src/subnet-http-query.ts";
import { matchSchemaOperation } from "../src/call-subnet-surface.ts";
import { resolveLocalSchemaObject } from "../src/subnet-openapi-reference.ts";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const parameter = (extra: Row = {}) => ({ name: "color", in: "query", ...(extra.content === undefined ? { schema: {} } : {}), ...extra });
const document = (parameters: unknown = [parameter()], extra: Row = {}) => ({
  ...(extra.swagger === "2.0" ? { swagger: "2.0" } : { openapi: "3.1.0" }),
  info: { title: "Hermetic subnet query fixture", version: "1" },
  paths: { "/query": { get: { parameters, responses: { "200": { description: "Fixture response" } } }, post: { parameters, requestBody: { content: { "application/json": {} } }, responses: { "200": { description: "Fixture response" } } } } },
  ...extra,
});
function render(value: unknown, extra: Row = {}, docExtra: Row = {}) {
  const declaration = docExtra.swagger === "2.0"
    ? { name: "color", in: "query", type: Array.isArray(value) ? "array" : typeof value, ...(Array.isArray(value) ? { items: { type: "string" } } : {}), ...extra }
    : parameter(extra);
  const doc = document([declaration], docExtra);
  const match = matchSchemaOperation(doc, "/query", "GET", true)!;
  const groups = serializeDeclaredQuery(doc, match.pathItem, match.operation, { color: value });
  const url = new URL("https://fixture.example/query");
  applySerializedQuery(url, groups, []);
  return url.search.slice(1);
}

describe("declared HTTP query serialization", () => {
  const colors = ["blue", "black", "brown"];
  const rgb = { R: 100, G: 200, B: 150 };
  for (const [label, value, options, expected] of [
    ["default array", colors, {}, "color=blue&color=black&color=brown"],
    ["joined array", colors, { explode: false }, "color=blue,black,brown"],
    ["default object", rgb, {}, "R=100&G=200&B=150"],
    ["joined object", rgb, { explode: false }, "color=R,100,G,200,B,150"],
    ["space array", colors, { style: "spaceDelimited" }, "color=blue%20black%20brown"],
    ["space object", rgb, { style: "spaceDelimited" }, "color=R%20100%20G%20200%20B%20150"],
    ["pipe array", colors, { style: "pipeDelimited" }, "color=blue%7Cblack%7Cbrown"],
    ["pipe object", rgb, { style: "pipeDelimited" }, "color=R%7C100%7CG%7C200%7CB%7C150"],
    ["deep object", rgb, { style: "deepObject", explode: true }, "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150"],
    ["deep default", rgb, { style: "deepObject" }, "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150"],
    ["deep false", rgb, { style: "deepObject", explode: false }, "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150"],
    ["empty string", "", {}, "color="],
    ["zero", 0, {}, "color=0"],
    ["false", false, {}, "color=false"],
    ["null", null, {}, ""],
    ["empty array", [], {}, ""],
    ["empty joined array", [], { explode: false }, ""],
    ["empty object", {}, {}, ""],
    ["empty joined object", {}, { explode: false }, ""],
    ["undefined list members", [null, "", false, 0], {}, "color=&color=false&color=0"],
    ["undefined map members", { a: null, b: "", c: false }, {}, "b=&c=false"],
    ["undefined deep member", { a: null, b: "" }, { style: "deepObject" }, "color%5Bb%5D="],
    ["literal commas", ["a,b", "c"], { explode: false }, "color=a%2Cb,c"],
    ["reserved literal commas", ["a,b", "c"], { explode: false, allowReserved: true }, "color=a%2Cb,c"],
    ["literal query syntax", "a&api_key=bad#fragment+[]", {}, "color=a%26api_key%3Dbad%23fragment%2B%5B%5D"],
    ["reserved syntax remains data", "a&api_key=bad#fragment+[]", { allowReserved: true }, "color=a%26api_key%3Dbad%23fragment%2B%5B%5D"],
    ["regular reserved characters", ":/?@!$()*,;", {}, "color=%3A%2F%3F%40%21%24%28%29%2A%2C%3B"],
    ["reserved characters", ":/?@!$()*,;", { allowReserved: true }, "color=:/?@!$()*,;"],
    ["reserved pre-encoding", "x%2By%2Fz%ZZ", { allowReserved: true }, "color=x%2By%2Fz%25ZZ"],
    ["regular pre-encoding", "x%2By", {}, "color=x%252By"],
    ["unicode", "雪 /", {}, "color=%E9%9B%AA%20%2F"],
    ["escaped deep key", { "a&b": "雪" }, { style: "deepObject" }, "color%5Ba%26b%5D=%E9%9B%AA"],
    ["provider pre-escaped space", ["a%20b", "c"], { style: "spaceDelimited" }, "color=a%2520b%20c"],
    ["provider pre-escaped pipe", ["a%7Cb", "c"], { style: "pipeDelimited" }, "color=a%257Cb%7Cc"],
  ] as const) test(label, () => assert.equal(render(value, options), expected));

  for (const [format, expected] of [
    [undefined, "color=blue,black,brown"], ["csv", "color=blue,black,brown"],
    ["ssv", "color=blue%20black%20brown"], ["tsv", "color=blue%09black%09brown"],
    ["pipes", "color=blue%7Cblack%7Cbrown"], ["multi", "color=blue&color=black&color=brown"],
  ] as const) test(`Swagger 2 ${format ?? "default"}`, () => {
    assert.equal(render(colors, { collectionFormat: format }, { swagger: "2.0" }), expected);
    assert.equal(render(false, {}, { swagger: "2.0" }), "color=false");
  });

  test("JSON-content parameters preserve every JSON root and serialize once", () => {
    for (const media of ["application/json", "Application/JSON; charset=utf-8", "application/vendor+json"])
      for (const value of [null, false, 0, "", "雪", ["a", { b: [null, false] }], { nested: { x: [1, 2] } }]) {
        const result = new URL(`https://fixture.example/query?${render(value, { content: { [media]: {} } })}`);
        assert.equal(result.searchParams.get("color"), JSON.stringify(value));
      }
    assert.equal(render("{\"raw\":1}", { content: { "text/plain": {} } }), "color=%7B%22raw%22%3A1%7D");
    const original = JSON.stringify;
    let stringifyCalls = 0;
    let query: string;
    try {
      JSON.stringify = new Proxy(original, { apply(target, receiver, args) {
        stringifyCalls++;
        return Reflect.apply(target, receiver, args);
      } });
      query = render({ nested: [1, false] }, { content: { "application/json": {} } });
    } finally { JSON.stringify = original; }
    assert.equal(query, "color=%7B%22nested%22%3A%5B1%2Cfalse%5D%7D");
    assert.equal(stringifyCalls, 1);
  });

  test("path-level local references and operation overrides preserve identities", () => {
    const direct = parameter({ style: "form", explode: false });
    const op = { parameters: [{ $ref: "#/parameters/0" }] };
    const pathItem = { parameters: [parameter({ style: "deepObject" })], get: op };
    const doc = { paths: { "/query": { $ref: "#/components/pathItems/a~1~0%20b" } }, components: { pathItems: { "a/~ b": pathItem } }, parameters: [direct] };
    const match = matchSchemaOperation(doc, "/query", "GET", true)!;
    assert.equal(match.pathItem, pathItem);
    assert.equal(match.operation, op);
    const url = new URL("https://fixture.example/query?keep=a%20b%7E&color=old&color=older#saved");
    applySerializedQuery(url, serializeDeclaredQuery(doc, match.pathItem, op, { color: ["a", "b"] }), []);
    assert.equal(url.href, "https://fixture.example/query?keep=a%20b%7E&color=a,b#saved");
    assert.deepEqual(matchSchemaOperation(doc, "/query", "GET"), { operation: op, matchedTemplate: "/query" });
    const header = { ...direct, in: "header" };
    const inherited = serializeDeclaredQuery(doc, pathItem, { parameters: [header] }, { color: { R: 1 } });
    assert.equal(inherited[0].pairs[0].encoded, "color%5BR%5D=1");
  });

  test("credentials override repeated, exploded and pre-existing query names", () => {
    const doc = document([parameter()]);
    const op = doc.paths["/query"].get;
    const groups = serializeDeclaredQuery(doc, {}, op, { color: { api_key: "wrong", safe: "a,b" } });
    const url = new URL("https://fixture.example/query?api_key=old&api_key=older&keep=x%20y&safe=old&&");
    applySerializedQuery(url, groups, [["api_key", "secret +&雪"]]);
    assert.equal(url.href, "https://fixture.example/query?keep=x%20y&&&safe=a%2Cb&api_key=secret+%2B%26%E9%9B%AA");
    assert.deepEqual(url.searchParams.getAll("api_key"), ["secret +&雪"]);
    const repeated = serializeDeclaredQuery(doc, {}, { parameters: [{ name: "api_key", in: "query" }] }, { api_key: ["wrong", "wrong2"] });
    applySerializedQuery(url, repeated, [["api_key", "actual"]]);
    assert.deepEqual(url.searchParams.getAll("api_key"), ["actual"]);
  });

  test("omitted typed values remove a pre-existing query field without adding a pair", () => {
    const doc = document();
    const url = new URL("https://fixture.example/query?color=old&keep=yes");
    applySerializedQuery(url, serializeDeclaredQuery(doc, {}, doc.paths["/query"].get, { color: null }), []);
    assert.equal(url.search, "?keep=yes");
  });

  test("undefined styles, shapes and malformed declarations fail before URL construction", () => {
    for (const [value, options, extra] of [
      [1, { style: "spaceDelimited" }, {}], [[1], { style: "matrix" }, {}],
      [[1], { explode: "yes" }, {}], [[1], { allowReserved: 1 }, {}],
      [[1], { style: "pipeDelimited", explode: true }, {}],
      [[1], { style: "deepObject" }, {}], [{ x: [1] }, {}, {}],
      [[[1]], {}, {}], [Infinity, {}, {}], [undefined, {}, {}],
      [{ a: 1 }, {}, { swagger: "2.0" }], [[1], { collectionFormat: "bad" }, { swagger: "2.0" }],
      [[1], { collectionFormat: "__proto__" }, { swagger: "2.0" }],
      [null, { content: {} }, {}], [null, { content: 1 }, {}],
      [null, { content: { "application/json": {}, "text/plain": {} } }, {}],
      [1, { content: { "text/plain": {} } }, {}],
      [undefined, { content: { "application/json": {} } }, {}],
      [1, { schema: {}, content: { "application/json": {} } }, {}],
      [["a b", "c"], { style: "spaceDelimited" }, {}],
      [["a|b", "c"], { style: "pipeDelimited" }, {}],
      [["a\tb", "c"], { collectionFormat: "tsv" }, { swagger: "2.0" }],
      [{ "a b": 1 }, { style: "spaceDelimited" }, {}],
      [{ a: "b|c" }, { style: "pipeDelimited" }, {}],
      [{ "a[b]": 1 }, { style: "deepObject" }, {}],
      ["\ud800", {}, {}],
    ] as const) assert.throws(() => render(value, options, extra));
    for (const parameters of [null, 1, {}]) {
      const doc = document(parameters);
      assert.throws(() => serializeDeclaredQuery(doc, {}, doc.paths["/query"].get, { color: [1] }), /malformed captured/);
    }
    for (const parameters of [undefined, [], [{ $ref: "https://foreign.example/parameter" }], [null], [{ name: 1, in: "query" }], [{ name: "color", in: "header" }]]) {
      const doc = document(parameters);
      const op = parameters === undefined ? {} : doc.paths["/query"].get;
      assert.throws(() => serializeDeclaredQuery(doc, {}, op, { color: [1] }), /not declared/);
    }
    const doc = document();
    assert.throws(() => serializeDeclaredQuery(doc, {}, doc.paths["/query"].get, { color: [1] }, { color: "legacy" }), /overlaps/);
    assert.throws(() => serializeDeclaredQuery(doc, {}, doc.paths["/query"].get, { color: { x: 1 } }, { x: "legacy" }), /overlaps/);
    const op = { parameters: [parameter(), { name: "x", in: "query" }] };
    assert.throws(() => serializeDeclaredQuery(doc, {}, op, { color: { x: 1 }, x: 2 }), /overlaps/);
  });

  test("local references traverse only canonical own array indices", () => {
    const direct = parameter();
    const doc = { parameters: [direct] };
    assert.equal(resolveLocalSchemaObject(doc, { $ref: "#/parameters/0" }), direct);
    for (const key of ["01", "-1", "-", "1", "length", "constructor", "__proto__", "0/constructor/prototype"])
      assert.equal(resolveLocalSchemaObject(doc, { $ref: `#/parameters/${key}` }), null);
    assert.equal(matchSchemaOperation({ paths: { "/query": { $ref: "#/missing" } } }, "/query", "GET"), null);
  });
});

async function invoke(args: Row, options: { doc?: Row | null; reviewed?: boolean; raw?: string; tool?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const artifacts: string[] = [];
  const surface = { surface_id: "query:api:1", netuid: 5, kind: "subnet-api", url: "https://fixture.example/api", auth_required: true, auth: { scheme: "api-key", location: "query", name: "api_key" }, probe: { method: "GET", enabled: !options.reviewed }, schema_source: { surface_id: "query:openapi:1" }, ...(options.reviewed ? { http: { operations: [{ method: "GET", path: "/query" }] } } : {}) };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url.hostname, "fixture.example", "No provider or production traffic");
    calls.push({ url: url.href, init: init! });
    return Response.json({ accepted: true });
  };
  try {
    const response = await handleMcpRequest(new Request("https://metagraph.sh/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: options.raw ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: options.tool ?? "call_subnet_surface", arguments: args } }) }), mockEnv(), {
      readArtifact: async (_env: Row, path: string) => {
        artifacts.push(path);
        if (path === "/metagraph/operational-surfaces.json") return { ok: true, data: { surfaces: [surface] } };
        if (path === "/metagraph/schemas/query:openapi:1.json" && options.doc !== null) return { ok: true, data: { document: options.doc ?? document() } };
        return { ok: false, status: 404 };
      },
    });
    const envelope = await jsonBody(response);
    return { result: envelope.result, calls, artifacts };
  } finally { globalThis.fetch = original; }
}
const base = { surface_id: "query:api:1", path: "/query", method: "GET", credential: "secret +&雪" };

describe("public MCP declared-query boundary", () => {
  test("both published schemas admit JSON query values and preserve legacy scalar restrictions", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const name of ["call_subnet_surface", "write_subnet_surface"]) {
      const valid = ajv.compile(MCP_TOOLS.find((tool) => tool.name === name)!.inputSchema);
      const args = { ...base, method: name === "call_subnet_surface" ? "GET" : "POST" };
      assert.equal(valid({ ...args, query_values: { color: ["a", "b"], filter: { nested: [null, 0, false] } } }), true, JSON.stringify(valid.errors));
      assert.equal(valid({ ...args, query: { color: ["a", "b"] } }), false);
      for (const query_values of [null, [], "", false]) assert.equal(valid({ ...args, query_values }), false);
    }
  });

  test("actual read/write calls emit declared query groups with last-wins credentials", async () => {
    for (const tool of ["call_subnet_surface", "write_subnet_surface"]) {
      const args = { ...base, method: tool === "call_subnet_surface" ? "GET" : "POST", query_values: { color: { api_key: "wrong", filter: "a,b" } }, ...(tool === "write_subnet_surface" ? { json_body: [false, null] } : {}) };
      const { result, calls } = await invoke(args, { tool });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://fixture.example/query?filter=a%2Cb&api_key=secret+%2B%26%E9%9B%AA");
      assert.equal(calls[0].init.method, args.method);
      if (tool === "write_subnet_surface") assert.equal(calls[0].init.body, "[false,null]");
      const text = JSON.stringify(result);
      assert.equal(text.includes("secret"), false);
      assert.equal(text.includes("wrong"), false);
    }
  });

  test("SDK round-trip preserves negative-zero and overflow normalization in JSON query content", async () => {
    const args = { ...base, query_values: { color: [] } };
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "call_subnet_surface", arguments: args } }).replace('"color":[]', '"color":[-0,1e400]');
    const { result, calls } = await invoke(args, { raw, doc: document([parameter({ content: { "application/json": {} } })]) });
    assert.equal(result.isError, undefined);
    assert.equal(new URL(calls[0].url).searchParams.get("color"), "[0,null]");
  });

  test("reviewed admission and captured query declarations are both required", async () => {
    const args = { ...base, query_values: { color: ["a", "b"] } };
    const valid = await invoke(args, { reviewed: true });
    assert.equal(valid.result.isError, undefined);
    assert.equal(valid.calls.length, 1);
    for (const doc of [null, { paths: {} }, document([])]) {
      const denied = await invoke(args, { reviewed: true, doc });
      assert.equal(denied.result.isError, true);
      assert.equal(denied.calls.length, 0);
    }
    const forbidden = await invoke({ ...args, path: "/unreviewed" }, { reviewed: true });
    assert.equal(forbidden.result.isError, true);
    assert.equal(forbidden.calls.length, 0);
    const legacy = await invoke({ ...base, query: { filter: "already serialized" } }, { reviewed: true, doc: null });
    assert.equal(legacy.result.isError, undefined);
    assert.equal(legacy.artifacts.some((path) => path.includes("/schemas/")), false);
  });

  test("malformed or conflicting typed values never reach a provider", async () => {
    for (const args of [
      { ...base, query_values: null }, { ...base, query_values: [] },
      { ...base, query_values: { unknown: [1] } },
      { ...base, query: { color: "a" }, query_values: { color: [1] } },
      { ...base, query_values: { color: [[1]] } },
      { ...base, path: undefined, method: undefined, query_values: { color: [1] } },
    ]) {
      const denied = await invoke(args);
      assert.equal(denied.result.isError, true);
      assert.equal(denied.calls.length, 0);
    }
  });

  test("empty typed values preserve the old scalar query bytes and require no schema read", async () => {
    const args = { ...base, query: { note: "a b~*雪", ok: false, count: 0 } };
    const before = await invoke(args, { reviewed: true });
    const after = await invoke({ ...args, query_values: {} }, { reviewed: true });
    assert.equal(before.result.isError, undefined);
    assert.equal(after.result.isError, undefined);
    assert.equal(after.calls[0].url, before.calls[0].url);
    assert.equal(after.artifacts.some((path) => path.includes("/schemas/")), false);
  });

  test("typed query fixture reduces argument escaping while keeping the exact outbound URL", async () => {
    const values = Array.from({ length: 12 }, (_, index) => `雪storm ${index} / bullish?x=y&雪`);
    const path = "/query?" + values.map((value) => `color=${encodeURIComponent(value)}`).join("&");
    const legacy = { ...base, path };
    const typed = { ...base, query_values: { color: values } };
    const before = await invoke(legacy);
    const after = await invoke(typed);
    assert.equal(before.result.isError, undefined);
    assert.equal(after.result.isError, undefined);
    assert.equal(after.calls[0].url, before.calls[0].url);
    assert.equal(before.calls.length, 1);
    assert.equal(after.calls.length, 1);
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
    const typedBytes = Buffer.byteLength(JSON.stringify(typed));
    assert.ok(typedBytes < legacyBytes);
    console.log("SUBNET_HTTP_QUERY_ARGUMENT_FIXTURE", JSON.stringify({ legacy_argument_bytes: legacyBytes, typed_argument_bytes: typedBytes, outbound_url_equal: true, provider_requests_per_mode: 1, production_requests: 0 }));
  });
});
