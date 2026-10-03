import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { describe, test } from "vitest";
import { serializeDeclaredHttpParameters } from "../src/subnet-http-parameters.ts";
import { callSubnetSurface, redactCredentialValue, type CallSubnetSurfaceCredential } from "../src/call-subnet-surface.ts";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { CallSubnetSurfaceInputSchema, WriteSubnetSurfaceInputSchema } from "../schemas-src/mcp-tools/ai-integration.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const parameter = (location: "header" | "cookie", extra: Row = {}) => ({ name: "color", in: location, ...(extra.content === undefined ? { schema: {} } : {}), ...extra });
function render(location: "header" | "cookie", value: unknown, extra: Row = {}, root: Row = {}) {
  const result = serializeDeclaredHttpParameters({ openapi: "3.2.0", ...root }, {}, { parameters: [parameter(location, extra)] }, location === "header" ? { color: value } : {}, location === "cookie" ? { color: value } : {});
  return location === "header" ? result.headers.color : result.cookies.map((group) => group.pairs.map((pair) => pair.value).join(group.separator)).filter(Boolean).join("; ");
}

describe("captured header and cookie representations", () => {
  for (const [name, location, value, options, expected] of [
    ["header primitive", "header", "a%2Cb /!", {}, "a%2Cb /!"],
    ["header zero", "header", 0, {}, "0"],
    ["header false", "header", false, {}, "false"],
    ["header null omission", "header", null, {}, undefined],
    ["header empty string", "header", "", {}, ""],
    ["header array", "header", ["a", "b", null], {}, "a,b"],
    ["header empty array", "header", [], {}, ""],
    ["header object", "header", { R: 1, G: 2, absent: null }, {}, "R,1,G,2"],
    ["header exploded object", "header", { R: 1, G: 2 }, { explode: true }, "R=1,G=2"],
    ["header empty object", "header", {}, {}, ""],
    ["header serialized content", "header", "a%2Cb", { content: { "text/plain": {} } }, "a%2Cb"],
    ["cookie form Unicode", "cookie", "a +;=&雪", {}, "color=a%20%2B%3B%3D%26%E9%9B%AA"],
    ["cookie form array", "cookie", ["a", "b", null], {}, "color=a&color=b"],
    ["cookie joined array", "cookie", ["a,b", "c"], { explode: false }, "color=a%2Cb,c"],
    ["cookie form object", "cookie", { R: 1, G: 2, absent: null }, {}, "R=1&G=2"],
    ["cookie joined object", "cookie", { R: 1, G: 2 }, { explode: false }, "color=R,1,G,2"],
    ["cookie empty array", "cookie", [], {}, "color="],
    ["cookie empty object", "cookie", {}, {}, "color="],
    ["cookie zero", "cookie", 0, {}, "color=0"],
    ["cookie false", "cookie", false, {}, "color=false"],
    ["cookie null omission", "cookie", null, {}, ""],
    ["cookie raw value", "cookie", "a%2Cb /!", { style: "cookie" }, "color=a%2Cb /!"],
    ["cookie raw array", "cookie", ["a", "b"], { style: "cookie" }, "color=a; color=b"],
    ["cookie raw object", "cookie", { R: 1, G: 2 }, { style: "cookie" }, "R=1; G=2"],
    ["cookie raw joined array", "cookie", ["a", "b"], { style: "cookie", explode: false }, "color=a,b"],
    ["cookie raw joined object", "cookie", { R: 1, G: 2 }, { style: "cookie", explode: false }, "color=R,1,G,2"],
    ["cookie raw reserved", "cookie", "a%2Cb", { style: "cookie", allowReserved: true }, "color=a%2Cb"],
    ["cookie reserved syntax", "cookie", ":/?@!$'()*,;=&#+%2C", { allowReserved: true }, "color=:/?@!$'()*,%3B%3D%26%23%2B%2C"],
    ["cookie joined reserved comma", "cookie", ["a,b", "c"], { allowReserved: true, explode: false }, "color=a%2Cb,c"],
    ["cookie content exact", "cookie", "%7B%22a%22%3A1%7D", { content: { "application/json": {} } }, "color=%7B%22a%22%3A1%7D"],
    ["cookie other content", "cookie", "opaque", { content: { "text/plain": {} } }, "color=opaque"],
  ] as const) test(name, () => assert.equal(render(location, value, options), expected));

  for (const value of [{ a: [null, false, "雪😀"] }, [0, null], "雪😀\r\n", 0, false, null])
    test(`JSON header content retains ${JSON.stringify(value)}`, () => {
      const wire = render("header", value, { content: { "Application/merge-patch+JSON; charset=utf-8": {} } }) as string;
      assert.deepEqual(JSON.parse(wire), value);
      assert.match(wire, /^[\x20-\x7e]*$/);
    });

  for (const [collectionFormat, expected] of [[undefined, "a,b"], ["csv", "a,b"], ["ssv", "a b"], ["tsv", "a\tb"], ["pipes", "a|b"]] as const)
    test(`Swagger header ${collectionFormat ?? "default"}`, () => assert.equal(render("header", ["a", "b"], { collectionFormat }, { swagger: "2.0" }), expected));

  test("path references, parameter references and case-insensitive operation overrides resolve once per list", () => {
    let inheritedReads = 0;
    let operationReads = 0;
    const inherited = [parameter("header", { name: "X-Color" }), parameter("cookie"), { in: "query", name: "ignored" }];
    const operation = { get parameters() { operationReads++; return [{ $ref: "#/parameters/0" }]; } };
    const doc = { openapi: "3.2.0", parameters: [parameter("header", { name: "x-COLOR", explode: true })] };
    const result = serializeDeclaredHttpParameters(doc, { get parameters() { inheritedReads++; return inherited; } }, operation, { "X-colOR": { R: 1 } }, { color: "a" });
    assert.equal(result.headers["x-color"], "R=1");
    assert.equal(inheritedReads, 1); assert.equal(operationReads, 1);
    assert.equal(result.cookies[0].pairs[0].value, "color=a");
  });

  test("header token keys retain own properties and require no Headers constructors", () => {
    const original = globalThis.Headers;
    globalThis.Headers = class { constructor() { throw new Error("Unnecessary header copy"); } } as unknown as typeof Headers;
    try {
      const names = ["__proto__", "constructor", "x-percent"];
      const result = serializeDeclaredHttpParameters({}, {}, { parameters: names.map((name) => parameter("header", { name })) }, Object.fromEntries(names.map((name) => [name, "literal%2C"])));
      assert.deepEqual(Object.entries(result.headers), names.map((name) => [name, "literal%2C"]));
    } finally { globalThis.Headers = original; }
  });

  test("malformed declarations and unsafe representations cannot produce request fields", () => {
    for (const [location, value, options, root] of [
      ["header", [1], { style: "form" }, {}], ["header", [1], { explode: "yes" }, {}],
      ["header", [1], { collectionFormat: "multi" }, { swagger: "2.0" }], ["header", [1], { collectionFormat: "__proto__" }, { swagger: "2.0" }],
      ["header", { a: 1 }, {}, { swagger: "2.0" }], ["header", [[1]], {}, {}], ["header", undefined, {}, {}], ["header", Infinity, {}, {}],
      ["header", ["a,b"], {}, {}], ["header", { "a=b": 1 }, { explode: true }, {}], ["header", { "a,b": 1 }, {}, {}],
      ["header", "\r\nX-New: injected", {}, {}], ["header", "雪", {}, {}], ["header", "\u0007", {}, {}],
      ["header", 1, { content: {} }, {}], ["header", 1, { content: null }, {}], ["header", 1, { content: { "text/plain": {} } }, {}],
      ["header", 1, { schema: {}, content: { "application/json": {} } }, {}], ["header", 1, { content: { "text/plain": {}, "application/json": {} } }, {}],
      ["header", undefined, { content: { "application/json": {} } }, {}],
      ["cookie", "a", {}, { swagger: "2.0" }], ["cookie", "a", { style: "simple" }, {}], ["cookie", "a", { explode: 1 }, {}], ["cookie", "a", { allowReserved: "yes" }, {}],
      ["cookie", { a: [1] }, {}, {}], ["cookie", "a; auth=wrong", { style: "cookie" }, {}], ["cookie", ["a,b"], { style: "cookie", explode: false }, {}],
      ["cookie", { "a b": 1 }, { style: "cookie" }, {}], ["cookie", "\r\n", { style: "cookie" }, {}], ["cookie", "\ud800", {}, {}],
      ["cookie", {}, { content: { "application/json": {} } }, {}], ["cookie", "a; auth=wrong", { content: { "text/plain": {} } }, {}],
      ["cookie", "雪", { content: { "text/plain": {} } }, {}], ["cookie", "a", { name: "a=b", content: { "text/plain": {} } }, {}],
    ] as const) assert.throws(() => render(location, value, options, root));
    for (const parameters of [null, {}, [null], [{ $ref: "https://foreign.example/param" }], [{ $ref: "#/missing" }], [parameter("header", { name: 1 })]])
      assert.throws(() => serializeDeclaredHttpParameters({}, {}, { parameters }, { color: "a" }));
    assert.throws(() => serializeDeclaredHttpParameters({}, {}, { parameters: [parameter("header")] }, { color: 1, COLOR: 2 }), /duplicates/);
    assert.throws(() => serializeDeclaredHttpParameters({}, {}, { parameters: [parameter("cookie"), parameter("cookie", { name: "R" })] }, {}, { color: { R: 1 }, R: 2 }), /overlaps/);
    assert.throws(() => serializeDeclaredHttpParameters({}, {}, { parameters: [] }, { unknown: "a" }), /not declared/);
  });

  for (const name of ["Accept", "Authorization", "Content-Type", "Cookie", "Host", "Connection", "Content-Length", "Transfer-Encoding", "Forwarded", "Origin", "Referer", "User-Agent", "Proxy-Authorization", "Sec-Fetch-Site", "x bad"])
    test(`header ${name} cannot control transport or authentication`, () => assert.throws(() => serializeDeclaredHttpParameters({}, {}, { parameters: [parameter("header", { name })] }, { [name]: "wrong" }), /transport/));
});

