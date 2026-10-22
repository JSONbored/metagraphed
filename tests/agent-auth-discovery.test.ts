import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { augmentAgentAuthDiscovery } from "../src/agent-auth-discovery.ts";
import type { AgentAuthEnv } from "../src/agent-auth.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

const { ready } = vi.hoisted(() => ({ ready: vi.fn() }));
vi.mock("../src/agent-auth.ts", () => ({
  AGENT_AUTH_ISSUER: "https://api.metagraph.sh",
  AGENT_AUTH_CLAIM_GRANT: "urn:workos:agent-auth:grant-type:claim",
  AGENT_AUTH_JWT_GRANT: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  isAgentAuthReady: ready,
}));
const env = {
  D1_STATE: {} as D1Database,
  D1_STATE_TABLES:
    "agent_auth_registrations,agent_auth_ceremonies,agent_auth_tokens",
  AUTHMD_SIGNING_JWK: "test-signing-key",
  AGENT_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  GITHUB_OAUTH_CLIENT_ID: "test-github-client",
  GITHUB_OAUTH_CLIENT_SECRET: "test-github-secret",
  DATA_API: {} as NonNullable<AgentAuthEnv["DATA_API"]>,
  API_KEY_LOOKUP_INTERNAL_TOKEN: "test-internal-token",
} satisfies AgentAuthEnv;
const url = "https://api.metagraph.sh/.well-known/oauth-authorization-server";
const document = {
  issuer: "https://api.metagraph.sh",
  authorization_endpoint: "https://api.metagraph.sh/authorize",
  token_endpoint: "https://api.metagraph.sh/oauth/token",
  revocation_endpoint: "https://api.metagraph.sh/oauth/token",
  grant_types_supported: ["authorization_code", "refresh_token"],
  scopes_supported: ["profile"],
};
beforeEach(() => {
  resetModuleState();
  ready.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

async function advertised(configuration: AgentAuthEnv = env): Promise<boolean> {
  const result = await augmentAgentAuthDiscovery(
    new Request(url),
    Response.json(document),
    configuration,
  );
  const body = (await result.json()) as Record<string, unknown>;
  return Object.hasOwn(body, "agent_auth");
}

test("discovery retains existing OAuth and advertises the implemented approval flow", async () => {
  const input = Response.json(document, {
    headers: {
      etag: '"old"',
      "content-length": "1",
      "access-control-allow-origin": "*",
    },
  });
  const result = await augmentAgentAuthDiscovery(new Request(url), input, env);
  expect(await result.json()).toEqual({
    ...document,
    jwks_uri: "https://api.metagraph.sh/oauth/jwks",
    grant_types_supported: [
      ...document.grant_types_supported,
      "urn:workos:agent-auth:grant-type:claim",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    agent_auth: {
      skill: "https://api.metagraph.sh/auth.md",
      identity_endpoint: "https://api.metagraph.sh/agent/register",
      claim_endpoint: "https://api.metagraph.sh/agent/claim",
      register_uri: "https://api.metagraph.sh/agent/register",
      identity_types_supported: ["service_auth"],
      service_auth: { claim_required: true, post_claim_scopes: ["profile"] },
    },
  });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("content-type")).toBe(
    "application/json; charset=utf-8",
  );
  expect(result.headers.get("content-length")).toBeNull();
  expect(result.headers.get("etag")).toBeNull();
  expect(result.headers.get("access-control-allow-origin")).toBe("*");
  expect(await input.json()).toEqual(document);
  expect(ready).toHaveBeenCalledWith(env);
});

test("missing provisioning or a missing migration leaves discovery unchanged", async () => {
  ready.mockResolvedValue(false);
  const input = Response.json(document);
  expect(await augmentAgentAuthDiscovery(new Request(url), input, env)).toBe(
    input,
  );
  expect(await input.json()).toEqual(document);
});

test("non-GET requests and failed provider responses are not augmented", async () => {
  for (const method of ["HEAD", "POST"]) {
    const input = new Response(null, { status: 200 });
    expect(
      await augmentAgentAuthDiscovery(new Request(url, { method }), input, env),
    ).toBe(input);
  }
  const failed = new Response("unavailable", { status: 503 });
  expect(await augmentAgentAuthDiscovery(new Request(url), failed, env)).toBe(
    failed,
  );
  expect(ready).not.toHaveBeenCalled();
});

test("malformed or foreign provider metadata cannot acquire our authority", async () => {
  for (const body of [
    "broken",
    "null",
    "false",
    '"text"',
    "[]",
    "{}",
    '{"issuer":"https://foreign.example"}',
  ]) {
    const input = new Response(body);
    expect(await augmentAgentAuthDiscovery(new Request(url), input, env)).toBe(
      input,
    );
    expect(await input.text()).toBe(body);
  }
});

test("grant registration tolerates absent grants and deduplicates supported grants", async () => {
  for (const grants of [
    undefined,
    "wrong",
    [null, 1, "authorization_code", "urn:workos:agent-auth:grant-type:claim"],
  ]) {
    const result = await augmentAgentAuthDiscovery(
      new Request(url),
      Response.json({ ...document, grant_types_supported: grants }),
      env,
    );
    const body = (await result.json()) as { grant_types_supported: string[] };
    expect(body.grant_types_supported).toEqual([
      ...(Array.isArray(grants) ? ["authorization_code"] : []),
      "urn:workos:agent-auth:grant-type:claim",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);
  }
});

test("repeated metadata requests reuse readiness across equivalent environment wrappers", async () => {
  expect(await advertised()).toBe(true);
  for (let i = 0; i < 4; i++) {
    expect(await advertised({ ...env })).toBe(true);
  }
  expect(ready).toHaveBeenCalledTimes(1);
});

test("concurrent metadata requests share one readiness probe", async () => {
  let finish!: (value: boolean) => void;
  ready.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (finish = resolve)),
  );
  const requests = Array.from({ length: 8 }, () => advertised());
  expect(ready).toHaveBeenCalledTimes(1);
  finish(true);
  expect(await Promise.all(requests)).toEqual(Array(8).fill(true));
  expect(await advertised()).toBe(true);
  expect(ready).toHaveBeenCalledTimes(1);
});

test.each([
  "D1_STATE",
  "D1_STATE_TABLES",
  "AUTHMD_SIGNING_JWK",
  "AGENT_AUTH_RATE_LIMITER",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "DATA_API",
  "API_KEY_LOOKUP_INTERNAL_TOKEN",
] as const)(
  "changing %s immediately invalidates cached readiness",
  async (key) => {
    ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await advertised()).toBe(true);
    expect(await advertised({ ...env, [key]: undefined })).toBe(false);
    expect(ready).toHaveBeenCalledTimes(2);
    // Only the current configuration is retained, even when an older one returns.
    expect(await advertised()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(3);
  },
);

test("successful readiness expires and a newly unavailable service is hidden", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await advertised()).toBe(true);
  vi.setSystemTime(29_999);
  expect(await advertised()).toBe(true);
  expect(ready).toHaveBeenCalledTimes(1);
  vi.setSystemTime(30_000);
  expect(await advertised()).toBe(false);
  expect(ready).toHaveBeenCalledTimes(2);
});

