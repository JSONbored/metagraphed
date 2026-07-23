import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import {
  buildOAuthProviderOptions,
  handleAuthorizeRequest,
  handleGithubOAuthCallback,
  isAnonymousMcpRequest,
  OAUTH_PENDING_TTL_SECONDS,
  UNUSED_DEFAULT_HANDLER,
} from "../src/github-oauth.ts";
import type { Row } from "./row-type.ts";
// Type-only -- fully erased, no runtime cost, safe even though the real
// package can't load in plain Node (see the vi.mock comment below).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// @cloudflare/workers-oauth-provider's real runtime file imports
// "cloudflare:workers" at module scope (see src/github-oauth.ts's own
// header) -- can't load in plain Node. vi.mock replaces module RESOLUTION
// itself, so this fake is used instead and the real package is never
// touched, even by the production (no deps.getHelpers override) code path
// this exists to cover.
const getOAuthApiMock = vi.fn();
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  getOAuthApi: (...args: unknown[]) => getOAuthApiMock(...args),
}));

beforeEach(() => {
  getOAuthApiMock.mockReset();
});

function createFakeKv() {
  const store = new Map();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key).value : null;
    },
    async put(key: string, value: unknown, opts: unknown) {
      store.set(key, { value, opts });
    },
    async delete(key: string) {
      store.delete(key);
    },
    _store: store,
  };
}

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    OAUTH_KV: createFakeKv(),
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DATA_API: { fetch: async () => new Response(JSON.stringify({ id: 1 })) },
    ...overrides,
  } as unknown as Env;
}

const FAKE_AUTH_REQUEST = {
  responseType: "code",
  clientId: "mcp-client",
  redirectUri: "https://client.example/callback",
  scope: ["profile"],
  state: "client-state",
};

function fakeHelpers(overrides: Record<string, unknown> = {}): OAuthHelpers {
  return {
    parseAuthRequest: async () => FAKE_AUTH_REQUEST,
    lookupClient: async () => ({ clientId: "mcp-client" }),
    completeAuthorization: async () => ({
      redirectTo: "https://client.example/callback?code=abc",
    }),
    ...overrides,
  } as unknown as OAuthHelpers;
}

describe("UNUSED_DEFAULT_HANDLER", () => {
  test("fetch() is a well-formed placeholder -- never actually invoked in production", async () => {
    const res = await UNUSED_DEFAULT_HANDLER.fetch();
    assert.equal(res.status, 500);
    assert.match(await res.text(), /not used outside OAuthProvider\.fetch\(\)/);
  });
});

describe("buildOAuthProviderOptions", () => {
  test("is pure and matches the MCP-only apiRoute shape", () => {
    const defaultHandler = { fetch: async () => new Response("default") };
    const options = buildOAuthProviderOptions(defaultHandler);
    assert.equal(options.apiRoute, "/mcp");
    assert.equal(options.authorizeEndpoint, "/authorize");
    assert.equal(options.tokenEndpoint, "/oauth/token");
    assert.equal(options.clientRegistrationEndpoint, "/oauth/register");
    assert.equal(options.defaultHandler, defaultHandler);
  });

  test("apiHandler.fetch delegates to the given defaultHandler unchanged", async () => {
    const calls: unknown[][] = [];
    const defaultHandler = {
      fetch: async (request: unknown, env: unknown, ctx: unknown) => {
        calls.push([request, env, ctx]);
        return new Response("delegated");
      },
    };
    const options = buildOAuthProviderOptions(defaultHandler);
    const apiHandler = options.apiHandler as unknown as {
      fetch: (...args: unknown[]) => Promise<Response>;
    };
    const response = await apiHandler.fetch("req", "env", "ctx");
    assert.equal(await response.text(), "delegated");
    assert.deepEqual(calls, [["req", "env", "ctx"]]);
  });
});

