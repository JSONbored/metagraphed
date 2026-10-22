import {
  createAgentAuthStore,
  AGENT_AUTH_POLL_SECONDS,
  type AgentAuthStore,
  type AgentAuthRegistration,
} from "./agent-auth-store.ts";
import {
  loadCachedAgentAuthSigner,
  type AgentAuthSigner,
} from "./agent-auth-jwt.ts";
import {
  exchangeGithubIdentity,
  upsertGithubIdentityAccount,
  resolveGithubOAuthOwner,
  type GithubIdentityEnv,
} from "./github-oauth.ts";
import { escapeHtml } from "./oauth-consent.ts";
import { sha256Hex } from "./sha256-hex.ts";
import { timingSafeEqual } from "./webhooks.ts";

export const AGENT_AUTH_ISSUER = "https://api.metagraph.sh";
export const AGENT_AUTH_CLAIM_GRANT = "urn:workos:agent-auth:grant-type:claim";
export const AGENT_AUTH_JWT_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const AGENT_AUTH_PATHS = {
  register: "/agent/register",
  claim: "/agent/claim",
  verify: "/agent/verify",
  approve: "/agent/approve",
  rotate: "/agent/rotate",
  token: "/oauth/token",
  revoke: "/oauth/revoke",
  jwks: "/oauth/jwks",
} as const;
const CLAIM_SECONDS = 600;
const MAX_BODY_BYTES = 8192;
const COOKIE = "__Host-mg_agent_claim";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PERMISSIONS = ["profile"] as const;
const TABLES = [
  "agent_auth_registrations",
  "agent_auth_ceremonies",
  "agent_auth_tokens",
];

export interface AgentAuthEnv extends GithubIdentityEnv {
  OAUTH_KV?: KVNamespace;
  D1_STATE?: D1Database;
  D1_STATE_TABLES?: string;
  AUTHMD_SIGNING_JWK?: string;
  AGENT_AUTH_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

export interface AgentAuthDeps {
  store?: AgentAuthStore | null;
  signer?: AgentAuthSigner | null;
  fetch?: typeof fetch;
  now?: () => number;
  resolveOwner?: typeof resolveGithubOAuthOwner;
}
interface Context {
  store: AgentAuthStore;
  signer: AgentAuthSigner;
  now: number;
}
type Body = Record<string, unknown>;

function headers(html = false, allowGithub = false): Headers {
  const result = new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (html) {
    result.set("content-type", "text/html; charset=utf-8");
    result.set(
      "content-security-policy",
      `default-src 'none'; form-action 'self'${allowGithub ? " https://github.com/login/oauth/authorize" : ""}; frame-ancestors 'none'; base-uri 'none'`,
    );
    result.set("cross-origin-opener-policy", "same-origin");
  } else {
    result.set("content-type", "application/json; charset=utf-8");
    result.set("access-control-allow-origin", "*");
    result.set("access-control-expose-headers", "Retry-After");
  }
  return result;
}

function json(body: unknown, status = 200, extra?: Record<string, string>) {
  const responseHeaders = headers();
  for (const [name, value] of Object.entries(extra ?? {}))
    responseHeaders.set(name, value);
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
function error(
  code: string,
  description: string,
  status = 400,
  retry?: number,
) {
  return json(
    { error: code, error_description: description },
    status,
    retry === undefined ? undefined : { "retry-after": String(retry) },
  );
}
function page(title: string, body: string, allowGithub = false) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    { status: 200, headers: headers(true, allowGithub) },
  );
}
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function userCode(): string {
  // Rejection sampling avoids modulo bias in the human verification code.
  const bytes = new Uint32Array(1);
  do crypto.getRandomValues(bytes);
  while (bytes[0] >= 4_294_000_000);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}