const document = (parameters: unknown = [parameter("header", { name: "X-Color" }), parameter("cookie")], extra: Row = {}) => ({
  openapi: "3.2.0", info: { title: "Hermetic header/cookie fixture", version: "1" },
  paths: { "/params": { get: { parameters, responses: { "200": { description: "Fixture" } } }, post: { parameters, requestBody: { content: { "application/json": {} } }, responses: { "200": { description: "Fixture" } } } } }, ...extra,
});
async function invoke(args: Row, options: { doc?: Row | null; reviewed?: boolean; tool?: string; auth?: Row; authRequired?: boolean; raw?: string; fail?: boolean } = {}) {
  const calls: { url: string; headers: [string, string][]; body: string | null }[] = [];
  const artifacts: string[] = [];
  const surface = { id: "params:api:1", surface_id: "params:api:1", netuid: 5, kind: "subnet-api", url: "https://fixture.example/api", public_safe: true, auth_required: options.authRequired ?? true, auth: options.auth ?? { scheme: "api-key", location: "header", name: "X-Color" }, probe: { method: "GET", enabled: !options.reviewed }, schema_source: { surface_id: "params:openapi:1" }, ...(options.reviewed ? { http: { operations: [{ method: "GET", path: "/params" }] } } : {}) };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url.hostname, "fixture.example", "No provider or production requests");
    const request = new Request(url, init);
    calls.push({ url: request.url, headers: [...request.headers], body: request.body ? await request.text() : null });
    if (options.fail) throw new Error(`Header ${request.headers.get("x-color")} Cookie ${request.headers.get("cookie")}`);
    return Response.json({ accepted: true });
  };
  try {
    const response = await handleMcpRequest(new Request("https://metagraph.sh/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: options.raw ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: options.tool ?? "call_subnet_surface", arguments: args } }) }), mockEnv(), {
      readArtifact: async (_env: Row, path: string) => {
        artifacts.push(path);
        if (path === "/metagraph/operational-surfaces.json") return { ok: true, data: { surfaces: options.reviewed ? [] : [surface] } };
        if (path === "/metagraph/surfaces.json") return { ok: true, data: { surfaces: [surface] } };
        if (path === "/metagraph/schemas/params:openapi:1.json" && options.doc !== null) return { ok: true, data: { document: options.doc ?? document() } };
        return { ok: false, status: 404 };
      },
    });
    return { result: (await jsonBody(response)).result, calls, artifacts };
  } finally { globalThis.fetch = original; }
}
const base = { surface_id: "params:api:1", path: "/params", method: "GET", credential: "caller-secret" };

