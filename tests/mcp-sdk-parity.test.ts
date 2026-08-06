// Proves the SDK envelope answers what the hand-rolled one answers (#9647).
//
// This is the entire justification for the migration shipping behind a flag
// instead of as a cutover. The claim is that swapping envelopes changes no
// response: same results, same error codes, same error TEXT, same status, same
// headers. That claim is either falsifiable or it is a hope.
//
// So these tests drive the REAL SERVED PATH both ways -- handleMcpRequest with
// MCP_SDK_ENVELOPE unset, then the same request with it set to "1" -- and
// compare what comes back. An earlier version of this file compared the
// adapter against the dispatcher through a stub `dispatch`, which proved the
// adapter could route a method but proved nothing about the wiring around it:
// the session headers, the CORS headers, the batch guards and the Accept
// normalization all live in serveMcpThroughSdk and none of them were covered.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  handleMcpRequest,
  listToolDefinitions,
  mcpSdkEnvelopeEnabled,
} from "../src/mcp-server.ts";
import {
  closeQuietly,
  JsonRpcFailure,
  SDK_RECLAIMED_METHODS,
  serveWithSdk,
  unwrapDispatchResponse,
} from "../src/mcp-sdk-adapter.ts";
import type { Row } from "./row-type.ts";

const HAND_ROLLED = {} as unknown as Env;
const SDK = { MCP_SDK_ENVELOPE: "1" } as unknown as Env;

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
async function observe(body: unknown, env: Env, headers: Row = {}) {
  const res = await handleMcpRequest(post(body, headers), env, {});
  const text = await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    contentType: res.headers.get("content-type"),
    cors: res.headers.get("access-control-allow-origin"),
    cacheControl: res.headers.get("cache-control"),
    // NORMALIZED, not compared: a minted session id is fresh per request, so
    // comparing the values would fail on every initialize and prove nothing.
    // What must match is WHETHER one was minted -- session minting reads the
    // dispatched response, which the SDK path has to capture on its way past
    // rather than parse back out of a serialized body, and getting that wrong
    // would silently cost every caller its identity (#9054).
    sessionMinted: sessionId ? "<minted>" : null,
  };
}

/**
 * The core assertion: one request, both envelopes, no observable difference.
 *
 * Returns the shared observation so a caller can additionally assert what the
 * response actually WAS -- parity with a broken answer is still broken, and a
 * comparison-only test passes happily when both sides regress together.
 */
async function assertParity(body: unknown, headers: Row = {}) {
  const mine = await observe(body, HAND_ROLLED, headers);
  const sdk = await observe(body, SDK, headers);
  assert.deepEqual(sdk, mine);
  return mine;
}

// WITHOUT THIS, EVERY PARITY TEST ABOVE IS VACUOUS. They compare two envs and
// assert no difference -- which is exactly what a flag that never reads would
// also produce. This is the test that says the second env really does take the
// other path.
describe("the envelope flag (#9647)", () => {
  test('is off unless MCP_SDK_ENVELOPE is exactly "1"', () => {
    assert.equal(mcpSdkEnvelopeEnabled(SDK), true, "the parity fixture is on");
    assert.equal(mcpSdkEnvelopeEnabled(HAND_ROLLED), false);
    // A flag whose off state depends on a variable being unset is one stray
    // empty-string binding away from enabling itself in production.
    for (const value of ["", "0", "true", "yes", " 1", 1, null, undefined]) {
      assert.equal(
        mcpSdkEnvelopeEnabled({ MCP_SDK_ENVELOPE: value } as unknown as Env),
        false,
        `MCP_SDK_ENVELOPE=${JSON.stringify(value)} must not enable the SDK path`,
      );
    }
    assert.equal(mcpSdkEnvelopeEnabled(undefined as unknown as Env), false);
  });
});

