// WHAT `/mcp` ANSWERS -- the published envelope contract (#9647).
//
// Until the cutover this file compared two implementations: the hand-rolled
// envelope against the SDK one, flag off then on. That comparison is gone
// because the second implementation is gone -- every well-formed request is
// now served by @modelcontextprotocol/sdk, and there is nothing left to diff
// it against.
//
// So the assertions became absolute instead of relative, which is the stronger
// form anyway: a comparison passes happily when both sides regress together,
// and `initialize` was already caught doing exactly that during the migration.
// Every expectation below is the literal response a caller receives.
//
// The malformed-input cases still exercise the OTHER branch -- dispatchMessage
// answering directly, because the SDK mishandles bad input (see
// dispatchMcpRequest). That is not legacy coverage; the branch is permanent.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import {
  closeQuietly,
  JsonRpcFailure,
  SDK_RECLAIMED_METHODS,
  serveWithSdk,
  unwrapDispatchResponse,
} from "../src/mcp-sdk-adapter.ts";
import type { Row } from "./row-type.ts";

const ENV = {} as unknown as Env;

const post = (body: unknown, headers: Row = {}) =>
  new Request("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(headers as Record<string, string>),
    },
    body: JSON.stringify(body),
  });

/** Everything a caller can observe: status, body, and the headers we set. */
async function observe(body: unknown, headers: Row = {}) {
  const res = await handleMcpRequest(post(body, headers), ENV, {});
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Row) : null,
    contentType: res.headers.get("content-type"),
    cors: res.headers.get("access-control-allow-origin"),
    cacheControl: res.headers.get("cache-control"),
    sessionId: res.headers.get("mcp-session-id"),
  };
}

