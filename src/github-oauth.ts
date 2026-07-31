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
// under a short-lived single-use nonce (mirrors wallet-auth.ts's
// issueWalletChallenge KV-challenge pattern -- proven shape, not
// reinvented), then redirect the browser to GitHub's own OAuth authorize
// endpoint with that nonce as `state`. GitHub redirects back to
// GET /oauth/callback/github with `?code&state`; we look up and delete the
// pending nonce (single-use -- a replayed callback can't complete twice),
// exchange `code` for a GitHub access token, fetch the GitHub user, upsert
// a `github_accounts` row via the DATA_API service binding (only that
// Worker holds the Postgres/Hyperdrive binding -- mirrors
// handleWalletVerify's shape in workers/data-api.ts), then call
// OAuthHelpers.completeAuthorization to mint OUR OWN grant/token for the
// original MCP client and redirect the browser back to it.
// completeAuthorization can only be called from THIS Worker (it needs
// OAUTH_KV, which workers/data-api.ts does not bind) -- the DATA_API hop
// is scoped to exactly the one Postgres write, nothing else.
//
// @cloudflare/workers-oauth-provider's real runtime file has a top-level
// `import ... from "cloudflare:workers"` (confirmed by reading
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
// directly, not just its .d.ts) -- that protocol only exists inside the
// real Workers runtime, so a STATIC import of this package anywhere in
// workers/api.ts's module graph would break every one of its ~90+ existing
// plain-Node vitest tests the moment api.ts itself is imported, regardless
// of whether those tests ever touch OAuth. getOAuthApi() is therefore never
// imported at module scope here -- only lazily, inside
// defaultGetOAuthHelpers below, via dynamic import() (deferred until
// actually called). Both exported handlers also accept an injectable
// `deps.getHelpers` for exactly this reason -- tests inject a fake helpers
// object and never touch the real package at all, same shape as
// usage-telemetry.ts's injectable `deps.fetch`.
//
// The package's real TYPES (as opposed to its runtime) have no
// cloudflare:workers dependency, so `import type` below is safe at module
// scope -- type-only imports are fully erased and carry no runtime cost.
import type {
  AuthRequest,
  OAuthHelpers,
  OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "./api-key-validation.ts";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API_URL = "https://api.github.com/user";

// Single source of truth for the OAuth-gated API route, shared by
// buildOAuthProviderOptions' apiRoute and isAnonymousMcpRequest below so the
// two can never drift apart.
const MCP_API_ROUTE = "/mcp";

/**
 * The tag every metagraphed API key carries (`mg_<opaque random>`), mirrored
 * from src/api-key-validation.ts's own `bareKeyFrom`. Duplicated rather than
 * imported to keep this module free of the key-validation graph -- it runs on
 * the entrypoint's hot path for every single request.
 */
const MG_API_KEY_TAG = "mg_";

// Mirrors wallet-auth.ts's WALLET_CHALLENGE_TTL_SECONDS: long enough for a
// human to complete a GitHub login popup, short enough that an intercepted
// nonce is worthless soon after.
export const OAUTH_PENDING_TTL_SECONDS = 300;
const OAUTH_PENDING_KV_PREFIX = "oauth-pending:";

// Exported so its trivial, deterministic behavior is directly testable
// (see tests/github-oauth.test.ts) even though production code never
// actually invokes it -- getOAuthApi() reads options.defaultHandler's
// presence but never calls .fetch() on it, only the real OAuthProvider
// instance in workers/api.entry.ts does that, with the REAL handler.
export const UNUSED_DEFAULT_HANDLER = {
  fetch: () =>
    new Response("not used outside OAuthProvider.fetch()", { status: 500 }),
};

interface DefaultHandler {
  fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Response | Promise<Response>;
}

/**
 * Options shared by the real OAuthProvider instance (workers/api.entry.ts,
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
export function buildOAuthProviderOptions(
  defaultHandler: DefaultHandler,
): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_API_ROUTE,
    // Authenticated /mcp gets identical behavior to anonymous /mcp today --
    // this only makes a validated GitHub identity available via ctx.props
    // for future use (metagraphed#7151's stated scope). apiHandler only ever
    // runs once OAuthProvider itself has already accepted a valid Bearer
    // token, so it's a pure pass-through to defaultHandler; it is NOT what
    // keeps anonymous /mcp working -- see isAnonymousMcpRequest below for why
    // that guard has to live at the entrypoint, one layer
    // OUTSIDE OAuthProvider.fetch() entirely, and this comment's own former
    // claim ("a request with no/invalid token falls through to defaultHandler
    // below") for the incident that guard fixes: OAuthProvider's
    // apiRoute/apiHandler machinery unconditionally 401s a request with no
    // Bearer token BEFORE apiHandler is ever reached (confirmed directly
    // against node_modules/@cloudflare/workers-oauth-provider/dist/
    // oauth-provider.js, not just its .d.ts) -- there is no library-level
    // "authenticate if present, else fall through" option.
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
  } as OAuthProviderOptions<Env>;
}

/**
 * True when `request` targets /mcp with credentials OAuthProvider cannot
 * evaluate -- either none at all, or one of OUR OWN `mg_` API keys.
 *
 * The real entrypoint (workers/api.entry.ts) routes a true result DIRECTLY to
 * the plain handler, bypassing oauthProvider.fetch() entirely.
 * @cloudflare/workers-oauth-provider's apiRoute/apiHandler machinery
 * unconditionally requires a valid OAuth Bearer token and 401s BEFORE
 * apiHandler is ever reached -- there is no library-level "authenticate if
 * present, else fall through" option (confirmed against
 * node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
 * directly, not just its .d.ts). So anything the library would reject but we
 * would accept has to be diverted before it gets there.
 *
 * The no-token case was the original fix (#7151 silently 401'd every anonymous
 * MCP client until it was added). The `mg_` case is #8643: the same bug, one
 * scheme over. Our Unkey API keys are sent as `Authorization: Bearer mg_...`,
 * which is a Bearer token OAuthProvider did not issue, so the old
 * "any Bearer at all" test handed them to the library and the library 401'd
 * them. The visible consequence was that MCP_TIERED_RATE_LIMIT.keyed
 * (500 req/60s) could never be reached on /mcp -- the tier existed, was
 * tested, and was unreachable in production -- and that a client configured
 * with a working API key fared WORSE than one sending nothing at all.
 * It stayed hidden until wallet login was provisioned and keys could first be
 * minted (#8640).
 *
 * `mg_` is matched as a prefix only, deliberately: this decides ROUTING, not
 * authentication. A forged `mg_` string reaches the plain handler and is then
 * rejected by the real validator (src/api-key-validation.ts, Unkey-backed) --
 * exactly as an anonymous request would be, and with the anonymous rate-limit
 * ceiling still applied, which is what workers/tiered-rate-limit.ts already
 * documents as intended ("a bad key is not itself abuse"). Nothing here grants
 * access; it only chooses which code gets to say no.
 *
 * Everything else -- /authorize, /oauth/token, /oauth/register, OAuthProvider's
 * discovery endpoints, and /mcp with a genuine OAuth Bearer -- still needs the
 * real oauthProvider.fetch() dispatch.
 */
export function isNonOAuthMcpRequest(request: Request): boolean {
  if (new URL(request.url).pathname !== MCP_API_ROUTE) return false;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return true;
  return header.slice("Bearer ".length).startsWith(MG_API_KEY_TAG);
}

/**
 * @deprecated Renamed to isNonOAuthMcpRequest in #8643, which widened it past
 * "anonymous". Kept as an alias so nothing importing the old name breaks.
 */
export const isAnonymousMcpRequest = isNonOAuthMcpRequest;

// Real production helpers resolver -- lazy-imports the package so no test
// that never calls it pays the cloudflare:workers cost. Can only run in the
// real Workers runtime: the package's own runtime file does
// `import ... from "cloudflare:workers"` at module scope (confirmed against
// dist/oauth-provider.js, not just its .d.ts), a protocol plain Node
// doesn't implement. Both real routes
// (handleAuthorizeRequest/handleGithubOAuthCallback) accept an injectable
// deps.getHelpers precisely so their own logic stays fully covered without
// this function ever running in a test.
/* v8 ignore start */
async function defaultGetOAuthHelpers(env: Env): Promise<OAuthHelpers> {
  const { getOAuthApi } = await import("@cloudflare/workers-oauth-provider");
  return getOAuthApi(buildOAuthProviderOptions(UNUSED_DEFAULT_HANDLER), env);
}
/* v8 ignore stop */

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface GithubOAuthDeps {
  // Injectable OAuthHelpers resolver (tests).
  getHelpers?: (env: Env) => Promise<OAuthHelpers>;
  // Injectable fetch, for the GitHub API calls + DATA_API hop (tests).
  fetch?: typeof fetch;
}

/** GET /authorize -- parse the incoming OAuth request, stash it, hand off to GitHub. */
export async function handleAuthorizeRequest(
  request: Request,
  env: Env,
  deps: GithubOAuthDeps = {},
): Promise<Response> {
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
  let authRequest: AuthRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (err) {
    return new Response(
      `invalid authorization request: ${(err as Error)?.message ?? "unknown error"}`,
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
export async function handleGithubOAuthCallback(
  request: Request,
  env: Env,
  deps: GithubOAuthDeps = {},
): Promise<Response> {
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
  let authRequest: AuthRequest;
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
  const tokenBody = (await tokenResponse.json()) as Record<string, unknown>;
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
  const githubUser = (await userResponse.json()) as Record<string, unknown>;
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
  // #8820: the upsert route is now gated with the internal-token pair. Without
  // the secret the request would 401; surface that as the same "not
  // provisioned" 503 the missing-binding case above returns, so an
  // unprovisioned deploy is diagnosable rather than a generic 502 below.
  if (!env.API_KEY_LOOKUP_INTERNAL_TOKEN) {
    return new Response(
      "account storage is not provisioned on this deployment",
      { status: 503 },
    );
  }
  const upsertResponse = await env.DATA_API.fetch(
    new Request("https://internal/api/v1/auth/github/upsert-account", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [API_KEY_LOOKUP_TOKEN_HEADER]: env.API_KEY_LOOKUP_INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        github_user_id: githubUserId,
        github_login: githubLogin,
      }),
    }),
  );
  if (!upsertResponse.ok) {
    return new Response("account storage failed", { status: 502 });
  }
  const account = (await upsertResponse.json()) as Record<string, unknown>;

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
