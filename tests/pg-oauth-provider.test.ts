import assert from "node:assert/strict";
import { afterAll, beforeAll, test, vi } from "vitest";
import type {
  OAuthHelpers,
  OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createPgOAuthProvider } from "../src/pg-oauth-provider.ts";
import type { NativeOAuthModule } from "../src/native-oauth-provider.ts";
import { createPgKv, type PgKvRuntime } from "../src/pg-kv.ts";
import type { AppKv } from "../src/app-kv-types.ts";
import {
  buildOAuthProviderOptions,
  handleAuthorizeRequest,
} from "../src/github-oauth.ts";
import {
  nativeOAuthFixture,
  oauthOptions,
  oauthContext,
} from "./helpers/native-oauth-fixture.ts";

function harness(options: OAuthProviderOptions<object> = oauthOptions) {
  let active = false,
    transactions = 0,
    status = 200,
    fail = false;
  const statements: string[] = [];
  const calls: { name: string; active: boolean; env: object }[] = [];
  const runtime: PgKvRuntime = {
    producer: {
      async query() {
        assert.equal(active, false);
        return [];
      },
      async first() {
        assert.equal(active, false);
        return null;
      },
      async run() {
        assert.equal(active, false);
        return { changes: 1 };
      },
    },
    async transaction(callback, settings) {
      assert.deepEqual(settings, { isolation: "read committed" });
      assert.equal(
        active,
        false,
        "nested operation checked out a second lease",
      );
      transactions += 1;
      active = true;
      try {
        return await callback({
          async query(text) {
            statements.push(text);
            return [];
          },
          async first() {
            return null;
          },
          async run(text) {
            statements.push(text);
            return { changes: 1 };
          },
        });
      } finally {
        active = false;
      }
    },
  };
  const upstream = {
    OAuthProvider: class {
      async fetch(
        _request: Request,
        env: { OAUTH_KV: AppKv; OAUTH_PROVIDER: OAuthHelpers },
      ) {
        calls.push({ name: "fetch", active, env });
        assert.ok(env.OAUTH_PROVIDER);
        if (fail) throw new Error("provider failed");
        return new Response("upstream", { status });
      }
    },
    getOAuthApi(_options: unknown, env: object) {
      return Object.fromEntries(
        [
          "parseAuthRequest",
          "lookupClient",
          "listClients",
          "listUserGrants",
          "unwrapToken",
          "completeAuthorization",
          "createClient",
          "updateClient",
          "deleteClient",
          "revokeGrant",
          "exchangeToken",
          "purgeExpiredData",
        ].map((name) => [
          name,
          async () => {
            calls.push({ name, active, env });
            if (name === "completeAuthorization") {
              await (env as { OAUTH_KV: AppKv }).OAUTH_KV.consume!("nested");
            }
            return name;
          },
        ]),
      );
    },
  } as unknown as NativeOAuthModule;
  return {
    provider: createPgOAuthProvider(runtime, upstream, options),
    upstream,
    runtime,
    calls,
    statements,
    transactions: () => transactions,
    status: (value: number) => {
      status = value;
    },
    fail: () => {
      fail = true;
    },
  };
}

test("helper mutations use fresh scoped environments and one READ COMMITTED namespace lock", async () => {
  const h = harness(),
    env = {};
  const helpers = h.provider.helpers(env);
  await helpers.parseAuthRequest(new Request("https://example.com"));
  await helpers.lookupClient("client");
  await helpers.listClients();
  await helpers.listUserGrants("user");
  await helpers.unwrapToken<{ user: string }>("token");
  assert.equal(h.transactions(), 0);
  const methods = [
    "completeAuthorization",
    "createClient",
    "updateClient",
    "deleteClient",
    "revokeGrant",
    "exchangeToken",
    "purgeExpiredData",
  ] as const;
  for (const method of methods) {
    const invoke = helpers[method] as (...args: unknown[]) => Promise<unknown>;
    assert.equal(await invoke("first", "second"), method);
  }
  assert.equal(h.transactions(), methods.length);
  assert.deepEqual(
    h.calls.map((call) => call.active),
    [false, false, false, false, false, ...methods.map(() => true)],
  );
  assert.equal(new Set(h.calls.map((call) => call.env)).size, h.calls.length);
  assert.deepEqual(env, {});
  for (let index = 0; index < methods.length; index += 1) {
    assert.equal(
      h.statements[index * 2],
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    );
    assert.match(h.statements[index * 2 + 1], /pg_advisory_xact_lock/);
  }
});

