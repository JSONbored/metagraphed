import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { matchSchemaOperation } from "../src/call-subnet-surface.ts";
import { resolveLocalRequestBody } from "../src/subnet-http-body.ts";
import { resolveSwaggerRequestBody } from "../src/subnet-swagger-body.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const bodyParameter = { name: "documentedName", in: "body", schema: {} };
const formParameter = { name: "file", in: "formData", type: "file", required: true };
const swagger = (operation: Row = {}, extra: Row = {}) => ({
  swagger: "2.0",
  info: { title: "Hermetic Swagger body fixture", version: "1" },
  consumes: ["application/json"],
  paths: { "/write": { post: { parameters: [bodyParameter], responses: { "200": { description: "fixture" } }, ...operation } } },
  ...extra,
});

function resolve(doc: Row) {
  const match = matchSchemaOperation(doc, "/write", "POST", true)!;
  return resolveSwaggerRequestBody(doc, match.pathItem, match.operation);
}

describe("captured Swagger 2 request body declarations", () => {
  test("other document formats do not inspect Swagger parameters", () => {
    const operation = { get parameters(): never { throw new Error("Unneeded parameter read"); } };
    for (const doc of [null, {}, { openapi: "3.1.0" }])
      assert.equal(resolveSwaggerRequestBody(doc, null, operation), null);
  });

  test("local path/parameter references and operation overrides keep the original schema", () => {
    const schema = { $ref: "#/definitions/Message" };
    const inherited = { ...bodyParameter, required: true };
    const overriding = { ...bodyParameter, required: false, schema };
    const pathItem = { parameters: [inherited], post: { parameters: [{ $ref: "#/parameters/0" }] } };
    const doc = swagger({}, { paths: { "/write": { $ref: "#/pathItems/0" } }, pathItems: [pathItem], parameters: [overriding] });
    const result = resolve(doc)!;
    assert.equal(result.required, false);
    assert.deepEqual(Object.keys(result.content), ["application/json"]);
    assert.equal(result.content["application/json"].schema, schema);
    assert.equal(overriding.schema, schema);
  });

  test("consumes inheritance, overrides and explicit clearing", () => {
    assert.deepEqual(Object.keys(resolve(swagger())!.content), ["application/json"]);
    assert.deepEqual(Object.keys(resolve(swagger({ consumes: ["text/plain"] }))!.content), ["text/plain"]);
    assert.deepEqual(Object.keys(resolve(swagger({ consumes: [] }))!.content), ["*/*"]);
    assert.deepEqual(Object.keys(resolve(swagger({}, { consumes: undefined }))!.content), ["*/*"]);
    assert.deepEqual(Object.keys(resolve(swagger({ consumes: ["application/vendor+json; charset=utf-8"] }))!.content), ["application/vendor+json; charset=utf-8"]);
  });

  test("form parameters admit exact URL-encoded and multipart payloads", () => {
    const doc = swagger({ parameters: [formParameter, { name: "labels", in: "formData", type: "array", collectionFormat: "multi", items: { type: "string" } }] }, { consumes: ["application/x-www-form-urlencoded", "multipart/form-data; boundary=fixed"] });
    assert.deepEqual(resolve(doc), { required: true, content: { "application/x-www-form-urlencoded": {}, "multipart/form-data; boundary=fixed": {} } });
    assert.deepEqual(Object.keys(resolve(swagger({ parameters: [{ ...formParameter, required: false }], consumes: [] }))!.content), ["application/x-www-form-urlencoded", "multipart/form-data"]);
  });

  test("operations without a payload declaration do not inherit a body from consumes", () => {
    assert.equal(resolve(swagger({ parameters: undefined }, { consumes: null })), null);
    assert.equal(resolve(swagger({ parameters: [{ name: "q", in: "query" }, { name: "h", in: "header" }] })), null);
  });

  for (const [label, operation, extra] of [
    ["null parameter list", { parameters: null }, {}],
    ["object parameter list", { parameters: {} }, {}],
    ["null parameter", { parameters: [null] }, {}],
    ["external parameter", { parameters: [{ $ref: "https://foreign.example/parameter" }] }, {}],
    ["cyclic parameter", { parameters: [{ $ref: "#/parameters/p" }] }, { parameters: { p: { $ref: "#/parameters/p" } } }],
    ["missing name", { parameters: [{ in: "body", schema: {} }] }, {}],
    ["duplicate body declaration", { parameters: [bodyParameter, bodyParameter] }, {}],
    ["multiple body names", { parameters: [bodyParameter, { ...bodyParameter, name: "other" }] }, {}],
    ["missing body schema", { parameters: [{ name: "body", in: "body" }] }, {}],
    ["boolean body schema", { parameters: [{ ...bodyParameter, schema: true }] }, {}],
    ["malformed required", { parameters: [{ ...bodyParameter, required: "yes" }] }, {}],
    ["body/form mixture", { parameters: [bodyParameter, formParameter] }, {}],
    ["null consumes", { consumes: null }, {}],
    ["string consumes", { consumes: "application/json" }, {}],
    ["non-string media", { consumes: [1] }, {}],
    ["empty media", { consumes: [" "] }, {}],
    ["non-form media", { parameters: [formParameter], consumes: ["application/json"] }, {}],
  ] as const)
    test(`rejects ${label}`, () => assert.throws(() => resolve(swagger(operation, extra)), /Invalid captured Swagger/));
});

