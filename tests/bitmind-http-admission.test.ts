import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import { SurfaceSchema } from "../schemas-src/routes/subnet-detail.ts";
import { HowDoICallOutputSchema } from "../schemas-src/mcp-tools/ai-integration.ts";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const registry = JSON.parse(
  readFileSync(
    new URL("../registry/subnets/bitmind.json", import.meta.url),
    "utf8",
  ),
);
const image = "https://example.com/photo.jpg";
const video = "https://example.com/video.mp4";
const cases = [
  {
    id: "sn-34-bitmind-detect-v1",
    path: "/v1/detect",
    host: "api.bitmind.ai",
    media: ["application/json", "text/plain", "multipart/form-data"],
    json: { media: image, debug: false },
    result: {
      mediaType: "image",
      result: {
        isAI: false,
        confidence: 0.23,
        similarity: 0.05,
        objectKey: "1234567890.jpg",
      },
    },
  },
  {
    id: "sn-34-bitmind-detect-image",
    path: "/detect-image",
    host: "api.bitmind.ai",
    media: ["application/json", "multipart/form-data"],
    json: { image, debug: true },
    result: {
      isAI: false,
      confidence: 0.23,
      similarity: 0.05,
      objectKey: "1234567890.jpg",
      debug: { raw: 0.42, region: "us" },
    },
  },
  {
    id: "sn-34-bitmind-detect-video",
    path: "/detect-video",
    host: "api.bitmind.ai",
    media: ["application/json", "multipart/form-data"],
    json: { video, startTime: 0, endTime: 1.5, fps: 1, debug: false },
    result: {
      isAI: true,
      confidence: 0.87,
      similarity: 0,
      objectKey: "1234567890.mp4",
      thumbnailObjectKey: "thumbnails/1234567890/main.jpg",
    },
  },
  {
    id: "sn-34-bitmind-detect-text",
    path: "/detect-text",
    host: "api.bitmind.ai",
    media: ["application/json"],
    json: {
      text: "An original fixture passage with enough characters for the documented text contract. ".repeat(
        4,
      ),
      debug: false,
      postContext: {
        platform: "fixture",
        sourceUrl: "https://example.com/post",
        author: "fixture",
      },
    },
    result: { isAI: false, confidence: 0.12, verdict: "uncertain" },
  },
  {
    id: "sn-34-bitmind-enterprise-image",
    path: "/image",
    host: "enterprise.bitmind.ai",
    media: ["application/json", "multipart/form-data"],
    json: { image, debug: false },
    result: { isAI: false, confidence: 0.897 },
  },
  {
    id: "sn-34-bitmind-enterprise-video",
    path: "/video",
    host: "enterprise.bitmind.ai",
    media: ["application/json", "multipart/form-data"],
    json: { video, startTime: 0, endTime: 1.5, fps: 1, debug: false },
    result: { isAI: true, confidence: 0.917 },
  },
] as const;
const admitted = cases.map(({ id }) => {
  const row = registry.surfaces.find((surface: Row) => surface.id === id);
  assert.ok(row);
  return { ...row, netuid: 34 };
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=",
  "base64",
);
function multipart(field: string) {
  return Buffer.concat([
    Buffer.from(
      `--fixture\r\nContent-Disposition: form-data; name="${field}"; filename="fixture.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    png,
    Buffer.from(
      '\r\n--fixture\r\nContent-Disposition: form-data; name="debug"\r\n\r\nfalse\r\n--fixture--\r\n',
    ),
  ]);
}
const contentType = "multipart/form-data; boundary=fixture";
const sourceUrl = `https://raw.githubusercontent.com/example/uploads/${"a".repeat(40)}/request.bin`;
function setup(
  options: { source?: Uint8Array<ArrayBuffer>; response?: Response } = {},
) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    bytes: Uint8Array;
  }[] = [];
  const sourceCalls: Headers[] = [];
  const readArtifact = async (_env: unknown, path: string) => {
    if (path === "/metagraph/operational-surfaces.json")
      return {
        ok: true,
        data: {
          surfaces: admitted.map((row) => ({ ...row, surface_id: row.id })),
        },
      };
    if (path === "/metagraph/surfaces.json")
      return {
        ok: true,
        data: {
          surfaces: registry.surfaces.map((row: Row) => ({
            ...row,
            netuid: 34,
          })),
        },
      };
    if (path === "/metagraph/agent-catalog/34.json")
      return {
        ok: true,
        data: {
          netuid: 34,
          name: "BitMind",
          slug: "sn-34",
          services: admitted.map((row) => ({
            surface_id: row.id,
            kind: row.kind,
            capability: row.name,
            base_url: row.url,
            method: row.method,
            auth_required: row.auth_required,
            auth_schemes: [],
            auth: row.auth,
            http: row.http,
            eligibility: { callable: false },
          })),
        },
      };
    return { ok: false, status: 404 };
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    const outgoing = new Request(url, init);
    if (outgoing.url === sourceUrl) {
      sourceCalls.push(outgoing.headers);
      assert.ok(options.source, "No external artifact requests");
      return new Response(options.source);
    }
    const provider = cases.find(
      (row) => outgoing.url === `https://${row.host}${row.path}`,
    );
    assert.ok(provider, "No unmocked provider request");
    calls.push({
      url: outgoing.url,
      method: outgoing.method,
      headers: outgoing.headers,
      bytes: new Uint8Array(await outgoing.arrayBuffer()),
    });
    return options.response ?? Response.json(provider.result);
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
        mockEnv(),
        { readArtifact },
      );
      return (await jsonBody(response)).result;
    });
  }
  return { calls, sourceCalls, readArtifact, invoke, withFetch };
}