test.each(["negative", "rejected"] as const)(
  "%s readiness is cached briefly and retried after five seconds",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    if (outcome === "negative") ready.mockResolvedValueOnce(false);
    else ready.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await advertised()).toBe(false);
    vi.setSystemTime(4_999);
    expect(await advertised()).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5_000);
    expect(await advertised()).toBe(true);
    expect(ready).toHaveBeenCalledTimes(2);
  },
);

test.each([true, false])(
  "an older in-flight %s probe cannot replace a newer configuration's result",
  async (oldReady) => {
    let finish!: (value: boolean) => void;
    ready
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finish = resolve)),
      )
      .mockResolvedValueOnce(!oldReady);
    const oldRequest = advertised();
    const changed = { ...env, AUTHMD_SIGNING_JWK: "rotated-test-key" };
    expect(await advertised(changed)).toBe(!oldReady);
    finish(oldReady);
    expect(await oldRequest).toBe(oldReady);
    expect(await advertised(changed)).toBe(!oldReady);
    expect(ready).toHaveBeenCalledTimes(2);
  },
);

test("an unresolved readiness probe cannot keep the discovery cache forever", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  let finish!: (value: boolean) => void;
  ready.mockImplementationOnce(
    () => new Promise<boolean>((resolve) => (finish = resolve)),
  );
  const oldRequest = advertised();
  vi.setSystemTime(30_000);
  expect(await advertised()).toBe(true);
  finish(false);
  expect(await oldRequest).toBe(false);
  expect(await advertised()).toBe(true);
  expect(ready).toHaveBeenCalledTimes(2);
});