describe("public MCP header/cookie boundary", () => {
  test("shared parameter schemas validate the same recursive JSON values with less schema output", () => {
    for (const schema of [CallSubnetSurfaceInputSchema, WriteSubnetSurfaceInputSchema]) {
      const shared = z.toJSONSchema(schema);
      const separate = z.toJSONSchema(schema.extend(Object.fromEntries(["query_values", "header_values", "cookie_values"].map((name) => [name, z.record(z.string(), z.json()).optional().describe(schema.shape[name as "query_values"].description!)]))));
      const validators = [shared, separate].map((input) => new Ajv2020({ strict: false, validateFormats: false }).compile(input));
      for (const value of [{ nested: [null, false, "雪", 1] }, [0], 0, false, null, ""]) for (const valid of validators)
        assert.equal(valid({ ...base, method: schema === WriteSubnetSurfaceInputSchema ? "POST" : "GET", header_values: { "X-Color": value }, cookie_values: { color: value }, query_values: { filter: value } }), true);
      for (const value of [null, [], false, "bad"]) for (const valid of validators)
        assert.equal(valid({ ...base, method: schema === WriteSubnetSurfaceInputSchema ? "POST" : "GET", header_values: value }), false);
      const sharedBytes = Buffer.byteLength(JSON.stringify(shared)); const separateBytes = Buffer.byteLength(JSON.stringify(separate));
      assert.ok(sharedBytes < separateBytes, `${sharedBytes} must be less than ${separateBytes}`);
      console.log("SUBNET_HTTP_PARAMETER_SCHEMA_FIXTURE", JSON.stringify({ tool: schema === WriteSubnetSurfaceInputSchema ? "write_subnet_surface" : "call_subnet_surface", shared_schema_bytes: sharedBytes, separate_schema_bytes: separateBytes, production_requests: 0 }));
    }
    for (const name of ["call_subnet_surface", "write_subnet_surface"]) assert.ok(MCP_TOOLS.find((tool) => tool.name === name)!.inputSchema!.properties!.header_values);
  });

  test("headers and cookies compose with typed queries, body bytes and credential precedence", async () => {
    const doc = document([parameter("header", { name: "x-color" }), parameter("cookie"), { name: "ids", in: "query", schema: {} }]);
    const result = await invoke({ ...base, method: "POST", header_values: { "X-COLOR": ["wrong", "wrong2"] }, cookie_values: { color: "a +&雪" }, query_values: { ids: [1, 2] }, json_body: [0, null] }, { tool: "write_subnet_surface", doc });
    assert.equal(result.result.isError, false, JSON.stringify(result.result)); assert.equal(result.calls.length, 1);
    const headers = new Headers(result.calls[0].headers);
    assert.equal(headers.get("x-color"), "caller-secret"); assert.equal(headers.get("cookie"), "color=a%20%2B%26%E9%9B%AA");
    assert.equal(headers.get("content-type"), "application/json"); assert.equal(result.calls[0].body, "[0,null]");
    assert.equal(result.calls[0].url, "https://fixture.example/params?ids=1&ids=2");
  });

  test("reviewed operations use one captured match for queries, headers and cookies", async () => {
    let matches = 0;
    const paths = document([{ name: "ids", in: "query", schema: {} }, parameter("header", { name: "X-Color" }), parameter("cookie")]).paths;
    const doc = { openapi: "3.2.0", get paths() { matches++; return paths; } };
    const result = await invoke({ ...base, query_values: { ids: [1, 2] }, header_values: { "X-Color": "wrong" }, cookie_values: { color: "a" } }, { doc, reviewed: true });
    assert.equal(result.result.isError, false, JSON.stringify(result.result)); assert.equal(result.calls.length, 1); assert.equal(matches, 1);
  });

  test("cookie credentials override exploded fields and opaque Cookie header credentials", async () => {
    const doc = document([parameter("cookie"), parameter("cookie", { name: "keep", style: "cookie" })]);
    for (const auth of [{ scheme: "api-key", location: "cookie", name: "token" }, { scheme: "api-key", location: "header", name: "Cookie" }]) {
      const result = await invoke({ ...base, credential: auth.location === "cookie" ? "secret" : "token=secret; session=exact", cookie_values: { color: { token: "wrong", keep2: "safe" }, keep: "literal%2C" } }, { auth, doc });
      assert.equal(result.result.isError, false, JSON.stringify(result.result));
      assert.equal(new Headers(result.calls[0].headers).get("cookie"), `keep2=safe; keep=literal%2C; token=secret${auth.location === "header" ? "; session=exact" : ""}`);
    }
  });

  test("raw SDK overflowing/negative-zero header JSON normalization is preserved", async () => {
    const doc = document([parameter("header", { name: "X-JSON", content: { "application/json": {} } })]);
    const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_subnet_surface","arguments":{"surface_id":"params:api:1","path":"/params","method":"GET","credential":"secret","header_values":{"X-JSON":[-0,1e400]}}}}';
    const result = await invoke({}, { raw, doc, auth: { scheme: "api-key", location: "header", name: "X-Auth" } });
    assert.equal(result.result.isError, false, JSON.stringify(result.result)); assert.equal(new Headers(result.calls[0].headers).get("x-json"), "[0,null]");
  });

  test("denials precede provider traffic and empty values preserve exact legacy requests", async () => {
    for (const args of [{ ...base, header_values: null }, { ...base, cookie_values: [] }, { ...base, header_values: { unknown: "a" } }, { ...base, cookie_values: { unknown: "a" } }, { ...base, header_values: { Host: "wrong" } }, { ...base, header_values: { "X-Color": "\r\n" } }, { ...base, cookie_values: { color: { nested: [1] } } }, { ...base, path: undefined, method: undefined, header_values: { "X-Color": "a" } }, { ...base, method: "POST", header_values: { "X-Color": "a" } }]) {
      const denied = await invoke(args); assert.equal(denied.result.isError, true); assert.equal(denied.calls.length, 0);
    }
    for (const doc of [null, document([], { paths: {} })]) {
      const denied = await invoke({ ...base, header_values: { "X-Color": "a" } }, { reviewed: true, doc });
      assert.equal(denied.result.isError, true); assert.equal(denied.calls.length, 0);
    }
    const before = await invoke(base, { reviewed: true, doc: null });
    const after = await invoke({ ...base, header_values: {}, cookie_values: {} }, { reviewed: true, doc: null });
    assert.equal(after.result.isError, false); assert.deepEqual(after.calls, before.calls); assert.equal(after.artifacts.some((path) => path.includes("/schemas/")), false);
  });

  test("fetch errors redact raw and transmitted parameter values together with credentials", async () => {
    const result = await invoke({ ...base, cookie_values: { color: "secret +&雪" } }, { fail: true });
    assert.equal(result.result.isError, true); assert.equal(result.calls.length, 1);
    for (const secret of ["caller-secret", "secret +&雪", "secret%20%2B%26%E9%9B%AA"]) assert.equal(JSON.stringify(result.result).includes(secret), false);
    assert.equal(redactCredentialValue("raw secret and encoded", undefined, ["secret"]), "raw <redacted> and encoded");
    assert.equal(redactCredentialValue("", undefined, ["secret"]), "");
    assert.equal(redactCredentialValue("unchanged", undefined, []), "unchanged");
    const anonymous = await invoke({ ...base, credential: undefined, header_values: { "X-Color": "private-header-value" }, cookie_values: { color: "private-cookie +&雪" } }, { authRequired: false, fail: true });
    assert.equal(anonymous.result.isError, true); assert.equal(anonymous.calls.length, 1);
    for (const secret of ["private-header-value", "private-cookie", "private-cookie%20%2B%26%E9%9B%AA"]) assert.equal(JSON.stringify(anonymous.result).includes(secret), false);
  });
});

