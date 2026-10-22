import assert from "node:assert/strict";
import { afterEach, beforeAll, test, vi } from "vitest";
import {
  AGENT_AUTH_CLAIM_GRANT,
  AGENT_AUTH_ISSUER,
  AGENT_AUTH_JWT_GRANT,
  handleAgentAuthGithubCallback,
  handleAgentAuthRequest,
  isAgentAuthReady,
  resolveAgentAuthExternalToken,
  type AgentAuthDeps,
  type AgentAuthEnv,
} from "../src/agent-auth.ts";
import {
  loadAgentAuthSigner,
  type AgentAuthSigner,
} from "../src/agent-auth-jwt.ts";
import { sha256Hex } from "../src/sha256-hex.ts";
import { createAgentAuthFixture } from "./agent-auth-fixtures.ts";

let signer: AgentAuthSigner;
let signingJwk: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  signingJwk = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const loaded = await loadAgentAuthSigner(signingJwk, AGENT_AUTH_ISSUER);
  assert.ok(loaded);
  signer = loaded;
});
const fixtures: ReturnType<typeof createAgentAuthFixture>[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.close());
  vi.restoreAllMocks();
});
interface Registration {
  registration_id: string;
  registration_type: string;
  claim_token: string;
  claim_token_expires: string;
  post_claim_scopes: string[];
  claim: {
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
}
interface Token {
  access_token: string;
  identity_assertion: string;
  assertion_expires: string;
  expires_in: number;
  token_type: string;
  scope: string;
}
function request(
  path: string,
  data?: Record<string, unknown>,
  headers: HeadersInit = {},
) {
  const requestHeaders = new Headers(headers);
  if (data !== undefined)
    requestHeaders.set("content-type", "application/json");
  return new Request(
    `${AGENT_AUTH_ISSUER}${path}`,
    data === undefined
      ? { headers: requestHeaders }
      : {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(data),
        },
  );
}
async function parsed<T>(response: Response | null): Promise<T> {
  assert.ok(response);
  return (await response.json()) as T;
}
async function errorCode(response: Response | null, status = 400) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await parsed<{ error: string }>(response)).error;
}
function fixture() {
  const f = createAgentAuthFixture();
  fixtures.push(f);
  let now = 100;
  const limit = vi.fn(async () => ({ success: true }));
  const env: AgentAuthEnv = {
    GITHUB_OAUTH_CLIENT_ID: "client",
    GITHUB_OAUTH_CLIENT_SECRET: "private-test-value",
    API_KEY_LOOKUP_INTERNAL_TOKEN: "internal-test-value",
    DATA_API: { fetch: vi.fn(async () => Response.json({ id: 42 })) },
    AGENT_AUTH_RATE_LIMITER: { limit },
  };
  const deps: AgentAuthDeps = { store: f.store, signer, now: () => now };
  const auth = (
    path: string,
    data?: Record<string, unknown>,
    headers?: HeadersInit,
    override: AgentAuthDeps = {},
  ) =>
    handleAgentAuthRequest(request(path, data, headers), env, undefined, {
      ...deps,
      ...override,
    });
  const register = async (name = "Example <agent>") => {
    const result = await auth("/agent/register", {
      type: "service_auth",
      login_hint: " Owner@Example.COM ",
      client_name: name,
    });
    assert.equal(result?.status, 201);
    return parsed<Registration>(result);
  };
  const browser = async (registration: Registration) => {
    const response = await auth(
      registration.claim.verification_uri.slice(AGENT_AUTH_ISSUER.length),
    );
    assert.equal(response?.status, 200);
    const cookie = response!.headers.get("set-cookie")!.split(";")[0];
    const [state, , csrf] = cookie.slice(cookie.indexOf("=") + 1).split("~");
    return { cookie, state, csrf, response: response! };
  };
  type Browser = Awaited<ReturnType<typeof browser>>;
  const browserHeaders = (b: Browser) => ({
    origin: AGENT_AUTH_ISSUER,
    cookie: b.cookie,
  });
  const github = (
    emails: unknown = [{ email: "owner@example.com", verified: true }],
  ) =>
    vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("access_token"))
        return Response.json({ access_token: "upstream-test-token" });
      if (String(url).endsWith("/user/emails")) return Response.json(emails);
      return Response.json({
        id: 4200,
        login: "owner",
        email: "owner@example.com",
      });
    });
  const callback = (
    b: Browser,
    fetch: typeof globalThis.fetch = github(),
    override: AgentAuthDeps = {},
  ) =>
    handleAgentAuthGithubCallback(
      request(
        `/oauth/callback/github?state=${b.state}&code=github-code`,
        undefined,
        { cookie: b.cookie },
      ),
      env,
      { ...deps, fetch, ...override },
    );
  const approve = (b: Browser, code: string) =>
    auth(
      "/agent/approve",
      { state: b.state, csrf: b.csrf, approve: "yes", user_code: code },
      browserHeaders(b),
    );
  const approved = async () => {
    const registration = await register();
    const b = await browser(registration);
    assert.equal((await callback(b)).status, 200);
    now = 110;
    assert.equal((await approve(b, registration.claim.user_code))?.status, 200);
    return { registration, browser: b };
  };
  const claim = (registration: Registration) =>
    auth("/oauth/token", {
      grant_type: AGENT_AUTH_CLAIM_GRANT,
      claim_token: registration.claim_token,
    });
  return {
    ...f,
    env,
    deps,
    auth,
    register,
    browser,
    browserHeaders,
    github,
    callback,
    approve,
    approved,
    claim,
    limit,
    time(value: number) {
      now = value;
    },
  };
}