describe("the published MCP envelope (#9647)", () => {
  test("initialize carries instructions, capabilities and the registry backlink", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "contract", version: "1" },
      },
    });
    assert.equal(seen.status, 200);
    const result = seen.body!.result as Row;
    // Named individually so a failure says WHICH field went missing. An
    // earlier draft of the adapter dropped `_meta` and `instructions`, and a
    // key-set comparison alone would not have said which.
    assert.ok(result.instructions, "instructions: what this server is FOR");
    assert.ok(result._meta, "the registry backlink");
    assert.ok(result.protocolVersion);
    assert.ok(result.capabilities);
    const info = result.serverInfo as Row;
    assert.equal(info.name, "metagraphed");
    assert.ok(info.title && info.description && info.version);
    // A successful single initialize mints the session the client will use.
    assert.match(String(seen.sessionId), /^[\x21-\x7E]{1,128}$/);
  });

  // #9680: Implementation.websiteUrl + Implementation.icons (MCP 2025-11-25),
  // both previously unemitted. Every icon `src` is asserted to be an absolute
  // https URL on our own site origin -- an icon field is a URL a client will
  // fetch and render, so a relative path or a third-party host is a defect
  // that only shows up in someone else's browser.
  test("the handshake advertises a website and icons", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    const info = (seen.body!.result as Row).serverInfo as Row;
    assert.equal(info.websiteUrl, "https://metagraph.sh");
    const icons = info.icons as Row[];
    assert.ok(Array.isArray(icons) && icons.length > 0, "icons are declared");
    for (const icon of icons) {
      assert.match(
        String(icon.src),
        /^https:\/\/metagraph\.sh\//,
        "same-origin",
      );
      assert.ok(String(icon.mimeType).startsWith("image/"), "declares a type");
      assert.ok(
        Array.isArray(icon.sizes) && icon.sizes.length > 0,
        "declares its sizes",
      );
    }
  });

  // Deliberately NOT per tool: 224 identical copies would add ~45 KB to a
  // tools/list every client holds in context, for nothing a client does not
  // already have from the handshake. Asserted so the decision is explicit
  // rather than an omission someone later "fixes".
  test("icons are server-level only, not repeated on every tool", () => {
    const withIcons = listToolDefinitions().filter(
      (t) => (t as Row).icons !== undefined,
    );
    assert.deepEqual(withIcons, []);
  });

  // The SDK's InitializeRequestSchema REQUIRES params.protocolVersion, so
  // registering a handler for it would refuse this with zod's text. Total
  // delegation is what keeps it working; this is the case that proves the
  // delegation is total rather than merely configured.
  test("a handshake with no protocolVersion is still negotiated", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(seen.status, 200);
    assert.ok((seen.body!.result as Row).protocolVersion);
  });

  test("ping", async () => {
    const seen = await observe({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.deepEqual(seen.body, { jsonrpc: "2.0", id: 2, result: {} });
    assert.equal(seen.sessionId, null, "only initialize mints a session");
  });

  test("tools/list publishes the whole catalogue", async () => {
    const seen = await observe({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (seen.body!.result as Row).tools as Row[];
    assert.equal(tools.length, listToolDefinitions().length);
    assert.ok(tools.length > 200, `expected 200+, saw ${tools.length}`);
  });

  test("prompts/list and resources/templates/list answer", async () => {
    for (const method of ["prompts/list", "resources/templates/list"]) {
      const seen = await observe({ jsonrpc: "2.0", id: 4, method });
      assert.equal(seen.status, 200, method);
      assert.ok(seen.body!.result, method);
    }
  });

  // ERROR TEXT, not just the code. McpError would have rewritten every message
  // to `MCP error -32601: …`; JsonRpcFailure is what keeps them verbatim, and
  // a code-only assertion would have passed while every error string on a
  // public surface silently changed.
  test("an unknown method keeps its code and its message", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      id: 6,
      method: "no/such/method",
    });
    assert.deepEqual(seen.body, {
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601, message: "Unknown method: no/such/method" },
    });
    assert.equal(seen.status, 200, "a JSON-RPC error is still HTTP 200");
    assert.equal(seen.sessionId, null, "a refused request mints nothing");
  });

  test("a refused tools/list cursor keeps its explanation", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { cursor: "eyJvIjoxMDB9" },
    });
    const error = seen.body!.error as Row;
    assert.equal(error.code, -32602);
    assert.match(String(error.message), /not paginated/);
  });

  test("a notification is answered 202 with no body", async () => {
    const seen = await observe({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(seen.status, 202);
    assert.equal(seen.body, null);
  });

  test("a batch keeps its order and drops its notifications", async () => {
    const seen = await observe([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
    ]);
    const responses = seen.body as unknown as Row[];
    assert.equal(responses.length, 2, "the notification produced no response");
    assert.deepEqual(
      responses.map((r) => r.id),
      [1, 2],
    );
  });

  // The SDK's transport fans a batch out with no ceiling of its own, so this
  // has to be enforced before it -- it is the only thing standing between one
  // HTTP request and unbounded fan-out.
  test("the batch ceiling is enforced", async () => {
    const seen = await observe(
      Array.from({ length: 11 }, (_, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "ping",
      })),
    );
    assert.equal(seen.status, 400);
    assert.match(String((seen.body!.error as Row).message), /maximum/);
  });

  test("an empty batch is refused", async () => {
    const seen = await observe([]);
    assert.equal(seen.status, 400);
    assert.equal((seen.body!.error as Row).message, "Empty JSON-RPC batch.");
  });

  // Most callers of this surface are scripts sending `*/*`, which fails the
  // SDK transport's literal substring test for both media types. The rebuilt
  // request normalizes the header, which is what stopped the cutover
  // presenting as "every script broke".
  test("Accept is not enforced against the caller", async () => {
    for (const headers of [{ accept: "*/*" }, { accept: "application/json" }]) {
      const seen = await observe(
        { jsonrpc: "2.0", id: 8, method: "ping" },
        headers,
      );
      assert.equal(seen.status, 200, JSON.stringify(headers));
      assert.deepEqual(seen.body!.result, {});
    }
  });

  test("a caller sending no Accept header at all is not 406'd", async () => {
    // Built by hand: post() always supplies a conformant Accept, so passing
    // `{}` for the overrides would have left the default in place and tested
    // nothing.
    const bare = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    });
    assert.equal(bare.headers.get("accept"), null, "the fixture is bare");
    const res = await handleMcpRequest(bare, ENV, {});
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as Row).result, {});
  });

  // The transport sets a bare `content-type` on a JSON reply and NOTHING on a
  // 202, so these survive only because MCP_HEADERS is overlaid on the way out.
  // Without that the CORS header and `cache-control: no-store` would have
  // disappeared at cutover -- a caching change and a browser-client breakage
  // with nothing to do with JSON-RPC.
  test("CORS, charset and cache-control are set on every response", async () => {
    for (const body of [
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 11, method: "no/such/method" },
    ]) {
      const seen = await observe(body);
      assert.equal(seen.cors, "*");
      assert.equal(seen.cacheControl, "no-store");
      assert.equal(seen.contentType, "application/json; charset=utf-8");
    }
  });

  // ── The branch the SDK never sees ────────────────────────────────────────
  //
  // Malformed input is answered by dispatchMessage directly. The SDK's
  // transport would answer `400 -32700 Parse error` for the whole request: the
  // wrong code (-32700 is reserved for JSON that did not parse), the wrong
  // status, and for a mixed batch it drops the valid members outright.
  describe("malformed input", () => {
    for (const [label, body] of [
      ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
      ["a missing method", { jsonrpc: "2.0", id: 1 }],
      ["a non-string method", { jsonrpc: "2.0", id: 1, method: 5 }],
    ] as Array<[string, unknown]>) {
      test(`${label} is -32600 inside a 200`, async () => {
        const seen = await observe(body);
        assert.equal(seen.status, 200);
        assert.deepEqual(seen.body, {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "Invalid JSON-RPC request." },
        });
      });
    }

    for (const [label, body] of [
      ["a null body", null],
      ["a scalar body", 42],
    ] as Array<[string, unknown]>) {
      test(`${label} is 202`, async () => {
        const seen = await observe(body);
        assert.equal(seen.status, 202);
        assert.equal(seen.body, null);
      });
    }

    // The case that loses data rather than relabelling it.
    test("a mixed batch still answers its valid members", async () => {
      const seen = await observe([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "1.0", id: 2, method: "ping" },
      ]);
      assert.equal(seen.status, 200);
      const responses = seen.body as unknown as Row[];
      assert.deepEqual(responses[0], { jsonrpc: "2.0", id: 1, result: {} });
      assert.equal((responses[1].error as Row).code, -32600);
    });

    test("a body that is not JSON at all is refused", async () => {
      const res = await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: "{not json",
        }),
        ENV,
        {},
      );
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as Row).error.code, -32700);
    });
  });
});