async function invoke(args: Row, doc: Row, options: { auth?: Row; tool?: string; raw?: string } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const artifacts: string[] = [];
  const surface = { surface_id: "swagger:api:1", netuid: 5, kind: "subnet-api", url: "https://fixture.example/api", auth_required: true, auth: options.auth ?? { scheme: "bearer", location: "header", name: "Authorization" }, probe: { method: "GET", enabled: true }, schema_source: { surface_id: "swagger:openapi:1" } };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url.hostname, "fixture.example", "No provider or production traffic");
    calls.push({ url: url.href, init: init! });
    return Response.json({ accepted: true });
  };
  try {
    const response = await handleMcpRequest(new Request("https://metagraph.sh/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: options.raw ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: options.tool ?? "write_subnet_surface", arguments: args } }) }), mockEnv(), {
      readArtifact: async (_env: Row, path: string) => {
        artifacts.push(path);
        if (path === "/metagraph/operational-surfaces.json") return { ok: true, data: { surfaces: [surface] } };
        if (path === "/metagraph/schemas/swagger:openapi:1.json") return { ok: true, data: { document: doc } };
        return { ok: false, status: 404 };
      },
    });
    const envelope = await jsonBody(response);
    return { result: envelope.result, calls, artifacts };
  } finally { globalThis.fetch = original; }
}
const args = { surface_id: "swagger:api:1", path: "/write", method: "POST", credential: "fixture-token" };
const header = (fixture: Awaited<ReturnType<typeof invoke>>, name: string) => new Headers(fixture.calls[0].init.headers).get(name);

