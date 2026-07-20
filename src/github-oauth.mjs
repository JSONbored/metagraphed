// GitHub OAuth App identity check for the metagraphed OAuth 2.1 authorization
// server (metagraphed#7151). @cloudflare/workers-oauth-provider implements
// the OAuth 2.1 protocol machinery (PKCE, token issuance/refresh, RFC9728
// Protected Resource Metadata, dynamic client registration) -- this module
// supplies the one thing it deliberately does NOT: `authorizeEndpoint` is
// "used in OAuth metadata and is not handled by the provider itself" (its
// own type doc). The actual /authorize UI and the upstream identity round
// trip are application code, same as Cloudflare's own
// remote-mcp-github-oauth reference template.
//
// Flow: an MCP client (or, later, the website login button) redirects the
// user's browser to GET /authorize with standard OAuth 2.1 + PKCE params.
// We parse that via OAuthHelpers.parseAuthRequest, stash it in OAUTH_KV
// under a short-lived single-use nonce (mirrors wallet-auth.mjs's
// issueWalletChallenge KV-challenge pattern -- proven shape, not
// reinvented), then redirect the browser to GitHub's own OAuth authorize
// endpoint with that nonce as `state`. GitHub redirects back to
// GET /oauth/callback/github with `?code&state`; we look up and delete the
// pending nonce (single-use -- a replayed callback can't complete twice),
// exchange `code` for a GitHub access token, fetch the GitHub user, upsert
// a `github_accounts` row via the DATA_API service binding (only that
// Worker holds the Postgres/Hyperdrive binding -- mirrors
// handleWalletVerify's shape in workers/data-api.mjs), then call
// OAuthHelpers.completeAuthorization to mint OUR OWN grant/token for the
// original MCP client and redirect the browser back to it.
// completeAuthorization can only be called from THIS Worker (it needs
// OAUTH_KV, which workers/data-api.mjs does not bind) -- the DATA_API hop
// is scoped to exactly the one Postgres write, nothing else.
//
// @cloudflare/workers-oauth-provider's real runtime file has a top-level
// `import ... from "cloudflare:workers"` (confirmed by reading
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
// directly, not just its .d.ts) -- that protocol only exists inside the
// real Workers runtime, so a STATIC import of this package anywhere in
// workers/api.mjs's module graph would break every one of its ~90+ existing
// plain-Node vitest tests the moment api.mjs itself is imported, regardless
// of whether those tests ever touch OAuth. getOAuthApi() is therefore never
// imported at module scope here -- only lazily, inside
// defaultGetOAuthHelpers below, via dynamic import() (deferred until
// actually called). Both exported handlers also accept an injectable
// `deps.getHelpers` for exactly this reason -- tests inject a fake helpers
// object and never touch the real package at all, same shape as
// usage-telemetry.mjs's injectable `deps.fetch`.
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API_URL = "https://api.github.com/user";

// Mirrors wallet-auth.mjs's WALLET_CHALLENGE_TTL_SECONDS: long enough for a
// human to complete a GitHub login popup, short enough that an intercepted
// nonce is worthless soon after.
export const OAUTH_PENDING_TTL_SECONDS = 300;
const OAUTH_PENDING_KV_PREFIX = "oauth-pending:";

// Exported so its trivial, deterministic behavior is directly testable
// (see tests/github-oauth.test.mjs) even though production code never
// actually invokes it -- getOAuthApi() reads options.defaultHandler's
// presence but never calls .fetch() on it, only the real OAuthProvider
// instance in workers/api.sentry.mjs does that, with the REAL handler.
export const UNUSED_DEFAULT_HANDLER = {
  fetch: () =>
    new Response("not used outside OAuthProvider.fetch()", { status: 500 }),
};

/**
 * Options shared by the real OAuthProvider instance (workers/api.sentry.mjs,
 * the deploy entrypoint) and by getOAuthApi() calls from this Worker's own
 * route handlers below -- single source of truth for endpoint URLs/TTLs/
 * scopes so the two never drift apart. Pure -- no import of the OAuth
 * package itself, safe to call from anywhere including plain-Node tests.
 *
 * `defaultHandler` is only ever actually invoked through the real
 * OAuthProvider instance's own fetch() dispatch (the entrypoint's use);
 * getOAuthApi() never calls it -- it only exposes the helper methods
 * (parseAuthRequest/lookupClient/completeAuthorization) used below. Callers
 * that only need those helpers pass UNUSED_DEFAULT_HANDLER: it's
 * structurally required by the library's types but dead weight there.
 */
export function buildOAuthProviderOptions(defaultHandler) {
  return {
    apiRoute: "/mcp",
    // Authenticated /mcp gets identical behavior to anonymous /mcp today --
    // this only makes a validated GitHub identity available via ctx.props
    // for future use (metagraphed#7151's stated scope). Anonymous/IP-rate-
    // limited access is unaffected: a request with no/invalid token falls
    // through to defaultHandler below, same as every other route.
    apiHandler: {
      fetch: (request, env, ctx) => defaultHandler.fetch(request, env, ctx),
    },
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["profile"],
    resourceMetadata: {
      resource_name: "metagraphed",
    },
  };
}

