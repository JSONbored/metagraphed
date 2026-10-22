import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";
import {
  buildOAuthProviderOptions,
  exchangeGithubIdentity,
  handleGithubOAuthCallback,
  resolveGithubOAuthOwner,
  upsertGithubIdentityAccount,
  UNUSED_DEFAULT_HANDLER,
  type GithubIdentityEnv,
  type GithubOwnerEnv,
} from "../src/github-oauth.ts";

const getOAuthApiMock = vi.fn();
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  getOAuthApi: (...args: unknown[]) => getOAuthApiMock(...args),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getOAuthApiMock.mockReset();
});
const request = new Request("https://api.metagraph.sh/oauth/callback/github");
const env: GithubIdentityEnv = {
  GITHUB_OAUTH_CLIENT_ID: "client",
  GITHUB_OAUTH_CLIENT_SECRET: "private-test-value",
};
function github(responses: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    assert.ok(response, "unexpected upstream request");
    return response;
  });
}
const token = () => Response.json({ access_token: "upstream-test-token" });
const profile = () =>
  Response.json({ id: 4200, login: "owner", email: "public@example.com" });
const identity = {
  githubUserId: 4200,
  githubLogin: "owner",
  verifiedEmails: ["owner@example.com"],
};
async function responseError(
  result: { identity: unknown } | { accountId: number } | { error: Response },
  message: string,
) {
  assert.ok("error" in result);
  assert.equal(result.error.status, 502);
  assert.equal(await result.error.text(), message);
}

test("verified email proof uses the authenticated GitHub email list exclusively", async () => {
  const doFetch = github([
    token(),
    profile(),
    Response.json([
      { email: " OWNER@EXAMPLE.COM ", verified: true },
      { email: "unverified@example.com", verified: false },
      { email: "public@example.com" },
      { email: 1, verified: true },
      null,
      "invalid",
    ]),
  ]);
  assert.deepEqual(
    await exchangeGithubIdentity(request, env, "code", doFetch, true),
    { identity },
  );
  assert.equal(
    String(doFetch.mock.calls[2][0]),
    "https://api.github.com/user/emails",
  );
  const emailHeaders = new Headers(doFetch.mock.calls[2][1]?.headers);
  assert.equal(emailHeaders.get("authorization"), "Bearer upstream-test-token");
  const sent = JSON.parse(String(doFetch.mock.calls[0][1]?.body));
  assert.equal(
    sent.redirect_uri,
    "https://api.metagraph.sh/oauth/callback/github",
  );
  assert.equal(sent.client_secret, "private-test-value");
  const legacyFetch = github([token(), profile()]);
  assert.deepEqual(
    await exchangeGithubIdentity(request, env, "code", legacyFetch),
    { identity: { ...identity, verifiedEmails: [] } },
  );
  assert.equal(legacyFetch.mock.calls.length, 2);
});

