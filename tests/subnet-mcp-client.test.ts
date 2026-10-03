import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { Row } from "./row-type.ts";
import {
  runSubnetMcp,
  SubnetMcpError,
  MAX_SUBNET_MCP_CATALOG_BYTES,
  type SubnetMcpOptions,
} from "../src/subnet-mcp-client.ts";
import { MAX_RESPONSE_BYTES } from "../src/call-subnet-surface.ts";

const endpoint = "https://subnet.example/mcp";
const readTool = {
  name: "read",
  description: "provider data",
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: "object" as const,
    required: ["value"],
    additionalProperties: false,
    properties: { value: { $ref: "#/$defs/value" } },
    $defs: { value: { type: "string", pattern: "^[0-9]+$" } },
  },
  outputSchema: {
    type: "object" as const,
    required: ["value"],
    additionalProperties: false,
    properties: { value: { type: "string" } },
  },
};
const writeTool = {
  ...readTool,
  name: "write",
  annotations: { readOnlyHint: true },
};
type Wire = { method: string; url: string; headers: Headers; message?: Row };

function fixture(
  overrides: {
    sse?: boolean;
    session?: string | null;
    protocol?: string;
    capabilities?: Row;
    tools?: (params: Row) => Row;
    prompts?: (params: Row) => Row;
    resources?: (params: Row) => Row;
    result?: Row;
    intercept?: (wire: Wire) => Response | Promise<Response> | undefined;
  } = {},
) {
  const calls: Wire[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const message =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const wire = {
      method,
      url: String(input),
      headers: new Headers(init?.headers),
      message,
    };
    calls.push(wire);
    const intercepted = await overrides.intercept?.(wire);
    if (intercepted) return intercepted;
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (message.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    assert.ok(message);
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: overrides.protocol ?? "2025-11-25",
            capabilities: overrides.capabilities ?? {
              tools: {},
              prompts: {},
              resources: {},
            },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? (overrides.tools?.(message.params ?? {}) ?? {
              tools: [readTool, writeTool],
            })
          : message.method === "prompts/list"
            ? (overrides.prompts?.(message.params ?? {}) ?? {
                prompts: [
                  {
                    name: "plan",
                    arguments: [{ name: "login", required: true }],
                  },
                ],
              })
            : message.method === "resources/list"
              ? (overrides.resources?.(message.params ?? {}) ?? {
                  resources: [{ name: "taxonomy", uri: "fixture://taxonomy" }],
                })
              : (overrides.result ?? {
                  content: [
                    { type: "text", text: 'exact "quoted" response\n' },
                  ],
                  structuredContent: { value: message.params.arguments.value },
                });
    const data = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    const headers = new Headers({
      "content-type": overrides.sse
        ? "text/event-stream; charset=utf-8"
        : "application/json; charset=utf-8",
    });
    if (message.method === "initialize" && overrides.session !== null)
      headers.set("mcp-session-id", overrides.session ?? "fixture-session");
    return new Response(
      overrides.sse ? `event: message\ndata: ${data}\n\n` : data,
      { headers },
    );
  };
  const options: SubnetMcpOptions = {
    url: endpoint,
    readTools: ["read"],
    writeTools: ["write"],
    timeoutMs: 2_000,
    fetchImpl,
    isUnsafeUrl: async () => false,
  };
  return { options, calls };
}
const read = {
  kind: "read" as const,
  name: "read",
  arguments: { value: "18446744073709551615" },
};
async function fails(
  options: SubnetMcpOptions,
  operation: Parameters<typeof runSubnetMcp>[1],
  code: string,
) {
  await assert.rejects(
    runSubnetMcp(options, operation),
    (error: unknown) => error instanceof SubnetMcpError && error.code === code,
  );
}

describe("isolated upstream MCP protocol", () => {
  for (const sse of [false, true])
    test(`prompt/resource ${sse ? "SSE" : "JSON"} discovery and native results`, async () => {
      const messages = [
        {
          role: "user",
          content: { type: "text", text: 'provider "instructions"\n' },
        },
        {
          role: "assistant",
          content: { type: "image", mimeType: "image/png", data: "AQIDBA==" },
        },
      ];
      const prompt = fixture({
        sse,
        result: { description: "plan", messages, _meta: { exact: true } },
      });
      prompt.options.readPrompts = ["plan"];
      const result = await runSubnetMcp(prompt.options, {
        kind: "prompt",
        name: "plan",
        arguments: { login: "caller" },
      });
      assert.deepEqual(result, {
        kind: "prompt",
        result: { description: "plan", messages, _meta: { exact: true } },
      });
      assert.deepEqual(
        prompt.calls
          .filter((call) => call.message?.id !== undefined)
          .map((call) => call.message?.method),
        ["initialize", "prompts/list", "prompts/get"],
      );
      const contents = [
        {
          uri: "fixture://taxonomy",
          mimeType: "application/json",
          text: '{"exact":"18446744073709551615"}\n',
        },
        {
          uri: "fixture://attachment",
          mimeType: "application/octet-stream",
          blob: "AAH/",
        },
      ];
      const resource = fixture({
        sse,
        result: { contents, _meta: { exact: true } },
      });
      resource.options.readResources = ["fixture://taxonomy"];
      assert.deepEqual(
        await runSubnetMcp(resource.options, {
          kind: "resource",
          uri: "fixture://taxonomy",
        }),
        { kind: "resource", result: { contents, _meta: { exact: true } } },
      );
      assert.deepEqual(
        resource.calls
          .filter((call) => call.message?.id !== undefined)
          .map((call) => call.message?.method),
        ["initialize", "resources/list", "resources/read"],
      );
    });
  test("discovery filters and paginates reviewed prompts/resources without executing them", async () => {
    const { options, calls } = fixture({
      prompts: (params) =>
        params.cursor
          ? { prompts: [{ name: "plan" }] }
          : { prompts: [{ name: "unreviewed" }], nextCursor: "next" },
      resources: (params) =>
        params.cursor
          ? { resources: [{ name: "taxonomy", uri: "fixture://taxonomy" }] }
          : {
              resources: [{ name: "other", uri: "fixture://other" }],
              nextCursor: "next",
            },
    });
    options.readPrompts = ["plan"];
    options.readResources = ["fixture://taxonomy"];
    const result = await runSubnetMcp(options, { kind: "discover" });
    assert.equal(result.kind, "discover");
    if (result.kind !== "discover") throw new Error("missing discovery");
    assert.deepEqual(result.prompts, [{ name: "plan" }]);
    assert.deepEqual(result.resources, [
      { name: "taxonomy", uri: "fixture://taxonomy" },
    ]);
    assert.equal(
      calls.some((call) =>
        ["prompts/get", "resources/read", "tools/call"].includes(
          call.message?.method,
        ),
      ),
      false,
    );
  });
  test("prompt/resource-only discovery does not require tools capability", async () => {
    const { options, calls } = fixture({
      capabilities: { prompts: {}, resources: {} },
    });
    options.readTools = [];
    options.writeTools = [];
    options.readPrompts = ["plan"];
    options.readResources = ["fixture://taxonomy"];
    const result = await runSubnetMcp(options, { kind: "discover" });
    assert.equal(result.kind, "discover");
    if (result.kind !== "discover") throw new Error("missing discovery");
    assert.deepEqual(result.tools, []);
    assert.equal(result.prompts?.length, 1);
    assert.equal(result.resources?.length, 1);
    assert.equal(
      calls.some((call) => call.message?.method.startsWith("tools/")),
      false,
    );
  });
  test("unadmitted prompt/resource reject before traffic, including URL-shaped resource identifiers", async () => {
    const { options, calls } = fixture();
    for (const operation of [
      { kind: "prompt" as const, name: "plan", arguments: {} },
      { kind: "resource" as const, uri: "http://127.0.0.1/private" },
    ])
      await fails(options, operation, "operation_not_allowed");
    assert.equal(calls.length, 0);
  });
  test("argument-free and optional prompts retain provider output without invented requirements", async () => {
    for (const argumentsList of [undefined, [{ name: "optional" }]]) {
      const { options } = fixture({
        prompts: () => ({
          prompts: [
            {
              name: "plan",
              ...(argumentsList ? { arguments: argumentsList } : {}),
            },
          ],
        }),
        result: { messages: [] },
      });
      options.readPrompts = ["plan"];
      assert.deepEqual(
        await runSubnetMcp(options, {
          kind: "prompt",
          name: "plan",
          arguments: {},
        }),
        { kind: "prompt", result: { messages: [] } },
      );
    }
  });
  test("SDK rejects malformed prompt and resource results", async () => {
    for (const kind of ["prompt", "resource"] as const) {
      const { options } = fixture({ result: { unexpected: true } });
      options.readPrompts = ["plan"];
      options.readResources = ["fixture://taxonomy"];
      await fails(
        options,
        kind === "prompt"
          ? { kind, name: "plan", arguments: { login: "caller" } }
          : { kind, uri: "fixture://taxonomy" },
        "upstream_mcp_error",
      );
    }
  });
  test("missing prompt arguments or catalog entries never reach get/read", async () => {
    const { options, calls } = fixture();
    options.readPrompts = ["plan", "missing"];
    options.readResources = ["fixture://missing"];
    await fails(
      options,
      { kind: "prompt", name: "plan", arguments: {} },
      "invalid_params",
    );
    await fails(
      options,
      { kind: "prompt", name: "missing", arguments: {} },
      "not_found",
    );
    await fails(
      options,
      { kind: "resource", uri: "fixture://missing" },
      "not_found",
    );
    assert.equal(
      calls.some((call) =>
        ["prompts/get", "resources/read"].includes(call.message?.method),
      ),
      false,
    );
  });
  for (const malformed of ["entry", "cursor", "limit"])
    test(`prompt/resource ${malformed} catalog rejection`, async () => {
      const { options } = fixture({
        prompts: () => ({
          prompts:
            malformed === "limit"
              ? Array.from({ length: 513 }, (_, i) => ({ name: `prompt-${i}` }))
              : [
                  { name: "plan" },
                  ...(malformed === "entry" ? [{ name: "plan" }] : []),
                ],
          ...(malformed === "cursor" ? { nextCursor: "loop" } : {}),
        }),
      });
      options.readPrompts = ["plan"];
      await fails(options, { kind: "discover" }, "invalid_catalog");
    });
  for (const sse of [false, true])
    test(`${sse ? "SSE" : "JSON"} negotiation, full schema validation and exact content`, async () => {
      const { options, calls } = fixture({ sse });
      const result = await runSubnetMcp(options, read);
      assert.equal(result.kind, "call");
      if (result.kind !== "call") throw new Error("missing call");
      assert.deepEqual(result.result, {
        content: [{ type: "text", text: 'exact "quoted" response\n' }],
        structuredContent: { value: read.arguments.value },
      });
      assert.ok(
        calls.some((c) => c.message?.method === "notifications/initialized"),
      );
      for (const call of calls.filter(
        (c) =>
          c.message?.method === "tools/list" ||
          c.message?.method === "tools/call",
      )) {
        assert.equal(call.headers.get("mcp-session-id"), "fixture-session");
        assert.equal(call.headers.get("mcp-protocol-version"), "2025-11-25");
        assert.equal(
          call.headers.get("accept"),
          "application/json, text/event-stream",
        );
      }
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
    });
  test("discovery retains complete schemas but permissions come from reviewed admission", async () => {
    const { options } = fixture({
      tools: () => ({
        tools: [readTool, writeTool, { ...readTool, name: "unknown" }],
      }),
    });
    const result = await runSubnetMcp(options, { kind: "discover" });
    assert.deepEqual(result, {
      kind: "discover",
      tools: [
        { ...readTool, access: "read" },
        { ...writeTool, access: "write" },
      ],
    });
  });
  test("write cannot be reached through read, regardless of provider annotations", async () => {
    const { options, calls } = fixture();
    await assert.rejects(
      runSubnetMcp(options, { ...read, name: "write" }),
      (error: unknown) =>
        error instanceof SubnetMcpError &&
        error.code === "operation_not_allowed" &&
        error.message === "This MCP operation is not admitted for this tool.",
    );
    await fails(options, { ...read, kind: "write" }, "operation_not_allowed");
    assert.equal(calls.length, 0);
    assert.equal(
      (await runSubnetMcp(options, { ...read, kind: "write", name: "write" }))
        .kind,
      "call",
    );
  });
  test("reject overlapping admissions and body transport credentials before network work", async () => {
    const { options, calls } = fixture();
    await fails({ ...options, writeTools: ["read"] }, read, "invalid_registry");
    await fails(
      {
        ...options,
        credential: { location: "body", values: { signature: "signed" } },
      },
      read,
      "credential_not_supported",
    );
    assert.equal(calls.length, 0);
  });
  test("input refs, required fields, pattern and additionalProperties reject before tools/call", async () => {
    for (const args of [
      {},
      { value: 42 },
      { value: "bad" },
      { value: "42", extra: true },
    ]) {
      const { options, calls } = fixture();
      await fails(options, { ...read, arguments: args }, "invalid_params");
      assert.equal(
        calls.filter((c) => c.message?.method === "tools/call").length,
        0,
      );
    }
  });
  test("SDK output validation rejects missing or malformed structured output", async () => {
    for (const result of [
      { content: [] },
      { content: [], structuredContent: { value: 42 } },
      { toolResult: { value: read.arguments.value } },
    ]) {
      const { options } = fixture({ result });
      await fails(options, read, "upstream_mcp_error");
    }
  });
  test("execution errors retain all native blocks and metadata without requiring structured output", async () => {
    const result = {
      isError: true,
      content: [
        { type: "text", text: "failure" },
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "audio", data: "BAUG", mimeType: "audio/wav" },
        {
          type: "resource",
          resource: {
            uri: "fixture://blob",
            mimeType: "application/octet-stream",
            blob: "BwgJ",
          },
        },
        {
          type: "resource_link",
          uri: "https://subnet.example/item",
          name: "item",
        },
      ],
      _meta: { trace: "provider-1" },
    };
    const { options } = fixture({ result });
    assert.deepEqual(await runSubnetMcp(options, read), {
      kind: "call",
      result,
    });
  });
  test("pagination calls a tool with its own page's cached output schema", async () => {
    const { options, calls } = fixture({
      tools: (params) =>
        params.cursor
          ? { tools: [readTool] }
          : { tools: [writeTool], nextCursor: "page2" },
    });
    assert.equal((await runSubnetMcp(options, read)).kind, "call");
    assert.deepEqual(
      calls
        .filter((c) => c.message?.method === "tools/list")
        .map((c) => c.message?.params),
      [undefined, { cursor: "page2" }],
    );
    const discovered = await runSubnetMcp(options, { kind: "discover" });
    assert.equal(discovered.kind === "discover" && discovered.tools.length, 2);
  });
  test("missing tools, duplicate names and cursor loops fail closed", async () => {
    for (const [tools, code] of [
      [() => ({ tools: [] }), "not_found"],
      [() => ({ tools: [writeTool, writeTool] }), "invalid_catalog"],
      [() => ({ tools: [], nextCursor: "same" }), "invalid_catalog"],
    ] as const) {
      const { options } = fixture({ tools });
      await fails(options, read, code);
    }
  });
  test("server session ids never carry into another invocation", async () => {
    const first = fixture({ session: "first" });
    const second = fixture({ session: "second" });
    await Promise.all([
      runSubnetMcp(first.options, read),
      runSubnetMcp(second.options, read),
    ]);
    for (const [own, other] of [
      [first, "second"],
      [second, "first"],
    ] as const) {
      assert.equal(own.calls[0].headers.get("mcp-session-id"), null);
      assert.ok(
        own.calls.every((c) => c.headers.get("mcp-session-id") !== other),
      );
    }
    const noSession = fixture({ session: null });
    await runSubnetMcp(noSession.options, read);
    assert.ok(noSession.calls.every((c) => c.method !== "DELETE"));
  });
  test("unsupported protocol versions fail negotiation", async () => {
    const { options, calls } = fixture({ protocol: "2099-01-01" });
    await fails(options, read, "upstream_mcp_error");
    assert.ok(calls.every((c) => c.message?.method !== "tools/call"));
  });
  for (const location of ["header", "query", "cookie"] as const)
    test(`${location} credentials apply to each protocol request and redact failures`, async () => {
      const secret =
        location === "query" ? "secret /λ space" : "secret / space";
      const { options, calls } = fixture();
      const credential = { location, name: "key", value: secret };
      await runSubnetMcp({ ...options, credential }, read);
      for (const call of calls) {
        if (location === "query")
          assert.equal(new URL(call.url).searchParams.get("key"), secret);
        else if (location === "cookie")
          assert.equal(call.headers.get("cookie"), `key=${secret}`);
        else assert.equal(call.headers.get("key"), secret);
      }
      const failing = fixture({
        intercept: () => {
          throw new Error(
            `provider ${secret} ${new URLSearchParams({ key: secret })}`,
          );
        },
      });
      await assert.rejects(
        runSubnetMcp({ ...failing.options, credential }, read),
        (error: unknown) => {
          assert.ok(error instanceof SubnetMcpError);
          assert.ok(!error.message.includes(secret));
          if (location === "query")
            assert.ok(
              !error.message.includes(
                new URLSearchParams({ key: secret }).toString().slice(4),
              ),
            );
          return true;
        },
      );
    });
  test("signature credential bundles and omitted empty placement", async () => {
    const { options, calls } = fixture();
    await runSubnetMcp(
      {
        ...options,
        credential: {
          location: "header",
          values: { key: "a", signature: "b" },
        },
      },
      read,
    );
    assert.ok(calls.every((c) => c.headers.get("signature") === "b"));
    assert.equal(
      (
        await runSubnetMcp(
          { ...options, credential: { location: "header" } },
          read,
        )
      ).kind,
      "call",
    );
  });
  test("same-origin redirects revalidate and retain protocol bytes; foreign redirects stop", async () => {
    const checked: string[] = [];
    const { options, calls } = fixture({
      intercept: (wire) =>
        new URL(wire.url).pathname === "/mcp"
          ? new Response(null, {
              status: 307,
              headers: { location: "/mcp-next" },
            })
          : undefined,
    });
    await runSubnetMcp(
      {
        ...options,
        isUnsafeUrl: async (url) => {
          checked.push(url);
          return false;
        },
      },
      read,
    );
    assert.ok(checked.includes("https://subnet.example/mcp-next"));
    const posts = calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts[0].message, posts[1].message);
    for (const target of ["https://other.example/mcp", "/mcp"]) {
      const redirected = fixture({
        intercept: () =>
          new Response(null, { status: 302, headers: { location: target } }),
      });
      await fails(redirected.options, read, "redirect_blocked");
      assert.ok(
        redirected.calls.every(
          (c) => new URL(c.url).origin === new URL(endpoint).origin,
        ),
      );
      assert.ok(redirected.calls.length <= 6);
    }
  });
  test("unsafe DNS and unsafe redirect targets are rejected before that request", async () => {
    const { options, calls } = fixture();
    await fails(
      { ...options, isUnsafeUrl: async () => true },
      read,
      "unsafe_url",
    );
    assert.equal(calls.length, 0);
    const redirected = fixture({
      intercept: () =>
        new Response(null, { status: 308, headers: { location: "/private" } }),
    });
    await fails(
      {
        ...redirected.options,
        isUnsafeUrl: async (url) => url.endsWith("/private"),
      },
      read,
      "unsafe_url",
    );
    assert.equal(redirected.calls.length, 1);
  });
  test("request, response, total-byte and request-count budgets remain bounded", async () => {
    const largeRequest = fixture();
    await fails(
      largeRequest.options,
      { ...read, arguments: { value: "1".repeat(MAX_RESPONSE_BYTES) } },
      "request_too_large",
    );
    assert.ok(
      largeRequest.calls.every((c) => c.message?.method !== "tools/call"),
    );
    const oversized = fixture({
      intercept: () =>
        new Response("x".repeat(MAX_RESPONSE_BYTES + 1), {
          headers: { "content-type": "application/json" },
        }),
    });
    await fails(oversized.options, read, "response_too_large");
    let page = 0;
    const total = fixture({
      tools: () => ({
        tools: [
          {
            ...readTool,
            name: `extra-${++page}`,
            description: "x".repeat(220_000),
          },
        ],
        nextCursor: String(page),
      }),
    });
    await fails(total.options, { kind: "discover" }, "response_too_large");
    const many = fixture({
      tools: (params) => ({
        tools: [],
        nextCursor: String(Number(params.cursor ?? 0) + 1),
      }),
    });
    await fails(many.options, { kind: "discover" }, "request_limit");
    const tooManyTools = fixture({
      tools: () => ({
        tools: Array.from({ length: 513 }, (_, i) => ({
          name: `tool-${i}`,
          inputSchema: { type: "object" },
        })),
      }),
    });
    await fails(tooManyTools.options, { kind: "discover" }, "invalid_catalog");
  });
  for (const sse of [false, true])
    test(`large ${sse ? "SSE" : "JSON"} catalogs retain tools, prompts and resources within the invocation budget`, async () => {
      const description = "x".repeat(MAX_RESPONSE_BYTES + 256);
      const tool = { ...readTool, description };
      const prompt = { name: "plan", description };
      const resource = { name: "taxonomy", uri: "fixture://taxonomy", description };
      const upstream = fixture({
        sse,
        tools: () => ({ tools: [tool] }),
        prompts: () => ({ prompts: [prompt] }),
        resources: () => ({ resources: [resource] }),
      });
      const result = await runSubnetMcp({
        ...upstream.options,
        readPrompts: ["plan"],
        readResources: ["fixture://taxonomy"],
      }, { kind: "discover" });
      assert.deepEqual(result, {
        kind: "discover",
        tools: [{ ...tool, access: "read" }],
        prompts: [prompt],
        resources: [resource],
      });
    });
  test("large catalogs cannot enlarge operation results or HTTP errors", async () => {
    const description = "x".repeat(MAX_RESPONSE_BYTES + 256);
    for (const method of ["tools/call", "prompts/get", "resources/read"]) {
      const upstream = fixture({
        tools: () => ({ tools: [{ ...readTool, description }] }),
        prompts: () => ({ prompts: [{ name: "plan", description }] }),
        resources: () => ({
          resources: [{ name: "taxonomy", uri: "fixture://taxonomy", description }],
        }),
        intercept: (wire) => wire.message?.method === method
          ? new Response(description, {
            headers: { "content-type": "application/json" },
          })
          : undefined,
      });
      upstream.options.readPrompts = ["plan"];
      upstream.options.readResources = ["fixture://taxonomy"];
      await fails(upstream.options, method === "tools/call" ? read
        : method === "prompts/get" ? { kind: "prompt", name: "plan", arguments: {} }
          : { kind: "resource", uri: "fixture://taxonomy" }, "response_too_large");
      assert.ok(upstream.calls.some((wire) => wire.message?.method === method));
    }
    const error = fixture({
      intercept: (wire) => wire.message?.method === "tools/list"
        ? new Response(description, { status: 500 })
        : undefined,
    });
    await fails(error.options, { kind: "discover" }, "response_too_large");
    const oversized = fixture({
      tools: () => ({ tools: [{
        ...readTool,
        description: "x".repeat(MAX_SUBNET_MCP_CATALOG_BYTES),
      }] }),
    });
    await fails(oversized.options, { kind: "discover" }, "response_too_large");
  });
  test("deadlines include stalled fetches, empty-chunk streams and cleanup", async () => {
    const stalled = fixture({
      intercept: () => new Promise<Response>(() => {}),
    });
    await fails({ ...stalled.options, timeoutMs: 10 }, read, "timeout");
    const empty = fixture({
      intercept: () =>
        new Response(
          new ReadableStream({
            pull(out) {
              out.enqueue(new Uint8Array());
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await fails({ ...empty.options, timeoutMs: 10 }, read, "timeout");
    const cleanup = fixture({
      intercept: (wire) =>
        wire.method === "DELETE" ? new Promise<Response>(() => {}) : undefined,
    });
    const started = performance.now();
    assert.equal((await runSubnetMcp(cleanup.options, read)).kind, "call");
    assert.ok(performance.now() - started < 1500);
  });
  test("stalled or rejected provider cancellation cannot retain the invocation", async () => {
    for (const reject of [false, true]) {
      const { options } = fixture({
        intercept: (wire) =>
          wire.method === "GET"
            ? new Response(
                new ReadableStream({
                  pull() {},
                  cancel() {
                    return reject
                      ? Promise.reject(new Error("cancel"))
                      : new Promise<void>(() => {});
                  },
                }),
                { status: 405 },
              )
            : undefined,
      });
      assert.equal((await runSubnetMcp(options, read)).kind, "call");
    }
  });
});