test("owner-approved lifecycle issues no credential until a separate explicit approval", async () => {
  const f = fixture();
  const registration = await f.register();
  assert.equal(registration.registration_type, "service_auth");
  assert.deepEqual(registration.post_claim_scopes, ["profile"]);
  assert.match(registration.claim_token, /^mg_claim_[A-Za-z0-9_-]{43}$/);
  assert.match(registration.claim.user_code, /^\d{6}$/);
  assert.equal(registration.claim.expires_in, 600);
  assert.equal(registration.claim.interval, 5);
  assert.equal(
    registration.claim_token_expires,
    new Date(700000).toISOString(),
  );
  assert.equal(
    await errorCode(await f.claim(registration)),
    "authorization_pending",
  );
  const tooFast = await f.claim(registration);
  assert.equal(tooFast?.headers.get("retry-after"), "5");
  assert.equal(await errorCode(tooFast), "slow_down");
  const b = await f.browser(registration);
  assert.match(
    b.response.headers.get("set-cookie")!,
    /Secure; HttpOnly; SameSite=Lax; Path=\//,
  );
  assert.match(
    b.response.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  assert.equal(b.response.headers.get("access-control-allow-origin"), null);
  assert.doesNotMatch(await b.response.text(), /owner@example.com/);
  const signIn = await f.auth(
    "/agent/verify",
    { state: b.state, csrf: b.csrf },
    f.browserHeaders(b),
  );
  assert.equal(signIn?.status, 302);
  const target = new URL(signIn!.headers.get("location")!);
  assert.equal(target.origin, "https://github.com");
  assert.equal(target.searchParams.get("scope"), "read:user user:email");
  assert.equal(target.searchParams.get("state"), b.state);
  const callback = await f.callback(b);
  const approvalPage = await callback.text();
  assert.equal(callback.status, 200);
  assert.match(approvalPage, /Example &lt;agent&gt;/);
  assert.match(approvalPage, /self-reported/);
  assert.match(approvalPage, /profile/);
  assert.equal(
    (await f.store.getRegistration(registration.registration_id))?.approvedAt,
    null,
  );
  f.time(105);
  assert.equal(
    await errorCode(await f.claim(registration)),
    "authorization_pending",
  );
  f.time(110);
  const approval = await f.approve(b, registration.claim.user_code);
  assert.equal(approval?.status, 200);
  assert.match(approval!.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(
    await errorCode(await f.approve(b, registration.claim.user_code), 403),
    "access_denied",
  );
  const result = await parsed<Token>(await f.claim(registration));
  assert.match(result.access_token, /^mg_agent_[A-Za-z0-9_-]{43}$/);
  assert.equal(result.expires_in, 3600);
  assert.equal(result.scope, "profile");
  assert.equal(result.token_type, "Bearer");
  assert.equal(result.assertion_expires, new Date(3710000).toISOString());
  const resolved = await resolveAgentAuthExternalToken(
    { token: result.access_token, request: request("/mcp"), env: f.env },
    f.deps,
  );
  assert.deepEqual(resolved, {
    props: { accountId: 42, agentRegistrationId: registration.registration_id },
    audience: [`${AGENT_AUTH_ISSUER}/mcp`],
  });
  const storage =
    JSON.stringify(
      f.sql.prepare("SELECT * FROM agent_auth_registrations").all(),
    ) + JSON.stringify(f.sql.prepare("SELECT * FROM agent_auth_tokens").all());
  assert.ok(!storage.includes(registration.claim_token));
  assert.ok(!storage.includes(result.access_token));
  f.time(200);
  const exchange = await parsed<Token>(
    await f.auth("/oauth/token", {
      grant_type: AGENT_AUTH_JWT_GRANT,
      assertion: result.identity_assertion,
      resource: `${AGENT_AUTH_ISSUER}/mcp/core`,
      scope: "profile",
    }),
  );
  assert.equal(exchange.expires_in, 3510);
  assert.equal(exchange.identity_assertion, undefined);
  f.time(205);
  assert.equal(
    (await parsed<Token>(await f.claim(registration))).expires_in,
    3505,
  );
  await f.auth("/oauth/revoke", {
    token: result.access_token,
    token_type_hint: "access_token",
  });
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: result.access_token, request: request("/mcp"), env: f.env },
      f.deps,
    ),
    null,
  );
  assert.deepEqual(
    await resolveAgentAuthExternalToken(
      { token: exchange.access_token, request: request("/mcp"), env: f.env },
      f.deps,
    ),
    {
      props: {
        accountId: 42,
        agentRegistrationId: registration.registration_id,
      },
      audience: [`${AGENT_AUTH_ISSUER}/mcp/core`],
    },
  );
  assert.ok(result.identity_assertion.length > 256);
  assert.equal(
    (await f.auth("/oauth/revoke", { token: result.identity_assertion }))
      ?.status,
    200,
  );
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: exchange.access_token, request: request("/mcp"), env: f.env },
      f.deps,
    ),
    null,
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: result.identity_assertion,
      }),
    ),
    "invalid_grant",
  );
  assert.equal(await errorCode(await f.claim(registration)), "access_denied");
  f.time(210);
  assert.equal(await errorCode(await f.claim(registration)), "access_denied");
});