test("endpoint dispatch preserves responses and errors without holding an application lease", async () => {
  const h = harness(),
    env = {};
  for (const path of ["/oauth/token", "/oauth/register"]) {
    for (const status of [200, 400, 500]) {
      h.status(status);
      const response = await h.provider.fetch(
        new Request(`https://server.example${path}`),
        env,
        oauthContext,
      );
      assert.equal(response.status, status);
      assert.equal(await response.text(), "upstream");
    }
  }
  assert.equal(h.transactions(), 6);
  await h.provider.fetch(
    new Request("https://server.example/oauth/token", { method: "OPTIONS" }),
    env,
    oauthContext,
  );
  await h.provider.fetch(
    new Request("https://server.example/mcp"),
    env,
    oauthContext,
  );
  assert.equal(h.transactions(), 6);
  assert.deepEqual(
    h.calls.slice(-2).map((call) => call.active),
    [false, false],
  );
  assert.deepEqual(env, {});
  h.fail();
  await assert.rejects(
    h.provider.fetch(
      new Request("https://server.example/oauth/token"),
      env,
      oauthContext,
    ),
    /provider failed/,
  );
});

test("absolute endpoint matching follows the upstream hostname and path rules", async () => {
  const h = harness({
    ...oauthOptions,
    tokenEndpoint: "https://oauth.example:443/exchange",
    clientRegistrationEndpoint: undefined,
  });
  await h.provider.fetch(
    new Request("http://oauth.example:8080/exchange?x=1"),
    {},
    oauthContext,
  );
  assert.equal(h.transactions(), 1);
  await h.provider.fetch(
    new Request("https://other.example/exchange"),
    {},
    oauthContext,
  );
  await h.provider.fetch(
    new Request("https://oauth.example/other"),
    {},
    oauthContext,
  );
  assert.equal(h.transactions(), 1);
});

test("production CIMD options require the still-separate native public fetch capability", () => {
  const h = harness();
  assert.throws(
    () =>
      createPgOAuthProvider(
        h.runtime,
        h.upstream,
        buildOAuthProviderOptions({ fetch: async () => new Response() }),
      ),
    /public-only fetch capability/,
  );
  assert.throws(
    () =>
      harness({
        ...oauthOptions,
        enterpriseManagedAuthorization: {
          trustedIssuers: async () => null,
          mapClaims: async () => null,
        },
      }),
    /public-only fetch capability/,
  );
});

let native: Awaited<ReturnType<typeof nativeOAuthFixture>>;
beforeAll(async () => {
  native = await nativeOAuthFixture();
});
afterAll(async () => {
  await native.close();
});

test("the real generated provider registers a client through the scoped native KV", async () => {
  const h = harness();
  const provider = createPgOAuthProvider(
    h.runtime,
    native.module,
    oauthOptions,
  );
  const response = await provider.fetch(
    new Request("https://server.example/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    }),
    {},
    oauthContext,
  );
  assert.equal(response.status, 201);
  assert.equal(
    ((await response.json()) as { token_endpoint_auth_method: string })
      .token_endpoint_auth_method,
    "none",
  );
  assert.match(h.statements[2], /INSERT INTO auth.kv_entries/);
});

test("GitHub authorization uses an explicitly supplied provider helper", async () => {
  let parsed = false;
  const env = {
    OAUTH_PENDING_STORE: createPgKv(harness().runtime, "oauth-pending"),
    GITHUB_OAUTH_CLIENT_ID: "fixture",
    GITHUB_OAUTH_CLIENT_SECRET: "fixture",
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => {
        parsed = true;
        throw new Error("fixture-invalid-request");
      },
    },
  } as unknown as Env;
  const response = await handleAuthorizeRequest(
    new Request("https://server.example/authorize"),
    env,
  );
  assert.equal(parsed, true);
  assert.equal(response.status, 400);
});

test("GitHub authorization retains the existing lazy Worker helper fallback", async () => {
  let called = false;
  vi.doMock("@cloudflare/workers-oauth-provider", () => ({
    getOAuthApi: () => ({
      parseAuthRequest: async () => {
        called = true;
        throw new Error("fixture-invalid-request");
      },
    }),
  }));
  try {
    const response = await handleAuthorizeRequest(
      new Request("https://server.example/authorize"),
      {
        OAUTH_PENDING_STORE: createPgKv(harness().runtime, "oauth-pending"),
        GITHUB_OAUTH_CLIENT_ID: "fixture",
        GITHUB_OAUTH_CLIENT_SECRET: "fixture",
      } as unknown as Env,
    );
    assert.equal(called, true);
    assert.equal(response.status, 400);
  } finally {
    vi.doUnmock("@cloudflare/workers-oauth-provider");
  }
});
