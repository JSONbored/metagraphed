import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, test } from "vitest";
import {
  fetchSubnetBodyArtifact,
  type SubnetBodyArtifact,
} from "../src/subnet-body-artifact.ts";
import { MAX_SUBNET_BODY_ARTIFACT_BYTES } from "../src/subnet-body-artifact-policy.ts";
import { publicCommitArtifactUrl } from "../src/public-commit-artifact.ts";
import { callSubnetSurface } from "../src/call-subnet-surface.ts";
import {
  handleMcpRequest,
  MCP_TOOLS,
  MAX_MCP_BODY_BYTES,
} from "../src/mcp-server.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const url = `https://raw.githubusercontent.com/example/uploads/${"a".repeat(40)}/payload.bin`;
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const reference = (data: Uint8Array): SubnetBodyArtifact => ({
  url,
  bytes: data.byteLength,
  sha256: hash(data),
});
const signal = () => new AbortController().signal;
const safe = async () => false;
const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
const base = { surface_id: "fixture:api:1", path: "/upload", method: "POST" };
const content_type = 'multipart/form-data; boundary="fixture"';

async function read(
  artifact: SubnetBodyArtifact,
  response: Response,
  options: { signal?: AbortSignal; unsafe?: boolean } = {},
) {
  return fetchSubnetBodyArtifact(artifact, {
    signal: options.signal ?? signal(),
    isUnsafeUrl: async () => options.unsafe ?? false,
    fetchImpl: async () => response,
  });
}

describe("public request body source identity", () => {
  test("uses the same immutable origin policy as native code references", () => {
    assert.equal(publicCommitArtifactUrl(url, "invalid"), url);
    for (const bad of [
      url.replace("https:", "http:"),
      url.replace("raw.githubusercontent.com", "localhost"),
      url.replace(
        "raw.githubusercontent.com",
        "raw.githubusercontent.com.attacker.example",
      ),
      url.replace("https://", "https://user@"),
      url.replace("https://", "https://user:pass@"),
      url.replace(".com/", ".com:444/"),
      `${url}?token=secret`,
      `${url}#fragment`,
      url.replace("a".repeat(40), "main"),
      url.replace("payload.bin", "payload%20file.bin"),
      url.replace("/example/", "/invalid.owner/"),
    ])
      assert.throws(
        () => publicCommitArtifactUrl(bad, "invalid"),
        /^Error: invalid$/,
      );
    assert.throws(
      () => publicCommitArtifactUrl("not a url", "invalid"),
      TypeError,
    );
  });
  test("publishes strict artifact fields, limits, exclusivity and write-only support", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const write = ajv.compile(
      MCP_TOOLS.find((t) => t.name === "write_subnet_surface")!.inputSchema,
    );
    const readTool = ajv.compile(
      MCP_TOOLS.find((t) => t.name === "call_subnet_surface")!.inputSchema,
    );
    assert.equal(write({ ...base, body_artifact: reference(payload) }), true);
    for (const bytes of [0, MAX_SUBNET_BODY_ARTIFACT_BYTES])
      assert.equal(
        write({ ...base, body_artifact: { ...reference(payload), bytes } }),
        true,
      );
    for (const bytes of [-1, 1.5, MAX_SUBNET_BODY_ARTIFACT_BYTES + 1, "256"])
      assert.equal(
        write({ ...base, body_artifact: { ...reference(payload), bytes } }),
        false,
      );
    for (const change of [
      { sha256: "A".repeat(64) },
      { sha256: "a".repeat(63) },
      { headers: { authorization: "secret" } },
    ])
      assert.equal(
        write({ ...base, body_artifact: { ...reference(payload), ...change } }),
        false,
      );
    for (const body of [
      { body: "" },
      { body: null },
      { json_body: null },
      { body_base64: "" },
    ])
      assert.equal(
        write({ ...base, body_artifact: reference(payload), ...body }),
        false,
      );
    assert.equal(
      readTool({
        surface_id: base.surface_id,
        body_artifact: reference(payload),
      }),
      false,
    );
  });
});