test("claim rotation preserves immutable email, invalidates old browser state, and does not reset expiry", async () => {
  const f = fixture();
  const registration = await f.register();
  const b = await f.browser(registration);
  assert.equal(
    await errorCode(
      await f.auth("/agent/claim", {
        claim_token: registration.claim_token,
        email: "attacker@example.com",
      }),
    ),
    "invalid_request",
  );
  assert.equal(
    (await f.store.getRegistration(registration.registration_id))?.emailHint,
    "owner@example.com",
  );
  f.time(200);
  const attempt = await parsed<{
    claim_attempt_id: string;
    claim_attempt: { user_code: string; expires_in: number };
  }>(
    await f.auth("/agent/claim", {
      claim_token: registration.claim_token,
      email: "OWNER@EXAMPLE.COM",
    }),
  );
  assert.equal(attempt.claim_attempt.expires_in, 500);
  assert.match(attempt.claim_attempt_id, /_2$/);
  assert.equal((await f.callback(b)).status, 403);
  const rotated = await parsed<Registration>(
    await f.auth("/agent/rotate", { claim_token: registration.claim_token }),
  );
  assert.notEqual(rotated.claim_token, registration.claim_token);
  assert.equal(rotated.claim_token_expires, registration.claim_token_expires);
  assert.equal(
    await errorCode(
      await f.auth(
        registration.claim.verification_uri.slice(AGENT_AUTH_ISSUER.length),
      ),
    ),
    "invalid_request",
  );
  assert.equal(await errorCode(await f.claim(registration)), "expired_token");
  assert.equal(
    await errorCode(await f.auth("/agent/rotate", { claim_token: "missing" })),
    "invalid_grant",
  );
  f.time(700);
  assert.equal(await errorCode(await f.claim(rotated)), "expired_token");
  assert.equal(
    await errorCode(
      await f.auth(
        `/agent/verify?registration_id=${registration.registration_id}`,
      ),
    ),
    "invalid_request",
  );
});