// REGRESSION: @cloudflare/workers-oauth-provider's apiRoute/apiHandler
// machinery unconditionally 401s a /mcp request with no Bearer token BEFORE
// apiHandler is ever reached -- confirmed directly against
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js.
// This silently broke every anonymous MCP client since GitHub OAuth (#7151)
// shipped; isAnonymousMcpRequest is what the real entrypoint
// (workers/api.sentry.ts) uses to bypass oauthProvider.fetch() entirely for
// exactly this one case, restoring the pre-#7151 anonymous behavior.
describe("isAnonymousMcpRequest", () => {
  test("true for /mcp with no Authorization header at all", () => {
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
    });
    assert.equal(isAnonymousMcpRequest(request), true);
  });

  test("true for /mcp with a non-Bearer Authorization header", () => {
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    assert.equal(isAnonymousMcpRequest(request), true);
  });

  test("false for /mcp with a Bearer token -- still needs the real OAuth dispatch", () => {
    const request = new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer real-token" },
    });
    assert.equal(isAnonymousMcpRequest(request), false);
  });

  test("false for a non-/mcp path with no Authorization header -- the OAuth flow's own endpoints must never bypass oauthProvider", () => {
    const request = new Request(
      "https://api.metagraph.sh/authorize?client_id=x",
    );
    assert.equal(isAnonymousMcpRequest(request), false);
  });

  test("false for /oauth/token with no Authorization header", () => {
    const request = new Request("https://api.metagraph.sh/oauth/token", {
      method: "POST",
    });
    assert.equal(isAnonymousMcpRequest(request), false);
  });
});

