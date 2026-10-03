import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import {
  handleMcpRequest,
  MAX_MCP_BODY_BYTES,
  MCP_TOOLS,
} from "../src/mcp-server.ts";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import {
  matchesBinaryRequestMediaType,
  resolveLocalRequestBody,
} from "../src/subnet-http-body.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const base = { surface_id: "fixture:api:1", path: "/bytes", method: "POST" };
const mediaBody = (media: string) => ({ content: { [media]: {} } });
const uploadRef = { $ref: "#/components/requestBodies/upload" };
const document = {
  openapi: "3.1.0",
  paths: {
    "/bytes": {
      post: { requestBody: uploadRef },
      put: { requestBody: uploadRef },
      patch: { requestBody: uploadRef },
    },
    "/multipart": { post: { requestBody: mediaBody("multipart/form-data") } },
    "/range": { post: { requestBody: mediaBody("image/*") } },
    "/any": { post: { requestBody: mediaBody("*/*") } },
    "/json": { post: { requestBody: mediaBody("application/json") } },
    "/multi": {
      post: {
        requestBody: {
          content: { "text/plain": {}, "application/octet-stream": {} },
        },
      },
    },
    "/none": { post: {} },
    "/remote": {
      post: { requestBody: { $ref: "https://foreign.example/body.json" } },
    },
  },
  components: {
    requestBodies: {
      upload: { $ref: "#/components/requestBodies/file~1~0body%20space" },
      "file/~body space": mediaBody("application/octet-stream"),
    },
  },
};
const surface = {
  surface_id: base.surface_id,
  netuid: 5,
  kind: "subnet-api",
  url: "https://fixture.example/api",
  auth_required: false,
  probe: { method: "GET", expect: "json", enabled: true },
  schema_source: { surface_id: "fixture:openapi:1" },
};
const surfaces = [
  surface,
  {
    ...surface,
    surface_id: "fixture:api:2",
    auth_required: true,
    auth: { scheme: "bearer", location: "header", name: "Authorization" },
  },
  {
    ...surface,
    surface_id: "fixture:api:3",
    auth_required: true,
    auth: { scheme: "api-key", location: "query", name: "api_key" },
  },
  {
    ...surface,
    surface_id: "fixture:api:4",
    auth_required: true,
    auth: {
      scheme: "signature",
      location: "cookie",
      names: ["session", "csrf"],
    },
  },
  {
    ...surface,
    surface_id: "fixture:api:5",
    auth_required: true,
    auth: {
      scheme: "signature",
      location: "body",
      names: ["identity", "signature"],
    },
  },
  { ...surface, surface_id: "fixture:api:6", probe: { enabled: false } },
];

async function invoke(
  args: Row,
  options: { tool?: string; raw?: string; schema?: Row } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const artifacts: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url.hostname, "fixture.example", "No external provider calls");
    calls.push({ url: url.href, init: init! });
    return Response.json({ accepted: true });
  };
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body:
          options.raw ??
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: options.tool ?? "write_subnet_surface",
              arguments: args,
            },
          }),
      }),
      mockEnv(),
      {
        readArtifact: async (_env: Row, path: string) => {
          artifacts.push(path);
          if (path === "/metagraph/operational-surfaces.json")
            return { ok: true, data: { surfaces } };
          if (path === "/metagraph/schemas/fixture:openapi:1.json")
            return { ok: true, data: { document: options.schema ?? document } };
          return { ok: false, status: 404 };
        },
      },
    );
    const envelope = await jsonBody(response);
    return {
      status: response.status,
      result: envelope.result,
      error: envelope.error,
      calls,
      artifacts,
    };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