test("claim rotation refuses a registration revoked after its pending claim was read", async () => {
  const f = fixture();
  const registration = await f.register();
  let interleaved = false;
  f.before((query) => {
    if (!query.includes("SET claim_token_hash=")) return;
    interleaved = true;
    f.sql
      .prepare("UPDATE agent_auth_registrations SET revoked_at=100 WHERE id=?")
      .run(registration.registration_id);
  });
  assert.equal(
    await errorCode(
      await f.auth("/agent/rotate", { claim_token: registration.claim_token }),
    ),
    "invalid_grant",
  );
  assert.equal(interleaved, true);
  const stored = await f.store.getRegistration(registration.registration_id);
  assert.equal(stored?.claimVersion, 1);
  assert.equal(stored?.revokedAt, 100);
});

test("browser verification binds the checked claim version to its atomic ceremony write", async () => {
  const f = fixture();
  const registration = await f.register();
  assert.equal(
    await errorCode(await f.auth("/agent/verify?claim_version=1")),
    "invalid_request",
  );
  let interleaved = false;
  f.before((query) => {
    if (!query.includes("INSERT INTO agent_auth_ceremonies")) return;
    interleaved = true;
    f.sql
      .prepare(
        "UPDATE agent_auth_registrations SET claim_version=claim_version+1 WHERE id=?",
      )
      .run(registration.registration_id);
  });
  const response = await f.auth(
    registration.claim.verification_uri.slice(AGENT_AUTH_ISSUER.length),
  );
  assert.equal(await errorCode(response), "invalid_request");
  assert.equal(interleaved, true);
  assert.equal(response?.headers.get("set-cookie"), null);
  assert.equal(
    f.sql.prepare("SELECT count(*) AS total FROM agent_auth_ceremonies").get()
      ?.total,
    0,
  );
  assert.equal(
    (await f.store.getRegistration(registration.registration_id))?.claimVersion,
    2,
  );
  f.before();
  assert.equal(
    (
      await f.auth(
        `/agent/verify?registration_id=${registration.registration_id}&claim_version=2`,
      )
    )?.status,
    200,
  );
});