describe("SDK envelope parity on the served path (#9647)", () => {
  test("initialize: every field, plus the registry backlink", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "parity", version: "1" },
      },
    });
    const result = (seen.body as Row).result as Row;
    // Asserted positively, not just compared: `instructions` is what tells a
    // model what this server is for, and `_meta` is the registry backlink.
    // Both were dropped by an earlier draft of the adapter and a
    // comparison-only test would have gone green once both sides lost them.
    assert.ok(result.instructions, "instructions survive the envelope");
    assert.ok(result._meta, "the registry backlink survives");
    assert.ok((result.serverInfo as Row).name);
    assert.equal(seen.sessionMinted, "<minted>", "initialize mints a session");
  });

  // The value, not just its presence -- and on the SDK path specifically. The
  // id is minted before dispatch so $mcp_initialize can carry it (#8994), then
  // read back out of the captured response; a path that captured the wrong
  // thing would still produce SOME header, so its shape gets asserted too.
  test("the minted session id is well-formed on both paths", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    };
    for (const env of [HAND_ROLLED, SDK]) {
      const res = await handleMcpRequest(post(body), env, {});
      const id = res.headers.get("mcp-session-id");
      assert.ok(id, "a session id was handed back");
      assert.match(String(id), /^[\x21-\x7E]{1,128}$/);
    }
  });

  // A FAILED initialize must mint nothing -- an id the client never received
  // would be a session the hub is holding for nobody.
  test("a refused request mints no session on either path", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 1,
      method: "no/such/method",
    });
    assert.equal(seen.sessionMinted, null);
  });

  test("initialize still negotiates a handshake with no protocolVersion", async () => {
    // The SDK's InitializeRequestSchema REQUIRES params.protocolVersion, so
    // registering a handler for it would reject this with zod's text. Total
    // delegation is what keeps it working, and this is the case that proves
    // the delegation is total rather than merely configured.
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.ok(
      ((seen.body as Row).result as Row).protocolVersion,
      "a sloppy handshake is still negotiated, not refused",
    );
  });

  test("ping", async () => {
    const seen = await assertParity({ jsonrpc: "2.0", id: 2, method: "ping" });
    assert.deepEqual((seen.body as Row).result, {});
  });

  test("tools/list publishes the identical catalogue", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    const tools = ((seen.body as Row).result as Row).tools as Row[];
    assert.equal(
      tools.length,
      listToolDefinitions().length,
      "the full catalogue, not a page",
    );
    assert.ok(tools.length > 200, `expected 200+ tools, saw ${tools.length}`);
  });

  test("prompts/list and resources/templates/list", async () => {
    await assertParity({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    await assertParity({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/templates/list",
    });
  });

  // ERROR TEXT, not just the code. This is the assertion that would have
  // failed against McpError, whose constructor rewrites every message to
  // `MCP error -32601: ...`. Parity on the code alone would have passed while
  // every error string on a public surface silently changed.
  test("an unknown method: same code AND same message", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 6,
      method: "no/such/method",
    });
    const error = (seen.body as Row).error as Row;
    assert.equal(error.code, -32601);
    assert.equal(error.message, "Unknown method: no/such/method");
  });

  test("a refused tools/list cursor keeps its code and its explanation", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { cursor: "eyJvIjoxMDB9" },
    });
    const error = (seen.body as Row).error as Row;
    assert.equal(error.code, -32602);
    assert.match(String(error.message), /not paginated/);
  });

  test("a notification is answered 202 with no body", async () => {
    const seen = await assertParity({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(seen.status, 202);
    assert.equal(seen.body, null);
  });

  test("a batch keeps its order and drops its notifications", async () => {
    const seen = await assertParity([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
    ]);
    const responses = seen.body as Row[];
    assert.equal(responses.length, 2, "the notification produced no response");
    assert.deepEqual(
      responses.map((r) => r.id),
      [1, 2],
    );
  });

  // The batch ceiling was HOISTED so both envelopes share it (the SDK's
  // transport fans out with no bound of its own). If it ever slips back inside
  // the hand-rolled branch, the flag becomes a way to turn off a resource
  // limit, and this is what says so.
  test("the batch ceiling applies to both envelopes", async () => {
    const seen = await assertParity(
      Array.from({ length: 11 }, (_, i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "ping",
      })),
    );
    assert.equal(seen.status, 400);
    assert.match(String(((seen.body as Row).error as Row).message), /maximum/);
  });

  test("an empty batch is refused identically", async () => {
    const seen = await assertParity([]);
    assert.equal(seen.status, 400);
  });

  // Most callers of this surface are scripts sending `*/*`, which fails the
  // SDK transport's literal substring test for both media types. Normalizing
  // the rebuilt request is what stops the migration presenting as "every
  // script broke", so it gets a test of its own rather than riding on the
  // default headers every other case here sends.
  test("a caller sending Accept: */* is not 406'd", async () => {
    const seen = await assertParity(
      { jsonrpc: "2.0", id: 8, method: "ping" },
      { accept: "*/*" },
    );
    assert.equal(seen.status, 200);
    assert.deepEqual((seen.body as Row).result, {});
  });

  test("a caller sending no Accept header at all is not 406'd", async () => {
    // Built by hand rather than through post(), which always supplies a
    // conformant Accept -- passing `{}` for the overrides would have left the
    // default in place and tested nothing.
    const bare = () =>
      new Request("https://api.metagraph.sh/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
      });
    assert.equal(bare().headers.get("accept"), null, "the fixture is bare");
    for (const env of [HAND_ROLLED, SDK]) {
      const res = await handleMcpRequest(bare(), env, {});
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as Row).result, {});
    }
  });

  // tools/call, through the real dispatcher. Every one of these answers
  // isError rather than a JSON-RPC error (SEP-1303, and #9646 for the unknown
  // tool), which makes them the cases where a divergence would be least
  // visible: the transport-level envelope is identical either way and the
  // difference would be buried in the result body.
  test("tools/call results, including both failure shapes", async () => {
    for (const params of [
      { name: "get_agent_catalog", arguments: {} },
      { name: "nope", arguments: {} },
      { name: "get_subnet", arguments: { netuid: "not-a-number" } },
    ]) {
      const seen = await assertParity({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params,
      });
      assert.ok((seen.body as Row).result, `${params.name} answered a result`);
    }
  });

  // EVERY CASE BELOW WAS A MEASURED DIVERGENCE before the dispatchable-message
  // gate (#9647). The SDK transport answers all of them
  // `400 -32700 Parse error: Invalid JSON-RPC message`; this server answers
  // -32600 inside a 200, or 202 for an id-less one. Left ungated, flipping the
  // flag would have changed the error code, the HTTP status and -- for the
  // mixed batch -- whether the valid members ran at all.
  describe("malformed input never reaches the SDK", () => {
    for (const [label, body] of [
      ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
      ["a missing method", { jsonrpc: "2.0", id: 1 }],
      ["a non-string method", { jsonrpc: "2.0", id: 1, method: 5 }],
    ] as Array<[string, unknown]>) {
      test(`${label} stays -32600 inside a 200`, async () => {
        const seen = await assertParity(body);
        assert.equal(seen.status, 200);
        assert.equal((seen.body as Row).error.code, -32600);
        assert.equal(
          (seen.body as Row).error.message,
          "Invalid JSON-RPC request.",
        );
      });
    }

    for (const [label, body] of [
      ["a null body", null],
      ["a scalar body", 42],
    ] as Array<[string, unknown]>) {
      test(`${label} stays 202`, async () => {
        const seen = await assertParity(body);
        assert.equal(seen.status, 202);
        assert.equal(seen.body, null);
      });
    }

    // The one that loses data rather than merely relabelling it.
    test("a mixed batch still answers its valid members", async () => {
      const seen = await assertParity([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "1.0", id: 2, method: "ping" },
      ]);
      assert.equal(seen.status, 200);
      const responses = seen.body as Row[];
      assert.deepEqual(responses[0], {
        jsonrpc: "2.0",
        id: 1,
        result: {},
      });
      assert.equal((responses[1].error as Row).code, -32600);
    });

    test("a body that is not JSON at all is refused identically", async () => {
      const res = await Promise.all(
        [HAND_ROLLED, SDK].map(async (env) => {
          const r = await handleMcpRequest(
            new Request("https://api.metagraph.sh/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: "{not json",
            }),
            env,
            {},
          );
          return { status: r.status, body: await r.text() };
        }),
      );
      assert.deepEqual(res[1], res[0]);
      assert.equal(res[0].status, 400);
    });
  });

  // The headers the transport does NOT set. It emits a bare
  // `content-type: application/json` and nothing at all on a 202, so without
  // the MCP_HEADERS overlay the CORS header and `cache-control: no-store`
  // would vanish the moment the flag flipped -- a caching change and a
  // browser-client breakage with nothing to do with JSON-RPC.
  test("CORS and cache-control survive both envelopes", async () => {
    for (const body of [
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) {
      const seen = await assertParity(body);
      assert.equal(seen.cors, "*");
      assert.equal(seen.cacheControl, "no-store");
      assert.equal(seen.contentType, "application/json; charset=utf-8");
    }
  });
});