describe("bounded exact artifact reading", () => {
  for (const size of [0, 256, 131_072, MAX_SUBNET_BODY_ARTIFACT_BYTES])
    test(`preserves all ${size} bytes`, async () => {
      const bytes = new Uint8Array(size).fill(0xa5);
      assert.deepEqual(
        await read(
          reference(bytes),
          new Response(bytes, { headers: { "content-length": String(size) } }),
        ),
        bytes,
      );
    });
  test("accepts absent and compressed wire lengths but checks decoded integrity", async () => {
    assert.deepEqual(
      await read(reference(payload), new Response(payload)),
      payload,
    );
    assert.deepEqual(
      await read(
        reference(payload),
        new Response(payload, {
          headers: { "content-encoding": "gzip", "content-length": "20" },
        }),
      ),
      payload,
    );
    assert.deepEqual(
      await read(
        reference(payload),
        new Response(payload, {
          headers: { "content-encoding": "identity", "content-length": "256" },
        }),
      ),
      payload,
    );
  });
  for (const change of [
    { bytes: -1 },
    { bytes: 1.5 },
    { bytes: MAX_SUBNET_BODY_ARTIFACT_BYTES + 1 },
    { sha256: "bad" },
  ])
    test(`rejects invalid reference ${JSON.stringify(change)}`, async () => {
      let fetched = false;
      await assert.rejects(
        fetchSubnetBodyArtifact(
          { ...reference(payload), ...change },
          {
            signal: signal(),
            isUnsafeUrl: safe,
            fetchImpl: async () => {
              fetched = true;
              return new Response(payload);
            },
          },
        ),
        /Invalid request body artifact/,
      );
      assert.equal(fetched, false);
    });
  test("rejects an unsafe resolved source without fetching it", async () => {
    let fetched = false;
    await assert.rejects(
      fetchSubnetBodyArtifact(reference(payload), {
        signal: signal(),
        isUnsafeUrl: async () => true,
        fetchImpl: async () => {
          fetched = true;
          return new Response(payload);
        },
      }),
      /URL is unsafe/,
    );
    assert.equal(fetched, false);
  });
  for (const status of [302, 404])
    test(`does not follow or accept source status ${status}`, async () => {
      let canceled = false;
      const stream = new ReadableStream({
        cancel() {
          canceled = true;
        },
      });
      await assert.rejects(
        read(
          reference(payload),
          new Response(stream, {
            status,
            headers: { location: "https://private.example/" },
          }),
        ),
        /response failed/,
      );
      assert.equal(canceled, true);
    });
  for (const length of [
    "bad",
    "257",
    "255",
    String(MAX_SUBNET_BODY_ARTIFACT_BYTES + 1),
  ])
    test(`rejects declared length ${length}`, async () => {
      await assert.rejects(
        read(
          reference(payload),
          new Response(payload, { headers: { "content-length": length } }),
        ),
        /declared length mismatch/,
      );
    });
  test("checks compressed wire bounds independently", async () => {
    await assert.rejects(
      read(
        reference(payload),
        new Response(payload, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(MAX_SUBNET_BODY_ARTIFACT_BYTES + 1),
          },
        }),
      ),
      /declared length mismatch/,
    );
  });
  test("rejects absent, short, oversized and mismatched content", async () => {
    await assert.rejects(
      read(reference(payload), new Response(null)),
      /body is absent/,
    );
    await assert.rejects(
      read(reference(payload), new Response(payload.subarray(0, 255))),
      /length mismatch/,
    );
    await assert.rejects(
      read(reference(payload), new Response(new Uint8Array(257))),
      /stream budget/,
    );
    await assert.rejects(
      read(reference(payload), new Response(new Uint8Array(256))),
      /checksum mismatch/,
    );
  });
  test("bounds empty chunks and yields while reading ready streams", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array());
      },
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      read(reference(new Uint8Array()), new Response(stream)),
      /stream budget/,
    );
    assert.equal(canceled, true);
  }, 20_000);
  test("redacts source transport and stream exception text", async () => {
    await assert.rejects(
      fetchSubnetBodyArtifact(reference(payload), {
        signal: signal(),
        isUnsafeUrl: safe,
        fetchImpl: async () => {
          throw new Error(`private detail ${url}`);
        },
      }),
      /^Error: Request body artifact could not be read$/,
    );
    const stream = new ReadableStream({
      start(c) {
        c.error(new Error(`private detail ${url}`));
      },
    });
    await assert.rejects(
      read(reference(payload), new Response(stream)),
      /^Error: Request body artifact could not be read$/,
    );
  });
  test("abort wins over a transport that ignores its signal", async () => {
    const controller = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const pending = fetchSubnetBodyArtifact(reference(payload), {
      signal: controller.signal,
      isUnsafeUrl: safe,
      fetchImpl: async () => {
        reached();
        return new Promise<Response>(() => {});
      },
    });
    await started;
    controller.abort();
    await assert.rejects(pending, /timed out/);
  });
  test("cancels a response that arrives after its transport deadline", async () => {
    const controller = new AbortController();
    let deliver!: (response: Response) => void;
    let reached!: () => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const pending = fetchSubnetBodyArtifact(reference(payload), {
      signal: controller.signal,
      isUnsafeUrl: safe,
      fetchImpl: () => {
        reached();
        return new Promise<Response>((r) => {
          deliver = r;
        });
      },
    });
    await started;
    controller.abort();
    await assert.rejects(pending, /timed out/);
    let canceled = false;
    deliver(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    assert.equal(canceled, true);
  });
  test("abort wins over stalled DNS and an already aborted invocation", async () => {
    const controller = new AbortController();
    const pending = fetchSubnetBodyArtifact(reference(payload), {
      signal: controller.signal,
      isUnsafeUrl: () => new Promise<boolean>(() => {}),
      fetchImpl: async () => {
        throw new Error("fetch forbidden");
      },
    });
    controller.abort();
    await assert.rejects(pending, /timed out/);
    await assert.rejects(
      fetchSubnetBodyArtifact(reference(payload), {
        signal: controller.signal,
        isUnsafeUrl: safe,
        fetchImpl: async () => {
          throw new Error("fetch forbidden");
        },
      }),
      /timed out/,
    );
  });
  test("a stalled read and stalled cancellation cannot extend the deadline", async () => {
    const controller = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const response = new Response(
      new ReadableStream({
        pull() {
          reached();
          return new Promise<void>(() => {});
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      }),
    );
    const pending = read(reference(payload), response, {
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(pending, /timed out/);
  });
});

async function invoke(
  args: Row,
  bytes = payload,
  tool = "write_subnet_surface",
  settings: {
    failSource?: boolean;
    unsafeTarget?: boolean;
    bodyAuth?: boolean;
  } = {},
) {
  const original = globalThis.fetch;
  const sourceCalls: RequestInit[] = [],
    targetCalls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const outgoing = String(input);
    const host = new URL(outgoing).hostname;
    if (host === "cloudflare-dns.com")
      return Response.json({
        Answer: [
          {
            type: 1,
            data:
              settings.unsafeTarget && outgoing.includes("subnet.example")
                ? "127.0.0.1"
                : "18.160.0.1",
          },
        ],
      });
    if (outgoing === url) {
      sourceCalls.push(init!);
      return settings.failSource
        ? new Response(null, { status: 404 })
        : new Response(bytes);
    }
    assert.equal(host, "subnet.example", "No actual source/provider requests");
    targetCalls.push({ url: outgoing, init: init! });
    return Response.json({ accepted: true });
  };
  try {
    const surface = {
      surface_id: base.surface_id,
      netuid: 34,
      kind: "subnet-api",
      url: "https://subnet.example/",
      public_safe: true,
      auth_required: true,
      auth: settings.bodyAuth
        ? {
            scheme: "signature",
            location: "body",
            names: ["identity", "signature"],
          }
        : { scheme: "bearer", location: "header", name: "Authorization" },
      probe: { enabled: false, method: "GET" },
      http: {
        operations: [
          {
            method: "POST",
            path: "/upload",
            request_content_types: ["multipart/form-data", "application/json"],
            request_body_required: true,
          },
        ],
      },
    };
    const response = await handleMcpRequest(
      new Request("https://metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      }),
      mockEnv(),
      {
        readArtifact: async (_env: Row, path: string) =>
          path === "/metagraph/operational-surfaces.json"
            ? { ok: true, data: { surfaces: [surface] } }
            : { ok: false, status: 404 },
      },
    );
    return {
      response,
      envelope: await jsonBody(response),
      sourceCalls,
      targetCalls,
    };
  } finally {
    globalThis.fetch = original;
  }
}

describe("public admitted write path", () => {
  test("verifies multipart bytes before one authenticated provider write and excludes source credentials", async () => {
    const bytes = Buffer.concat([
      Buffer.from(
        '--fixture\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\n\r\n',
      ),
      payload,
      Buffer.from("\r\n--fixture--\r\n"),
    ]);
    const result = await invoke(
      {
        ...base,
        content_type,
        body_artifact: reference(bytes),
        credential: "Bearer fixture-secret",
      },
      bytes,
    );
    assert.equal(result.envelope.result.isError, false);
    assert.equal(result.sourceCalls.length, 1);
    assert.deepEqual(result.sourceCalls[0]!.headers, {
      accept: "application/octet-stream",
    });
    assert.equal(result.sourceCalls[0]!.redirect, "manual");
    assert.equal(result.targetCalls.length, 1);
    assert.deepEqual(result.targetCalls[0]!.init.body, new Uint8Array(bytes));
    const headers = new Headers(result.targetCalls[0]!.init.headers);
    assert.equal(headers.get("content-type"), content_type);
    assert.equal(headers.get("authorization"), "Bearer fixture-secret");
    assert.ok(!JSON.stringify(result.envelope).includes("fixture-secret"));
    assert.ok(!JSON.stringify(result.envelope).includes(url));
  });
  test("a compact reference executes a file larger than the unchanged inline limit", async () => {
    const bytes = Buffer.concat([
      Buffer.from(
        '--fixture\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\n\r\n',
      ),
      new Uint8Array(131_072).fill(0xa5),
      Buffer.from("\r\n--fixture--\r\n"),
    ]);
    const artifactArgs = {
      ...base,
      content_type,
      body_artifact: reference(bytes),
      credential: "Bearer fixture-secret",
    };
    const actual = await invoke(artifactArgs, bytes);
    assert.equal(actual.envelope.result.isError, false);
    assert.deepEqual(
      Buffer.from(actual.targetCalls[0]!.init.body as Uint8Array),
      Buffer.from(bytes),
    );
    const inline = {
      ...base,
      content_type,
      body_base64: Buffer.from(bytes).toString("base64"),
      credential: "Bearer fixture-secret",
    };
    assert.ok(JSON.stringify(inline).length > MAX_MCP_BODY_BYTES);
    const refused = await invoke(inline, bytes);
    assert.equal(refused.response.status, 413);
    assert.equal(refused.sourceCalls.length + refused.targetCalls.length, 0);
    console.log(
      "SUBNET_BODY_ARTIFACT_FIXTURE " +
        JSON.stringify({
          payload_bytes: bytes.length,
          inline_argument_json_bytes: Buffer.byteLength(JSON.stringify(inline)),
          reference_argument_json_bytes: Buffer.byteLength(
            JSON.stringify(artifactArgs),
          ),
          source_requests: actual.sourceCalls.length,
          provider_requests: actual.targetCalls.length,
          production_requests: 0,
        }),
    );
  });
  test("small inline and referenced forms send exactly the same bytes", async () => {
    const common = {
      ...base,
      content_type,
      credential: "Bearer fixture-secret",
    };
    const inline = await invoke({
      ...common,
      body_base64: Buffer.from(payload).toString("base64"),
    });
    const artifact = await invoke({
      ...common,
      body_artifact: reference(payload),
    });
    assert.equal(artifact.targetCalls[0]!.url, inline.targetCalls[0]!.url);
    assert.equal(
      artifact.targetCalls[0]!.init.method,
      inline.targetCalls[0]!.init.method,
    );
    assert.deepEqual(
      artifact.targetCalls[0]!.init.headers,
      inline.targetCalls[0]!.init.headers,
    );
    assert.deepEqual(
      Buffer.from(artifact.targetCalls[0]!.init.body as Uint8Array),
      Buffer.from(inline.targetCalls[0]!.init.body as Uint8Array),
    );
    assert.deepEqual(
      artifact.envelope.result.structuredContent.body,
      inline.envelope.result.structuredContent.body,
    );
  });
  test("raw referenced JSON retains negative zero and overflow encoding", async () => {
    for (const text of ["-0", "1e400"]) {
      const bytes = Buffer.from(text);
      const actual = await invoke(
        {
          ...base,
          content_type: "application/json",
          body_artifact: reference(bytes),
          credential: "Bearer fixture-secret",
        },
        bytes,
      );
      assert.equal(actual.envelope.result.isError, false);
      assert.deepEqual(actual.targetCalls[0]!.init.body, new Uint8Array(bytes));
    }
  });
  for (const change of [
    { credential: undefined },
    { surface_id: "fixture:api:missing" },
    { path: "/undeclared" },
    { method: "DELETE" },
    { content_type: "image/png" },
    { body: null },
    { body: "" },
    { json_body: null },
    { body_base64: "" },
    { body_artifact: { url, bytes: -1, sha256: "a".repeat(64) } },
    { body_artifact: { url, bytes: 1, sha256: "bad" } },
  ])
    test(`rejects before source/provider traffic: ${JSON.stringify(change)}`, async () => {
      const result = await invoke({
        ...base,
        content_type,
        body_artifact: reference(payload),
        credential: "Bearer fixture-secret",
        ...change,
      });
      assert.ok(result.envelope.error || result.envelope.result.isError);
      assert.equal(result.sourceCalls.length + result.targetCalls.length, 0);
    });
  test("read permission and unsafe targets do not fetch a source", async () => {
    const args = {
      ...base,
      content_type,
      body_artifact: reference(payload),
      credential: "Bearer fixture-secret",
    };
    const wrongTool = await invoke(args, payload, "call_subnet_surface");
    const unsafe = await invoke(args, payload, "write_subnet_surface", {
      unsafeTarget: true,
    });
    for (const result of [wrongTool, unsafe]) {
      assert.ok(result.envelope.error || result.envelope.result.isError);
      assert.equal(result.sourceCalls.length + result.targetCalls.length, 0);
    }
  });
  test("source failure and checksum mismatch cannot issue a provider write", async () => {
    const args = {
      ...base,
      content_type,
      body_artifact: reference(payload),
      credential: "Bearer fixture-secret",
    };
    const missing = await invoke(args, payload, "write_subnet_surface", {
      failSource: true,
    });
    const mismatch = await invoke(args, new Uint8Array(256));
    for (const result of [missing, mismatch]) {
      assert.equal(result.envelope.result.isError, true);
      assert.equal(result.sourceCalls.length, 1);
      assert.equal(result.targetCalls.length, 0);
    }
  });
  test("JSON body credentials cannot reshape an artifact before source traffic", async () => {
    const actual = await invoke(
      {
        ...base,
        content_type,
        body_artifact: reference(payload),
        credential: {
          identity: "fixture-identity",
          signature: "fixture-signature",
        },
      },
      payload,
      "write_subnet_surface",
      { bodyAuth: true },
    );
    assert.equal(actual.envelope.result.isError, true);
    assert.equal(actual.sourceCalls.length + actual.targetCalls.length, 0);
  });
  test("redirects reuse one resolved byte view and retain credential stripping", async () => {
    let resolved = 0;
    const calls: RequestInit[] = [];
    const result = await callSubnetSurface(
      { url: "https://subnet.example/" },
      {
        path: "/upload",
        method: "POST",
        contentType: content_type,
        body: async () => {
          resolved++;
          return payload;
        },
        credential: {
          location: "header",
          name: "Authorization",
          value: "Bearer fixture-secret",
        },
        isUnsafeUrl: safe,
        fetchImpl: async (_url, init) => {
          calls.push(init!);
          return calls.length === 1
            ? new Response(null, {
                status: 307,
                headers: { location: "https://other.example/upload" },
              })
            : Response.json({ accepted: true });
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(resolved, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body, payload);
    assert.equal(calls[1]!.body, payload);
    assert.equal(
      new Headers(calls[0]!.headers).get("authorization"),
      "Bearer fixture-secret",
    );
    assert.equal(new Headers(calls[1]!.headers).get("authorization"), null);
  });
  test("body credentials and read verbs cannot resolve deferred bytes", async () => {
    let resolved = 0;
    const body = async () => {
      resolved++;
      return payload;
    };
    const denied = await callSubnetSurface(
      { url: "https://subnet.example/" },
      {
        path: "/upload",
        method: "POST",
        body,
        credential: { location: "body", name: "token", value: "secret" },
        isUnsafeUrl: safe,
        fetchImpl: async () => {
          throw new Error("forbidden");
        },
      },
    );
    assert.equal(denied.ok, false);
    await callSubnetSurface(
      { url: "https://subnet.example/" },
      {
        path: "/upload",
        method: "GET",
        body,
        isUnsafeUrl: safe,
        fetchImpl: async () => Response.json({ accepted: true }),
      },
    );
    assert.equal(resolved, 0);
  });
});