function email(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}
function string(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function isIdentityAssertion(value: unknown): boolean {
  if (!string(value, MAX_BODY_BYTES)) return false;
  try {
    const header = value.split(".")[0];
    if (!header || header.length > 684 || !/^[A-Za-z0-9_-]+$/.test(header))
      return false;
    const decoded: unknown = JSON.parse(
      atob(header.replaceAll("-", "+").replaceAll("_", "/")),
    );
    return (
      typeof decoded === "object" &&
      decoded !== null &&
      "typ" in decoded &&
      decoded.typ === "oauth-id-jag+jwt"
    );
  } catch {
    return false;
  }
}
function ownsRevocation(data: Body | null): boolean {
  return (
    data !== null &&
    (data.registration_id !== undefined ||
      data.token_type_hint === "identity_assertion" ||
      (typeof data.token === "string" && data.token.startsWith("mg_agent_")) ||
      isIdentityAssertion(data.token))
  );
}

async function body(request: Request): Promise<Body | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      void reader.cancel();
      return null;
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const contentType = request.headers.get("content-type")?.split(";")[0].trim();
  if (contentType === "application/json") {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Body)
      : null;
  }
  if (contentType !== "application/x-www-form-urlencoded") return null;
  const fields = new URLSearchParams(raw);
  const parsed: Body = {};
  for (const [key, value] of fields) {
    if (Object.hasOwn(parsed, key)) return null;
    Object.defineProperty(parsed, key, { value, enumerable: true });
  }
  return parsed;
}
async function readBody(request: Request): Promise<Body | null> {
  try {
    return await body(request);
  } catch {
    return null;
  }
}

async function context(
  env: AgentAuthEnv,
  deps: AgentAuthDeps,
): Promise<Context | null> {
  const selected = new Set(env.D1_STATE_TABLES?.split(","));
  if (
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET ||
    !env.DATA_API ||
    !env.API_KEY_LOOKUP_INTERNAL_TOKEN ||
    !env.AGENT_AUTH_RATE_LIMITER ||
    (deps.store === undefined && !TABLES.every((name) => selected.has(name)))
  )
    return null;
  const store =
    deps.store === undefined ? createAgentAuthStore(env.D1_STATE) : deps.store;
  const signer =
    deps.signer === undefined
      ? await loadCachedAgentAuthSigner(
          env.AUTHMD_SIGNING_JWK,
          AGENT_AUTH_ISSUER,
        )
      : deps.signer;
  return store && signer
    ? { store, signer, now: deps.now?.() ?? Math.floor(Date.now() / 1000) }
    : null;
}

/** Metadata never advertises a key or schema that cannot support a claim. */
export async function isAgentAuthReady(
  env: AgentAuthEnv,
  deps: AgentAuthDeps = {},
): Promise<boolean> {
  try {
    const configured = await context(env, deps);
    return configured ? await configured.store.ready() : false;
  } catch {
    return false;
  }
}

