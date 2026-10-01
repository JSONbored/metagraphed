import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { authLookupCacheWrite } from "../src/auth-lookup-cache.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv, type Row } from "./row-type.ts";

const API_KEY = "mg_required_auth_synthetic_credential";
const ACCOUNT = 7;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "required-auth-fixture", version: "1" },
  },
};

function request(body: unknown, path = "/mcp", headers: Row = {}) {
  return new Request(`https://api.metagraph.sh${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fixture(tier = "free") {
  const store = new Map<string, string>();
  const paths: string[] = [];
  let state = "active";
  let tierAvailable = true;
  let accountId: string | null = String(ACCOUNT);
  let quotaAllowed = true;
  const anonymous = vi.fn(async () => ({ success: true }));
  const keyed = vi.fn(async () => ({ success: true }));
  const kv = {
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    }),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
  const env = mockEnv({
    METAGRAPH_CONTROL: kv,
    MCP_RATE_LIMITER: { limit: anonymous },
    MCP_RATE_LIMITER_KEYED: { limit: keyed },
    MCP_RATE_LIMITER_PAID: { limit: keyed },
    API_KEY_LOOKUP_INTERNAL_TOKEN: "synthetic-lookup-token",
    DATA_API: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        paths.push(path);
        if (path.endsWith("/github/tier"))
          return Response.json(
            tierAvailable ? { found: true, tier } : { found: false },
          );
        if (path.endsWith("/keys/verify"))
          return Response.json({
            valid: true,
            keyId: "key_required_auth",
            managed: true,
            tier,
            accountId,
          });
        if (path.endsWith("/keys/state")) return Response.json({ state });
        if (path.endsWith("/keys/quota"))
          return Response.json({
            allowed: quotaAllowed,
            used: 1,
            limit: 1000,
            remaining: 999,
            resetAt: "2026-10-01T00:00:00Z",
          });
        assert.ok(path.endsWith("/keys/usage"), path);
        return Response.json({ ok: true });
      },
    },
  });
  const deps = {
    requireAuthentication: true,
    executionCtx: { props: { accountId: ACCOUNT }, waitUntil() {} },
  };
  return {
    env,
    deps,
    paths,
    store,
    kv,
    anonymous,
    keyed,
    setState(value: string) {
      state = value;
    },
    loseTier() {
      tierAvailable = false;
    },
    identitylessKey(value: string | null = null) {
      accountId = value;
    },
    exhaustQuota() {
      quotaAllowed = false;
    },
  };
}

describe("required authentication at the public MCP router", () => {
  test("every mount and profile refuses before reading even malformed bodies", async () => {
    for (const path of [
      "/mcp",
      "/mcp/",
      "/mcp/core",
      "/mcp/core/",
      "/mcp?catalog=full",
      "/mcp?search_page_size=1",
    ]) {
      for (const body of [
        initialize,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        [initialize],
        "invalid JSON",
      ]) {
        const f = fixture();
        const req = request(body, path);
        const res = await handleRequest(req, f.env, {});
        assert.equal(res.status, 401, path);
        assert.equal(req.bodyUsed, false);
        assert.match(
          res.headers.get("www-authenticate")!,
          new RegExp(`oauth-protected-resource${new URL(req.url).pathname}"`),
        );
        assert.equal(res.headers.get("access-control-allow-origin"), "*");
        assert.deepEqual(
          f.paths,
          [],
          "no account lookup, quota or artifact dispatch",
        );
        assert.match(
          (await res.json()).error_description,
          /Authentication required to use Metagraphed MCP/,
        );
      }
    }
  });

  test("headers, sessions, a GitHub label and an invalid account do not prove access", async () => {
    for (const props of [
      {},
      { githubLogin: "fixture" },
      { accountId: "invalid" },
    ]) {
      const f = fixture();
      const req = request(initialize, "/mcp", {
        authorization: "Bearer unverified",
        "mcp-session-id": "other-account-session",
      });
      const res = await handleMcpRequest(req, f.env, {
        requireAuthentication: true,
        executionCtx: { waitUntil() {}, props },
      });
      assert.equal(res.status, 401);
      assert.equal(req.bodyUsed, false);
      assert.deepEqual(f.paths, []);
    }
  });

  test("authenticated account resolution failure refuses with retry advice, then recovers", async () => {
    const f = fixture();
    f.loseTier();
    const req = request(initialize);
    const res = await handleMcpRequest(req, f.env, f.deps);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.equal(req.bodyUsed, false);
    assert.deepEqual(f.paths, ["/api/v1/internal/accounts/github/tier"]);
    f.store.set(
      "oauth-account-tier:v2:7",
      authLookupCacheWrite(
        { found: true, tier: "free" },
        { positiveTtlSeconds: 300, negativeTtlSeconds: 30 },
      ).value,
    );
    assert.equal(
      (await handleMcpRequest(request(initialize), f.env, f.deps)).status,
      200,
    );
  });

  test.each([null, "", " "])(
    "a verified key without an account (%j) is challenged",
    async (account) => {
      const f = fixture();
      f.identitylessKey(account);
      const req = request(initialize, "/mcp", {
        authorization: `Bearer ${API_KEY}`,
      });
      assert.equal(
        (await handleMcpRequest(req, f.env, { requireAuthentication: true }))
          .status,
        401,
      );
      assert.equal(req.bodyUsed, false);
      assert.equal(f.paths.filter((p) => p.endsWith("/quota")).length, 0);
    },
  );

  test("managed API keys retain live revocation checks without a second verification", async () => {
    const f = fixture();
    const post = () =>
      request(initialize, "/mcp", { authorization: `Bearer ${API_KEY}` });
    const first = await handleRequest(post(), f.env, {});
    assert.equal(first.status, 200);
    assert.equal((await handleRequest(post(), f.env, {})).status, 200);
    assert.equal(f.paths.filter((p) => p.endsWith("/verify")).length, 1);
    assert.equal(f.paths.filter((p) => p.endsWith("/state")).length, 1);
    assert.equal(f.paths.filter((p) => p.endsWith("/quota")).length, 0);
    f.setState("revoked");
    const req = post();
    assert.equal((await handleRequest(req, f.env, {})).status, 401);
    assert.equal(req.bodyUsed, false);
    assert.equal(f.paths.filter((p) => p.endsWith("/quota")).length, 0);
  });

  test("rate-limit rejection stays ahead of auth and account quotas remain enforced", async () => {
    const f = fixture();
    f.anonymous.mockResolvedValue({ success: false });
    const req = request(initialize);
    assert.equal((await handleRequest(req, f.env, {})).status, 429);
    assert.equal(req.bodyUsed, false);
    assert.deepEqual(f.paths, []);
    const keyed = fixture("paid");
    keyed.exhaustQuota();
    const res = await handleMcpRequest(
      request(initialize),
      keyed.env,
      keyed.deps,
    );
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("x-ratelimit-scope"), "daily-quota");
  });

  test("account blocks still refuse before body parsing and quota spending", async () => {
    const f = fixture();
    f.store.set(
      "api-key-blocklist",
      JSON.stringify({
        blocks: [
          {
            accountId: ACCOUNT,
            accountKind: "github",
            reasonCode: "abuse_manual",
          },
        ],
      }),
    );
    const req = request(initialize);
    const res = await handleMcpRequest(req, f.env, f.deps);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("x-ratelimit-scope"), "blocked");
    assert.equal(req.bodyUsed, false);
    assert.equal(f.paths.filter((p) => p.endsWith("/quota")).length, 0);
  });

  test("stream and termination requests require an account rather than just a session", async () => {
    for (const method of ["GET", "DELETE"]) {
      const f = fixture();
      const req = new Request("https://api.metagraph.sh/mcp", {
        method,
        headers: { "mcp-session-id": "other-account-session" },
      });
      assert.equal((await handleRequest(req, f.env, {})).status, 401);
    }
  });

  test("account-authenticated profiles retain dispatch, schemas, batches and notification bytes", async () => {
    for (const path of ["/mcp", "/mcp/core", "/mcp?catalog=full"]) {
      for (const body of [
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        [
          { jsonrpc: "2.0", id: 3, method: "ping" },
          { jsonrpc: "2.0", id: 4, method: "prompts/list" },
        ],
        { jsonrpc: "2.0", id: 5, method: "missing_method" },
      ]) {
        const f = fixture();
        const baseline = await handleMcpRequest(
          request(body, path, { "mcp-protocol-version": "2025-03-26" }),
          f.env,
          {
            ...f.deps,
            requireAuthentication: false,
          },
        );
        const actual = await handleMcpRequest(
          request(body, path, { "mcp-protocol-version": "2025-03-26" }),
          f.env,
          f.deps,
        );
        assert.equal(actual.status, baseline.status);
        assert.equal(await actual.text(), await baseline.text());
        assert.equal(
          f.paths.filter((p) => p.endsWith("/github/tier")).length,
          1,
          "the gate reuses the cached account lookup",
        );
      }
    }
  });
});