test("verified-email and subject failures cannot become owner identities", async () => {
  await responseError(
    await exchangeGithubIdentity(
      request,
      env,
      "code",
      github([token(), profile(), new Response("no", { status: 403 })]),
      true,
    ),
    "failed to verify github email",
  );
  await responseError(
    await exchangeGithubIdentity(
      request,
      env,
      "code",
      github([
        token(),
        profile(),
        Response.json({ email: "owner@example.com", verified: true }),
      ]),
      true,
    ),
    "invalid github email response",
  );
  for (const invalidProfile of [
    { id: 0, login: "owner" },
    { id: -1, login: "owner" },
    { id: 1.5, login: "owner" },
    { id: Number.MAX_SAFE_INTEGER + 1, login: "owner" },
    { id: "4200", login: "owner" },
    { id: 4200, login: "" },
    null,
  ]) {
    await responseError(
      await exchangeGithubIdentity(
        request,
        env,
        "code",
        github([token(), Response.json(invalidProfile)]),
        true,
      ),
      "github user profile missing id/login",
    );
  }
  const failedJson = new Response("{", {
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    exchangeGithubIdentity(
      request,
      env,
      "code",
      github([token(), profile(), failedJson]),
      true,
    ),
  );
});

test("identity extraction retains legacy exchange failures and default fetch injection", async () => {
  await responseError(
    await exchangeGithubIdentity(
      request,
      env,
      "code",
      github([new Response("no", { status: 500 })]),
    ),
    "github token exchange failed",
  );
  for (const value of [null, {}, { access_token: "" }, { access_token: 1 }])
    await responseError(
      await exchangeGithubIdentity(
        request,
        env,
        "code",
        github([Response.json(value)]),
      ),
      "github token exchange returned no access_token",
    );
  await responseError(
    await exchangeGithubIdentity(
      request,
      env,
      "code",
      github([token(), new Response("no", { status: 500 })]),
    ),
    "failed to fetch github user profile",
  );
  vi.stubGlobal("fetch", github([token(), profile()]));
  assert.deepEqual(await exchangeGithubIdentity(request, env, "code"), {
    identity: { ...identity, verifiedEmails: [] },
  });
});

test("GitHub account storage stays capability guarded and validates returned local IDs", async () => {
  for (const unconfigured of [
    {},
    { DATA_API: { fetch: async () => Response.json({ id: 42 }) } },
    { API_KEY_LOOKUP_INTERNAL_TOKEN: "internal-test-value" },
  ]) {
    const result = await upsertGithubIdentityAccount(unconfigured, identity);
    assert.ok("error" in result);
    assert.equal(result.error.status, 503);
  }
  const dataFetch = vi.fn(async (input: RequestInfo | URL) => {
    assert.ok(input instanceof Request);
    assert.equal(
      input.url,
      "https://internal/api/v1/auth/github/upsert-account",
    );
    assert.equal(input.method, "POST");
    assert.equal(
      input.headers.get(API_KEY_LOOKUP_TOKEN_HEADER),
      "internal-test-value",
    );
    assert.deepEqual(await input.json(), {
      github_user_id: 4200,
      github_login: "owner",
    });
    return Response.json({ id: "42" });
  });
  const accountEnv = {
    DATA_API: { fetch: dataFetch },
    API_KEY_LOOKUP_INTERNAL_TOKEN: "internal-test-value",
  };
  assert.deepEqual(await upsertGithubIdentityAccount(accountEnv, identity), {
    accountId: 42,
  });
  for (const result of [
    null,
    {},
    { id: false },
    { id: true },
    { id: 0 },
    { id: "invalid" },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await responseError(
      await upsertGithubIdentityAccount(
        {
          ...accountEnv,
          DATA_API: { fetch: async () => Response.json(result) },
        },
        identity,
      ),
      "invalid stored account identity",
    );
  await responseError(
    await upsertGithubIdentityAccount(
      {
        ...accountEnv,
        DATA_API: { fetch: async () => new Response("no", { status: 500 }) },
      },
      identity,
    ),
    "account storage failed",
  );
});

function ownerRequest(token = "provider-owner-grant") {
  return new Request("https://api.metagraph.sh/oauth/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
function ownerHelpers(decoded: unknown) {
  return { unwrapToken: vi.fn(async () => decoded) } as unknown as Pick<
    OAuthHelpers,
    "unwrapToken"
  >;
}
const ownerEnv: GithubOwnerEnv = { OAUTH_KV: {} as KVNamespace };
const decodedOwner = {
  userId: "42",
  scope: ["profile"],
  grant: { props: { accountId: 42 } },
};

test("owner revocation proof unwraps the real local OAuth grant and rejects agent/API tokens", async () => {
  const helpers = ownerHelpers(decodedOwner);
  const getHelpers = vi.fn(async () => helpers);
  assert.deepEqual(
    await resolveGithubOAuthOwner(ownerRequest(), ownerEnv, getHelpers),
    { accountId: "42" },
  );
  assert.equal(
    await resolveGithubOAuthOwner(ownerRequest(), {}, getHelpers),
    null,
  );
  assert.equal(
    await resolveGithubOAuthOwner(new Request(request), ownerEnv, getHelpers),
    null,
  );
  for (const bearer of ["", "mg_key", "mg_agent_" + "A".repeat(43)])
    assert.equal(
      await resolveGithubOAuthOwner(ownerRequest(bearer), ownerEnv, getHelpers),
      null,
    );
  assert.equal(getHelpers.mock.calls.length, 1);
  for (const decoded of [
    null,
    {},
    { ...decodedOwner, scope: [] },
    { ...decodedOwner, userId: "99" },
    { ...decodedOwner, grant: { props: {} } },
    { ...decodedOwner, grant: { props: { accountId: true } } },
    { ...decodedOwner, grant: { props: { accountId: 0 } } },
    { ...decodedOwner, grant: { props: { accountId: 1.5 } } },
    { ...decodedOwner, grant: { props: { accountId: "invalid" } } },
  ]) {
    assert.equal(
      await resolveGithubOAuthOwner(ownerRequest(), ownerEnv, async () =>
        ownerHelpers(decoded),
      ),
      null,
    );
  }
  assert.equal(
    await resolveGithubOAuthOwner(ownerRequest(), ownerEnv, async () => {
      throw new Error("private failure");
    }),
    null,
  );
  assert.deepEqual(
    await resolveGithubOAuthOwner(ownerRequest(), ownerEnv, async () =>
      ownerHelpers({ ...decodedOwner, grant: { props: { accountId: "42" } } }),
    ),
    { accountId: "42" },
  );
});

test("default owner proof resolver uses the same provider options and never trusts request props", async () => {
  getOAuthApiMock.mockReturnValue(ownerHelpers(decodedOwner));
  assert.deepEqual(await resolveGithubOAuthOwner(ownerRequest(), ownerEnv), {
    accountId: "42",
  });
  assert.equal(getOAuthApiMock.mock.calls[0][0].tokenEndpoint, "/oauth/token");
  assert.equal(getOAuthApiMock.mock.calls[0][1], ownerEnv);
  getOAuthApiMock.mockReturnValue(ownerHelpers(null));
  assert.equal(await resolveGithubOAuthOwner(ownerRequest(), ownerEnv), null);
});

test("provider external-token hook accepts only service-auth namespace and callback dispatch stays separate", async () => {
  const options = buildOAuthProviderOptions(UNUSED_DEFAULT_HANDLER);
  const resolve = options.resolveExternalToken!;
  for (const value of [
    "provider-owner-grant",
    "mg_api-key",
    "mg_agent_invalid",
    `mg_agent_${"A".repeat(43)}`,
  ]) {
    assert.equal(
      await resolve({ token: value, request, env: {} as Env }),
      null,
    );
  }
  const callback = await handleGithubOAuthCallback(
    new Request(
      "https://api.metagraph.sh/oauth/callback/github?state=agent_auth_test&code=code",
    ),
    {} as Env,
  );
  assert.equal(callback.status, 503);
  assert.equal(
    ((await callback.json()) as { error: string }).error,
    "temporarily_unavailable",
  );
});