describe("exact subnet HTTP request bytes", () => {
  test("published schemas enforce canonical base64 and mutually exclusive body fields", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const write = ajv.compile(
      MCP_TOOLS.find((tool) => tool.name === "write_subnet_surface")!
        .inputSchema,
    );
    const read = ajv.compile(
      MCP_TOOLS.find((tool) => tool.name === "call_subnet_surface")!
        .inputSchema,
    );
    for (const body_base64 of [
      "",
      "Zg==",
      "Zm8=",
      "Zm9v",
      bytes.toString("base64"),
    ])
      assert.equal(
        write({ ...base, body_base64 }),
        true,
        JSON.stringify(write.errors),
      );
    for (const body_base64 of [
      "Zh==",
      "Zm9=",
      "Zg",
      "Zg=",
      "Zg===",
      "Zg==\n",
      "__8=",
      "a===",
      null,
      {},
      3,
    ])
      assert.equal(write({ ...base, body_base64 }), false);
    for (const body of [
      { body: "" },
      { json_body: null },
      { body: "", json_body: null },
    ])
      assert.equal(write({ ...base, body_base64: "", ...body }), false);
    assert.equal(read({ surface_id: base.surface_id, body_base64: "" }), false);
  });

  for (const method of ["POST", "PUT", "PATCH"])
    test(`${method} sends every byte through locally referenced bodies with no UTF8 conversion`, async () => {
      const { result, calls, artifacts } = await invoke({
        ...base,
        method,
        body_base64: bytes.toString("base64"),
      });
      assert.equal(result.isError, false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://fixture.example/bytes");
      assert.equal(calls[0]!.init.method, method);
      assert.ok(calls[0]!.init.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(calls[0]!.init.body), bytes);
      assert.equal(
        new Headers(calls[0]!.init.headers).get("content-type"),
        "application/octet-stream",
      );
      assert.equal(
        artifacts.filter((path) => path.includes("/schemas/")).length,
        1,
      );
    });

  test("an empty byte body remains a present body with its Content-Type", async () => {
    const { result, calls } = await invoke({ ...base, body_base64: "" });
    assert.equal(result.isError, false);
    assert.ok(calls[0]!.init.body instanceof Uint8Array);
    assert.equal(calls[0]!.init.body.byteLength, 0);
    assert.equal(
      new Headers(calls[0]!.init.headers).get("content-type"),
      "application/octet-stream",
    );
  });

  test("caller-encoded multipart retains nonUTF8 file bytes and the quoted boundary", async () => {
    const multipart = Buffer.concat([
      Buffer.from(
        '--fixture-boundary\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
      ),
      bytes,
      Buffer.from("\r\n--fixture-boundary--\r\n"),
    ]);
    const content_type = 'multipart/form-data; boundary="fixture-boundary"';
    const { result, calls } = await invoke({
      ...base,
      path: "/multipart",
      content_type,
      body_base64: multipart.toString("base64"),
    });
    assert.equal(result.isError, false);
    assert.ok(calls[0]!.init.body instanceof Uint8Array);
    assert.deepEqual(Buffer.from(calls[0]!.init.body), multipart);
    assert.equal(
      new Headers(calls[0]!.init.headers).get("content-type"),
      content_type,
    );
  });

  test("declared MIME ranges admit only explicit concrete request types", async () => {
    for (const path of ["/range", "/any"]) {
      const { result, calls } = await invoke({
        ...base,
        path,
        content_type: "image/png",
        body_base64: "AP+A",
      });
      assert.equal(result.isError, false);
      assert.equal(
        new Headers(calls[0]!.init.headers).get("content-type"),
        "image/png",
      );
      assert.ok(calls[0]!.init.body instanceof Uint8Array);
      assert.deepEqual([...calls[0]!.init.body], [0, 255, 128]);
    }
  });

  test("raw JSON byte requests preserve -0 and overflow; direct JSON keeps normalization", async () => {
    for (const [raw, normalized] of [
      ["-0", "0"],
      ["1e400", "null"],
    ]) {
      const payload = Buffer.from(raw!);
      const exact = await invoke({
        ...base,
        path: "/json",
        body_base64: payload.toString("base64"),
      });
      assert.equal(exact.result.isError, false);
      assert.ok(exact.calls[0]!.init.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(exact.calls[0]!.init.body), payload);
      const direct = await invoke(
        {},
        {
          raw:
            '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_subnet_surface","arguments":{"surface_id":"fixture:api:1","path":"/json","method":"POST","json_body":' +
            raw +
            "}}}",
        },
      );
      assert.equal(direct.result.isError, false);
      assert.equal(direct.calls[0]!.init.body, normalized);
    }
  });

  test("header, query and cookie credentials preserve exact bytes and redact secrets", async () => {
    for (const [id, credential, location] of [
      [2, "Bearer fixture-secret", "header"],
      [3, "fixture-secret", "query"],
      [4, { session: "fixture-session", csrf: "fixture-csrf" }, "cookie"],
    ] as const) {
      const { result, calls } = await invoke({
        ...base,
        surface_id: `fixture:api:${id}`,
        credential,
        body_base64: bytes.toString("base64"),
      });
      assert.equal(result.isError, false);
      assert.ok(calls[0]!.init.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(calls[0]!.init.body), bytes);
      const headers = new Headers(calls[0]!.init.headers);
      if (location === "header")
        assert.equal(headers.get("authorization"), credential);
      if (location === "query")
        assert.equal(
          new URL(calls[0]!.url).searchParams.get("api_key"),
          credential,
        );
      if (location === "cookie")
        assert.equal(
          headers.get("cookie"),
          "session=fixture-session; csrf=fixture-csrf",
        );
      for (const secret of [
        "fixture-secret",
        "fixture-session",
        "fixture-csrf",
      ])
        assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });

  test("invalid bytes, body conflicts, paths, media and credentials never call the provider", async () => {
    for (const override of [
      { body_base64: "Zh==" },
      { body_base64: "Zm9=" },
      { body_base64: null },
      { body: null },
      { body: "" },
      { json_body: false },
      { json_body: null },
      { path: "/none" },
      { path: "/remote" },
      { path: "/missing" },
      { path: "/multi" },
      { path: "/range" },
      { path: "/any" },
      { content_type: "text/plain" },
      { content_type: "application/octet-stream\r\nx-forged: yes" },
      { method: "DELETE" },
      { method: "GET" },
      { path: undefined, method: undefined },
      { surface_id: "fixture:api:2" },
      { surface_id: "fixture:api:6" },
      {
        surface_id: "fixture:api:5",
        credential: { identity: "fixture", signature: "fixture-signature" },
      },
    ]) {
      const { result, calls } = await invoke({
        ...base,
        body_base64: "AP+A",
        ...override,
      });
      assert.equal(result.isError, true, JSON.stringify(override));
      assert.equal(calls.length, 0);
    }
    const read = await invoke(
      { ...base, method: "GET", body_base64: "" },
      { tool: "call_subnet_surface" },
    );
    assert.equal(read.result.isError, true);
    assert.equal(read.calls.length, 0);
  });

  test("the complete MCP request cap includes base64 overhead and rejects before artifact/provider work", async () => {
    const input = {
      ...base,
      body_base64: Buffer.alloc((MAX_MCP_BODY_BYTES * 3) / 4).toString(
        "base64",
      ),
    };
    const { status, error, calls, artifacts } = await invoke(input);
    assert.equal(status, 413);
    assert.ok(error);
    assert.equal(calls.length, 0);
    assert.equal(artifacts.length, 0);
  });

  test("the outbound caller forwards only the active byte view and reuses it after safe redirects", async () => {
    const backing = Buffer.from([99, 0, 255, 128, 99]);
    const body = backing.subarray(1, 4);
    const observed: BodyInit[] = [];
    const checked: string[] = [];
    const result = await callSubnetSurface(
      { url: "https://fixture.example/api" },
      {
        path: "/bytes",
        method: "PUT",
        body,
        contentType: "application/octet-stream",
        isUnsafeUrl: async (url) => {
          checked.push(url);
          return false;
        },
        fetchImpl: async (_url, init) => {
          assert.equal(init!.body, body);
          observed.push(init!.body!);
          const request = new Request("https://fixture.example/bytes", init);
          assert.deepEqual(
            Buffer.from(await request.arrayBuffer()),
            Buffer.from([0, 255, 128]),
          );
          return observed.length === 1
            ? new Response(null, {
                status: 307,
                headers: { location: "/accepted" },
              })
            : Response.json({ accepted: true });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(observed.length, 2);
    assert.deepEqual(checked, [
      "https://fixture.example/bytes",
      "https://fixture.example/accepted",
      "https://fixture.example/accepted",
    ]);
  });

  test("the outbound caller defensively refuses JSON credential merges into a byte body", async () => {
    const result = await callSubnetSurface(
      { url: "https://fixture.example/api" },
      {
        path: "/bytes",
        method: "POST",
        body: bytes,
        credential: { location: "body", values: { signature: "fixture" } },
        isUnsafeUrl: async () => {
          throw new Error("No DNS work");
        },
        fetchImpl: async () => {
          throw new Error("No provider work");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error_class, "invalid_params");
  });
});

describe("captured request-body reference resolution", () => {
  test("inline and absent bodies allocate no reference-cycle tracking state", () => {
    const direct = Object.freeze(mediaBody("application/json"));
    const OriginalSet = globalThis.Set;
    let allocations = 0;
    const CountingSet = new Proxy(OriginalSet, {
      construct(target, args, newTarget) {
        allocations++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    let inlineResult: unknown;
    let absentResult: unknown;
    let inlineAllocations: number;
    let referenceAllocations: number;
    try {
      globalThis.Set = CountingSet;
      for (let index = 0; index < 1000; index++) {
        inlineResult = resolveLocalRequestBody(document, direct);
        absentResult = resolveLocalRequestBody(document, undefined);
      }
      inlineAllocations = allocations;
      resolveLocalRequestBody(document, uploadRef);
      referenceAllocations = allocations - inlineAllocations;
    } finally {
      globalThis.Set = OriginalSet;
    }
    assert.equal(inlineResult, direct);
    assert.equal(absentResult, null);
    assert.equal(inlineAllocations, 0);
    assert.equal(referenceAllocations, 1);
    console.log(
      "SUBNET_HTTP_REFERENCE_ALLOCATION",
      JSON.stringify({
        fixture_calls: 2000,
        inline_or_absent_sets: inlineAllocations,
        referenced_body_sets: referenceAllocations,
        provider_calls: 0,
      }),
    );
  });
  test("direct bodies and escaped/percent-encoded local chains resolve without mutation", () => {
    const direct = mediaBody("application/json");
    assert.equal(resolveLocalRequestBody(null, direct), direct);
    const snapshot = JSON.stringify(document);
    assert.equal(
      resolveLocalRequestBody(document, uploadRef),
      document.components.requestBodies["file/~body space"],
    );
    assert.equal(JSON.stringify(document), snapshot);
  });
  test("malformed, missing, external, cyclic and prototype references fail closed", () => {
    const doc = {
      bodies: { loop: { $ref: "#/bodies/loop" }, scalar: 1, array: [] },
    };
    for (const requestBody of [
      null,
      [],
      false,
      { $ref: 3 },
      { $ref: "body.json#/body" },
      { $ref: "#anchor" },
      { $ref: "#/missing" },
      { $ref: "#/bodies/missing" },
      { $ref: "#/bodies/scalar/field" },
      { $ref: "#/bodies/array/0" },
      { $ref: "#/bodies/scalar" },
      { $ref: "#/bodies/loop" },
      { $ref: "#/bodies/%ZZ" },
      { $ref: "#/bodies/bad~2escape" },
      { $ref: "#/bodies/bad~" },
      { $ref: "#/constructor/prototype" },
    ])
      assert.equal(resolveLocalRequestBody(doc, requestBody), null);
  });
  test("reference chains stop at the bounded hop budget", () => {
    const bodies: Row = {};
    for (let index = 0; index < 32; index++)
      bodies[index] = { $ref: `#/bodies/${index + 1}` };
    bodies[32] = mediaBody("application/json");
    assert.equal(
      resolveLocalRequestBody({ bodies }, { $ref: "#/bodies/0" }),
      null,
    );
  });
  test("legacy JSON/text bodies can use the same captured local references", async () => {
    for (const [media, field, value, expected] of [
      [
        "application/json",
        "json_body",
        [null, false, "雪"],
        '[null,false,"雪"]',
      ],
      ["text/plain", "body", "exact\n雪", "exact\n雪"],
    ] as const) {
      const schema = {
        ...document,
        components: { requestBodies: { upload: mediaBody(media) } },
      };
      const { result, calls } = await invoke(
        { ...base, [field]: value },
        { schema },
      );
      assert.equal(result.isError, false);
      assert.equal(calls[0]!.init.body, expected);
    }
  });
});

describe("byte request MIME admission", () => {
  for (const [contentType, declared, expected] of [
    ["application/octet-stream", ["application/octet-stream"], true],
    ["image/png", ["image/*"], true],
    ["image/png", ["*/*"], true],
    ['multipart/form-data; boundary="a;b"', ["multipart/form-data"], true],
    ["Application/Json; charset=UTF-8", ["application/json"], true],
    ["text/plain; charset=utf-8", ["text/plain; charset=utf-8"], true],
    ["text/plain; charset=ascii", ["text/plain; charset=utf-8"], false],
    ["application/octet-stream", ["image/*"], false],
    ["image/*", ["image/*"], false],
    ["*/*", ["*/*"], false],
    ["not a MIME", ["*/*"], false],
    ["application/", ["*/*"], false],
    ["application/octet-stream\nx-forged: yes", ["*/*"], false],
    ["image/png", [], false],
  ] as const)
    test(`${JSON.stringify(contentType)} against ${JSON.stringify(declared)}`, () => {
      assert.equal(
        matchesBinaryRequestMediaType(contentType, declared),
        expected,
      );
    });
});
