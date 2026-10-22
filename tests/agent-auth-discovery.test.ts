import { beforeEach, expect, test, vi } from "vitest";
import { augmentAgentAuthDiscovery } from "../src/agent-auth-discovery.ts";
import type { AgentAuthEnv } from "../src/agent-auth.ts";

const { ready } = vi.hoisted(() => ({ ready: vi.fn() }));
vi.mock("../src/agent-auth.ts", () => ({
  AGENT_AUTH_ISSUER: "https://api.metagraph.sh",
  AGENT_AUTH_CLAIM_GRANT: "urn:workos:agent-auth:grant-type:claim",
  AGENT_AUTH_JWT_GRANT: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  isAgentAuthReady: ready,
}));
const env = {} as AgentAuthEnv;
const url = "https://api.metagraph.sh/.well-known/oauth-authorization-server";
const document = {
  issuer: "https://api.metagraph.sh",
  authorization_endpoint: "https://api.metagraph.sh/authorize",
  token_endpoint: "https://api.metagraph.sh/oauth/token",
  revocation_endpoint: "https://api.metagraph.sh/oauth/token",
  grant_types_supported: ["authorization_code", "refresh_token"],
  scopes_supported: ["profile"],
};
beforeEach(() => ready.mockReset().mockResolvedValue(true));

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