// INVISIBLE TO A RESPONSE ASSERTION, which is why it gets its own test. The
// SDK's Protocol dispatches notifications fire-and-forget, so the 202 returns
// while the handler is still running; on Workers the request context is then
// torn down with the telemetry write unfinished. Every test above passes
// either way -- the response is identical -- and the only symptom would have
// been notifications/initialized quietly disappearing from PostHog.
describe("a notification's dispatch completes before the response (#9647)", () => {
  const notify = () =>
    new Request("https://x/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

  test("the funnel has finished, not merely started, when serveWithSdk resolves", async () => {
    const events: string[] = [];
    await serveWithSdk(notify(), {
      serverInfo: { name: "n", version: "1" },
      capabilities: { tools: {} },
      dispatch: async (message) => {
        events.push(`start:${message.method}`);
        // Stands in for the PostHog write dispatchMessage's `finally` makes:
        // a real await, so "started" and "finished" are distinguishable.
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`done:${message.method}`);
        return null;
      },
    });
    assert.deepEqual(events, [
      "start:notifications/initialized",
      "done:notifications/initialized",
    ]);
  });

  test("a rejecting notification dispatch never becomes the response", async () => {
    const res = await serveWithSdk(notify(), {
      serverInfo: { name: "n", version: "1" },
      capabilities: { tools: {} },
      dispatch: async () => {
        throw new Error("telemetry backend is down");
      },
    });
    assert.equal(res.status, 202, "the caller still gets its 202");
  });
});

