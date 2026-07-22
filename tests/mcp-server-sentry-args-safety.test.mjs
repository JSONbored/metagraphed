// metagraphed#7687 (MCP execute Phase 3b): confirms dispatchTool's
// Sentry.startSpan call (src/mcp-server.mjs) never receives a tool's raw
// arguments -- only {name, op}. Motivated by call_subnet_surface's Phase 3
// `credential` argument, but the property being verified is generic to
// every MCP tool, not specific to that one. A separate small file rather
// than folded into tests/call-subnet-surface-mcp.test.mjs: vi.mock is
// file-scoped and hoisted, and that file's other ~48 tests already exercise
// the real (unmocked) Sentry.startSpan through every other tool call --
// mocking it there risks disturbing tests this issue doesn't own.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const startSpanCalls = vi.hoisted(() => []);
const captureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  startSpan: async (spanArgs, callback) => {
    startSpanCalls.push(spanArgs);
    return callback();
  },
  captureException,
}));

const { handleMcpRequest } = await import("../src/mcp-server.mjs");

afterEach(() => {
  startSpanCalls.length = 0;
  captureException.mockClear();
});

async function callTool(name, args, fetchImpl) {
  const of = globalThis.fetch;
  globalThis.fetch =
    fetchImpl ??
    (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  const deps = {
    readArtifact: async (_e, path) => {
      if (path === "/metagraph/operational-surfaces.json") {
        return {
          ok: true,
          data: {
            surfaces: [
              {
                surface_id: "x:api:1",
                netuid: 5,
                kind: "subnet-api",
                url: "https://x.example/admin",
                auth_required: true,
                auth: {
                  scheme: "bearer",
                  location: "header",
                  name: "Authorization",
                },
                probe: { method: "GET", enabled: true },
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    },
  };
  try {
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
      {},
      deps,
    );
    return (await response.json()).result;
  } finally {
    globalThis.fetch = of;
  }
}

test("Sentry.startSpan is called exactly once per tool call, with only {name, op}", async () => {
  const result = await callTool("call_subnet_surface", {
    surface_id: "x:api:1",
    credential: "Bearer super-secret-abc123",
  });
  assert.equal(result.isError, false);
  assert.equal(startSpanCalls.length, 1);
  assert.deepEqual(Object.keys(startSpanCalls[0]).sort(), ["name", "op"]);
  assert.equal(startSpanCalls[0].name, "mcp.tool/call_subnet_surface");
  assert.equal(startSpanCalls[0].op, "mcp.tool");
});

test("the credential value never appears anywhere in the span-creation call", async () => {
  await callTool("call_subnet_surface", {
    surface_id: "x:api:1",
    credential: "Bearer super-secret-abc123",
  });
  const serialized = JSON.stringify(startSpanCalls);
  assert.ok(!serialized.includes("super-secret-abc123"));
});