async function limited(
  request: Request,
  env: AgentAuthEnv,
): Promise<Response | null> {
  const result = await env.AGENT_AUTH_RATE_LIMITER!.limit({
    key: `agent-auth:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
  });
  return result.success
    ? null
    : error("slow_down", "Too many authentication requests.", 429, 60);
}

function claimView(
  registration: AgentAuthRegistration,
  code: string,
  now: number,
) {
  return {
    user_code: code,
    expires_in: Math.max(0, registration.expiresAt - now),
    verification_uri: `${AGENT_AUTH_ISSUER}${AGENT_AUTH_PATHS.verify}?registration_id=${encodeURIComponent(registration.id)}&claim_version=${registration.claimVersion}`,
    interval: AGENT_AUTH_POLL_SECONDS,
  };
}
function registrationView(
  registration: AgentAuthRegistration,
  token: string,
  code: string,
  now: number,
) {
  return {
    registration_id: registration.id,
    registration_type: "service_auth",
    claim_url: AGENT_AUTH_ISSUER + AGENT_AUTH_PATHS.claim,
    claim_token: token,
    claim_token_expires: new Date(registration.expiresAt * 1000).toISOString(),
    post_claim_scopes: PERMISSIONS,
    claim: claimView(registration, code, now),
  };
}

interface BrowserState {
  state: string;
  cookie: string;
  csrf: string;
}
function browserState(request: Request): BrowserState | null {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const [state, cookie, csrf, ...extra] = matches[0]
    .slice(COOKIE.length + 1)
    .split("~");
  return extra.length === 0 &&
    /^agent_auth_[A-Za-z0-9_-]{43}$/.test(state ?? "") &&
    SECRET.test(cookie ?? "") &&
    SECRET.test(csrf ?? "")
    ? { state, cookie, csrf }
    : null;
}
function browserPost(
  request: Request,
  data: Body,
  state: BrowserState | null,
): state is BrowserState {
  return (
    request.headers.get("origin") === AGENT_AUTH_ISSUER &&
    new URL(request.url).origin === AGENT_AUTH_ISSUER &&
    state !== null &&
    data.state === state.state &&
    timingSafeEqual(data.csrf, state.csrf)
  );
}
function hidden(state: BrowserState): string {
  return `<input type="hidden" name="state" value="${escapeHtml(state.state)}"><input type="hidden" name="csrf" value="${escapeHtml(state.csrf)}">`;
}

async function tokenResponse(
  ctx: Context,
  registration: AgentAuthRegistration,
  issuedAt: number,
  expiresAt: number,
  assertion: boolean,
  resource: string,
) {
  const accessToken = `mg_agent_${randomSecret()}`;
  const identityAssertion = assertion
    ? await ctx.signer.sign(registration.id, issuedAt, expiresAt)
    : undefined;
  const stored = await ctx.store.issueToken({
    registrationId: registration.id,
    issuedAt,
    assertionExpiresAt: expiresAt,
    tokenHash: await sha256Hex(accessToken),
    now: ctx.now,
    expiresAt,
    resource,
  });
  if (!stored)
    return error(
      "invalid_grant",
      "The approved registration is no longer active.",
    );
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresAt - ctx.now,
    scope: registration.permissions.join(" "),
    ...(assertion
      ? {
          identity_assertion: identityAssertion,
          assertion_expires: new Date(expiresAt * 1000).toISOString(),
        }
      : {}),
  });
}

async function handleToken(data: Body, ctx: Context) {
  if (
    data.resource !== undefined &&
    data.resource !== `${AGENT_AUTH_ISSUER}/mcp` &&
    data.resource !== `${AGENT_AUTH_ISSUER}/mcp/core`
  )
    return error(
      "invalid_target",
      "Only this service's MCP resource is supported.",
    );
  if (data.scope !== undefined && data.scope !== "profile")
    return error("invalid_scope", "Only profile scope is supported.");
  const resource =
    typeof data.resource === "string"
      ? data.resource
      : `${AGENT_AUTH_ISSUER}/mcp`;
  if (data.grant_type === AGENT_AUTH_CLAIM_GRANT) {
    if (!string(data.claim_token))
      return error("invalid_request", "claim_token is required.");
    const result = await ctx.store.pollClaim(
      await sha256Hex(data.claim_token),
      ctx.now,
    );
    switch (result.status) {
      case "missing":
        return error("expired_token", "Unknown or expired claim token.");
      case "expired":
        return error("expired_token", "The claim has expired.");
      case "revoked":
        return error("access_denied", "The registration was revoked.");
      case "rate_limited":
        return error(
          "slow_down",
          "Wait before polling again.",
          400,
          result.retryAfter,
        );
      case "pending":
        return error(
          "authorization_pending",
          "The owner has not approved this agent.",
        );
      case "approved":
        return tokenResponse(
          ctx,
          result.registration,
          result.issuedAt,
          result.assertionExpiresAt,
          true,
          resource,
        );
    }
  }
  if (!string(data.assertion, MAX_BODY_BYTES))
    return error("invalid_request", "assertion is required.");
  const assertion = await ctx.signer.verify(data.assertion, ctx.now);
  if (!assertion)
    return error("invalid_grant", "Invalid or expired assertion.");
  const registration = await ctx.store.getRegistration(
    assertion.registrationId,
  );
  if (!registration) return error("invalid_grant", "Unknown registration.");
  return tokenResponse(
    ctx,
    registration,
    assertion.issuedAt,
    assertion.expiresAt,
    false,
    resource,
  );
}

/** Return null for routes/grants owned by the existing OAuth provider. */
export async function handleAgentAuthRequest(
  request: Request,
  env: AgentAuthEnv,
  _executionCtx?: ExecutionContext,
  deps: AgentAuthDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!(Object.values(AGENT_AUTH_PATHS) as string[]).includes(url.pathname))
    return null;
  let data: Body | null = null;
  if (request.method === "POST") data = await readBody(request.clone());
  const revoke =
    url.pathname === AGENT_AUTH_PATHS.revoke ||
    (url.pathname === AGENT_AUTH_PATHS.token &&
      data?.grant_type === undefined &&
      ownsRevocation(data));
  if (
    url.pathname === AGENT_AUTH_PATHS.token &&
    (request.method !== "POST" ||
      (!revoke &&
        data?.grant_type !== AGENT_AUTH_CLAIM_GRANT &&
        data?.grant_type !== AGENT_AUTH_JWT_GRANT))
  )
    return null;
  if (
    url.pathname === AGENT_AUTH_PATHS.revoke &&
    request.method === "POST" &&
    data &&
    !ownsRevocation(data)
  )
    return null;
  if (request.method === "OPTIONS") {
    return json({}, 204, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    });
  }
  const get =
    url.pathname === AGENT_AUTH_PATHS.jwks ||
    url.pathname === AGENT_AUTH_PATHS.verify;
  if (
    (url.pathname === AGENT_AUTH_PATHS.jwks && request.method !== "GET") ||
    (request.method !== "POST" && !(request.method === "GET" && get))
  )
    return error("invalid_request", "Method not allowed.", 405);
  if (request.method === "POST" && !data)
    return error("invalid_request", "A bounded JSON or form body is required.");
  try {
    const ctx = await context(env, deps);
    if (!ctx)
      return error(
        "temporarily_unavailable",
        "Agent authentication is not provisioned.",
        503,
      );
    if (url.pathname === AGENT_AUTH_PATHS.jwks) return json(ctx.signer.jwks());
    const rateLimited = await limited(request, env);
    if (rateLimited) return rateLimited;
    if (url.pathname === AGENT_AUTH_PATHS.token && !revoke)
      return await handleToken(data!, ctx);
    if (revoke) {
      if (data!.registration_id !== undefined) {
        if (
          !string(data!.registration_id, 128) ||
          !ID.test(data!.registration_id)
        )
          return error(
            "invalid_request",
            "A valid registration_id is required.",
          );
        const owner = await (deps.resolveOwner ?? resolveGithubOAuthOwner)(
          request,
          env,
        );
        if (!owner)
          return error(
            "access_denied",
            "A human GitHub OAuth owner grant is required.",
            401,
          );
        await ctx.store.revokeRegistration({
          registrationId: data!.registration_id,
          ownerId: owner.accountId,
          now: ctx.now,
        });
        return json({});
      }
      if (!string(data!.token, MAX_BODY_BYTES))
        return error("invalid_request", "token is required.");
      const hint = data!.token_type_hint;
      if (
        hint !== undefined &&
        hint !== "access_token" &&
        hint !== "identity_assertion"
      )
        return error(
          "unsupported_token_type",
          "Use access_token or identity_assertion.",
        );
      if (
        hint === "access_token" ||
        (hint === undefined && data!.token.startsWith("mg_agent_"))
      ) {
        await ctx.store.revokeToken(await sha256Hex(data!.token));
      } else {
        const assertion = await ctx.signer.verify(data!.token, ctx.now);
        const record = assertion
          ? await ctx.store.getRegistration(assertion.registrationId)
          : null;
        if (
          assertion &&
          record?.ownerId &&
          record.approvedAt === assertion.issuedAt &&
          assertion.expiresAt === assertion.issuedAt + 3600
        )
          await ctx.store.revokeRegistration({
            registrationId: record.id,
            ownerId: record.ownerId,
            now: ctx.now,
          });
      }
      return json({});
    }
    if (url.pathname === AGENT_AUTH_PATHS.register) {
      const hint = email(data!.login_hint);
      if (
        data!.type !== "service_auth" ||
        !hint ||
        (data!.client_name !== undefined && !string(data!.client_name, 80))
      )
        return error(
          "invalid_request",
          "service_auth and a valid email login_hint are required.",
        );
      const token = `mg_claim_${randomSecret()}`;
      const code = userCode();
      const registration = await ctx.store.createRegistration({
        id: crypto.randomUUID(),
        agentName:
          typeof data!.client_name === "string"
            ? data!.client_name
            : "Unnamed agent",
        emailHint: hint,
        permissions: PERMISSIONS,
        claimTokenHash: await sha256Hex(token),
        userCodeHash: await sha256Hex(code),
        createdAt: ctx.now,
        expiresAt: ctx.now + CLAIM_SECONDS,
      });
      return registration
        ? json(registrationView(registration, token, code, ctx.now), 201)
        : error(
            "temporarily_unavailable",
            "Registration could not be stored.",
            503,
          );
    }
    if (
      url.pathname === AGENT_AUTH_PATHS.claim ||
      url.pathname === AGENT_AUTH_PATHS.rotate
    ) {
      if (!string(data!.claim_token))
        return error("invalid_request", "claim_token is required.");
      const currentHash = await sha256Hex(data!.claim_token);
      const current = await ctx.store.readClaim(currentHash, ctx.now);
      if (!current)
        return error("invalid_grant", "The pending claim is not active.");
      if (
        url.pathname === AGENT_AUTH_PATHS.claim &&
        email(data!.email) !== current.emailHint
      )
        return error(
          "invalid_request",
          "email must match the registration login_hint.",
        );
      const token =
        url.pathname === AGENT_AUTH_PATHS.rotate
          ? `mg_claim_${randomSecret()}`
          : data!.claim_token;
      const code = userCode();
      const registration = await ctx.store.rotateClaim({
        registrationId: current.id,
        claimTokenHash: currentHash,
        nextClaimTokenHash: await sha256Hex(token),
        nextUserCodeHash: await sha256Hex(code),
        now: ctx.now,
      });
      if (!registration)
        return error(
          "invalid_grant",
          "The claim changed; restart the ceremony.",
        );
      if (url.pathname === AGENT_AUTH_PATHS.rotate)
        return json(registrationView(registration, token, code, ctx.now));
      return json({
        registration_id: registration.id,
        claim_attempt_id: `${registration.id}_${registration.claimVersion}`,
        status: "initiated",
        expires_at: new Date(registration.expiresAt * 1000).toISOString(),
        claim_attempt: claimView(registration, code, ctx.now),
      });
    }
    if (url.pathname === AGENT_AUTH_PATHS.verify && request.method === "GET") {
      const id = url.searchParams.get("registration_id") ?? "";
      const version = url.searchParams.get("claim_version");
      const registration = ID.test(id)
        ? await ctx.store.getRegistration(id)
        : null;
      if (
        !registration ||
        version !== String(registration.claimVersion) ||
        registration.approvedAt !== null ||
        registration.revokedAt !== null ||
        registration.expiresAt <= ctx.now
      )
        return error("invalid_request", "No active pending registration.");
      const state = {
        state: `agent_auth_${randomSecret()}`,
        cookie: randomSecret(),
        csrf: randomSecret(),
      };
      const ceremony = await ctx.store.createCeremony({
        stateHash: await sha256Hex(state.state),
        registrationId: id,
        cookieHash: await sha256Hex(state.cookie),
        csrfHash: await sha256Hex(state.csrf),
        createdAt: ctx.now,
        expiresAt: Math.min(ctx.now + CLAIM_SECONDS, registration.expiresAt),
      });
      if (!ceremony)
        return error("invalid_request", "The pending registration changed.");
      const response = page(
        "Verify the agent owner",
        `<p>Sign in with the GitHub account that has the registration email verified. Signing in does not approve this agent.</p><form method="post" action="${AGENT_AUTH_PATHS.verify}">${hidden(state)}<button type="submit">Continue to GitHub</button></form>`,
        true,
      );
      response.headers.set(
        "set-cookie",
        `${COOKIE}=${state.state}~${state.cookie}~${state.csrf}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CLAIM_SECONDS}`,
      );
      return response;
    }
    const state = browserState(request);
    if (!browserPost(request, data!, state))
      return error(
        "access_denied",
        "A same-origin browser approval session is required.",
        403,
      );
    const stateHash = await sha256Hex(state.state);
    const cookieHash = await sha256Hex(state.cookie);
    if (url.pathname === AGENT_AUTH_PATHS.verify) {
      const ceremony = await ctx.store.getCeremony({
        stateHash,
        cookieHash,
        now: ctx.now,
      });
      if (!ceremony || ceremony.oauthConsumedAt !== null)
        return error(
          "access_denied",
          "The sign-in state is no longer active.",
          403,
        );
      const target = new URL("https://github.com/login/oauth/authorize");
      target.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID!);
      target.searchParams.set(
        "redirect_uri",
        `${AGENT_AUTH_ISSUER}/oauth/callback/github`,
      );
      target.searchParams.set("scope", "read:user user:email");
      target.searchParams.set("state", state.state);
      const response = new Response(null, {
        status: 302,
        headers: headers(true, true),
      });
      response.headers.set("location", target.toString());
      return response;
    }
    if (
      data!.approve !== "yes" ||
      !string(data!.user_code, 6) ||
      !/^\d{6}$/.test(data!.user_code)
    )
      return error(
        "invalid_request",
        "Explicit approval and the six-digit user_code are required.",
      );
    const approved = await ctx.store.consumeCeremony({
      stateHash,
      cookieHash,
      csrfHash: await sha256Hex(state.csrf),
      userCodeHash: await sha256Hex(data!.user_code),
      now: ctx.now,
    });
    if (!approved)
      return error(
        "access_denied",
        "Approval failed or the verification code is no longer active.",
        403,
      );
    const response = page(
      "Agent approved",
      "<p>You approved profile access for this agent. Return to the agent to complete its claim.</p>",
    );
    response.headers.set(
      "set-cookie",
      `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
    return response;
  } catch {
    return error(
      "temporarily_unavailable",
      "Agent authentication is temporarily unavailable.",
      503,
    );
  }
}

