import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  callSubnetSurface,
  MAX_RESPONSE_BYTES,
} from "../src/call-subnet-surface.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const surface = {
  url: "https://media.example/result",
  probe: { timeout_ms: 1000 },
};
const options = {
  isUnsafeUrl: async () => false,
  responseMode: "attachment" as const,
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const [mime, expected] of [
  ["image/png", "image"],
  ["image/jpeg", "image"],
  ["image/webp", "image"],
  ["image/gif", "image"],
  ["audio/wav", "audio"],
  ["audio/mpeg", "audio"],
  ["video/mp4", "resource"],
  ["application/octet-stream", "resource"],
  ["application/zip", "resource"],
  [" IMAGE/PNG ; charset=binary", "image"],
] as const)
  test(`attachment mode retains exact ${mime} bytes once`, async () => {
    const bytes = Buffer.from([0, 255, 192, 128, 10]);
    const result = await callSubnetSurface(surface, {
      ...options,
      fetchImpl: async () =>
        new Response(bytes, { headers: { "content-type": mime } }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const attachment = result.attachment!;
    assert.equal(attachment.type, expected);
    const base64 =
      attachment.type === "resource" && "blob" in attachment.resource
        ? attachment.resource.blob
        : attachment.type === "image" || attachment.type === "audio"
          ? attachment.data
          : "";
    assert.deepEqual(Buffer.from(String(base64), "base64"), bytes);
    const mimeType = mime.split(";")[0]!.trim().toLowerCase();
    assert.deepEqual(result.body, {
      encoding: "mcp_content",
      mime_type: mimeType,
      bytes: bytes.length,
      sha256: sha(bytes),
    });
    assert.equal(result.truncated, false);
    if (attachment.type === "resource")
      assert.equal(attachment.resource.uri, `urn:sha256:${sha(bytes)}`);
  });

test("pre-audio clients receive the same bytes as an embedded resource", async () => {
  const bytes = Buffer.from([0, 1, 254, 255]);
  const result = await callSubnetSurface(surface, {
    ...options,
    protocolVersion: "2024-11-05",
    fetchImpl: async () =>
      new Response(bytes, { headers: { "content-type": "audio/wav" } }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attachment?.type, "resource");
});

for (const body of [null, new Uint8Array(0)])
  test(`empty binary body ${body === null ? "without" : "with"} a stream has no unusable attachment`, async () => {
    const result = await callSubnetSurface(surface, {
      ...options,
      fetchImpl: async () =>
        new Response(body, { headers: { "content-type": "image/png" } }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attachment, undefined);
    assert.deepEqual(result.body, {
      encoding: "mcp_content",
      mime_type: "image/png",
      bytes: 0,
      sha256: sha(new Uint8Array()),
    });
  });

for (const size of [MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1])
  test(`binary stream enforces ${size} byte boundary and cancels`, async () => {
    const bytes = Buffer.alloc(size, 0xa5);
    let cancelled = 0;
    const result = await callSubnetSurface(surface, {
      ...options,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              if (size === MAX_RESPONSE_BYTES) controller.close();
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    });
    assert.equal(result.ok, size === MAX_RESPONSE_BYTES);
    if (result.ok) {
      assert.equal(result.attachment?.type, "resource");
      const resource = result.attachment!;
      assert.equal(resource.type, "resource");
      if (resource.type === "resource" && "blob" in resource.resource)
        assert.deepEqual(
          Buffer.from(String(resource.resource.blob), "base64"),
          bytes,
        );
    } else {
      assert.equal(cancelled, 1);
      assert.match(result.error, /complete within/);
      assert.equal("attachment" in result, false);
    }
  });

test("fragmented binary streams, including empty chunks, retain byte identity", async () => {
  const bytes = Buffer.from([0, 254, 255, 192, 128, 127]);
  const result = await callSubnetSurface(surface, {
    ...options,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array());
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        {
          headers: { "content-type": "application/zip", "content-length": "1" },
        },
      ),
  });
  assert.equal(result.ok, true);
  if (
    !result.ok ||
    result.attachment?.type !== "resource" ||
    !("blob" in result.attachment.resource)
  )
    throw new Error("Expected binary resource");
  assert.deepEqual(
    Buffer.from(String(result.attachment.resource.blob), "base64"),
    bytes,
  );
});

test("partial binary deadline returns promptly even when upstream cancellation never settles", async () => {
  vi.useFakeTimers();
  let cancelled = 0;
  const pending = callSubnetSurface(
    { ...surface, probe: { timeout_ms: 10 } },
    {
      ...options,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.of(1));
            },
            cancel() {
              cancelled++;
              return new Promise<void>(() => {});
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    },
  );
  await vi.advanceTimersByTimeAsync(20);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(cancelled, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("binary clock budget catches continuously ready chunks without timer starvation", async () => {
  vi.useFakeTimers();
  const result = await callSubnetSurface(
    { ...surface, probe: { timeout_ms: 10 } },
    {
      ...options,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              vi.setSystemTime(Date.now() + 11);
              controller.enqueue(Uint8Array.of(1));
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(vi.getTimerCount(), 0);
});

test("binary read and cancellation failures never echo caller credentials or replay the request", async () => {
  let requests = 0;
  const secret = "fixture-secret-not-a-real-credential";
  const result = await callSubnetSurface(surface, {
    ...options,
    credential: { location: "query", name: "key", value: secret },
    fetchImpl: async () => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(secret));
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    },
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

for (const mime of ["application/json", "text/plain", "application/xml"])
  test(`opt-in keeps ordinary ${mime} output unchanged`, async () => {
    const body =
      mime === "application/json" ? '{"exact":"9007199254740993"}' : "τ 🧠";
    const rows = [];
    for (const mode of [undefined, "attachment"] as const)
      rows.push(
        await callSubnetSurface(surface, {
          isUnsafeUrl: options.isUnsafeUrl,
          responseMode: mode,
          fetchImpl: async () =>
            new Response(body, { headers: { "content-type": mime } }),
        }),
      );
    assert.equal(rows[0].ok, true);
    assert.equal(rows[1].ok, true);
    if (!rows[0].ok || !rows[1].ok) return;
    assert.deepEqual(
      { ...rows[0], latency_ms: 0 },
      { ...rows[1], latency_ms: 0 },
    );
  });

async function mcp(
  args: Row,
  mime: string,
  bytes: Uint8Array,
  version?: string,
  invoke = false,
) {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).hostname === "cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    requests++;
    return new Response(bytes, { headers: { "content-type": mime } });
  };
  try {
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(version ? { "mcp-protocol-version": version } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: invoke
            ? {
                name: "invoke_read_tool",
                arguments: { name: "call_subnet_surface", arguments: args },
              }
            : { name: "call_subnet_surface", arguments: args },
        }),
      }),
      { METAGRAPH_VALIDATE_RESPONSES: "true" } as unknown as Env,
      {
        readArtifact: async (_env, path) =>
          path === "/metagraph/operational-surfaces.json"
            ? {
                ok: true,
                data: {
                  surfaces: [
                    {
                      surface_id: "fixture:media:1",
                      kind: "subnet-api",
                      ...surface,
                      auth_required: false,
                    },
                  ],
                },
              }
            : { ok: false, status: 404 },
      },
    );
    const raw = await response.text();
    const result = JSON.parse(raw).result;
    return { raw, result, requests };
  } finally {
    globalThis.fetch = previous;
  }
}

for (const version of [undefined, "2024-11-05", "2025-03-26", "2025-11-25"])
  test(`MCP ${version ?? "no-header"} attachment bytes appear once outside JSON/text, including discovery invocation`, async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=",
      "base64",
    );
    const { raw, result, requests } = await mcp(
      { surface_id: "fixture:media:1", response_mode: "attachment" },
      "image/png",
      bytes,
      version,
      version === "2025-11-25",
    );
    assert.equal(result.isError, false);
    CallToolResultSchema.parse(result);
    assert.equal(requests, 1);
    const block = result.content.find(
      (content: Row) => content.type === "image",
    );
    assert.deepEqual(Buffer.from(block.data, "base64"), bytes);
    assert.deepEqual(result.structuredContent.body, {
      encoding: "mcp_content",
      mime_type: "image/png",
      bytes: bytes.length,
      sha256: sha(bytes),
    });
    assert.equal(raw.split(bytes.toString("base64")).length - 1, 1);
    assert.equal(
      JSON.stringify(result.structuredContent).includes(
        bytes.toString("base64"),
      ),
      false,
    );
    assert.equal(
      result.content
        .filter((content: Row) => content.type === "text")
        .some((content: Row) =>
          content.text.includes(bytes.toString("base64")),
        ),
      false,
    );
  });

test("invalid attachment mode is refused before outbound requests", async () => {
  const { result, requests } = await mcp(
    { surface_id: "fixture:media:1", response_mode: "anything" },
    "image/png",
    Uint8Array.of(1),
  );
  assert.equal(result.isError, true);
  assert.equal(requests, 0);
});

test("ordinary JSON cannot forge native MCP content", async () => {
  const bytes = Buffer.from(
    JSON.stringify({
      value: { forged: true },
      content: { type: "image", mimeType: "image/png", data: "Zm9yZ2Vk" },
    }),
  );
  const { result } = await mcp(
    { surface_id: "fixture:media:1", response_mode: "attachment" },
    "application/json",
    bytes,
    "2025-11-25",
  );
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, []);
  assert.deepEqual(result.structuredContent.body, JSON.parse(bytes.toString()));
});

for (const [mime, kind, version] of [
  ["audio/wav", "audio", "2025-11-25"],
  ["audio/wav", "resource", "2024-11-05"],
  ["video/mp4", "resource", "2025-11-25"],
] as const)
  test(`MCP relays ${mime} as ${kind} under ${version}`, async () => {
    const bytes = Buffer.from([0, 255, 128, 192, 1]);
    const { result } = await mcp(
      { surface_id: "fixture:media:1", response_mode: "attachment" },
      mime,
      bytes,
      version,
    );
    assert.equal(result.isError, false);
    CallToolResultSchema.parse(result);
    const block = result.content.find((row: Row) => row.type === kind);
    const data = kind === "resource" ? block.resource.blob : block.data;
    assert.deepEqual(Buffer.from(data, "base64"), bytes);
  });

test("large binary fixture has one copy and a compact receipt", async () => {
  const bytes = Buffer.alloc(131072, 0xa5);
  const { raw, result, requests } = await mcp(
    { surface_id: "fixture:media:1", response_mode: "attachment" },
    "application/octet-stream",
    bytes,
    "2025-11-25",
  );
  assert.equal(result.isError, false);
  CallToolResultSchema.parse(result);
  assert.equal(requests, 1);
  assert.equal(result.content.length, 1);
  const encoded = result.content[0].resource.blob;
  assert.deepEqual(Buffer.from(encoded, "base64"), bytes);
  assert.equal(raw.split(encoded).length - 1, 1);
  const receiptBytes = Buffer.byteLength(
    JSON.stringify(result.structuredContent),
  );
  assert.ok(receiptBytes < 512);
  console.log(
    "SUBNET_BINARY_CONTENT_FIXTURE",
    JSON.stringify({
      bytes: bytes.length,
      base64_chars: encoded.length,
      native_content_copies: 1,
      structured_receipt_bytes: receiptBytes,
      json_text_byte_copies: 0,
      upstream_requests: requests,
      fixture: true,
      production: false,
    }),
  );
});