// Real production helpers resolver -- lazy-imports the package so no test
// that never calls it pays the cloudflare:workers cost. Can only run in the
// real Workers runtime: the package's own runtime file does
// `import ... from "cloudflare:workers"` at module scope (confirmed against
// dist/oauth-provider.js, not just its .d.ts), a protocol plain Node
// doesn't implement -- same justification as workers/*.sentry.mjs's
// vitest.config.mjs exclusion. Both real routes
// (handleAuthorizeRequest/handleGithubOAuthCallback) accept an injectable
// deps.getHelpers precisely so their own logic stays fully covered without
// this function ever running in a test.
/* v8 ignore start */
async function defaultGetOAuthHelpers(env) {
  const { getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
  return getOAuthApi(buildOAuthProviderOptions(UNUSED_DEFAULT_HANDLER), env);
}
/* v8 ignore stop */

function randomNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @typedef {object} GithubOAuthDeps
 * @property {(env: object) => Promise<object>} [getHelpers] Injectable OAuthHelpers resolver (tests).
 * @property {typeof fetch} [fetch] Injectable fetch, for the GitHub API calls + DATA_API hop (tests).
 */

/** GET /authorize -- parse the incoming OAuth request, stash it, hand off to GitHub. */
export async function handleAuthorizeRequest(request, env, deps = {}) {
  if (!env.OAUTH_KV) {
    return new Response("oauth is not provisioned on this deployment", {
      status: 503,
    });
  }
  if (!env.GITHUB_OAUTH_CLIENT_ID) {
    return new Response("github oauth is not provisioned on this deployment", {
      status: 503,
    });
  }
  const getHelpers = deps.getHelpers ?? defaultGetOAuthHelpers;
  const helpers = await getHelpers(env);
  let authRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (err) {
    return new Response(
      `invalid authorization request: ${err?.message ?? "unknown error"}`,
      { status: 400 },
    );
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  if (!client) {
    return new Response("unknown client_id", { status: 400 });
  }
  const nonce = randomNonce();
  await env.OAUTH_KV.put(
    `${OAUTH_PENDING_KV_PREFIX}${nonce}`,
    JSON.stringify(authRequest),
    { expirationTtl: OAUTH_PENDING_TTL_SECONDS },
  );
  const redirectUri = new URL("/oauth/callback/github", request.url).toString();
  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
  githubUrl.searchParams.set("redirect_uri", redirectUri);
  githubUrl.searchParams.set("state", nonce);
  githubUrl.searchParams.set("scope", "read:user");
  return Response.redirect(githubUrl.toString(), 302);
}

/** GET /oauth/callback/github -- GitHub's redirect back after the user authorizes. */
export async function handleGithubOAuthCallback(request, env, deps = {}) {
  if (
    !env.OAUTH_KV ||
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET
  ) {
    return new Response("github oauth is not provisioned on this deployment", {
      status: 503,
    });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return new Response("missing code or state", { status: 400 });
  }
  const pendingKey = `${OAUTH_PENDING_KV_PREFIX}${state}`;
  const pendingRaw = await env.OAUTH_KV.get(pendingKey);
  if (!pendingRaw) {
    return new Response("expired or unknown state -- restart the login", {
      status: 400,
    });
  }
  // Single-use: delete before doing any further work so a replayed callback
  // (browser back-button, a proxy retrying the GET) can't complete twice
  // against the same pending request.
  await env.OAUTH_KV.delete(pendingKey);
  let authRequest;
  try {
    authRequest = JSON.parse(pendingRaw);
  } catch {
    return new Response("corrupted pending authorization state", {
      status: 500,
    });
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  const redirectUri = new URL("/oauth/callback/github", request.url).toString();
  const tokenResponse = await doFetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    return new Response("github token exchange failed", { status: 502 });
  }
  const tokenBody = await tokenResponse.json();
  const githubAccessToken = tokenBody?.access_token;
  if (typeof githubAccessToken !== "string" || !githubAccessToken) {
    return new Response("github token exchange returned no access_token", {
      status: 502,
    });
  }

  const userResponse = await doFetch(GITHUB_USER_API_URL, {
    headers: {
      authorization: `Bearer ${githubAccessToken}`,
      "user-agent": "metagraphed-oauth",
      accept: "application/vnd.github+json",
    },
  });
  if (!userResponse.ok) {
    return new Response("failed to fetch github user profile", {
      status: 502,
    });
  }
  const githubUser = await userResponse.json();
  const githubUserId = githubUser?.id;
  const githubLogin = githubUser?.login;
  if (
    typeof githubUserId !== "number" ||
    typeof githubLogin !== "string" ||
    !githubLogin
  ) {
    return new Response("github user profile missing id/login", {
      status: 502,
    });
  }

  if (!env.DATA_API) {
    return new Response(
      "account storage is not provisioned on this deployment",
      { status: 503 },
    );
  }
  const upsertResponse = await env.DATA_API.fetch(
    new Request("https://internal/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        github_user_id: githubUserId,
        github_login: githubLogin,
      }),
    }),
  );
  if (!upsertResponse.ok) {
    return new Response("account storage failed", { status: 502 });
  }
  const account = await upsertResponse.json();

  const getHelpers = deps.getHelpers ?? defaultGetOAuthHelpers;
  const helpers = await getHelpers(env);
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: String(account.id),
    scope: authRequest.scope,
    metadata: { githubLogin },
    props: { githubUserId, githubLogin, accountId: account.id },
  });
  return Response.redirect(redirectTo, 302);
}
