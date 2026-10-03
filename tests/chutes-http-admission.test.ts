import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import { SurfaceSchema } from "../schemas-src/routes/subnet-detail.ts";
import { AgentCatalogServiceSchema } from "../schemas-src/routes/agent-catalog.ts";
import { HowDoICallOutputSchema } from "../schemas-src/mcp-tools/ai-integration.ts";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const registry = JSON.parse(
  readFileSync(
    new URL("../registry/subnets/chutes.json", import.meta.url),
    "utf8",
  ),
);
const llmId = "sn-64-chutes-sse";
const modelsId = "sn-64-chutes-subnet-api";
const embeddingId = "sn-64-chutes-embeddings";
const imageId = "sn-64-chutes-image-generation";
const rows: Row[] = registry.surfaces
  .filter((row: Row) =>
    [llmId, modelsId, embeddingId, imageId].includes(row.id),
  )
  .map((row: Row) => ({ ...row, netuid: 64 }));
const cases = [
  {
    id: llmId,
    path: "/v1/chat/completions",
    host: "llm.chutes.ai",
    body: {
      model: "fixture-model",
      messages: [{ role: "user", content: "雪" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: { type: "object" } },
        },
      ],
      tool_choice: "auto",
      response_format: { type: "json_object" },
      chat_template_kwargs: { thinking: true },
    },
    result: {
      id: "chat-fixture",
      choices: [
        { message: { role: "assistant", content: "雪", tool_calls: [] } },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  },
  {
    id: llmId,
    path: "/v1/completions",
    host: "llm.chutes.ai",
    body: {
      model: "fixture-model",
      prompt: "A completion",
      stream: false,
      temperature: 0,
      seed: 7,
      max_tokens: 32,
      stop: ["END"],
    },
    result: {
      id: "completion-fixture",
      choices: [{ text: "exact completion", finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  },
  {
    id: llmId,
    path: "/tokenize",
    host: "llm.chutes.ai",
    body: { model: "fixture-model", prompt: "雪", add_special_tokens: false },
    result: { count: 2, max_model_len: 4096, tokens: [1, 2] },
  },
  {
    id: llmId,
    path: "/detokenize",
    host: "llm.chutes.ai",
    body: { model: "fixture-model", tokens: [1, 2] },
    result: { prompt: "雪" },
  },
  {
    id: embeddingId,
    path: "/v1/embeddings",
    host: "embed.chutes.ai",
    body: {
      model: "fixture-model",
      input: ["雪", "second"],
      dimensions: 2,
      encoding_format: "float",
      truncate_prompt_tokens: 64,
      user: "fixture",
    },
    result: {
      id: "embedding-fixture",
      object: "list",
      model: "fixture-model",
      data: [
        { index: 0, object: "embedding", embedding: [0.25, -0.5] },
        { index: 1, object: "embedding", embedding: [0, 1] },
      ],
      usage: { prompt_tokens: 3, total_tokens: 3, completion_tokens: 0 },
    },
  },
  {
    id: imageId,
    path: "/generate",
    host: "image.chutes.ai",
    body: {
      model: "fixture-model",
      prompt: "a mountain",
      negative_prompt: "blur",
      width: 128,
      height: 128,
      seed: 7,
      num_inference_steps: 2,
      guidance_scale: 1,
    },
    result: { fixture: "declared image gateway request" },
  },
] as const;

function setup(
  options: { rows?: Row[]; response?: () => Response; captured?: Row } = {},
) {
  const services = options.rows ?? rows;
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    bytes: Buffer;
  }[] = [];
  const artifacts: string[] = [];
  const readArtifact = async (_env: unknown, path: string) => {
    artifacts.push(path);
    if (path === "/metagraph/operational-surfaces.json")
      return {
        ok: true,
        data: {
          surfaces: services.map((row) => ({ ...row, surface_id: row.id })),
        },
      };
    if (path === "/metagraph/surfaces.json")
      return { ok: true, data: { surfaces: services } };
    if (path === "/metagraph/agent-catalog/64.json")
      return {
        ok: true,
        data: {
          netuid: 64,
          name: "Chutes",
          slug: "sn-64",
          services: services.map((row) => ({
            surface_id: row.id,
            kind: row.kind,
            capability: row.name,
            base_url: row.url,
            method: row.method,
            auth_required: row.auth_required,
            auth: row.auth,
            auth_schemes: [],
            http: row.http,
            eligibility: { callable: false },
          })),
        },
      };
    if (path === `/metagraph/schemas/${llmId}.json` && options.captured)
      return { ok: true, data: { document: options.captured } };
    return { ok: false, status: 404 };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    if (new URL(String(url)).hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    const outgoing = new Request(url, init);
    const target = new URL(outgoing.url);
    const provider = cases.find(
      (item) => item.host === target.hostname && item.path === target.pathname,
    );
    const models =
      target.origin === "https://llm.chutes.ai" &&
      target.pathname === "/v1/models";
    assert.ok(provider || models, "No unmocked provider or production traffic");
    calls.push({
      url: outgoing.url,
      method: outgoing.method,
      headers: outgoing.headers,
      bytes: Buffer.from(await outgoing.arrayBuffer()),
    });
    return (
      options.response?.() ??
      Response.json(
        provider?.result ?? { object: "list", data: [{ id: "fixture-model" }] },
      )
    );
  };
  async function withFetch<T>(action: () => Promise<T>) {
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await action();
    } finally {
      globalThis.fetch = original;
    }
  }
  async function invoke(args: Row, name = "write_subnet_surface") {
    return withFetch(async () => {
      const response = await handleMcpRequest(
        new Request("https://metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        mockEnv({ METAGRAPH_VALIDATE_RESPONSES: "true" }),
        { readArtifact },
      );
      return (await jsonBody(response)).result;
    });
  }
  return { calls, artifacts, readArtifact, invoke, withFetch };
}
const baseArgs = {
  surface_id: llmId,
  path: "/v1/chat/completions",
  method: "POST",
  credential: "Bearer fixture-chutes-key",
  json_body: cases[0].body,
};

describe("Chutes source-reviewed inference and parameter execution", () => {
  test("actual registry declarations validate through manifest, REST/catalog and guide contracts", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../schemas/subnet-manifest.schema.json", import.meta.url),
        "utf8",
      ),
    );
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(manifest);
    assert.equal(validate(registry), true, JSON.stringify(validate.errors));
    assert.equal(rows.length, 4);
    assert.equal(
      rows.reduce((count, row) => count + (row.http?.operations.length ?? 0), 0),
      6,
    );
    for (const row of rows) {
      assert.equal(SurfaceSchema.safeParse(row).success, true);
      assert.equal(
        AgentCatalogServiceSchema.safeParse({
          surface_id: row.id,
          kind: row.kind,
          base_url: row.url,
          auth: row.auth ?? null,
          http: row.http,
        }).success,
        true,
      );
      if (row.id === modelsId) {
        assert.equal(row.auth_required, false);
        assert.equal(row.probe.enabled, true);
        assert.equal(row.http, undefined);
        continue;
      }
      assert.ok(
        row.source_urls.some((url: string) =>
          url.includes("3b5609f42f84e29dea374382ef1fa95b0fda329c"),
        ),
      );
      assert.equal(row.auth_required, true);
      assert.equal(row.probe.enabled, false);
      assert.equal(row.probe.method, "GET");
      assert.equal(row.method, "POST");
      assert.equal(row.auth.name, "Authorization");
      for (const operation of row.http.operations) {
        assert.deepEqual(operation.request_content_types, ["application/json"]);
        assert.equal(operation.request_body_required, true);
      }
    }
  });
  for (const provider of cases) {
    test(`${provider.path} forwards native JSON fields and provider result once`, async () => {
      const fixture = setup();
      const result = await fixture.invoke({
        ...baseArgs,
        surface_id: provider.id,
        path: provider.path,
        json_body: provider.body,
        header_values: { "X-TEE-Only": true, "X-Chutes-Trace": false },
      });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.body, provider.result);
      assert.equal(fixture.calls.length, 1);
      const call = fixture.calls[0]!;
      assert.equal(call.url, `https://${provider.host}${provider.path}`);
      assert.equal(call.method, "POST");
      assert.equal(call.bytes.toString(), JSON.stringify(provider.body));
      assert.equal(call.headers.get("authorization"), baseArgs.credential);
      assert.equal(call.headers.get("content-type"), "application/json");
      assert.equal(call.headers.get("x-tee-only"), "true");
      assert.equal(call.headers.get("x-chutes-trace"), "false");
      assert.equal(
        fixture.artifacts.some((path) =>
          path.startsWith("/metagraph/schemas/"),
        ),
        false,
      );
      assert.equal(JSON.stringify(result).includes(baseArgs.credential), false);
    });
    test(`${provider.path} rejects keyless, read-tool, missing body and unreviewed path calls before traffic`, async () => {
      const fixture = setup();
      const args = {
        ...baseArgs,
        surface_id: provider.id,
        path: provider.path,
        json_body: provider.body,
      };
      for (const [changes, name] of [
        [{ credential: undefined }, "write_subnet_surface"],
        [{}, "call_subnet_surface"],
        [{ path: "/not-reviewed" }, "write_subnet_surface"],
        [{ json_body: undefined }, "write_subnet_surface"],
        [{ content_type: "text/plain" }, "write_subnet_surface"],
      ] as const)
        assert.equal(
          (await fixture.invoke({ ...args, ...changes }, name)).isError,
          true,
        );
      assert.equal(fixture.calls.length, 0);
    });
  }
  test("public model discovery stays credential-free with one GET and no body", async () => {
    const fixture = setup();
    const result = await fixture.invoke(
      { surface_id: modelsId },
      "call_subnet_surface",
    );
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.body, {
      object: "list",
      data: [{ id: "fixture-model" }],
    });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0]!.method, "GET");
    assert.equal(fixture.calls[0]!.bytes.length, 0);
    assert.equal(fixture.calls[0]!.headers.has("authorization"), false);
  });
  for (const path of ["/v1/chat/completions", "/v1/completions"])
    test(`${path} preserves bounded SSE bytes, terminal marker and thinking/query controls`, async () => {
      const events =
        'data: {"id":"fixture","choices":[{"delta":{"content":"雪"}}]}\n\ndata: [DONE]\n\n';
      const fixture = setup({
        response: () =>
          new Response(events, {
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const result = await fixture.invoke({
        ...baseArgs,
        path,
        json_body: { model: "fixture-model", stream: true },
        query_values: { stream: true },
        header_values: { "x-enable-thinking": true },
      });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.body, events);
      assert.equal(result.structuredContent.truncated, false);
      assert.equal(fixture.calls.length, 1);
      assert.equal(
        fixture.calls[0]!.url,
        `https://llm.chutes.ai${path}?stream=true`,
      );
      assert.equal(fixture.calls[0]!.headers.get("x-enable-thinking"), "true");
      assert.equal(
        fixture.calls[0]!.bytes.toString(),
        '{"model":"fixture-model","stream":true}',
      );
    });
  test("image attachment retains exact fixture bytes in native content and a compact receipt", async () => {
    const bytes = Buffer.from([255, 216, 255, 0, 192, 128, 255, 217]);
    const fixture = setup({
      response: () =>
        new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
    });
    const provider = cases[5];
    const result = await fixture.invoke({
      ...baseArgs,
      surface_id: provider.id,
      path: provider.path,
      json_body: provider.body,
      response_mode: "attachment",
    });
    assert.equal(result.isError, false);
    const attachment = result.content.find(
      (item: Row) => item.type === "image",
    );
    assert.deepEqual(Buffer.from(attachment.data, "base64"), bytes);
    assert.deepEqual(result.structuredContent.body, {
      encoding: "mcp_content",
      mime_type: "image/jpeg",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.equal(fixture.calls.length, 1);
  });
  for (const status of [400, 401, 403, 404, 426, 429, 503])
    test(`provider ${status} is preserved with its exact body and no replay`, async () => {
      const body = {
        detail: `fixture provider refusal ${status}`,
        provider_field: "unchanged",
      };
      const fixture = setup({
        response: () => Response.json(body, { status }),
      });
      const result = await fixture.invoke(baseArgs);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.status_code, status);
      assert.deepEqual(result.structuredContent.body, body);
      assert.equal(fixture.calls.length, 1);
    });
  test("reviewed parameters preserve captured serialization while removing one schema read", async () => {
    const surface = rows.find((row) => row.id === llmId)!;
    const operation = surface.http.operations.find(
      (item: Row) => item.path === baseArgs.path,
    );
    const captured = {
      openapi: "3.1.0",
      paths: {
        [baseArgs.path]: { post: { parameters: operation.parameters } },
      },
    };
    const previous = {
      ...surface,
      http: {
        operations: surface.http.operations.map(
          ({ parameters: _parameters, ...item }: Row) => item,
        ),
      },
    };
    const baseline = setup({ rows: [previous], captured });
    const current = setup({ rows: [surface], captured });
    const args = {
      ...baseArgs,
      query_values: { stream: false },
      header_values: { "X-TEE-Only": true, "X-Enable-Thinking": false },
    };
    const before = await baseline.invoke(args);
    const after = await current.invoke(args);
    assert.equal(before.isError, false);
    assert.equal(after.isError, false);
    assert.deepEqual(
      after.structuredContent.body,
      before.structuredContent.body,
    );
    assert.equal(current.calls[0]!.url, baseline.calls[0]!.url);
    assert.deepEqual(current.calls[0]!.bytes, baseline.calls[0]!.bytes);
    assert.deepEqual(
      [...current.calls[0]!.headers],
      [...baseline.calls[0]!.headers],
    );
    assert.equal(
      baseline.artifacts.filter((path) =>
        path.startsWith("/metagraph/schemas/"),
      ).length,
      1,
    );
    assert.equal(
      current.artifacts.filter((path) => path.startsWith("/metagraph/schemas/"))
        .length,
      0,
    );
    console.log(
      "CHUTES_REVIEWED_PARAMETER_FIXTURE",
      JSON.stringify({
        captured_schema_reads: 1,
        reviewed_schema_reads: 0,
        provider_requests_each: 1,
        request_bytes_equal: true,
        response_body_equal: true,
        production_requests: 0,
      }),
    );
  });
  test("reviewed query/header/cookie collections share existing serializers without a schema read", async () => {
    const surface = rows.find((row) => row.id === llmId)!;
    const parameters = [
      { name: "filter", in: "query", style: "deepObject" },
      { name: "tags", in: "query", style: "form", explode: false },
      { name: "X-Values", in: "header", style: "simple", explode: true },
      { name: "session", in: "cookie", style: "cookie", explode: false },
    ];
    const fixture = setup({
      rows: [
        {
          ...surface,
          http: {
            operations: [
              {
                method: "POST",
                path: baseArgs.path,
                request_content_types: ["application/json"],
                parameters,
              },
            ],
          },
        },
      ],
    });
    const result = await fixture.invoke({
      ...baseArgs,
      query_values: { filter: { name: "雪" }, tags: ["a", "b"] },
      header_values: { "X-Values": { a: "one", b: "two" } },
      cookie_values: { session: ["one", "two"] },
    });
    assert.equal(result.isError, false);
    assert.equal(
      fixture.calls[0]!.url,
      `https://llm.chutes.ai${baseArgs.path}?filter%5Bname%5D=%E9%9B%AA&tags=a,b`,
    );
    assert.equal(fixture.calls[0]!.headers.get("x-values"), "a=one,b=two");
    assert.equal(fixture.calls[0]!.headers.get("cookie"), "session=one,two");
    assert.equal(
      fixture.artifacts.some((path) => path.startsWith("/metagraph/schemas/")),
      false,
    );
  });
  for (const changes of [
    { header_values: { "X-Unknown": "value" } },
    { header_values: { Authorization: "Bearer override" } },
    { header_values: { "X-TEE-Only": "true\r\nInjected: value" } },
    { header_values: { "X-TEE-Only": true, "x-tee-only": false } },
    { cookie_values: { unknown: "value" } },
    { query_values: { unknown: "value" } },
    { query_values: { stream: { nested: { value: true } } } },
  ])
    test(`undeclared or malformed parameters fail before traffic: ${JSON.stringify(changes)}`, async () => {
      const fixture = setup();
      assert.equal(
        (await fixture.invoke({ ...baseArgs, ...changes })).isError,
        true,
      );
      assert.equal(fixture.calls.length, 0);
      assert.equal(
        fixture.artifacts.some((path) =>
          path.startsWith("/metagraph/schemas/"),
        ),
        false,
      );
    });
  test("an explicit empty reviewed parameter list refuses undeclared values without captured fallback", async () => {
    const model = rows.find((row) => row.id === modelsId)!;
    const fixture = setup({
      rows: [
        {
          ...model,
          http: {
            operations: [{ method: "GET", path: "/v1/models", parameters: [] }],
          },
        },
      ],
    });
    const result = await fixture.invoke(
      {
        surface_id: modelsId,
        path: "/v1/models",
        method: "GET",
        query_values: { stream: true },
      },
      "call_subnet_surface",
    );
    assert.equal(result.isError, true);
    assert.equal(fixture.calls.length, 0);
    assert.equal(
      fixture.artifacts.some((path) => path.startsWith("/metagraph/schemas/")),
      false,
    );
  });
  for (const parameter of [
    { name: "", in: "header" },
    { name: "x".repeat(129), in: "header" },
    { name: "X-Test", in: "body" },
    { name: "X-Test", in: "header", style: "unknown" },
    { name: "X-Test", in: "header", explode: "true" },
    { name: "X-Test", in: "header", allowReserved: "true" },
    { name: "X-Test", in: "header", credential: "private" },
  ])
    test(`malformed reviewed metadata grants no execution: ${JSON.stringify(parameter)}`, async () => {
      const surface = rows.find((row) => row.id === llmId)!;
      const { netuid: _netuid, ...declaration } = surface;
      const changed = {
        ...declaration,
        http: {
          operations: [
            { method: "POST", path: baseArgs.path, parameters: [parameter] },
          ],
        },
      };
      assert.equal(SurfaceSchema.safeParse(changed).success, false);
      const manifest = JSON.parse(
        readFileSync(
          new URL("../schemas/subnet-manifest.schema.json", import.meta.url),
          "utf8",
        ),
      );
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile({ ...manifest.$defs.surface, $defs: manifest.$defs });
      assert.equal(validate(changed), false);
      const fixture = setup({ rows: [{ ...changed, netuid: 64 }] });
      assert.equal((await fixture.invoke(baseArgs)).isError, true);
      assert.equal(fixture.calls.length, 0);
    });
  test("stored keys remain isolated across caller accounts and the three gateways", async () => {
    const fixture = setup();
    const values = new Map<string, string>();
    const env = mockEnv({
      MCP_SURFACE_CREDENTIAL_SECRET: "fixture-secret",
      METAGRAPH_CONTROL: {
        get: async (key: string) =>
          values.has(key) ? JSON.parse(values.get(key)!) : null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
    });
    type Ctx = Parameters<(typeof MCP_TOOLS)[number]["handler"]>[1];
    const ctx = {
      env,
      accountId: "7",
      readArtifact: fixture.readArtifact,
    } as unknown as Ctx;
    const store = MCP_TOOLS.find(
      (tool) => tool.name === "store_surface_credential",
    )!;
    const write = MCP_TOOLS.find(
      (tool) => tool.name === "write_subnet_surface",
    )!;
    await fixture.withFetch(async () => {
      await store.handler(
        { surface_id: llmId, credential: "Bearer fixture-llm-stored" },
        ctx,
      );
      const { credential: _credential, ...args } = baseArgs;
      await write.handler(args, ctx);
      await assert.rejects(
        write.handler(args, { ...ctx, accountId: "8" }),
        (error: Row) => error.code === "auth_required",
      );
      for (const provider of cases.slice(4)) {
        const request = {
          ...args,
          surface_id: provider.id,
          path: provider.path,
          json_body: provider.body,
        };
        await assert.rejects(
          write.handler(request, ctx),
          (error: Row) => error.code === "auth_required",
        );
        await store.handler(
          {
            surface_id: provider.id,
            credential: `Bearer fixture-${provider.id}-stored`,
          },
          ctx,
        );
        await write.handler(request, ctx);
        await write.handler(
          { ...request, credential: "Bearer fixture-explicit" },
          ctx,
        );
      }
    });
    assert.deepEqual(
      fixture.calls.map((call) => call.headers.get("authorization")),
      [
        "Bearer fixture-llm-stored",
        `Bearer fixture-${embeddingId}-stored`,
        "Bearer fixture-explicit",
        `Bearer fixture-${imageId}-stored`,
        "Bearer fixture-explicit",
      ],
    );
  });
  test("guide publishes six inference operations and exact public auth/parameter metadata without network or schema reads", async () => {
    const fixture = setup();
    const result = await fixture.invoke({ netuid: 64 }, "how_do_i_call");
    assert.equal(result.isError, false);
    const guide = HowDoICallOutputSchema.parse(result.structuredContent);
    assert.equal(guide.services.length, 4);
    assert.deepEqual(
      guide.services.map((item) => item.http),
      rows.map((row) => row.http),
    );
    assert.deepEqual(
      guide.services.map((item) => item.auth.detail),
      rows.map((row) => row.auth),
    );
    assert.deepEqual(fixture.artifacts, ["/metagraph/agent-catalog/64.json"]);
    assert.equal(fixture.calls.length, 0);
    console.log(
      "CHUTES_DOCUMENTED_HTTP_FIXTURE",
      JSON.stringify({
        documented_operations: 6,
        admitted_operations: 6,
        guide_catalog_reads: 1,
        guide_provider_requests: 0,
        guide_schema_reads: 0,
        production_requests: 0,
        live_model_availability_qualified: false,
      }),
    );
  });
});
