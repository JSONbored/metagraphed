import assert from "node:assert/strict";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildOAuthProviderOptions,
  handleAuthorizeConsent,
  handleAuthorizeRequest,
  handleGithubOAuthCallback,
  isAnonymousMcpRequest,
  isNonOAuthMcpRequest,
  isMcpEndpointPath,
  matchesMcpApiRoute,
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
    // #8820: the upsert route is now gated with the internal-token pair; the
    // callback sends it and returns "not provisioned" 503 when it is absent.
    API_KEY_LOOKUP_INTERNAL_TOKEN: "test-lookup-token",
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

  // #9637: asserted as an explicit `false`, not merely "not true". The
  // library branches on `allowPlainPKCE !== false` for the advertised metadata
  // and on `=== false` for the runtime rejection, so `undefined` -- the value
  // this option had before -- takes the permissive side of BOTH. A test that
  // accepted any falsy value would pass on exactly the state being fixed.
  test("requires S256 PKCE: plain is disallowed explicitly (#9637)", () => {
    const defaultHandler = { fetch: async () => new Response("default") };
    const options = buildOAuthProviderOptions(defaultHandler);
    assert.equal(options.allowPlainPKCE, false);
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
// (workers/api.entry.ts) uses to bypass oauthProvider.fetch() entirely for
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
    // #11569: GET now RENDERS the consent screen rather than redirecting. The
    // hand-off to GitHub moved to POST, so that arriving at this URL -- via a
    // link, a prefetch, an <img> -- can no longer start a grant.
    assert.equal(res.status, 200);
    assert.equal(getOAuthApiMock.mock.calls.length, 1);
  });

  test("stashes the parsed AuthRequest and renders consent; POST hands off to GitHub", async () => {
    // The two halves of #11569's split, asserted together because neither is
    // meaningful alone: the GET must stash the request AND show it, and the
    // POST must only proceed for a nonce that names something we stashed.
    const env = baseEnv();
    const deps = { getHelpers: async () => fakeHelpers() };
    const res = await handleAuthorizeRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    // A consent screen bound to one pending request must never be cached; a
    // cached copy would show a stale client to the next person through.
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    const nonce = /name="consent_nonce" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce, "the form must carry the CSRF nonce");

    const approved = await handleAuthorizeConsent(
      new Request("https://api.metagraph.sh/authorize", {
        method: "POST",
        body: new URLSearchParams({ consent_nonce: nonce! }),
      }),
      env,
    );
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get("location")!);
    assert.equal(location.origin, "https://github.com");
    assert.equal(location.pathname, "/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), "client-id");
    assert.equal(location.searchParams.get("state"), nonce);
  });

  test("consent renders for a client that registered nothing but an id", async () => {
    // A DCR client may carry no name and no redirectUris array at all. The
    // page still has to render -- a missing field is not a reason to fail an
    // authorization, and an unrendered consent screen is a dead flow.
    const env = baseEnv();
    const deps = {
      getHelpers: async () =>
        fakeHelpers({
          lookupClient: async () => ({ clientId: "bare-client" }),
          parseAuthRequest: async () => ({
            ...FAKE_AUTH_REQUEST,
            scope: [],
          }),
        }),
    };
    const res = await handleAuthorizeRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env,
      deps,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    // No host to show and no name to fall back to, so the id itself stands in
    // -- labelled as self-reported, never as verified.
    assert.match(html, /name self-reported/);
    // An empty scope list must not render as "will be able to: (nothing)" for
    // a grant that still happens.
    assert.match(html, /profile/);
  });

  test("a registered name and redirect list reach the page", async () => {
    const env = baseEnv();
    const deps = {
      getHelpers: async () =>
        fakeHelpers({
          lookupClient: async () => ({
            clientId: "local-client",
            clientName: "My Local Agent",
            redirectUris: ["http://localhost:3118/callback", 42],
          }),
        }),
    };
    const res = await handleAuthorizeRequest(
      new Request("https://api.metagraph.sh/authorize"),
      env,
      deps,
    );
    const html = await res.text();
    assert.match(html, /My Local Agent/);
    // Loopback-only, so the warning fires -- and the non-string entry in the
    // list is filtered rather than reaching the URL parser.
    assert.match(html, /runs on your own machine/);
  });

  test("POST without a nonce, or with one we never issued, starts nothing", async () => {
    // The nonce is what stops a forged POST beginning a grant for a client the
    // user never saw. Both arms matter: absent, and present-but-unknown.
    const env = baseEnv();
    const missing = await handleAuthorizeConsent(
      new Request("https://api.metagraph.sh/authorize", {
        method: "POST",
        body: new URLSearchParams({}),
      }),
      env,
    );
    assert.equal(missing.status, 400);
    const forged = await handleAuthorizeConsent(
      new Request("https://api.metagraph.sh/authorize", {
        method: "POST",
        body: new URLSearchParams({ consent_nonce: "never-issued" }),
      }),
      env,
    );
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /expired/);
  });

  test("POST is 503 on a deployment with no oauth provisioned", async () => {
    for (const env of [
      baseEnv({ OAUTH_KV: undefined }),
      baseEnv({ GITHUB_OAUTH_CLIENT_ID: undefined }),
    ]) {
      const res = await handleAuthorizeConsent(
        new Request("https://api.metagraph.sh/authorize", {
          method: "POST",
          body: new URLSearchParams({ consent_nonce: "x" }),
        }),
        env,
      );
      assert.equal(res.status, 503);
    }
  });

  test("a malformed POST body is refused rather than throwing", async () => {
    const res = await handleAuthorizeConsent(
      new Request("https://api.metagraph.sh/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-form-data",
      }),
      baseEnv(),
    );
    assert.equal(res.status, 400);
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

  test("502 when github's token body is valid JSON but not an object", async () => {
    // `null` and `"gh-token"` are both valid JSON, so `response.json()`
    // resolves and the cast this replaces typed them as an object. The read
    // for `access_token` then produced undefined on a string and THREW on
    // null -- a 500 out of a handler whose next line already answers 502.
    for (const tokenBody of [null, "gh-token", 42] as unknown[]) {
      const env = baseEnv();
      await seedPendingState(env, "n1");
      const deps = {
        fetch: fakeGithubFetch({
          tokenBody: tokenBody as Record<string, unknown>,
        }),
      };
      const res = await handleGithubOAuthCallback(
        new Request(githubCallbackUrl({ code: "c", state: "n1" })),
        env,
        deps,
      );
      assert.equal(res.status, 502, `${JSON.stringify(tokenBody)} must 502`);
      assert.match(await res.text(), /no access_token/);
    }
  });

  test("502 when github's user body is valid JSON but not an object", async () => {
    for (const userBody of [null, "octocat"] as unknown[]) {
      const env = baseEnv();
      await seedPendingState(env, "n1");
      const deps = {
        fetch: fakeGithubFetch({
          userBody: userBody as Record<string, unknown>,
        }),
      };
      const res = await handleGithubOAuthCallback(
        new Request(githubCallbackUrl({ code: "c", state: "n1" })),
        env,
        deps,
      );
      assert.equal(res.status, 502, `${JSON.stringify(userBody)} must 502`);
    }
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

  // #8820: the callback authenticates its own DATA_API hop with the
  // internal-token header the upsert route now requires.
  test("the DATA_API upsert request carries the x-api-key-lookup-token header", async () => {
    let upsertRequest: Request | undefined;
    const env = baseEnv({
      API_KEY_LOOKUP_INTERNAL_TOKEN: "the-secret",
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
    const deps = {
      fetch: fakeGithubFetch(),
      getHelpers: async () => fakeHelpers(),
    };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 302);
    assert.equal(
      upsertRequest!.headers.get("x-api-key-lookup-token"),
      "the-secret",
    );
  });

  test("503 (not a 502) when API_KEY_LOOKUP_INTERNAL_TOKEN is absent, and DATA_API is never called", async () => {
    let called = false;
    const env = baseEnv({
      API_KEY_LOOKUP_INTERNAL_TOKEN: undefined,
      DATA_API: {
        fetch: async () => {
          called = true;
          return new Response(JSON.stringify({ id: 1 }));
        },
      },
    });
    await seedPendingState(env, "n1");
    const deps = {
      fetch: fakeGithubFetch(),
      getHelpers: async () => fakeHelpers(),
    };
    const res = await handleGithubOAuthCallback(
      new Request(githubCallbackUrl({ code: "c", state: "n1" })),
      env,
      deps,
    );
    assert.equal(res.status, 503);
    assert.equal(
      called,
      false,
      "the upsert must not be posted unauthenticated",
    );
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

describe("isNonOAuthMcpRequest (#8643) — our own API keys must not reach OAuthProvider", () => {
  const at = (headers: Record<string, string> = {}) =>
    new Request("https://api.metagraph.sh/mcp", { method: "POST", headers });

  test("diverts an mg_ API key to the plain handler", () => {
    // The bug: `mg_` keys are Bearer tokens OAuthProvider never issued, so the
    // old "any Bearer at all" test handed them to the library, which 401s
    // anything it cannot validate. MCP_TIERED_RATE_LIMIT.keyed was therefore
    // unreachable in production, and a client WITH a valid key fared worse
    // than one sending nothing.
    expect(
      isNonOAuthMcpRequest(
        at({ Authorization: "Bearer mg_live_abcdefghijklmnop" }),
      ),
    ).toBe(true);
  });

  test("still diverts an anonymous request, the original #7151 case", () => {
    expect(isNonOAuthMcpRequest(at())).toBe(true);
    expect(isNonOAuthMcpRequest(at({ Authorization: "" }))).toBe(true);
  });

  test("still routes a genuine OAuth bearer to OAuthProvider", () => {
    expect(
      isNonOAuthMcpRequest(at({ Authorization: "Bearer gho_someoauthtoken" })),
    ).toBe(false);
    expect(
      isNonOAuthMcpRequest(at({ Authorization: "Bearer eyJhbGciOi.J9.sig" })),
    ).toBe(false);
  });

  test("never diverts a non-/mcp path, whatever the credentials", () => {
    for (const url of [
      "https://api.metagraph.sh/authorize",
      "https://api.metagraph.sh/oauth/token",
      "https://api.metagraph.sh/api/v1/subnets",
    ]) {
      const request = new Request(url, {
        headers: { Authorization: "Bearer mg_abcdefghijklmnop" },
      });
      expect(isNonOAuthMcpRequest(request), url).toBe(false);
    }
  });

  // The inverse of the case above, and the one nothing pinned. OAuthProvider's
  // matchApiRoute matches a path-style apiRoute with `startsWith`, so `/mcp` claims
  // `/mcp/`, `/mcp/sse` and `/mcpx`. This predicate used `!==` against the same
  // constant — one character narrower — and every path in the gap was handed to
  // oauthProvider.fetch, which answered an anonymous 401 with a
  // `WWW-Authenticate: Bearer realm="OAuth"` challenge before the app ever ran.
  // Reproduced against production: POST /mcp -> 200, POST /mcp/ -> 401. A trailing
  // slash was enough to tell an unauthenticated client it needed OAuth.
  test("diverts every path OAuthProvider would claim by prefix, not just /mcp exactly", () => {
    for (const url of [
      "https://api.metagraph.sh/mcp",
      "https://api.metagraph.sh/mcp/",
      "https://api.metagraph.sh/mcp/sse",
      "https://api.metagraph.sh/mcp/message",
      "https://api.metagraph.sh/mcpx",
    ]) {
      expect(isNonOAuthMcpRequest(new Request(url)), url).toBe(true);
    }
  });

  test("isMcpEndpointPath is the endpoint, not the OAuth surface", () => {
    // Narrower than matchesMcpApiRoute on purpose: `/mcp/sse` is claimed by OAuth's
    // prefix but is NOT the endpoint, and serving it as MCP would be worse than the
    // 404 it gets. A trailing slash, though, IS the endpoint — that is the client
    // mistake most likely to be made, and it now works instead of 405ing.
    for (const [pathname, expected] of [
      ["/mcp", true],
      ["/mcp/", true],
      ["/mcp/sse", false],
      ["/mcp/message", false],
      ["/mcpx", false],
      ["/api/v1/subnets", false],
    ] as Array<[string, boolean]>) {
      expect(isMcpEndpointPath(pathname), pathname).toBe(expected);
    }
  });

  test("matchesMcpApiRoute agrees with OAuthProvider's startsWith, so the two cannot drift", () => {
    // If this ever disagrees with matchApiRoute, the gap reopens as a 401.
    const claimedByLibrary = (pathname: string) => pathname.startsWith("/mcp");
    for (const pathname of [
      "/mcp",
      "/mcp/",
      "/mcp/sse",
      "/mcpx",
      "/api/v1/subnets",
      "/authorize",
      "/",
    ]) {
      expect(matchesMcpApiRoute(pathname), pathname).toBe(
        claimedByLibrary(pathname),
      );
    }
  });

  test("routes on the prefix only — it decides WHO validates, never whether access is granted", () => {
    // A forged mg_ string is diverted to the plain handler on purpose: the
    // real Unkey-backed validator rejects it there, with the anonymous
    // ceiling still applied. Diversion is not authentication.
    expect(isNonOAuthMcpRequest(at({ Authorization: "Bearer mg_" }))).toBe(
      true,
    );
    expect(
      isNonOAuthMcpRequest(at({ Authorization: "Bearer mg_totally-made-up" })),
    ).toBe(true);
  });

  test("keeps the old name working as an alias", () => {
    expect(isAnonymousMcpRequest).toBe(isNonOAuthMcpRequest);
  });
});