// A method the SDK still owns is a method dispatchMessage never sees, and so a
// method that silently stops being counted -- initialize most of all, which
// carries the client attribution (#8994) and the session identity (#9054).
// The adapter reclaims them by name through public API; this proves the list
// is COMPLETE, by reflection, so an SDK upgrade that registers a new handler
// fails here instead of quietly going dark in PostHog.
describe("the SDK owns no method (#9647)", () => {
  const CAPABILITIES = {
    tools: {},
    resources: { subscribe: true },
    prompts: {},
  };

  test("nothing remains registered after the reclaim", async () => {
    const seen: string[] = [];
    await serveWithSdk(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      {
        serverInfo: { name: "reflect", version: "1" },
        capabilities: CAPABILITIES,
        dispatch: async (message) => {
          seen.push(String(message.method));
          return { jsonrpc: "2.0", id: message.id, result: {} };
        },
      },
    );
    assert.deepEqual(seen, ["ping"], "ping reached our funnel, not the SDK's");

    // The reflective half: build the same Server the adapter builds, reclaim
    // the same names, and assert the SDK's own registries are empty. Reaching
    // into private state is right here and wrong in production -- a gate may
    // know more about its dependency than the code it guards.
    const { Server } =
      await import("@modelcontextprotocol/sdk/server/index.js");
    const probe = new Server(
      { name: "reflect", version: "1" },
      { capabilities: CAPABILITIES },
    ) as unknown as {
      _requestHandlers: Map<string, unknown>;
      _notificationHandlers: Map<string, unknown>;
      removeRequestHandler: (m: string) => void;
      removeNotificationHandler: (m: string) => void;
    };
    for (const m of SDK_RECLAIMED_METHODS.requests) {
      probe.removeRequestHandler(m);
    }
    for (const m of SDK_RECLAIMED_METHODS.notifications) {
      probe.removeNotificationHandler(m);
    }
    assert.deepEqual(
      [...probe._requestHandlers.keys()],
      [],
      "the SDK still answers a request method our funnel never sees",
    );
    assert.deepEqual(
      [...probe._notificationHandlers.keys()],
      [],
      "the SDK still absorbs a notification our funnel never counts",
    );
  });
});

// The one place dispatchMessage's response convention is translated into the
// SDK's, and so the one place a mistranslation could hide.
describe("unwrapDispatchResponse (#9647)", () => {
  test("returns the result of a successful response", () => {
    assert.deepEqual(
      unwrapDispatchResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
      { ok: true },
    );
  });

  test("returns a falsy result rather than mistaking it for an error", () => {
    // `result: {}` is what ping answers; an `if (response.result)` test would
    // have thrown on it.
    assert.deepEqual(
      unwrapDispatchResponse({ jsonrpc: "2.0", id: 1, result: {} }),
      {},
    );
  });

  test("throws the error verbatim, with no prefix added", () => {
    assert.throws(
      () =>
        unwrapDispatchResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid params." },
        }),
      (error: JsonRpcFailure) => {
        assert.equal(error.code, -32602);
        assert.equal(error.message, "Invalid params.");
        return true;
      },
    );
  });

  test("carries `data` through when the error has one", () => {
    assert.throws(
      () =>
        unwrapDispatchResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "no", data: { field: "netuid" } },
        }),
      (error: JsonRpcFailure) => {
        assert.deepEqual(error.data, { field: "netuid" });
        return true;
      },
    );
  });

  // A handler returning undefined publishes `{"result":undefined}`, which
  // JSON.stringify drops -- a reply with neither result nor error. Unreachable
  // through dispatchMessage, and deliberately loud rather than silent.
  test("refuses to publish a response that is neither", () => {
    assert.throws(
      () => unwrapDispatchResponse(null),
      (error: JsonRpcFailure) => {
        assert.equal(error.code, -32603);
        assert.equal(error.message, "Internal error.");
        return true;
      },
    );
  });
});

// The teardown guard, driven directly: it only fires when a close() rejects,
// which no request does. An unhandled rejection raised in the adapter's
// `finally` would replace the response the caller was already owed with a
// teardown error, so the swallow is load-bearing and gets exercised rather
// than assumed.
describe("closeQuietly (#9668)", () => {
  test("swallows a rejecting close", async () => {
    let called = false;
    await closeQuietly({
      close: async () => {
        called = true;
        throw new Error("transport already torn down");
      },
    });
    assert.equal(called, true, "the close was attempted, not skipped");
  });

  test("tolerates an object with no close at all", async () => {
    await closeQuietly({});
  });

  test("awaits a close that resolves", async () => {
    let closed = false;
    await closeQuietly({
      close: async () => {
        closed = true;
      },
    });
    assert.equal(closed, true);
  });
});