test("browser approval requires current cookie, Origin, CSRF and explicit six-digit consent", async () => {
  const f = fixture();
  const registration = await f.register();
  const b = await f.browser(registration);
  const data = {
    state: b.state,
    csrf: b.csrf,
    approve: "yes",
    user_code: registration.claim.user_code,
  };
  for (const h of [
    {},
    { cookie: b.cookie },
    { ...f.browserHeaders(b), origin: "https://attacker.example" },
    { ...f.browserHeaders(b), cookie: `${b.cookie}; ${b.cookie}` },
    { ...f.browserHeaders(b), cookie: `${b.cookie}~extra` },
    {
      ...f.browserHeaders(b),
      cookie: b.cookie.slice(0, b.cookie.lastIndexOf("~")),
    },
    {
      ...f.browserHeaders(b),
      cookie: `${b.cookie.slice(0, b.cookie.lastIndexOf("~"))}~invalid`,
    },
  ]) {
    assert.equal(
      await errorCode(await f.auth("/agent/approve", data, h), 403),
      "access_denied",
    );
  }
  for (const fields of [{ state: "other" }, { csrf: "other" }])
    assert.equal(
      await errorCode(
        await f.auth(
          "/agent/approve",
          { ...data, ...fields },
          f.browserHeaders(b),
        ),
        403,
      ),
      "access_denied",
    );
  const alienOrigin = new Request(`https://wrong.example/agent/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", ...f.browserHeaders(b) },
    body: JSON.stringify(data),
  });
  assert.equal(
    (await handleAgentAuthRequest(alienOrigin, f.env, undefined, f.deps))
      ?.status,
    403,
  );
  for (const fields of [
    { approve: "no" },
    { user_code: "12345" },
    { user_code: "abcdef" },
    { user_code: 123456 },
  ])
    assert.equal(
      await errorCode(
        await f.auth(
          "/agent/approve",
          { ...data, ...fields },
          f.browserHeaders(b),
        ),
      ),
      "invalid_request",
    );
  assert.equal((await f.approve(b, registration.claim.user_code))?.status, 403);
  assert.equal((await f.callback(b)).status, 200);
  assert.equal((await f.callback(b)).status, 403);
  assert.equal(
    (await f.auth("/agent/verify", data, f.browserHeaders(b)))?.status,
    403,
  );
  assert.equal(
    (
      await f.approve(
        b,
        registration.claim.user_code === "000000" ? "000001" : "000000",
      )
    )?.status,
    403,
  );
  assert.equal((await f.approve(b, registration.claim.user_code))?.status, 200);
});

test("GitHub's verified email, rather than submitted or public profile email, proves ownership", async () => {
  const f = fixture();
  const registration = await f.register();
  for (const emails of [
    [],
    [{ email: "owner@example.com", verified: false }],
    [{ email: "other@example.com", verified: true }],
  ]) {
    const b = await f.browser(registration);
    assert.equal((await f.callback(b, f.github(emails))).status, 403);
    assert.equal(
      (await f.store.getRegistration(registration.registration_id))?.approvedAt,
      null,
    );
  }
  const b = await f.browser(registration);
  assert.equal(
    (
      await f.callback(
        b,
        f.github([{ email: " OWNER@EXAMPLE.COM ", verified: true }]),
      )
    ).status,
    200,
  );
  assert.equal((await f.approve(b, registration.claim.user_code))?.status, 200);
});

test("registration and grant validation reject malformed or broader authority", async () => {
  const f = fixture();
  for (const fields of [
    { type: "oauth" },
    { login_hint: "not-an-email" },
    { login_hint: "a".repeat(255) },
    { client_name: "" },
    { client_name: "x".repeat(81) },
  ])
    assert.equal(
      await errorCode(
        await f.auth("/agent/register", {
          type: "service_auth",
          login_hint: "owner@example.com",
          ...fields,
        }),
      ),
      "invalid_request",
    );
  const unnamed = await parsed<Registration>(
    await f.auth("/agent/register", {
      type: "service_auth",
      login_hint: "owner@example.com",
    }),
  );
  assert.equal(
    (await f.store.getRegistration(unnamed.registration_id))?.agentName,
    "Unnamed agent",
  );
  for (const path of ["/agent/claim", "/agent/rotate"])
    assert.equal(await errorCode(await f.auth(path, {})), "invalid_request");
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", { grant_type: AGENT_AUTH_CLAIM_GRANT }),
    ),
    "invalid_request",
  );
  for (const resource of [
    "https://attacker.example/mcp",
    `${AGENT_AUTH_ISSUER}/mcp/`,
    1,
  ])
    assert.equal(
      await errorCode(
        await f.auth("/oauth/token", {
          grant_type: AGENT_AUTH_CLAIM_GRANT,
          claim_token: "unknown",
          resource,
        }),
      ),
      "invalid_target",
    );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_CLAIM_GRANT,
        claim_token: "unknown",
        scope: "admin",
      }),
    ),
    "invalid_scope",
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", { grant_type: AGENT_AUTH_JWT_GRANT }),
    ),
    "invalid_request",
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: "invalid",
      }),
    ),
    "invalid_grant",
  );
  const unknown = await signer.sign("unknown", 100, 3700);
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: unknown,
      }),
    ),
    "invalid_grant",
  );
  assert.equal(
    await errorCode(await f.auth("/agent/verify?registration_id=bad!")),
    "invalid_request",
  );
  assert.equal(
    await errorCode(await f.auth("/agent/verify?registration_id=missing")),
    "invalid_request",
  );
});

test("revocation is idempotent, single-token by default, and owner checked for registration IDs", async () => {
  const f = fixture();
  const { registration } = await f.approved();
  const token = await parsed<Token>(await f.claim(registration));
  assert.equal(
    (await f.auth("/oauth/revoke", { token: "mg_agent_unknown" }))?.status,
    200,
  );
  assert.equal(
    (
      await f.auth("/oauth/token", {
        token: "mg_agent_unknown",
        token_type_hint: "access_token",
      })
    )?.status,
    200,
  );
  assert.equal(
    (
      await f.auth("/oauth/revoke", {
        token: "invalid",
        token_type_hint: "identity_assertion",
      })
    )?.status,
    200,
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/revoke", {
        token: "mg_agent_unknown",
        token_type_hint: "refresh_token",
      }),
    ),
    "unsupported_token_type",
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/revoke", { token_type_hint: "identity_assertion" }),
    ),
    "invalid_request",
  );
  assert.equal(
    await errorCode(await f.auth("/oauth/revoke", { registration_id: "bad!" })),
    "invalid_request",
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/revoke", {
        registration_id: registration.registration_id,
      }),
      401,
    ),
    "access_denied",
  );
  const owner = async () => ({ accountId: "42" });
  assert.equal(
    (
      await f.auth(
        "/oauth/revoke",
        { registration_id: registration.registration_id },
        {},
        { resolveOwner: async () => ({ accountId: "99" }) },
      )
    )?.status,
    200,
  );
  assert.ok(
    await f.store.resolveToken(await sha256Hex(token.access_token), 110),
  );
  assert.equal(
    (
      await f.auth(
        "/oauth/revoke",
        { registration_id: registration.registration_id },
        {},
        { resolveOwner: owner },
      )
    )?.status,
    200,
  );
  assert.equal(
    (
      await f.auth(
        "/oauth/revoke",
        { registration_id: registration.registration_id },
        {},
        { resolveOwner: owner },
      )
    )?.status,
    200,
  );
  assert.equal(
    await f.store.resolveToken(await sha256Hex(token.access_token), 110),
    null,
  );
  assert.equal(
    (
      await f.auth(
        "/agent/verify?registration_id=" + registration.registration_id,
      )
    )?.status,
    400,
  );
});

test("an assertion cannot extend the approval horizon or survive owner deletion", async () => {
  const f = fixture();
  const { registration } = await f.approved();
  const token = await parsed<Token>(await f.claim(registration));
  f.time(120);
  const altered = await signer.sign(registration.registration_id, 111, 3711);
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: altered,
      }),
    ),
    "invalid_grant",
  );
  assert.equal(
    (
      await f.auth("/oauth/revoke", {
        token: altered,
        token_type_hint: "identity_assertion",
      })
    )?.status,
    200,
  );
  assert.equal(
    (await f.store.getRegistration(registration.registration_id))?.revokedAt,
    null,
  );
  f.sql.exec("DELETE FROM github_accounts WHERE id=42");
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: token.access_token, request: request("/mcp"), env: f.env },
      f.deps,
    ),
    null,
  );
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: token.identity_assertion,
      }),
    ),
    "invalid_grant",
  );
  f.time(3710);
  assert.equal(
    await errorCode(
      await f.auth("/oauth/token", {
        grant_type: AGENT_AUTH_JWT_GRANT,
        assertion: token.identity_assertion,
      }),
    ),
    "invalid_grant",
  );
});

test("body parsing is bounded and ordinary OAuth flows retain their request body", async () => {
  const f = fixture();
  assert.equal(await f.auth("/unrelated"), null);
  for (const data of [
    { grant_type: "authorization_code", code: "opaque" },
    { grant_type: "refresh_token", refresh_token: "opaque" },
  ]) {
    const r = request("/oauth/token", data);
    assert.equal(
      await handleAgentAuthRequest(r, f.env, undefined, f.deps),
      null,
    );
    assert.deepEqual(await r.json(), data);
  }
  for (const token of [
    "provider-opaque-token",
    "bad.jwt.parts",
    "e30.payload.signature",
    "!",
    "A".repeat(700),
    "bnVsbA.payload.signature",
  ])
    assert.equal(
      await f.auth("/oauth/revoke", { token, token_type_hint: "access_token" }),
      null,
    );
  assert.equal(await f.auth("/oauth/revoke", { token: 1 }), null);
  assert.equal(await f.auth("/oauth/token"), null);
  for (const [body, contentType] of [
    ["[]", "application/json"],
    ["null", "application/json"],
    ["{", "application/json"],
    ["{}", "text/plain"],
    ["type=service_auth&type=again", "application/x-www-form-urlencoded"],
    ["x".repeat(8193), "application/json"],
  ]) {
    const r = new Request(`${AGENT_AUTH_ISSUER}/agent/register`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    assert.equal(
      await errorCode(
        await handleAgentAuthRequest(r, f.env, undefined, f.deps),
      ),
      "invalid_request",
    );
  }
  const invalidUtf8 = new Request(`${AGENT_AUTH_ISSUER}/agent/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([255]),
  });
  assert.equal(
    (await handleAgentAuthRequest(invalidUtf8, f.env, undefined, f.deps))
      ?.status,
    400,
  );
  const noBody = new Request(`${AGENT_AUTH_ISSUER}/agent/register`, {
    method: "POST",
  });
  assert.equal(
    (await handleAgentAuthRequest(noBody, f.env, undefined, f.deps))?.status,
    400,
  );
  const oversized = new Request(`${AGENT_AUTH_ISSUER}/agent/register`, {
    method: "POST",
    headers: { "content-length": "9000" },
    body: "{}",
  });
  assert.equal(
    (await handleAgentAuthRequest(oversized, f.env, undefined, f.deps))?.status,
    400,
  );
  const form = new Request(`${AGENT_AUTH_ISSUER}/agent/register`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: "type=service_auth&login_hint=owner%40example.com",
  });
  assert.equal(
    (await handleAgentAuthRequest(form, f.env, undefined, f.deps))?.status,
    201,
  );
  for (const path of [
    "/agent/register",
    "/agent/claim",
    "/agent/rotate",
    "/agent/approve",
    "/oauth/revoke",
  ])
    assert.equal((await f.auth(path))?.status, 405);
  assert.equal((await f.auth("/oauth/jwks", {}))?.status, 405);
  const options = await handleAgentAuthRequest(
    new Request(`${AGENT_AUTH_ISSUER}/agent/register`, { method: "OPTIONS" }),
    {},
    undefined,
  );
  assert.equal(options?.status, 204);
  assert.equal(await options?.text(), "");
  assert.equal(options?.headers.get("access-control-allow-origin"), "*");
  assert.equal((await f.auth("/oauth/jwks"))?.status, 200);
});