/** GitHub proves the owner; a separate same-origin POST grants the agent access. */
export async function handleAgentAuthGithubCallback(
  request: Request,
  env: AgentAuthEnv,
  deps: AgentAuthDeps = {},
): Promise<Response> {
  try {
    const ctx = await context(env, deps);
    if (!ctx)
      return error(
        "temporarily_unavailable",
        "Agent authentication is not provisioned.",
        503,
      );
    const rateLimited = await limited(request, env);
    if (rateLimited) return rateLimited;
    const url = new URL(request.url);
    const state = browserState(request);
    const code = url.searchParams.get("code");
    if (
      !state ||
      url.searchParams.get("state") !== state.state ||
      !string(code, 1024)
    )
      return error("access_denied", "Invalid browser sign-in state.", 403);
    const stateHash = await sha256Hex(state.state);
    const cookieHash = await sha256Hex(state.cookie);
    const ceremony = await ctx.store.consumeOAuthState({
      stateHash,
      cookieHash,
      now: ctx.now,
    });
    if (!ceremony)
      return error(
        "access_denied",
        "Sign-in state expired or was already used.",
        403,
      );
    const resolved = await exchangeGithubIdentity(
      request,
      env,
      code,
      deps.fetch,
      true,
    );
    if ("error" in resolved)
      return error(
        "temporarily_unavailable",
        "GitHub identity verification failed.",
        502,
      );
    const registration = await ctx.store.getRegistration(
      ceremony.registrationId,
    );
    if (
      !registration ||
      !resolved.identity.verifiedEmails.includes(registration.emailHint)
    )
      return error(
        "access_denied",
        "GitHub must verify the registration email for this owner.",
        403,
      );
    const stored = await upsertGithubIdentityAccount(env, resolved.identity);
    if ("error" in stored)
      return error(
        "temporarily_unavailable",
        "Owner account storage is unavailable.",
        503,
      );
    const finished = await ctx.store.finishOAuth({
      stateHash,
      cookieHash,
      owner: {
        kind: "github",
        id: String(stored.accountId),
        email: registration.emailHint,
      },
      now: ctx.now,
    });
    if (!finished)
      return error("access_denied", "The pending registration changed.", 403);
    return page(
      "Approve this agent",
      `<p>Signed in as ${escapeHtml(resolved.identity.githubLogin)} with verified email ${escapeHtml(registration.emailHint)}.</p><p>Agent name (self-reported): <strong>${escapeHtml(registration.agentName)}</strong></p><p>Requested access: ${registration.permissions.map(escapeHtml).join(", ")}. Approval allows this agent to use your account's current access tier for up to one hour.</p><form method="post" action="${AGENT_AUTH_PATHS.approve}">${hidden(state)}<label>Enter the six-digit code shown by your agent <input name="user_code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="off"></label><button type="submit" name="approve" value="yes">Approve profile access</button></form><p>Close this page to decline.</p>`,
    );
  } catch {
    return error(
      "temporarily_unavailable",
      "Owner verification is temporarily unavailable.",
      503,
    );
  }
}

/** Called only after the provider rejects an internal token; no new anonymous grant. */
export async function resolveAgentAuthExternalToken(
  input: { token: string; request: Request; env: AgentAuthEnv },
  deps: AgentAuthDeps = {},
) {
  if (!/^mg_agent_[A-Za-z0-9_-]{43}$/.test(input.token)) return null;
  try {
    const ctx = await context(input.env, deps);
    if (!ctx) return null;
    const record = await ctx.store.resolveToken(
      await sha256Hex(input.token),
      ctx.now,
    );
    if (!record?.ownerId || record.ownerKind !== "github") return null;
    const id = Number(record.ownerId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return {
      props: { accountId: id, agentRegistrationId: record.id },
      audience: [record.resource],
    };
  } catch {
    return null;
  }
}
