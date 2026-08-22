// #11563: a protected tool called without an identity must fail the HTTP
// REQUEST with 401, not return a tool error inside a 200.
//
// The MCP authorization spec and Claude's lazy-authentication guidance agree on
// what the old shape did: a 200 carrying `isError: true` is an application
// failure, so the client hands the text to the model and moves on -- no sign-in
// is ever offered. Only a transport-level 401 makes a client pause, run the
// authorization flow, and retry.
//
// The measured consequence of the old shape is why this exists: five accounts
// completed the GitHub flow unprompted and everyone else stayed anonymous,
// because nothing in the surface ever asked (#11562).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AUTH_REQUIRED_TOOL_NAMES,
  authRequiredToolsIn,
  handleMcpRequest,
  mcpAuthChallenge,
} from "../src/mcp-server.ts";
import { mockEnv, type Row } from "./row-type.ts";

const PROTECTED = "list_surface_credentials";
const PUBLIC = "get_coverage";

function env() {
  return mockEnv({
    MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MCP_RATE_LIMITER_KEYED: { limit: async () => ({ success: true }) },
  } as Row);
}

function rpc(name: string, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name } };
}

function post(body: unknown, path = "/mcp") {
  return new Request(`https://api.metagraph.sh${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

/** An OAuth-authenticated caller, the way the provider presents one. */
const authed = { executionCtx: { waitUntil() {}, props: { accountId: 7 } } };

describe("authRequiredToolsIn", () => {
  test("names the protected tools in a single call", () => {
    assert.deepEqual(authRequiredToolsIn(rpc(PROTECTED)), [PROTECTED]);
  });

  test("finds one hidden among public calls in a legacy batch", () => {
    // A batch is one HTTP request, so a protected call buried in it must still
    // challenge -- otherwise the gate is bypassed by adding a public sibling.
    const batch = [rpc(PUBLIC, 1), rpc(PROTECTED, 2), rpc(PUBLIC, 3)];
    assert.deepEqual(authRequiredToolsIn(batch), [PROTECTED]);
  });

  test("ignores everything that is not a protected tools/call", () => {
    for (const body of [
      rpc(PUBLIC),
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      {},
      null,
      [],
      "not an object",
    ]) {
      assert.deepEqual(authRequiredToolsIn(body), [], JSON.stringify(body));
    }
  });

  test("covers every declared protected tool, so the set cannot drift", () => {
    for (const name of AUTH_REQUIRED_TOOL_NAMES) {
      assert.deepEqual(authRequiredToolsIn(rpc(name)), [name], name);
    }
  });
});

describe("mcpAuthChallenge", () => {
  test("is a 401 whose WWW-Authenticate points at this path's metadata", () => {
    const res = mcpAuthChallenge(post(rpc(PROTECTED)), [PROTECTED]);
    assert.equal(res.status, 401);
    const header = res.headers.get("www-authenticate")!;
    assert.match(header, /^Bearer /);
    assert.match(header, /error="invalid_token"/);
    assert.match(header, /scope="profile"/);
    assert.match(
      header,
      /resource_metadata="https:\/\/api\.metagraph\.sh\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  test("the metadata pointer follows the mount path, not a hard-coded /mcp", () => {
    // RFC 9728 requires the document's `resource` to match the URL the caller
    // used, and this server is mounted at both /mcp and the /mcp/core listing
    // profile. A hard-coded pointer would hand a core caller a document
    // describing a different resource, which a client is right to reject.
    const res = mcpAuthChallenge(post(rpc(PROTECTED), "/mcp/core"), [
      PROTECTED,
    ]);
    assert.match(
      res.headers.get("www-authenticate")!,
      /oauth-protected-resource\/mcp\/core"/,
    );
  });

  test("names the tools that need the identity", async () => {
    const res = mcpAuthChallenge(post(rpc(PROTECTED)), [PROTECTED]);
    const body = (await res.json()) as Row;
    assert.equal(body.error, "invalid_token");
    assert.match(String(body.error_description), new RegExp(PROTECTED));
  });
});

describe("handleMcpRequest — the gate end to end", () => {
  test("an anonymous protected call is a 401, NOT a 200 tool error", async () => {
    const res = await handleMcpRequest(post(rpc(PROTECTED)), env(), {});
    assert.equal(res.status, 401);
    assert.ok(res.headers.get("www-authenticate"), "carries the challenge");
    // The regression this pins: a 200 here produces no sign-in prompt at all.
    assert.notEqual(res.status, 200);
  });

  test("an anonymous PUBLIC call is still served", async () => {
    // The server stays "an OAuth 2.1 protected resource that permits anonymous
    // access" (ADR 0027). This narrows the challenge to protected calls; it
    // does not gate the surface.
    const res = await handleMcpRequest(post(rpc(PUBLIC)), env(), {});
    assert.equal(res.status, 200);
  });

  test("initialize and tools/list are never challenged", async () => {
    for (const method of ["initialize", "tools/list"]) {
      const res = await handleMcpRequest(
        post({ jsonrpc: "2.0", id: 1, method, params: {} }),
        env(),
        {},
      );
      assert.equal(res.status, 200, method);
    }
  });

  test("an authenticated caller reaches the tool", async () => {
    const res = await handleMcpRequest(post(rpc(PROTECTED)), env(), authed);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("www-authenticate"), null);
  });

  test("a batch hiding a protected call is challenged as a whole", async () => {
    // Stated behaviour, not incidental: the challenge is a property of the HTTP
    // request, and a batch is one request. Serving the public siblings and
    // failing only the protected one would put the refusal back inside a 200 --
    // exactly the shape this issue removes.
    const res = await handleMcpRequest(
      post([rpc(PUBLIC, 1), rpc(PROTECTED, 2)]),
      env(),
      {},
    );
    assert.equal(res.status, 401);
  });

  test("the handler's own check survives as defence in depth", async () => {
    // The gate is transport-level; the tool itself is still the authority. A
    // future caller that reaches the handler another way must not be served,
    // so the in-handler refusal is deliberately NOT removed.
    const res = await handleMcpRequest(post(rpc(PROTECTED)), env(), {});
    assert.equal(res.status, 401);
    for (const name of AUTH_REQUIRED_TOOL_NAMES) {
      const one = await handleMcpRequest(post(rpc(name)), env(), {});
      assert.equal(one.status, 401, name);
    }
  });
});
