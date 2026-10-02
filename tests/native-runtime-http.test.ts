import assert from "node:assert/strict";
import { test, vi, afterEach } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleNativeRuntime } from "../workers/request-handlers/native-runtime.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import {
  NativeRuntimeArtifactSchema,
  NativeRuntimeRequestSchema,
} from "../schemas-src/routes/native-runtime.ts";
import { withNativeRuntimeFixture } from "./fixtures/native-runtime.ts";

afterEach(() => vi.restoreAllMocks());
const operations = [{ kind: "storage", pallet: "System", member: "Number" }];
function request(
  path = "/api/v1/native-runtime",
  body: unknown = { operations },
  method = "POST",
) {
  return new Request(`https://api.metagraph.sh${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.1",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
test("native REST and MCP share bytes, network source and the existing limiter", async () => {
  const keys: string[] = [];
  const env = apiEnv({
    ...createLocalArtifactEnv(),
    RPC_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    },
  });
  await withNativeRuntimeFixture(async () => {
    for (const [path, network] of [
      ["/api/v1/native-runtime", "finney"],
      ["/api/v1/mainnet/native-runtime", "finney"],
      ["/api/v1/testnet/native-runtime", "test"],
      ["/api/v1/mainnet/testnet/native-runtime", "test"],
    ] as const) {
      const rest = await handleRequest(request(path), env, {});
      assert.equal(rest.status, 200);
      const artifact = NativeRuntimeArtifactSchema.parse(
        (await rest.json()).data,
      );
      assert.equal(artifact.source.network, network);
      assert.equal(rest.headers.get("cache-control"), "no-store");
      assert.equal(rest.headers.get("etag"), null);
      const tool = await MCP_TOOLS.find(
        (row) => row.name === "get_native_runtime",
      )!.handler({ network, operations }, { env, clientIp: "192.0.2.1" });
      assert.equal(JSON.stringify(tool), JSON.stringify(artifact));
    }
  });
  assert.equal(keys.length, 8);
  assert.ok(
    keys.slice(0, 4).every((key) => key === "native-runtime:192.0.2.1"),
  );
  assert.ok(
    keys.slice(4).every((key) => key === "testnet:native-runtime:192.0.2.1"),
  );
});
test("REST and MCP validate native requests once and preserve canonical defaults and result bytes", async () => {
  const parse = vi.spyOn(NativeRuntimeRequestSchema, "parse");
  const safe = vi.spyOn(NativeRuntimeRequestSchema, "safeParse");
  const env = apiEnv(createLocalArtifactEnv());
  await withNativeRuntimeFixture(async () => {
    const response = await handleNativeRuntime(request(), env);
    assert.equal(response.status, 200);
    assert.equal(parse.mock.calls.length, 1);
    const rest = NativeRuntimeArtifactSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    parse.mockClear();
    safe.mockClear();
    const tool = await MCP_TOOLS.find(
      (row) => row.name === "get_native_runtime",
    )!.handler({ operations }, { env, clientIp: "192.0.2.1" });
    assert.equal(parse.mock.calls.length, 0);
    assert.equal(safe.mock.calls.length, 1);
    assert.equal(JSON.stringify(tool), JSON.stringify(rest));
    console.log(
      "NATIVE_RUNTIME_VALIDATION_FIXTURE",
      JSON.stringify({
        rest_schema_traversals: 1,
        mcp_schema_traversals: 1,
        redundant_traversals_removed_per_request: 1,
        fixture: true,
        production: false,
      }),
    );
  });
});
test("native preflight permits the real POST on every explicit network path", async () => {
  for (const path of [
    "/api/v1/native-runtime",
    "/api/v1/testnet/native-runtime",
    "/api/v1/mainnet/testnet/native-runtime",
  ]) {
    const response = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://metagraph.sh",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
      apiEnv(createLocalArtifactEnv()),
      {},
    );
    assert.equal(response.status, 204);
    assert.match(
      response.headers.get("access-control-allow-methods") ?? "",
      /POST/,
    );
  }
});
test("invalid requests, network contradictions and throttling perform no RPC work", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No external traffic allowed"));
  const env = apiEnv(createLocalArtifactEnv());
  for (const [req, status] of [
    [request(undefined, { operations: [] }), 400],
    [
      request("/api/v1/testnet/native-runtime", {
        network: "finney",
        operations,
      }),
      400,
    ],
    [
      request("/api/v1/mainnet/native-runtime", {
        network: "test",
        operations,
      }),
      400,
    ],
    [request("/api/v1/native-runtime?limit=1"), 400],
    [request("/api/v1/local/native-runtime"), 404],
    [request(undefined, undefined, "GET"), 405],
    [
      new Request("https://api.metagraph.sh/api/v1/native-runtime", {
        method: "POST",
        body: "{",
      }),
      400,
    ],
    [
      request(undefined, {
        operations: [{ kind: "describe", pallet: "x".repeat(33000) }],
      }),
      400,
    ],
  ] as const) {
    assert.equal((await handleRequest(req, env, {})).status, status);
  }
  const limited = apiEnv({
    ...createLocalArtifactEnv(),
    RPC_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const response = await handleRequest(request(), limited, {});
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  await assert.rejects(
    MCP_TOOLS.find((row) => row.name === "get_native_runtime")!.handler(
      { operations },
      { env: limited, clientIp: "192.0.2.1" },
    ),
    { code: "rate_limited" },
  );
  assert.equal(fetch.mock.calls.length, 0);
});
test("unbound limiter uses the same reader and chain failures return a sanitized no-store error", async () => {
  const env = apiEnv(createLocalArtifactEnv());
  await withNativeRuntimeFixture(async () =>
    assert.equal((await handleNativeRuntime(request(), env)).status, 200),
  );
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("private endpoint credential should not appear"),
  );
  const response = await handleNativeRuntime(request(), env);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("credential"));
});
