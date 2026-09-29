import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest } from "../src/mcp-server.ts";
import {
  POSTHOG_PROJECT_TOKEN_ENV,
  recordMcpToolsListEvent,
} from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";

const env = mockEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" });

async function discover(
  profile: "core" | "full" | "discovery",
  params: Row,
  notification = false,
) {
  const discovery: Row[] = [];
  const usage: Row[] = [];
  const scheduled: Promise<unknown>[] = [];
  const response = await handleMcpRequest(
    new Request(
      `https://api.metagraph.sh/mcp${profile === "core" ? "/core" : profile === "full" ? "?catalog=full" : ""}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: 1 }),
          method: "tools/list",
          params,
        }),
      },
    ),
    env,
    {
      executionCtx: {
        waitUntil: (pending: Promise<unknown>) => scheduled.push(pending),
      },
      recordMcpToolsListEvent: (_env: unknown, event: Row) =>
        discovery.push(event),
      recordUsageEvent: (_env: unknown, event: Row) => usage.push(event),
    },
  );
  await Promise.all(scheduled);
  return { response, discovery, usage };
}

describe("MCP discovery outcomes", () => {
  for (const profile of ["core", "full", "discovery"] as const) {
    test(`${profile} records the actual advertised catalogue without copying its schemas`, async () => {
      const { response, discovery, usage } = await discover(profile, {});
      const body = (await response.json()) as Row;
      assert.equal(response.status, 200);
      assert.equal(discovery.length, 1);
      assert.deepEqual(
        discovery[0].listedToolNames,
        body.result.tools.map((tool: Row) => tool.name),
      );
      assert.equal(discovery[0].toolCount, body.result.tools.length);
      assert.equal(discovery[0].profile, profile);
      assert.equal(discovery[0].isError, false);
      assert.deepEqual(discovery[0].response, body.result);
      assert.equal(discovery[0].protocolVersion, "2025-11-25");
      assert.equal(typeof discovery[0].durationMs, "number");
      assert.deepEqual(discovery[0].parameters, {
        request: { method: "tools/list", params: {} },
      });
      assert.equal(usage.length, 1);
      assert.equal(usage[0].ok, true);
    });
  }

  for (const notification of [false, true]) {
    test(`invalid cursors record a failed discovery, notification=${notification}`, async () => {
      const { response, discovery, usage } = await discover(
        "full",
        { cursor: "invalid" },
        notification,
      );
      if (notification) {
        assert.equal(response.status, 202);
        assert.equal(await response.text(), "");
      } else {
        const body = (await response.json()) as Row;
        assert.equal(body.error.code, -32602);
        assert.equal(discovery[0].errorMessage, body.error.message);
      }
      assert.equal(discovery.length, 1);
      assert.equal(discovery[0].isError, true);
      assert.equal(discovery[0].errorCode, "invalid_params");
      assert.equal(discovery[0].toolCount, undefined);
      assert.equal(discovery[0].listedToolNames, undefined);
      assert.equal(usage.length, 1);
      assert.equal(usage[0].ok, false);
    });
  }

  test("the discovery recorder retains bounded outcomes and redacts metadata", async () => {
    const events: Row[] = [];
    const fetch = (async (_url, init) => {
      events.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    await recordMcpToolsListEvent(
      env,
      {
        isError: true,
        errorCode: "invalid_params",
        errorMessage: "Omit cursor.",
        durationMs: 91_000_000,
        parameters: {
          request: { method: "tools/list", params: { token: "secret" } },
        },
        response: { tools: [], nextCursor: "next-page", token: "secret" },
      },
      { fetch },
    );
    assert.equal(events.length, 1);
    const properties = events[0].properties;
    assert.equal(events[0].event, "$mcp_tools_list");
    assert.equal(properties.$mcp_is_error, true);
    assert.equal(properties.$mcp_error_type, "validation");
    assert.equal(properties.$mcp_error_code, "invalid_params");
    assert.equal(properties.$mcp_error_message, "Omit cursor.");
    assert.equal(properties.$mcp_duration_ms, 86_400_000);
    assert.equal(properties.$mcp_parameters.request.params.token, "[redacted]");
    assert.deepEqual(properties.$mcp_response, {
      tools: [],
      nextCursor: "next-page",
      token: "[redacted]",
    });
  });

  test("large discovery capture is bounded without modifying the advertised catalogue", async () => {
    const events: Row[] = [];
    const { response, discovery } = await discover("full", {});
    const body = await response.json();
    await recordMcpToolsListEvent(env, discovery[0], {
      fetch: (async (_url, init) => {
        events.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const captured = events[0].properties.$mcp_response;
    assert.equal(captured.truncated, true);
    assert.ok(captured.preview.length <= 4096);
    assert.deepEqual(discovery[0].response, (body as Row).result);
  });
});
