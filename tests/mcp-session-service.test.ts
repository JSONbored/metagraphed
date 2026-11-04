import assert from "node:assert/strict";
import { test } from "vitest";
import { mcpSessionService } from "../src/mcp-session-service.ts";
import { chainFirehoseService } from "../src/chain-firehose-service.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { apiEnv } from "./helpers/worker-env.ts";

test("explicit realtime services preserve absent bindings and reject malformed native selections", async () => {
  assert.equal(mcpSessionService({}, "A"), undefined);
  assert.equal(chainFirehoseService({}), undefined);
  for (const value of [null, false, {}, { fetch: "invalid" }]) {
    assert.throws(
      () => mcpSessionService({ MCP_SESSION_SERVICE: value }, "A"),
      /Invalid native/,
    );
    assert.throws(
      () => chainFirehoseService({ CHAIN_FIREHOSE_SERVICE: value }),
      /Invalid native/,
    );
  }
  const calls: string[] = [];
  const native = {
    fetch: async (id: string, request: Request) => {
      calls.push(`${id}:${request.method}:${await request.text()}`);
      return new Response("native");
    },
  };
  assert.equal(
    await mcpSessionService({ MCP_SESSION_SERVICE: native }, "A")!
      .fetch("https://session.invalid/notify", {
        method: "POST",
        body: "notice",
      })
      .then((r) => r.text()),
    "native",
  );
  assert.deepEqual(calls, ["A:POST:notice"]);
  assert.equal(
    await chainFirehoseService({
      CHAIN_FIREHOSE_SERVICE: {
        fetch: async (request: Request) => new Response(request.url),
      },
    })!
      .fetch("https://chain.invalid/latest")
      .then((r) => r.text()),
    "https://chain.invalid/latest",
  );
});

test("absent native selection resolves Worker session keys and the global chain actor", async () => {
  const names: string[] = [];
  const namespace = {
    idFromName: (name: string) => {
      names.push(name);
      return name;
    },
    get: () => ({
      fetch: async (input: RequestInfo | URL) => new Response(String(input)),
    }),
  };
  const session = mcpSessionService(
    apiEnv({ MCP_SESSION_HUB: namespace }),
    "worker-session",
  )!;
  assert.equal(
    await session.fetch("https://session.invalid/notify").then((r) => r.text()),
    "https://session.invalid/notify",
  );
  const chain = chainFirehoseService(
    apiEnv({ CHAIN_FIREHOSE_HUB: namespace }),
  )!;
  assert.equal(
    await chain.fetch("https://chain.invalid/latest").then((r) => r.text()),
    "https://chain.invalid/latest",
  );
  assert.deepEqual(names, ["worker-session", "global"]);
});

test("public MCP initialization, membership, stream, termination and chain reads use explicit native services", async () => {
  const calls: { id: string; path: string; body: unknown }[] = [];
  let streamSignal: AbortSignal | undefined;
  const env = apiEnv({
    MCP_SESSION_SERVICE: {
      async fetch(id: string, request: Request) {
        const path = new URL(request.url).pathname;
        calls.push({
          id,
          path,
          body: request.method === "POST" ? await request.json() : null,
        });
        if (path === "/stream") {
          streamSignal = request.signal;
          return new Response("data: native\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response('{"ok":true}');
      },
    },
    CHAIN_FIREHOSE_SERVICE: {
      fetch: async () => new Response('{"payload":{"table":"native_chain"}}'),
    },
    MCP_SESSION_HUB: {
      get: () => {
        throw new Error("legacy session fallback");
      },
    },
    CHAIN_FIREHOSE_HUB: {
      get: () => {
        throw new Error("legacy chain fallback");
      },
    },
  });
  const rpc = (method: string, params: unknown, id?: string) =>
    handleMcpRequest(
      new Request("https://mcp.invalid/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(id ? { "mcp-session-id": id } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      env,
    );
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "native-fixture", version: "1" },
  });
  assert.equal(initialized.status, 200);
  const id = initialized.headers.get("mcp-session-id")!;
  assert.ok(id);
  const uri = "metagraph://chain/stream";
  assert.equal((await rpc("resources/subscribe", { uri }, id)).status, 200);
  const read = await rpc("resources/read", { uri }, id);
  const result = JSON.parse(await read.text());
  assert.equal(
    JSON.parse(result.result.contents[0].text).table,
    "native_chain",
  );
  env.CHAIN_FIREHOSE_SERVICE = { fetch: async () => new Response("null") };
  const invalid = await rpc("resources/read", { uri }, id);
  assert.equal(JSON.parse(await invalid.text()).error.code, -32603);
  const abort = new AbortController();
  const stream = await handleMcpRequest(
    new Request("https://mcp.invalid/mcp", {
      headers: { "mcp-session-id": id },
      signal: abort.signal,
    }),
    env,
  );
  assert.equal(await stream.text(), "data: native\n\n");
  abort.abort();
  assert.equal(streamSignal?.aborted, true);
  assert.equal((await rpc("resources/unsubscribe", { uri }, id)).status, 200);
  assert.equal(
    (
      await handleMcpRequest(
        new Request("https://mcp.invalid/mcp", {
          method: "DELETE",
          headers: { "mcp-session-id": id },
        }),
        env,
      )
    ).status,
    204,
  );
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/register", "/subscribe", "/stream", "/unsubscribe", "/terminate"],
  );
  assert.ok(calls.every((call) => call.id === id));
});
