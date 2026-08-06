// Proves the SDK envelope answers what the hand-rolled one answers (#9647).
//
// This is the entire justification for step 1 existing as its own PR. The
// migration is an ENVELOPE SWAP: no tool's behaviour, schema or error shape is
// meant to change. That claim is either falsifiable or it is a hope, and these
// tests are what make it falsifiable -- both implementations are driven with
// the same requests and their published output compared, so a port that
// changes a response fails here rather than in production.
//
// `/mcp` still answers from src/mcp-server.ts. Nothing in this file touches
// the served path.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import {
  closeQuietly,
  mergeInitializeMeta,
  serveWithSdk,
} from "../src/mcp-sdk-adapter.ts";
import type { Row } from "./row-type.ts";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const post = (body: unknown) =>
  new Request("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });

/** The current server's answer. */
async function viaHandRolled(body: unknown): Promise<Row> {
  const res = await handleMcpRequest(post(body), {} as unknown as Env, {});
  return (await res.json()) as Row;
}

/**
 * The SDK's answer.
 *
 * Parsed as a bare JSON body, deliberately: the adapter sets
 * `enableJsonResponse` so the transport answers the same shape the hand-rolled
 * dispatcher does. If that is ever dropped, the transport falls back to SSE
 * framing (`event: message\ndata: {...}`) and this parse fails -- which is the
 * correct outcome, because a client parsing our responses today would fail the
 * same way.
 */
async function viaSdk(
  body: unknown,
  dispatch = passthroughDispatch,
): Promise<Row> {
  const res = await serveWithSdk(post(body), {
    tools: listToolDefinitions() as Array<
      Record<string, unknown> & { name: string }
    >,
    dispatch,
  });
  return (await res.json()) as Row;
}

/** Stands in for dispatchTool; step 2 replaces it with the real funnel. */
let dispatched: Array<{ name: string; args: unknown }> = [];
const passthroughDispatch = async (
  name: string,
  args?: Record<string, unknown>,
) => {
  dispatched.push({ name, args });
  return { content: [{ type: "text", text: `ok:${name}` }], isError: false };
};

describe("SDK envelope parity with the hand-rolled dispatcher (#9647)", () => {
  test("tools/list publishes the identical catalogue", async () => {
    const mine = await viaHandRolled({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const sdk = await viaSdk({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    const a = (mine.result as Row).tools as Row[];
    const b = (sdk.result as Row).tools as Row[];
    assert.ok(a.length > 200, `expected the full catalogue, got ${a.length}`);
    assert.equal(b.length, a.length, "tool count must match");

    // Compared whole, not sampled: a per-tool diff is exactly the thing that
    // would be missed by checking three of 224.
    assert.deepEqual(
      JSON.parse(JSON.stringify(b)),
      JSON.parse(JSON.stringify(a)),
      "every published field of every tool must survive the envelope swap",
    );
  });

  // THE WHOLE PAYLOAD, not a field or two. The first version of this test
  // compared serverInfo.version and protocolVersion and called it "identity" --
  // which would have passed while silently dropping `instructions` (what tells
  // a model what this server is FOR), serverInfo.title/description, and the
  // `_meta` registry backlink. `initialize` is handled INSIDE the SDK's Server
  // rather than by a handler we register, so every one of those fields has to
  // arrive through the constructor or a shim, and only a whole-payload compare
  // proves it did.
  test("initialize is byte-identical, every field", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "parity", version: "1" },
      },
    };
    const mine = (await viaHandRolled(body)).result as Row;
    const sdk = (await viaSdk(body)).result as Row;

    // Named first so a failure says WHICH field went missing rather than
    // dumping two large objects at the reader.
    assert.deepEqual(
      Object.keys(sdk).sort(),
      Object.keys(mine).sort(),
      "the handshake's field set must not change",
    );
    for (const key of ["instructions", "protocolVersion"]) {
      assert.deepEqual(sdk[key], mine[key], `initialize.${key} differs`);
    }
    assert.deepEqual(sdk.serverInfo, mine.serverInfo);
    assert.deepEqual(sdk.capabilities, mine.capabilities);
    assert.deepEqual(sdk._meta, mine._meta, "the registry backlink survives");
    assert.deepEqual(sdk, mine);
  });

  test("tools/call reaches the dispatch funnel with the caller's arguments", async () => {
    dispatched = [];
    const sdk = await viaSdk({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_subnet", arguments: { netuid: 64 } },
    });
    assert.deepEqual(dispatched, [
      { name: "get_subnet", args: { netuid: 64 } },
    ]);
    assert.equal((sdk.result as Row).isError, false);
  });

  // The property step 2 depends on: ONE funnel. If the SDK path ever dispatched
  // somewhere else, the telemetry #8993/#9639/#9642 hang off that single point
  // would silently stop covering it.
  test("every tools/call goes through the funnel exactly once", async () => {
    dispatched = [];
    for (const name of ["get_subnet", "get_economics", "list_subnets"]) {
      await viaSdk({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      });
    }
    assert.equal(dispatched.length, 3);
    assert.deepEqual(
      dispatched.map((d) => d.name),
      ["get_subnet", "get_economics", "list_subnets"],
    );
  });

  // Nothing may outlive its request: on Workers an object that survives is
  // shared with the next caller. Re-running the same request must be clean,
  // which is also what the transport's own reuse ban is protecting.
  test("a fresh server and transport per request, with no bleed between them", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const first = await viaSdk(body);
    const second = await viaSdk(body);
    assert.deepEqual(
      (second.result as Row).tools,
      (first.result as Row).tools,
      "a reused-transport error would surface as a failed second request",
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

// The shim restoring the one initialize field the SDK drops. Narrow by design:
// a compatibility patch that can turn a valid response into an invalid one is
// worse than the gap it closes, so every guard is exercised.
describe("mergeInitializeMeta (#9668)", () => {
  const initResult = (extra: Row = {}) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "x" },
        ...extra,
      },
    });

  test("adds _meta to an initialize result that lacks it", () => {
    const out = JSON.parse(mergeInitializeMeta(initResult())) as Row;
    assert.ok((out.result as Row)._meta, "the registry backlink is restored");
  });

  test("never overwrites a _meta the SDK did produce", () => {
    const out = JSON.parse(
      mergeInitializeMeta(initResult({ _meta: { mine: true } })),
    ) as Row;
    assert.deepEqual((out.result as Row)._meta, { mine: true });
  });

  // Anything that is not an initialize result must come back untouched --
  // byte-identical, not merely equivalent, since this runs on every response.
  test("leaves a non-initialize payload byte-identical", () => {
    for (const body of [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "no" },
      }),
      JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]),
      "",
    ]) {
      assert.equal(mergeInitializeMeta(body), body);
    }
  });

  test("returns unparseable input unchanged rather than throwing", () => {
    assert.equal(mergeInitializeMeta("{not json"), "{not json");
  });
});