// INVISIBLE TO A RESPONSE COMPARISON, which is why it gets its own test. The
// SDK's Protocol dispatches notifications fire-and-forget, so the 202 returns
// while the handler is still running; on Workers the request context is then
// torn down with the telemetry write unfinished. Every parity test above
// passes either way -- the HTTP response is identical -- and the only symptom
// would have been notifications/initialized quietly disappearing from PostHog
// after the flag flipped.
describe("a notification's dispatch completes before the response (#9647)", () => {
  test("the funnel has finished, not merely started, when serveWithSdk resolves", async () => {
    const events: string[] = [];
    await serveWithSdk(
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
      }),
      {
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
      },
    );
    assert.deepEqual(events, [
      "start:notifications/initialized",
      "done:notifications/initialized",
    ]);
  });

  test("a rejecting notification dispatch never becomes the response", async () => {
    const res = await serveWithSdk(
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
      }),
      {
        serverInfo: { name: "n", version: "1" },
        capabilities: { tools: {} },
        dispatch: async () => {
          throw new Error("telemetry backend is down");
        },
      },
    );
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
        capabilities: {
          tools: {},
          resources: { subscribe: true },
          prompts: {},
        },
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
      {
        capabilities: {
          tools: {},
          resources: { subscribe: true },
          prompts: {},
        },
      },
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

// The one place the two envelopes' conventions are translated, and so the one
// place a mistranslation could hide.
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
