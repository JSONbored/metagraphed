// metagraphed#7687 (MCP execute Phase 3b), #7768/#7766: confirms
// dispatchTool's PostHog trace-span call (src/mcp-server.ts, formerly
// Sentry.startSpan -- Sentry fully removed) never receives a tool's raw
// arguments -- only the span's name/attributes (mcp_tool). Motivated by
// call_subnet_surface's Phase 3 `credential` argument, but the property
// being verified is generic to every MCP tool, not specific to that one. A
// separate small file rather than folded into
// tests/call-subnet-surface-mcp.test.mjs: vi.mock is file-scoped and
// hoisted, and that file's other ~48 tests already exercise the real
// (unmocked) trace-span call through every other tool call -- mocking it
// there risks disturbing tests this issue doesn't own.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { Row } from "./row-type.ts";

const recordTraceSpanCalls = vi.hoisted((): Row[] => []);

vi.mock("../src/tracing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tracing.ts")>();
  return {
    ...actual,
    recordTraceSpan: async (_env: unknown, span: Row) => {
      recordTraceSpanCalls.push(span);
      return true;
    },
  };
});

const { handleMcpRequest } = await import("../src/mcp-server.ts");

afterEach(() => {
  recordTraceSpanCalls.length = 0;
});

async function callTool(name: string, args: Row, fetchImpl?: typeof fetch) {
  const of = globalThis.fetch;
  globalThis.fetch =
    fetchImpl ??
    (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  const deps = {
    readArtifact: async (_e: unknown, path: string) => {
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
      // POSTHOG_TRACES_SAMPLE_RATE: "1" forces every call through
      // recordTraceSpan (default rate is 0, off, see src/tracing.ts's own
      // header) so this file's whole point -- inspecting what actually
      // reaches the span recorder -- has something to inspect.
      { POSTHOG_TRACES_SAMPLE_RATE: "1" } as unknown as Env,
      deps,
    );
    return ((await response.json()) as Row).result;
  } finally {
    globalThis.fetch = of;
  }
}

test("the trace span is recorded exactly once per tool call, with only the expected attributes", async () => {
  const result = await callTool("call_subnet_surface", {
    surface_id: "x:api:1",
    credential: "Bearer super-secret-abc123",
  });
  assert.equal(result.isError, false);
  assert.equal(recordTraceSpanCalls.length, 1);
  const span = recordTraceSpanCalls[0];
  assert.equal(span.name, "mcp.tool/call_subnet_surface");
  assert.equal(span.serviceName, "metagraphed-api");
  assert.deepEqual(span.attributes, { mcp_tool: "call_subnet_surface" });
});

test("the credential value never appears anywhere in the span-recording call", async () => {
  await callTool("call_subnet_surface", {
    surface_id: "x:api:1",
    credential: "Bearer super-secret-abc123",
  });
  const serialized = JSON.stringify(recordTraceSpanCalls);
  assert.ok(!serialized.includes("super-secret-abc123"));
});
