import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_PROJECT_TOKEN_ENV,
  POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV,
  recordExceptionEvent,
  recordMcpInitializeEvent,
  recordMcpMissingCapabilityEvent,
  recordMcpPromptGetEvent,
  recordMcpPromptsListEvent,
  recordMcpResourceReadEvent,
  recordMcpResourcesListEvent,
  recordMcpToolCallEvent,
  recordMcpToolsListEvent,
  type McpServerIdentity,
  type McpToolCallEvent,
  normalizeMcpLlmModel,
} from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";

const env = mockEnv({ [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" });
function captures() {
  const events: Row[] = [];
  const deps = {
    fetch: (async (_url, init) => {
      events.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  };
  return { events, deps };
}

describe("MCP product events exclude operational traffic", () => {
  test("a transport refusal is not a tool call, even with an internal probe marker", async () => {
    for (const probe of [undefined, "manual-release-check"]) {
      const { events, deps } = captures();
      await recordMcpToolCallEvent(
        env,
        {
          requestStage: "refused",
          isError: true,
          durationMs: 0,
          errorCode: "unsupported_protocol_version",
          errorStatus: 400,
          requestMethod: "POST",
          protocolVersion: "2026-07-28",
          probe,
        },
        deps,
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "mcp_request_refused");
      assert.equal(events[0].properties.$mcp_protocol_version, "2026-07-28");
      assert.equal(events[0].properties.$mcp_tool_name, undefined);
      assert.equal(events[0].properties.$process_person_profile, false);
    }
  });

  test("all native event families retain one separate capture for a verified probe", async () => {
    const recorders = {
      tool_call: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) =>
        recordMcpToolCallEvent(
          env,
          {
            ...identity,
            toolName: "get_subnet",
            isError: false,
            durationMs: 2,
          },
          deps,
        ),
      initialize: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpInitializeEvent(env, identity, deps),
      tools_list: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpToolsListEvent(env, identity, deps),
      resources_list: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpResourcesListEvent(env, identity, deps),
      resource_read: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpResourceReadEvent(env, identity, deps),
      prompts_list: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpPromptsListEvent(env, identity, deps),
      prompt_get: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpPromptGetEvent(env, identity, deps),
      missing_capability: (
        identity: McpServerIdentity,
        deps: ReturnType<typeof captures>["deps"],
      ) => recordMcpMissingCapabilityEvent(env, identity, deps),
    };
    for (const [name, record] of Object.entries(recorders)) {
      for (const probe of [undefined, "  ", "release-check"]) {
        const { events, deps } = captures();
        assert.equal(
          await record(
            {
              probe,
              clientUserAgent: "claude-code/2.1.0 (sdk-ts)",
              vendorClient: "claude-code",
            },
            deps,
          ),
          true,
        );
        assert.equal(events.length, 1);
        assert.equal(
          events[0].event,
          probe === "release-check" ? `mcp_probe_${name}` : `$mcp_${name}`,
        );
        assert.equal(
          events[0].properties.$mcp_client_user_agent,
          "claude-code/2.1.0 (sdk-ts)",
        );
        assert.equal(events[0].properties.$mcp_vendor_client, "claude-code");
      }
    }
  });
});

describe("MCP attribution and outcomes", () => {
  test("only validated echoes override the transport session in native capture", async () => {
    for (const conversationId of [
      undefined,
      "chat-1",
      "0198f2d6-abcd-7123-8456-789abcdef012",
    ]) {
      for (const conversationIdAccepted of [undefined, false, true]) {
        const { events, deps } = captures();
        await recordMcpToolCallEvent(
          env,
          {
            toolName: "get_contracts",
            isError: false,
            durationMs: 1,
            sessionId: " transport-session ",
            conversationId,
            conversationIdAccepted,
          },
          deps,
        );
        const properties = events[0].properties;
        const accepted =
          conversationIdAccepted === true && conversationId?.startsWith("0198");
        if (accepted) {
          assert.match(properties.$session_id, /^ses_[0-9a-f]{64}$/);
          assert.equal(
            properties.$mcp_protocol_session_id,
            "transport-session",
          );
        } else {
          assert.equal(properties.$session_id, "transport-session");
          assert.equal(properties.$mcp_protocol_session_id, undefined);
        }
        assert.equal(properties.$mcp_conversation_id, conversationId);
      }
    }
  });

  test("native model properties preserve provenance and omit unknown claims", async () => {
    for (const source of [
      "client_metadata",
      "self_reported",
      undefined,
      "guessed",
    ]) {
      for (const model of ["  gpt-6  ", " UNKNOWN ", "", undefined]) {
        const { events, deps } = captures();
        await recordMcpToolCallEvent(
          env,
          {
            isError: false,
            durationMs: 1,
            llmModel: model,
            llmModelSource: source as McpToolCallEvent["llmModelSource"],
          },
          deps,
        );
        const accepted =
          model === "  gpt-6  " &&
          (source === "client_metadata" || source === "self_reported");
        assert.equal(
          events[0].properties.$mcp_llm_model,
          accepted ? "gpt-6" : undefined,
        );
        assert.equal(
          events[0].properties.$mcp_llm_model_source,
          accepted ? source : undefined,
        );
        assert.equal(events.length, 1);
      }
    }
    assert.equal(normalizeMcpLlmModel("x".repeat(1000))?.length, 256);
    for (const invalid of [null, 42, {}, " ", "unknown"])
      assert.equal(normalizeMcpLlmModel(invalid), undefined);
  });

  test("native harness labels are bounded and omitted when absent", async () => {
    for (const raw of [null, undefined, " ", "x".repeat(1000)]) {
      const { events, deps } = captures();
      await recordMcpInitializeEvent(
        env,
        { clientUserAgent: raw, vendorClient: raw },
        deps,
      );
      for (const key of ["$mcp_client_user_agent", "$mcp_vendor_client"]) {
        assert.equal(
          events[0].properties[key],
          raw?.startsWith("x") ? "x".repeat(256) : undefined,
        );
      }
    }
  });

  test("retains full/core profile and a bounded protocol version", async () => {
    for (const profile of ["core", "full", undefined, "invalid"] as const) {
      const { events, deps } = captures();
      await recordMcpInitializeEvent(
        env,
        {
          profile: profile as McpServerIdentity["profile"],
          protocolVersion: " 2025-11-25 ",
        },
        deps,
      );
      assert.equal(
        events[0].properties.$mcp_profile,
        profile === "invalid" ? undefined : profile,
      );
      assert.equal(events[0].properties.$mcp_protocol_version, "2025-11-25");
    }
  });

  test("only failed tools carry their bounded error message", async () => {
    for (const isError of [false, true]) {
      for (const errorMessage of [undefined, "  bad arguments  "]) {
        const { events, deps } = captures();
        await recordMcpToolCallEvent(
          env,
          { isError, durationMs: 4, errorMessage },
          deps,
        );
        assert.equal(
          events[0].properties.$mcp_error_message,
          isError && errorMessage ? "bad arguments" : undefined,
        );
      }
    }
  });

  test("resource timings reject invalid values and failures are classified", async () => {
    for (const durationMs of [
      undefined,
      NaN,
      Infinity,
      -1,
      0,
      12.6,
      100_000_000,
    ]) {
      for (const isError of [undefined, false, true]) {
        const { events, deps } = captures();
        await recordMcpResourceReadEvent(
          env,
          {
            durationMs,
            isError,
            errorCode: "invalid_params",
            errorMessage: "  Invalid URI.  ",
          },
          deps,
        );
        const props = events[0].properties;
        assert.equal(props.$mcp_is_error, isError);
        assert.equal(
          props.$mcp_duration_ms,
          durationMs === 12.6
            ? 13
            : durationMs === 100_000_000
              ? 86_400_000
              : undefined,
        );
        assert.equal(props.$mcp_error_type, isError ? "validation" : undefined);
        assert.equal(
          props.$mcp_error_code,
          isError ? "invalid_params" : undefined,
        );
        assert.equal(
          props.$mcp_error_message,
          isError ? "Invalid URI." : undefined,
        );
      }
    }
    const { events, deps } = captures();
    await recordMcpResourceReadEvent(env, { isError: true }, deps);
    assert.equal(events[0].properties.$mcp_error_code, undefined);
    assert.equal(events[0].properties.$mcp_error_message, undefined);
  });
});

describe("MCP analytics payload privacy", () => {
  test("resource exception context uses the same credential redaction as resource events", async () => {
    const { events, deps } = captures();
    const uri =
      "https://user:password@data.example/path?api_key=credential&netuid=1#access_token=fragment";
    await recordExceptionEvent(
      { ...env, [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "0" },
      {
        error: new Error("read failed"),
        route: "mcp-dispatch:resources/read",
        nativeMcp: { resourceName: uri, resourceIsUri: true },
      },
      deps,
    );
    await recordMcpResourceReadEvent(env, { resourceName: uri }, deps);
    assert.equal(events.length, 2);
    assert.equal(
      events[0].properties.$mcp_resource_name,
      events[1].properties.$mcp_resource_name,
    );
    const serialized = JSON.stringify(events);
    for (const secret of ["user:", "password", "credential", "fragment"])
      assert.ok(!serialized.includes(secret));
  });

  test("removes URI credentials from both resource dimensions and parameters", async () => {
    const { events, deps } = captures();
    const uri =
      "https://user:password@data.example/path?api_key=credential&netuid=1#access_token=fragment";
    await recordMcpResourceReadEvent(
      env,
      {
        resourceName: uri,
        parameters: { request: { method: "resources/read", params: { uri } } },
      },
      deps,
    );
    const serialized = JSON.stringify(events);
    for (const secret of ["user:", "password", "credential", "fragment"])
      assert.ok(!serialized.includes(secret));
    assert.ok(events[0].properties.$mcp_resource_name.includes("netuid=1"));
    assert.equal(
      events[0].properties.$mcp_parameters.request.method,
      "resources/read",
    );
  });

  test("retains clean URI labels but excludes malformed URI strings", async () => {
    for (const uri of [
      "metagraph://registry/summary",
      "not a uri containing a secret",
    ]) {
      const { events, deps } = captures();
      await recordMcpResourceReadEvent(
        env,
        { resourceName: uri, parameters: { uri } },
        deps,
      );
      const expected = uri.startsWith("metagraph:") ? uri : "[invalid uri]";
      assert.equal(events[0].properties.$mcp_resource_name, expected);
      assert.equal(events[0].properties.$mcp_parameters.uri, expected);
    }
  });

  test("removes binary blocks while retaining ordinary data and discovery metadata", async () => {
    const { events, deps } = captures();
    await recordMcpResourcesListEvent(
      env,
      {
        response: {
          resources: [
            {
              uri: "metagraph://registry/summary",
              mimeType: "application/json",
            },
          ],
          nextCursor: "page-2",
          blocks: [
            { type: "image", data: "private-image" },
            { type: "audio", data: "private-audio" },
            { blob: "private-blob" },
            {
              type: "result",
              data: { netuid: 1 },
              url: "https://data.example/path",
            },
            { uri: 12 },
          ],
        },
      },
      deps,
    );
    assert.ok(!JSON.stringify(events).includes("private-"));
    const response = events[0].properties.$mcp_response;
    assert.equal(response.nextCursor, "page-2");
    assert.deepEqual(response.blocks[3].data, { netuid: 1 });
    assert.equal(response.blocks[4].uri, 12);
  });
});
