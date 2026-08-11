// The resource and prompt half of the MCP surface was invisible to analytics.
//
// This server advertises both `resources` and `prompts` in its handshake
// capabilities and serves four methods behind them. PostHog defines an event
// for each -- $mcp_resources_list, $mcp_resource_read, $mcp_prompts_list,
// $mcp_prompt_get -- and none of the four was emitted. A client that read a
// resource on every turn was indistinguishable from one that never touched the
// surface, which is the same blind spot #8963 closed for tools/list, left open
// one method family over. Measured against the live project: zero events of all
// four names in 30 days, against a server that answers all four methods.
//
// What these tests hold in place is the wiring AND its two constraints: the
// event must never break the method (waitUntil + no-throw, like every other
// scheduler here), and `$mcp_resource_name` must stay bounded -- it is the same
// caller-supplied-label trap that tools/call had.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { handleMcpRequest, listPromptDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };

function fakeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
  };
}

function baseDeps(extra: Row = {}) {
  return {
    readArtifact: (_env: Row, path: string) =>
      Promise.resolve({
        ok: true,
        data: { schema_version: 1, path },
        source: "test",
        storage_tier: "git",
      }),
    readHealthKv: () => Promise.resolve(null),
    ...extra,
  };
}

async function call(method: string, params: Row, extraDeps: Row = {}) {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    CONFIGURED_ENV as unknown as Env,
    baseDeps(extraDeps),
  );
  return (await response.json()) as Row;
}

/** Captures whichever of the four recorders the method under test should hit. */
function recorders() {
  const seen: Record<string, Row[]> = {
    resourcesList: [],
    resourceRead: [],
    promptsList: [],
    promptGet: [],
  };
  return {
    seen,
    deps: {
      recordMcpResourcesListEvent: (_e: unknown, event: Row) => {
        seen.resourcesList.push(event);
        return true;
      },
      recordMcpResourceReadEvent: (_e: unknown, event: Row) => {
        seen.resourceRead.push(event);
        return true;
      },
      recordMcpPromptsListEvent: (_e: unknown, event: Row) => {
        seen.promptsList.push(event);
        return true;
      },
      recordMcpPromptGetEvent: (_e: unknown, event: Row) => {
        seen.promptGet.push(event);
        return true;
      },
    },
  };
}

const A_PROMPT = "integrate_with_subnet";

describe("resources/list and prompts/list are recorded", () => {
  for (const [method, bucket] of [
    ["resources/list", "resourcesList"],
    ["prompts/list", "promptsList"],
  ] as const) {
    test(`${method} emits exactly one discovery event`, async () => {
      const spy = recorders();
      const executionCtx = fakeExecutionCtx();

      const payload = await call(method, {}, { ...spy.deps, executionCtx });

      // The method still answers.
      assert.ok(payload.result, `${method} should still return a result`);
      assert.equal(spy.seen[bucket].length, 1);
      // Drained through waitUntil rather than awaited in the request path.
      // Two promises, not one: this server already records every protocol
      // method as a usage_event, and the new $mcp_* event rides alongside it
      // exactly as $mcp_tool_call rides alongside tools/call's.
      assert.equal(executionCtx.scheduled.length, 2);
      // A list names nothing -- PostHog's own schema has no name on these two.
      assert.equal(spy.seen[bucket][0].resourceName, undefined);
      // Server identity rides along, so an event can be pinned to a deploy.
      assert.equal(typeof spy.seen[bucket][0].serverName, "string");
      assert.equal(typeof spy.seen[bucket][0].serverVersion, "string");
    });

    test(`${method} records nothing for a notification`, async () => {
      // Preserving the pre-existing contract: a notification-shaped call does
      // no work, so there is nothing to record. This is the behaviour the
      // resources/subscribe comment protects, and the change must not alter it.
      const spy = recorders();
      await call(method, {}, spy.deps);
      const notification = await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
        }),
        CONFIGURED_ENV as unknown as Env,
        baseDeps(spy.deps),
      );
      assert.equal(notification.status, 202);
      // One from the request above, none from the notification.
      assert.equal(spy.seen[bucket].length, 1);
    });
  }
});