describe("BitMind source-reviewed detection execution", () => {
  test("all six actual registry declarations validate and leave probes disabled", () => {
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
    for (const [index, row] of admitted.entries()) {
      const expected = cases[index]!;
      assert.equal(SurfaceSchema.safeParse(row).success, true);
      assert.equal(row.auth_required, true);
      assert.equal(row.probe.enabled, false);
      assert.equal(row.method, "POST");
      assert.deepEqual(row.http.operations, [
        {
          method: "POST",
          path: expected.path,
          request_content_types: expected.media,
          request_body_required: true,
        },
      ]);
      assert.ok(
        row.source_urls.some((url: string) =>
          url.startsWith("https://docs.bitmind.ai/api-reference/"),
        ),
      );
    }
  });
  for (const provider of cases) {
    test(`${provider.id} forwards documented JSON fields and preserves its native result`, async () => {
      const fixture = setup();
      const credential = provider.host.startsWith("enterprise.")
        ? "Bearer fixture-enterprise-key"
        : "Bearer fixture-standard-key";
      const result = await fixture.invoke({
        surface_id: provider.id,
        path: provider.path,
        method: "POST",
        credential,
        json_body: provider.json,
      });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.body, provider.result);
      assert.equal(fixture.calls.length, 1);
      assert.equal(
        fixture.calls[0]!.url,
        `https://${provider.host}${provider.path}`,
      );
      assert.equal(fixture.calls[0]!.method, "POST");
      assert.equal(
        Buffer.from(fixture.calls[0]!.bytes).toString(),
        JSON.stringify(provider.json),
      );
      assert.equal(fixture.calls[0]!.headers.get("authorization"), credential);
      assert.equal(
        fixture.calls[0]!.headers.get("content-type"),
        "application/json",
      );
      assert.equal(JSON.stringify(result).includes(credential), false);
      assert.equal(fixture.sourceCalls.length, 0);
    });
    test(`${provider.id} requires a credential and an admitted write before traffic`, async () => {
      const fixture = setup();
      const args = {
        surface_id: provider.id,
        path: provider.path,
        method: "POST",
        json_body: provider.json,
      };
      for (const [changes, tool] of [
        [{}, "write_subnet_surface"],
        [{ credential: "Bearer fixture-key" }, "call_subnet_surface"],
        [
          {
            credential: "Bearer fixture-key",
            method: "GET",
            json_body: undefined,
          },
          "call_subnet_surface",
        ],
        [
          { credential: "Bearer fixture-key", path: "/not-admitted" },
          "write_subnet_surface",
        ],
        [
          { credential: "Bearer fixture-key", json_body: undefined },
          "write_subnet_surface",
        ],
      ] as const)
        assert.equal(
          (await fixture.invoke({ ...args, ...changes }, tool)).isError,
          true,
        );
      assert.equal(fixture.calls.length, 0);
      assert.equal(fixture.sourceCalls.length, 0);
    });
    if (provider.media.some((media) => media === "multipart/form-data")) {
      for (const representation of ["body_base64", "body_artifact"] as const) {
        test(`${provider.id} preserves exact multipart ${representation} bytes and source isolation`, async () => {
          const field =
            provider.path === "/v1/detect"
              ? "file"
              : provider.path.includes("image")
                ? "image"
                : "video";
          const bytes = multipart(field);
          const fixture = setup({ source: bytes });
          const body =
            representation === "body_base64"
              ? { body_base64: bytes.toString("base64") }
              : {
                  body_artifact: {
                    url: sourceUrl,
                    bytes: bytes.length,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                  },
                };
          const result = await fixture.invoke({
            surface_id: provider.id,
            path: provider.path,
            method: "POST",
            credential: "Bearer fixture-private-key",
            content_type: contentType,
            ...body,
          });
          assert.equal(result.isError, false);
          assert.deepEqual(result.structuredContent.body, provider.result);
          assert.equal(fixture.calls.length, 1);
          assert.deepEqual(Buffer.from(fixture.calls[0]!.bytes), bytes);
          assert.equal(
            fixture.calls[0]!.headers.get("content-type"),
            contentType,
          );
          assert.equal(
            fixture.calls[0]!.headers.get("authorization"),
            "Bearer fixture-private-key",
          );
          assert.equal(
            fixture.sourceCalls.length,
            representation === "body_artifact" ? 1 : 0,
          );
          for (const headers of fixture.sourceCalls)
            assert.equal(headers.has("authorization"), false);
        });
      }
    }
  }
  test("the unified front door forwards implicit plain text and explicit text JSON without rewriting it", async () => {
    const fixture = setup();
    const text =
      "An original fixture passage with unicode 雪 and enough characters to exercise the declared text route. ".repeat(
        3,
      );
    for (const body of [
      { body: text, content_type: "text/plain" },
      {
        json_body: {
          media: text,
          type: "text",
          debug: false,
          postContext: { platform: "fixture" },
        },
      },
    ]) {
      const result = await fixture.invoke({
        surface_id: cases[0].id,
        path: cases[0].path,
        method: "POST",
        credential: "Bearer fixture-key",
        ...body,
      });
      assert.equal(result.isError, false);
    }
    assert.equal(Buffer.from(fixture.calls[0]!.bytes).toString(), text);
    assert.equal(fixture.calls[0]!.headers.get("content-type"), "text/plain");
    assert.equal(
      Buffer.from(fixture.calls[1]!.bytes).toString(),
      JSON.stringify({
        media: text,
        type: "text",
        debug: false,
        postContext: { platform: "fixture" },
      }),
    );
    assert.equal(fixture.calls.length, 2);
  });
  for (const status of [400, 401, 403, 415, 429])
    test(`provider ${status} is preserved without replay`, async () => {
      const body = { detail: `fixture-provider-${status}` };
      const fixture = setup({ response: Response.json(body, { status }) });
      const result = await fixture.invoke({
        surface_id: cases[5].id,
        path: cases[5].path,
        method: "POST",
        credential: "Bearer fixture-key",
        json_body: cases[5].json,
      });
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.status_code, status);
      assert.deepEqual(result.structuredContent.body, body);
      assert.equal(fixture.calls.length, 1);
    });
  test("invalid media and unreviewed older operations remain denied before provider traffic", async () => {
    const fixture = setup();
    for (const args of [
      {
        surface_id: cases[3].id,
        path: cases[3].path,
        method: "POST",
        body_base64: png.toString("base64"),
        content_type: "multipart/form-data; boundary=fixture",
      },
      {
        surface_id: "sn-34-bitmind-get-video-upload-url",
        path: "/get-video-upload-url",
        method: "POST",
        json_body: {},
      },
    ])
      assert.equal(
        (await fixture.invoke({ credential: "Bearer fixture-key", ...args }))
          .isError,
        true,
      );
    assert.equal(fixture.calls.length, 0);
  });
  test("stored standard and enterprise keys stay isolated by account and surface", async () => {
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
    const standard = {
      surface_id: cases[1].id,
      path: cases[1].path,
      method: "POST",
      json_body: cases[1].json,
    };
    const enterprise = {
      surface_id: cases[4].id,
      path: cases[4].path,
      method: "POST",
      json_body: cases[4].json,
    };
    await store.handler(
      {
        surface_id: standard.surface_id,
        credential: "Bearer fixture-standard-stored",
      },
      ctx,
    );
    await fixture.withFetch(async () => {
      await write.handler(standard, ctx);
      await assert.rejects(
        write.handler(enterprise, ctx),
        (error: Row) => error.code === "auth_required",
      );
      await assert.rejects(
        write.handler(standard, { ...ctx, accountId: "8" }),
        (error: Row) => error.code === "auth_required",
      );
      assert.equal(fixture.calls.length, 1);
      await store.handler(
        {
          surface_id: enterprise.surface_id,
          credential: "Bearer fixture-enterprise-stored",
        },
        ctx,
      );
      await write.handler(enterprise, ctx);
      await write.handler(
        { ...enterprise, credential: "Bearer fixture-explicit" },
        ctx,
      );
    });
    assert.deepEqual(
      fixture.calls.map((call) => call.headers.get("authorization")),
      [
        "Bearer fixture-standard-stored",
        "Bearer fixture-enterprise-stored",
        "Bearer fixture-explicit",
      ],
    );
    assert.equal(fixture.calls[0]!.url, "https://api.bitmind.ai/detect-image");
    assert.equal(fixture.calls[1]!.url, "https://enterprise.bitmind.ai/image");
  });
  test("the integration guide publishes all six exact media contracts without provider/schema reads", async () => {
    const fixture = setup();
    const result = await fixture.invoke({ netuid: 34 }, "how_do_i_call");
    assert.equal(result.isError, false);
    const guide = HowDoICallOutputSchema.parse(result.structuredContent);
    assert.equal(guide.services.length, 6);
    assert.deepEqual(
      guide.services.map((service) => service.auth.detail),
      admitted.map((row) => row.auth),
    );
    assert.deepEqual(
      guide.services.map((service) => service.http),
      admitted.map((row) => row.http),
    );
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.sourceCalls.length, 0);
    console.log(
      "BITMIND_DOCUMENTED_HTTP_FIXTURE",
      JSON.stringify({
        documented_operations: 6,
        admitted_operations: 6,
        guide_provider_requests: 0,
        production_requests: 0,
        live_availability_qualified: false,
      }),
    );
  });
});