test("low-level caller strips declared fields across origins and preserves input maps", async () => {
  for (const crossOrigin of [false, true]) {
    const parsed = serializeDeclaredHttpParameters({}, {}, { parameters: [parameter("header", { name: "X-Color" }), parameter("cookie", { style: "cookie" })] }, { "X-Color": "value" }, { color: "literal%2C" });
    const calls: Headers[] = [];
    const result = await callSubnetSurface({ url: "https://fixture.example/api" }, { path: "/params", method: "GET", requestHeaders: parsed.headers, serializedCookies: parsed.cookies, parameterRedactions: parsed.redactions, credential: { location: "header", name: "x-AUTH", value: "secret" }, isUnsafeUrl: async () => false, fetchImpl: async (url, init) => {
      assert.ok(["fixture.example", "other.example"].includes(new URL(String(url)).hostname)); calls.push(new Headers(init?.headers));
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: crossOrigin ? "https://other.example/result" : "/result" } }) : Response.json({ accepted: true });
    } });
    assert.equal(result.ok, true); assert.equal(calls.length, 2); assert.equal(parsed.headers["x-color"], "value"); assert.equal(Object.hasOwn(parsed.headers, "x-AUTH"), false);
    assert.equal(calls[1].get("x-color"), crossOrigin ? null : "value"); assert.equal(calls[1].get("cookie"), crossOrigin ? null : "color=literal%2C"); assert.equal(calls[1].get("x-auth"), crossOrigin ? null : "secret");
  }
  const credential: CallSubnetSurfaceCredential = { location: "query", name: "token", value: "secret +&雪" };
  assert.equal(redactCredentialValue("secret+%2B%26%E9%9B%AA plus param", credential, ["param", ""]), "<redacted> plus <redacted>");
});