test("oversized authentication bodies refuse promptly even if cancellation hangs or rejects", async () => {
  const f = fixture();
  for (const cancel of [
    vi.fn(() => new Promise<void>(() => {})),
    vi.fn(() => Promise.reject(new Error("private cancellation failure"))),
  ]) {
    const r = request("/agent/register", {});
    vi.spyOn(r, "clone").mockReturnValue({
      headers: r.headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8193));
        },
        cancel,
      }),
    } as Request);
    const response = await handleAgentAuthRequest(r, f.env, undefined, f.deps);
    assert.equal(await errorCode(response), "invalid_request");
    assert.equal(cancel.mock.calls.length, 1);
  }
});

test("provisioning and native rate limits fail closed without leaking credentials", async () => {
  const f = fixture();
  assert.equal(await isAgentAuthReady(f.env, f.deps), true);
  assert.equal(
    await isAgentAuthReady(f.env, { ...f.deps, store: null }),
    false,
  );
  assert.equal(
    await isAgentAuthReady(f.env, { ...f.deps, signer: null }),
    false,
  );
  assert.equal(
    await isAgentAuthReady({ ...f.env, DATA_API: undefined }, f.deps),
    false,
  );
  assert.equal(
    await isAgentAuthReady(f.env, {
      ...f.deps,
      store: {
        ...f.store,
        ready: async () => {
          throw new Error("private failure");
        },
      },
    }),
    false,
  );
  const nativeEnv = {
    ...f.env,
    D1_STATE: f.db,
    D1_STATE_TABLES:
      "agent_auth_registrations,agent_auth_ceremonies,agent_auth_tokens",
    AUTHMD_SIGNING_JWK: signingJwk,
  };
  assert.equal(await isAgentAuthReady(nativeEnv), true);
  assert.equal(
    await isAgentAuthReady({
      ...nativeEnv,
      D1_STATE_TABLES: "agent_auth_registrations",
    }),
    false,
  );
  assert.equal(
    await isAgentAuthReady({ ...nativeEnv, D1_STATE: undefined }),
    false,
  );
  assert.equal(
    await isAgentAuthReady({ ...nativeEnv, AUTHMD_SIGNING_JWK: "invalid" }),
    false,
  );
  const notProvisioned = await handleAgentAuthRequest(
    request("/agent/register", {}),
    {},
    undefined,
  );
  assert.equal(await errorCode(notProvisioned, 503), "temporarily_unavailable");
  const unavailable = await f.auth(
    "/agent/register",
    { type: "service_auth", login_hint: "owner@example.com" },
    {},
    { store: { ...f.store, createRegistration: async () => null } },
  );
  assert.equal(await errorCode(unavailable, 503), "temporarily_unavailable");
  f.limit.mockResolvedValue({ success: false });
  for (const [path, data] of [
    ["/agent/register", {}],
    ["/oauth/token", { grant_type: AGENT_AUTH_JWT_GRANT, assertion: "x" }],
    ["/oauth/revoke", { token: "mg_agent_x" }],
  ] as const) {
    const response = await f.auth(path, data);
    assert.equal(response?.headers.get("retry-after"), "60");
    assert.equal(await errorCode(response, 429), "slow_down");
  }
  assert.equal((await f.auth("/oauth/jwks"))?.status, 200);
  assert.deepEqual(f.limit.mock.calls[0], [{ key: "agent-auth:unknown" }]);
  await f.auth("/agent/register", {}, { "cf-connecting-ip": "192.0.2.1" });
  assert.deepEqual(f.limit.mock.calls.at(-1), [
    { key: "agent-auth:192.0.2.1" },
  ]);
  assert.equal(
    (
      await handleAgentAuthGithubCallback(
        request("/oauth/callback/github"),
        f.env,
        f.deps,
      )
    ).status,
    429,
  );
});