describe("handleAuthorizeRequest", () => {
  test("503 when OAUTH_KV is unbound", async () => {
    const env = baseEnv({ OAUTH_KV: undefined });
    const res = await handleAuthorizeRequest(
      new Request("https://x/authorize"),
      env,
    );
    assert.equal(res.status, 503);
  });

  test("503 when GITHUB_OAUTH_CLIENT_ID is unset", async () => {
    const env = baseEnv({ GITHUB_OAUTH_CLIENT_ID: undefined });
    const res = await handleAuthorizeRequest(
      new Request("https://x/authorize"),
      env,
    );
    assert.equal(res.status, 503);
  });

  test("400 when parseAuthRequest rejects", async () => {
    const env = baseEnv();
    const deps = {
      getHelpers: async () =>
        fakeHelpers({
          parseAuthRequest: async () => {
            throw new Error("bad redirect_uri");
          },
        }),
    };
    const res = await handleAuthorizeRequest(
      new Request("https://x/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /bad redirect_uri/);
  });

  test("400 when lookupClient finds no client", async () => {
    const env = baseEnv();
    const deps = {
      getHelpers: async () => fakeHelpers({ lookupClient: async () => null }),
    };
    const res = await handleAuthorizeRequest(
      new Request("https://x/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /unknown client_id/);
  });

  test("400 with a generic message when the thrown error has no .message", async () => {
    const env = baseEnv();
    const deps = {
      getHelpers: async () =>
        fakeHelpers({
          parseAuthRequest: async () => {
            // Deliberately a non-Error throw, to exercise the err?.message
            // fallback branch.
            throw "not an Error instance";
          },
        }),
    };
    const res = await handleAuthorizeRequest(
      new Request("https://x/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /unknown error/);
  });

  test("falls back to the real getOAuthApi when deps.getHelpers is omitted", async () => {
    const env = baseEnv();
    getOAuthApiMock.mockReturnValue(fakeHelpers());
    const res = await handleAuthorizeRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env,
    );
    assert.equal(res.status, 302);
    assert.equal(getOAuthApiMock.mock.calls.length, 1);
  });

  test("stashes the parsed AuthRequest in OAUTH_KV and redirects to GitHub", async () => {
    const env = baseEnv();
    const deps = { getHelpers: async () => fakeHelpers() };
    const res = await handleAuthorizeRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin, "https://github.com");
    assert.equal(location.pathname, "/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "client-id");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://api.metagraph.sh/oauth/callback/github",
    );
    assert.equal(location.searchParams.get("scope"), "read:user");
    const nonce = location.searchParams.get("state");
    assert.ok(nonce && nonce.length > 0);

    const stored = (env.OAUTH_KV as unknown as Row)._store.get(
      `oauth-pending:${nonce}`,
    );
    assert.ok(stored);
    assert.deepEqual(JSON.parse(stored.value), FAKE_AUTH_REQUEST);
    assert.equal(stored.opts.expirationTtl, OAUTH_PENDING_TTL_SECONDS);
  });
});

function githubCallbackUrl(params: Record<string, string>) {
  const url = new URL("https://api.metagraph.sh/oauth/callback/github");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function seedPendingState(
  env: Row,
  nonce: string,
  authRequest: unknown = FAKE_AUTH_REQUEST,
) {
  await env.OAUTH_KV.put(
    `oauth-pending:${nonce}`,
    JSON.stringify(authRequest),
    {
      expirationTtl: OAUTH_PENDING_TTL_SECONDS,
    },
  );
}

function fakeGithubFetch({
  tokenOk = true,
  tokenBody = { access_token: "gh-token" } as Record<string, unknown>,
  userOk = true,
  userBody = { id: 42, login: "octocat" } as Record<string, unknown>,
} = {}) {
  return async (url: unknown) => {
    const href = typeof url === "string" ? url : (url as URL).toString();
    if (href === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify(tokenBody), {
        status: tokenOk ? 200 : 400,
      });
    }
    if (href === "https://api.github.com/user") {
      return new Response(JSON.stringify(userBody), {
        status: userOk ? 200 : 401,
      });
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
}

describe("handleGithubOAuthCallback", () => {
  test("503 when github oauth is not provisioned", async () => {
    const env = baseEnv({ GITHUB_OAUTH_CLIENT_SECRET: undefined });
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "s" })),
      env,
    );
    assert.equal(res.status, 503);
  });

  test("400 when code or state is missing", async () => {
    const env = baseEnv();
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ state: "s" })),
      env,
    );
    assert.equal(res.status, 400);
  });

  test("400 when the state nonce is unknown/expired", async () => {
    const env = baseEnv();
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "missing-nonce" })),
      env,
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /restart the login/);
  });

  test("500 when the pending state is corrupted", async () => {
    const env = baseEnv();
    await env.OAUTH_KV.put("oauth-pending:n1", "not json", {});
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
    );
    assert.equal(res.status, 500);
  });

  test("state is single-use -- deleted before any further work", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const deps = {
      fetch: fakeGithubFetch(),
      getHelpers: async () => fakeHelpers(),
    };
    await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(
      (env.OAUTH_KV as unknown as Row)._store.has("oauth-pending:n1"),
      false,
    );

    const replay = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(replay.status, 400);
  });

  test("502 when github token exchange fails", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch({ tokenOk: false }) };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /token exchange failed/);
  });

  test("502 when github returns no access_token", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch({ tokenBody: {} }) };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /no access_token/);
  });

  test("502 when the github user profile fetch fails", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch({ userOk: false }) };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /user profile/);
  });

  test("502 when the github user profile is missing id/login", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch({ userBody: { login: "octocat" } }) };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /missing id\/login/);
  });

  test("503 when DATA_API is unbound", async () => {
    const env = baseEnv({ DATA_API: undefined });
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch() };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 503);
  });

  test("502 when the DATA_API upsert fails", async () => {
    const env = baseEnv({
      DATA_API: { fetch: async () => new Response("boom", { status: 500 }) },
    });
    await seedPendingState(env, "n1");
    const deps = { fetch: fakeGithubFetch() };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /account storage failed/);
  });

  test("happy path: upserts the account and completes authorization", async () => {
    let upsertRequest: Request | undefined;
    const env = baseEnv({
      DATA_API: {
        fetch: async (request: Request) => {
          upsertRequest = request;
          return new Response(
            JSON.stringify({ id: 7, github_login: "octocat", tier: "free" }),
          );
        },
      },
    });
    await seedPendingState(env, "n1");
    let completeAuthorizationArgs: Row | undefined;
    const deps = {
      fetch: fakeGithubFetch(),
      getHelpers: async () =>
        fakeHelpers({
          completeAuthorization: async (opts: Row) => {
            completeAuthorizationArgs = opts;
            return { redirectTo: "https://client.example/callback?code=xyz" };
          },
        }),
    };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      "https://client.example/callback?code=xyz",
    );

    assert.equal(
      upsertRequest!.url,
      "https://internal/api/v1/auth/github/upsert-account",
    );
    assert.deepEqual(await upsertRequest!.clone().json(), {
      github_user_id: 42,
      github_login: "octocat",
    });

    assert.equal(completeAuthorizationArgs!.userId, "7");
    assert.deepEqual(completeAuthorizationArgs!.request, FAKE_AUTH_REQUEST);
    assert.deepEqual(completeAuthorizationArgs!.props, {
      githubUserId: 42,
      githubLogin: "octocat",
      accountId: 7,
    });
  });

  test("falls back to globalThis.fetch when deps.fetch is omitted", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeGithubFetch();
    try {
      const res = await handleGithubOAuthCallback(
        new Request(githubCallbackUrl({ code: "c", state: "n1" })),
        env,
        { getHelpers: async () => fakeHelpers() },
      );
      assert.equal(res.status, 302);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("falls back to the real getOAuthApi when deps.getHelpers is omitted", async () => {
    const env = baseEnv();
    await seedPendingState(env, "n1");
    getOAuthApiMock.mockReturnValue(fakeHelpers());
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      { fetch: fakeGithubFetch() },
    );
    assert.equal(res.status, 302);
    assert.equal(getOAuthApiMock.mock.calls.length, 1);
  });
});