describe("public MCP Swagger body forwarding", () => {
  test("JSON roots retain the exact OpenAPI 3 outgoing bytes and body names do not wrap them", async () => {
    for (const json_body of [null, false, 0, "", "雪", [false, null], { message: "雪" }]) {
      const input = { ...args, json_body };
      const before = await invoke(input, { openapi: "3.1.0", paths: { "/write": { post: { requestBody: { content: { "application/json": {} } } } } } });
      const after = await invoke(input, swagger());
      for (const fixture of [before, after]) {
        assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
        assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.calls[0].init.body, JSON.stringify(json_body));
        assert.equal(header(fixture, "authorization"), "Bearer fixture-token");
        assert.equal(header(fixture, "content-type"), "application/json");
      }
      assert.equal(after.calls[0].url, before.calls[0].url);
    }
  });

  test("operation consumes overrides global media, including JSON suffixes and parameters", async () => {
    const content_type = "Application/vendor+json; charset=utf-8";
    for (const body of [{ json_body: { x: 1 } }, { body: { x: 1 } }, { body: '{"x":1}' }]) {
      const fixture = await invoke({ ...args, ...body }, swagger({ consumes: [content_type] }));
      assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
      assert.equal(fixture.calls[0].init.body, '{"x":1}');
      assert.equal(header(fixture, "content-type"), content_type);
    }
  });

  test("cleared/unspecified consumes permits concrete media and defaults JSON values", async () => {
    for (const doc of [swagger({ consumes: [] }), swagger({}, { consumes: undefined })]) {
      const json = await invoke({ ...args, json_body: [1, false] }, doc);
      assert.notEqual(json.result.isError, true, JSON.stringify(json.result));
      assert.equal(header(json, "content-type"), "application/json");
      const text = await invoke({ ...args, body: "exact 雪 text", content_type: "text/plain; charset=utf-8" }, doc);
      assert.notEqual(text.result.isError, true, JSON.stringify(text.result));
      assert.equal(text.calls[0].init.body, "exact 雪 text");
      const bytes = await invoke({ ...args, body_base64: "AP+A", content_type: "application/octet-stream" }, doc);
      assert.deepEqual([...bytes.calls[0].init.body as Uint8Array], [0, 255, 128]);
      const missingMedia = await invoke({ ...args, body_base64: "AP+A" }, doc);
      assert.equal(missingMedia.result.isError, true);
      assert.equal(missingMedia.calls.length, 0);
    }
  });

  test("inherited local-reference bodies work for every body verb with query serialization", async () => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const pathItem = { parameters: [{ $ref: "#/parameters/body" }], [method.toLowerCase()]: { parameters: [{ name: "ids", in: "query", type: "array", items: { type: "string" }, collectionFormat: "multi" }] } };
      const doc = swagger({}, { paths: { "/write": { $ref: "#/pathItems/p" } }, pathItems: { p: pathItem }, parameters: { body: bodyParameter } });
      const fixture = await invoke({ ...args, method, json_body: [false, 0], query_values: { ids: ["a b", "雪"] } }, doc);
      assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
      assert.equal(fixture.calls[0].init.method, method);
      assert.equal(fixture.calls[0].init.body, "[false,0]");
      assert.equal(fixture.calls[0].url, "https://fixture.example/write?ids=a%20b&ids=%E9%9B%AA");
    }
  });

  test("URL-encoded form fields preserve empty, repeated, escaped and Unicode bytes", async () => {
    const body = "empty=&labels=a%2Cb&labels=%E9%9B%AA+space&zero=0&false=false";
    const doc = swagger({ parameters: [
      { name: "labels", in: "formData", type: "array", collectionFormat: "multi", items: { type: "string" } },
      { name: "empty", in: "formData", type: "string", allowEmptyValue: true },
      { name: "zero", in: "formData", type: "integer" },
      { name: "false", in: "formData", type: "boolean" },
    ], consumes: ["application/x-www-form-urlencoded"] });
    const fixture = await invoke({ ...args, body }, doc);
    assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
    assert.equal(fixture.calls[0].init.body, body);
    assert.equal(header(fixture, "content-type"), "application/x-www-form-urlencoded");
    assert.equal(header(fixture, "authorization"), "Bearer fixture-token");
  });

  test("multipart file bytes and boundaries remain exact with query/cookie credentials", async () => {
    const bytes = Buffer.concat([Buffer.from('--upload\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from("\r\n--upload--\r\n")]);
    const content_type = 'multipart/form-data; boundary="upload"';
    for (const location of ["query", "cookie"]) {
      const fixture = await invoke({ ...args, body_base64: bytes.toString("base64"), content_type }, swagger({ parameters: [formParameter], consumes: ["multipart/form-data"] }), { auth: { scheme: "api-key", location, name: "token" } });
      assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
      assert.deepEqual(Buffer.from(fixture.calls[0].init.body as Uint8Array), bytes);
      assert.equal(header(fixture, "content-type"), content_type);
      if (location === "query") assert.equal(new URL(fixture.calls[0].url).searchParams.get("token"), "fixture-token");
      else assert.equal(header(fixture, "cookie"), "token=fixture-token");
      assert.equal(JSON.stringify(fixture.result).includes("fixture-token"), false);
    }
  });

  test("JSON body credentials preserve merges, and non-JSON credential reshaping is refused", async () => {
    const auth = { scheme: "signature", location: "body", names: ["identity", "signature"] };
    const input = { ...args, credential: { identity: "addr", signature: "proof" }, json_body: { identity: "wrong", message: "exact" } };
    const fixture = await invoke(input, swagger(), { auth });
    assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
    assert.deepEqual(JSON.parse(fixture.calls[0].init.body as string), { identity: "addr", message: "exact", signature: "proof" });
    const denied = await invoke({ ...args, credential: input.credential, body: "x=1" }, swagger({ parameters: [formParameter], consumes: ["application/x-www-form-urlencoded"] }), { auth });
    assert.equal(denied.result.isError, true);
    assert.equal(denied.calls.length, 0);
  });

  test("the SDK numeric normalization is retained for Swagger JSON bodies", async () => {
    const input = { ...args, json_body: [] };
    const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_subnet_surface", arguments: input } }).replace('"json_body":[]', '"json_body":[-0,1e400]');
    const fixture = await invoke(input, swagger(), { raw });
    assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
    assert.equal(fixture.calls[0].init.body, "[0,null]");
  });

  test("missing declarations, malformed specs, media mismatch and read-tool writes never reach a provider", async () => {
    for (const [input, doc, options] of [
      [{ ...args, json_body: {} }, swagger({ parameters: [] }), {}],
      [{ ...args, json_body: {} }, swagger({ parameters: [bodyParameter, formParameter] }), {}],
      [{ ...args, json_body: {} }, swagger({ consumes: null }), {}],
      [{ ...args, json_body: {} }, swagger({ parameters: [{ $ref: "https://foreign.example/body" }] }), {}],
      [{ ...args, json_body: {} }, swagger({ consumes: ["text/plain"] }), {}],
      [{ ...args, body: {} }, swagger({ parameters: [formParameter], consumes: ["multipart/form-data"] }), {}],
      [{ ...args, body: "x", content_type: "text/plain" }, swagger(), {}],
      [{ ...args, json_body: {} }, swagger(), { tool: "call_subnet_surface" }],
      [{ ...args, body_base64: "AP+A", content_type: "multipart/form-data; boundary=other" }, swagger({ parameters: [formParameter], consumes: ["multipart/form-data; boundary=fixed"] }), {}],
    ] as const) {
      const denied = await invoke(input, doc, options);
      assert.equal(denied.result.isError, true);
      assert.equal(denied.calls.length, 0);
    }
  });

  test("existing nonstandard requestBody declarations in Swagger retain priority and exact bytes", async () => {
    const fixture = await invoke({ ...args, json_body: [1, false] }, swagger({ parameters: [formParameter], consumes: ["text/plain"], requestBody: { content: { "application/json": {} } } }));
    assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
    assert.equal(fixture.calls[0].init.body, "[1,false]");
    assert.equal(header(fixture, "content-type"), "application/json");
  });

  test("body-free calls skip unused body resolution and preserve legacy omission", async () => {
    for (const format of [{ openapi: "3.1.0" }, { swagger: "2.0" }]) {
      let lookups = 0;
      const operation = { get requestBody() { lookups++; return { $ref: "#/components/requestBodies/unused" }; } };
      const doc = { ...format, paths: { "/write": { get: operation } }, components: { requestBodies: { unused: { content: { "application/json": {} } } } } };
      const fixture = await invoke({ ...args, method: "GET" }, doc, { tool: "call_subnet_surface" });
      assert.notEqual(fixture.result.isError, true, JSON.stringify(fixture.result));
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0].init.body, undefined);
      assert.equal(lookups, 0);
      assert.equal(resolveLocalRequestBody(doc, operation.requestBody), doc.components.requestBodies.unused);
      assert.equal(lookups, 1);
      console.log("SUBNET_HTTP_UNUSED_BODY_FIXTURE", JSON.stringify({ document_format: Object.keys(format)[0], baseline_b87b75f_body_lookups: 1, current_body_lookups: 0, provider_requests: 1, production_requests: 0 }));
    }
    const omitted = await invoke({ ...args, body: null }, swagger({ parameters: [{ ...bodyParameter, required: true }] }));
    assert.notEqual(omitted.result.isError, true, JSON.stringify(omitted.result));
    assert.equal(omitted.calls[0].init.body, undefined);
  });
});