describe("resources/read is recorded with a bounded name", () => {
  test("emits the read event naming the uri it served", async () => {
    const spy = recorders();
    const executionCtx = fakeExecutionCtx();
    const uri = "metagraph://registry/summary";

    const payload = await call(
      "resources/read",
      { uri },
      { ...spy.deps, executionCtx },
    );

    assert.ok(payload.result?.contents, "the read should still return content");
    assert.equal(spy.seen.resourceRead.length, 1);
    const event = spy.seen.resourceRead[0];
    assert.equal(event.resourceName, uri);
    // usage_event + $mcp_resource_read, both via waitUntil.
    assert.equal(executionCtx.scheduled.length, 2);
    // Arguments and result travel for drill-down, as on $mcp_tool_call. The
    // recorder redacts and size-caps them; that contract is proven in
    // tests/usage-telemetry.test.ts and is not re-asserted here.
    assert.deepEqual(event.parameters, { uri });
    assert.ok(event.response, "the read event should carry its response");
  });

  test("an unresolvable uri records nothing", async () => {
    // This is what BOUNDS $mcp_resource_name: readResource throws for a uri
    // that is neither a live stream nor a resolvable artifact path, and the
    // event is scheduled after it resolves. So a caller cannot mint dimension
    // values here the way it could through tools/call before mcpToolLabel.
    const spy = recorders();

    await call("resources/read", { uri: "metagraph://not-a-real/thing-92831" });
    await call(
      "resources/read",
      { uri: "metagraph://not-a-real/thing-92831" },
      spy.deps,
    );

    assert.deepEqual(spy.seen.resourceRead, []);
  });
});

describe("prompts/get is recorded with a bounded name", () => {
  test("emits the get event naming the prompt", async () => {
    const spy = recorders();
    const executionCtx = fakeExecutionCtx();

    const payload = await call(
      "prompts/get",
      { name: A_PROMPT, arguments: { netuid: "1" } },
      { ...spy.deps, executionCtx },
    );

    assert.ok(payload.result?.messages, "the prompt should still be returned");
    assert.equal(spy.seen.promptGet.length, 1);
    assert.equal(spy.seen.promptGet[0].resourceName, A_PROMPT);
    // usage_event + $mcp_prompt_get, both via waitUntil.
    assert.equal(executionCtx.scheduled.length, 2);
  });

  test("an unknown prompt records nothing", async () => {
    const spy = recorders();
    await call("prompts/get", { name: "no_such_prompt_at_all" }, spy.deps);
    assert.deepEqual(spy.seen.promptGet, []);
  });

  test("the recorded name is always one the server advertises", async () => {
    // Derived from the served prompt list, so this cannot drift.
    const spy = recorders();
    const advertised = listPromptDefinitions().map(
      (p: Row) => p.name as string,
    );
    assert.ok(
      advertised.length > 0,
      "expected the server to advertise prompts",
    );
    assert.ok(advertised.includes(A_PROMPT));

    await call(
      "prompts/get",
      { name: A_PROMPT, arguments: { netuid: "1" } },
      spy.deps,
    );
    assert.ok(
      advertised.includes(spy.seen.promptGet[0].resourceName as string),
    );
  });
});

describe("resource and prompt telemetry never breaks the method", () => {
  // The same discipline every other scheduler in mcp-server.ts is held to: a
  // broken recorder is a telemetry problem, never a request problem.
  for (const [label, override] of Object.entries({
    "the recorder rejects": () => Promise.reject(new Error("posthog down")),
    "the recorder throws synchronously": () => {
      throw new Error("posthog exploded");
    },
  })) {
    test(`resources/read still answers when ${label}`, async () => {
      const payload = await call(
        "resources/read",
        { uri: "metagraph://registry/summary" },
        { recordMcpResourceReadEvent: override },
      );
      assert.ok(payload.result?.contents);
      assert.equal(payload.error, undefined);
    });

    test(`prompts/get still answers when ${label}`, async () => {
      const payload = await call(
        "prompts/get",
        { name: A_PROMPT, arguments: { netuid: "1" } },
        { recordMcpPromptGetEvent: override },
      );
      assert.ok(payload.result?.messages);
      assert.equal(payload.error, undefined);
    });

    // The two LIST methods were missing from this loop, so their schedulers'
    // rejection path was the only half of the family never exercised -- and it
    // is the half that matters most, because a list call is the one an agent
    // makes on every connect.
    test(`resources/list still answers when ${label}`, async () => {
      const payload = await call(
        "resources/list",
        {},
        { recordMcpResourcesListEvent: override },
      );
      assert.ok(payload.result?.resources);
      assert.equal(payload.error, undefined);
    });

    test(`prompts/list still answers when ${label}`, async () => {
      const payload = await call(
        "prompts/list",
        {},
        { recordMcpPromptsListEvent: override },
      );
      assert.ok(payload.result?.prompts);
      assert.equal(payload.error, undefined);
    });
  }

  test("a missing ExecutionContext does not break the method", async () => {
    const payload = await call(
      "resources/list",
      {},
      {
        executionCtx: {
          waitUntil() {
            throw new Error("isolate already finished");
          },
        },
      },
    );
    assert.ok(payload.result?.resources);
  });
});