test("store, signing, callback and resolution failures return bounded generic errors", async () => {
  const f = fixture();
  const { registration } = await f.approved();
  const token = await parsed<Token>(await f.claim(registration));
  f.time(120);
  const failing: AgentAuthDeps = {
    store: {
      ...f.store,
      issueToken: async () => {
        throw new Error("private details");
      },
    },
  };
  const response = await f.auth(
    "/oauth/token",
    { grant_type: AGENT_AUTH_JWT_GRANT, assertion: token.identity_assertion },
    {},
    failing,
  );
  assert.equal(response?.status, 503);
  assert.doesNotMatch(
    await response!.text(),
    /private details|private-test-value|internal-test-value/,
  );
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: "invalid", request: request("/mcp"), env: f.env },
      f.deps,
    ),
    null,
  );
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: token.access_token, request: request("/mcp"), env: f.env },
      { ...f.deps, signer: null },
    ),
    null,
  );
  assert.equal(
    await resolveAgentAuthExternalToken(
      { token: token.access_token, request: request("/mcp"), env: f.env },
      {
        ...f.deps,
        store: {
          ...f.store,
          resolveToken: async () => {
            throw new Error("private");
          },
        },
      },
    ),
    null,
  );
  const record = (await f.store.getRegistration(registration.registration_id))!;
  for (const ownerId of [null, "0", "1.5", "not-a-number"])
    assert.equal(
      await resolveAgentAuthExternalToken(
        { token: token.access_token, request: request("/mcp"), env: f.env },
        {
          ...f.deps,
          store: {
            ...f.store,
            resolveToken: async () => ({
              ...record,
              ownerId,
              tokenExpiresAt: 3710,
              resource: `${AGENT_AUTH_ISSUER}/mcp`,
            }),
          },
        },
      ),
      null,
    );
  assert.equal(
    (
      await handleAgentAuthGithubCallback(
        request("/oauth/callback/github"),
        {},
        f.deps,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await handleAgentAuthGithubCallback(
        request("/oauth/callback/github"),
        f.env,
        f.deps,
      )
    ).status,
    403,
  );
  const other = await f.register();
  const b = await f.browser(other);
  const wrongState = request(
    `/oauth/callback/github?state=other&code=x`,
    undefined,
    { cookie: b.cookie },
  );
  assert.equal(
    (await handleAgentAuthGithubCallback(wrongState, f.env, f.deps)).status,
    403,
  );
  assert.equal(
    (
      await f.callback(
        b,
        vi.fn(async () => new Response("no", { status: 500 })),
      )
    ).status,
    502,
  );
  const c = await f.browser(other);
  f.env.DATA_API = { fetch: async () => new Response("no", { status: 500 }) };
  assert.equal((await f.callback(c)).status, 503);
  const d = await f.browser(other);
  assert.equal(
    (
      await f.callback(
        d,
        vi.fn(async () => {
          throw new Error("private");
        }),
      )
    ).status,
    503,
  );
  const e = await f.browser(other);
  f.env.DATA_API = { fetch: async () => Response.json({ id: 42 }) };
  assert.equal(
    (
      await f.callback(e, f.github(), {
        store: { ...f.store, finishOAuth: async () => null },
      })
    ).status,
    403,
  );
});
