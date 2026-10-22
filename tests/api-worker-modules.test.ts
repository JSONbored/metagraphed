// Exercise the compiled deploy entry in workerd, where native Node imports,
// cloudflare:workers, WASM and deferred ESM chunks must all resolve together.
// Source-only handler tests cannot catch a broken deployed module graph.
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApiWorker } from "../scripts/build-api-worker.ts";
import { repoRoot } from "../scripts/lib.ts";
import {
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "../src/kv-keys.ts";

let outdir: string;
let runtime: Miniflare;
let agentRuntime: Miniflare;
let eagerBytes: number;
let totalBytes: number;
let eagerInputs: Set<string>;
const outbound: string[] = [];

beforeAll(async () => {
  outdir = await mkdtemp(path.join(tmpdir(), "api-worker-modules-"));
  const { metafile } = await buildApiWorker(outdir);
  const visited = new Set<string>();
  const visit = (name: string): number => {
    if (visited.has(name)) return 0;
    visited.add(name);
    const output = metafile.outputs[name];
    return (
      output.bytes +
      output.imports
        .filter((item) => !item.external && item.kind === "import-statement")
        .reduce((bytes, item) => bytes + visit(item.path), 0)
    );
  };
  eagerBytes = visit(
    path.relative(repoRoot, path.join(outdir, "api.entry.js")),
  );
  eagerInputs = new Set(
    [...visited].flatMap((name) => Object.keys(metafile.outputs[name].inputs)),
  );
  totalBytes = Object.entries(metafile.outputs)
    .filter(([name]) => name.endsWith(".js"))
    .reduce((bytes, [, output]) => bytes + output.bytes, 0);

  const names = (await readdir(outdir, { recursive: true }))
    .filter((name) => name.endsWith(".js") || name.endsWith(".wasm"))
    .sort((a, b) =>
      a === "api.entry.js" ? -1 : b === "api.entry.js" ? 1 : a.localeCompare(b),
    );
  const modules = names.map((name) => ({
    type: name.endsWith(".wasm")
      ? ("CompiledWasm" as const)
      : ("ESModule" as const),
    path: path.join(outdir, name),
  }));
  runtime = new Miniflare({
    modules,
    modulesRoot: outdir,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    kvNamespaces: ["METAGRAPH_CONTROL", "OAUTH_KV"],
    d1Databases: ["D1_STATE"],
    outboundService(request) {
      outbound.push(request.url);
      if (request.url === "https://facilitator.payai.network/supported")
        return new MiniflareResponse(
          JSON.stringify({
            kinds: [
              { x402Version: 2, scheme: "exact", network: "eip155:8453" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      return new MiniflareResponse("No external calls in this fixture", {
        status: 503,
      });
    },
    bindings: {
      METAGRAPH_NEURONS_SOURCE: "data-api",
      METAGRAPH_AUDIT_RESPONSES: "enforce",
      X402_PAY_TO: "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f",
      X402_PAY_TO_SOLANA: "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87",
      X402_NETWORK: "eip155:8453",
      X402_NETWORK_SOLANA: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      X402_SOLANA_ENABLED: "false",
      X402_FACILITATOR_URL: "https://facilitator.payai.network",
      D1_STATE_TABLES: "x402_payment_attempts",
    },
  });
  const db = await runtime.getD1Database("D1_STATE");
  const migration = readFileSync(
    new URL("../migrations/d1/0039_x402_payment_attempts.sql", import.meta.url),
    "utf8",
  ).replace(/^--.*$/gm, "");
  await db.prepare(migration).run();
  expect(
    await db
      .withSession("first-primary")
      .prepare("SELECT identity_key FROM x402_payment_attempts LIMIT 1")
      .first(),
  ).toBeNull();
  const kv = await runtime.getKVNamespace("METAGRAPH_CONTROL");
  const stamp = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    block_number: 8_950_000,
  };
  await kv.put(
    KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
    JSON.stringify({
      ...stamp,
      account_count: 0,
      limit: 20,
      priced_registered_stake_tao: null,
      rankings: { stake: [], emission: [], reach: [] },
    }),
  );
  await kv.put(
    KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
    JSON.stringify({
      ...stamp,
      validator_count: 0,
      operator_count: 0,
      operators: [],
    }),
  );
  const key = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  agentRuntime = new Miniflare({
    modules,
    modulesRoot: outdir,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    kvNamespaces: ["METAGRAPH_CONTROL", "OAUTH_KV"],
    d1Databases: ["D1_STATE"],
    ratelimits: {
      AGENT_AUTH_RATE_LIMITER: {
        namespace_id: "1028",
        simple: { limit: 20, period: 60 },
      },
    },
    serviceBindings: {
      DATA_API: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/auth/github/upsert-account")
          return MiniflareResponse.json({ id: 42 });
        if (path === "/api/v1/internal/accounts/github/tier")
          return MiniflareResponse.json({ found: true, tier: "free" });
        return new MiniflareResponse("Unexpected service call", {
          status: 503,
        });
      },
    },
    outboundService(request) {
      const responses: Record<string, unknown> = {
        "https://github.com/login/oauth/access_token": {
          access_token: "synthetic-github-token",
        },
        "https://api.github.com/user": { id: 4200, login: "owner" },
        "https://api.github.com/user/emails": [
          { email: "owner@example.com", verified: true },
        ],
      };
      return Object.hasOwn(responses, request.url)
        ? MiniflareResponse.json(responses[request.url])
        : new MiniflareResponse("Unexpected external call", { status: 503 });
    },
    bindings: {
      AUTHMD_SIGNING_JWK: JSON.stringify(
        await crypto.subtle.exportKey("jwk", key.privateKey),
      ),
      D1_STATE_TABLES:
        "agent_auth_registrations,agent_auth_ceremonies,agent_auth_tokens",
      GITHUB_OAUTH_CLIENT_ID: "synthetic-client",
      GITHUB_OAUTH_CLIENT_SECRET: "synthetic-secret",
      API_KEY_LOOKUP_INTERNAL_TOKEN: "synthetic-internal-token",
    },
  });
  const agentDb = await agentRuntime.getD1Database("D1_STATE");
  for (const file of ["0005_user_state.sql", "0040_agent_auth.sql"]) {
    const sql = readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint"))
      if (statement.trim()) await agentDb.prepare(statement).run();
  }
  await agentDb
    .prepare(
      "INSERT INTO github_accounts(id,github_user_id,github_login,created_at) VALUES(42,4200,'owner',1)",
    )
    .run();
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
  await agentRuntime?.dispose();
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

test("directory startup excludes the full router and at least three quarters of the JavaScript", () => {
  expect(eagerBytes).toBeLessThan(totalBytes / 4);
  expect(eagerInputs.has("workers/api.ts")).toBe(false);
  expect(eagerInputs.has("src/contracts.ts")).toBe(false);
});

test("the composed entry serves both validated directory projections", async () => {
  for (const [route, count] of [
    ["accounts/directory", "account_count"],
    ["validators/operators", "operator_count"],
  ]) {
    const response = await runtime.dispatchFetch(
      `https://api.metagraph.sh/api/v1/${route}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { [count]: 0 },
    });
  }
});

test("query validation still rejects invalid requests", async () => {
  const response = await runtime.dispatchFetch(
    "https://api.metagraph.sh/api/v1/accounts/directory?network=invalid",
  );
  expect(response.status).toBe(400);
});

test("the GraphQL chunk loads and executes in workerd", async () => {
  const response = await runtime.dispatchFetch(
    "https://api.metagraph.sh/api/v1/graphql",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { __typename: "Query" } });
});

test("the public MCP entry challenges anonymous initialization", async () => {
  const response = await runtime.dispatchFetch("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "module-runtime-test", version: "1" },
      },
    }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://api.metagraph.sh/.well-known/oauth-protected-resource/mcp"',
  );
  expect(await response.json()).toMatchObject({ error: "invalid_token" });
});

test("the OAuth provider still owns bearer-token authentication", async () => {
  const response = await runtime.dispatchFetch("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: { authorization: "Bearer invalid" },
  });
  expect(response.status).toBe(401);
});

test("the compiled paid export admits browser preflights and exposes its quote", async () => {
  const url = "https://api.metagraph.sh/api/v1/export/chain-events?limit=1";
  const preflight = await runtime.dispatchFetch(url, {
    method: "OPTIONS",
    headers: {
      origin: "https://browser.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "payment-signature, signature",
      "payment-signature": "!!!",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain(
    "payment-signature",
  );
  expect(preflight.headers.get("access-control-allow-methods")).toBe(
    "GET, HEAD, OPTIONS",
  );
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  const beforeInvalid = outbound.length;
  const invalid = await runtime.dispatchFetch(`${url}&__invalid=1`, {
    headers: { "payment-signature": "!!!" },
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    error: { code: "invalid_query" },
  });
  expect(outbound).toHaveLength(beforeInvalid);
  const unpaid = await runtime.dispatchFetch(url);
  expect(
    unpaid.status,
    JSON.stringify({ body: await unpaid.clone().text(), outbound }),
  ).toBe(402);
  expect(unpaid.headers.get("payment-required")).toBeTruthy();
  expect(unpaid.headers.get("access-control-expose-headers")).toContain(
    "payment-required",
  );
  expect(await unpaid.json()).toMatchObject({
    x402Version: 2,
    accepts: expect.arrayContaining([
      expect.objectContaining({
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: { name: "USD Coin", version: "2" },
      }),
    ]),
  });
});

test("public OAuth discovery, registration, server card and preflight remain available", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp/core",
    "/.well-known/oauth-authorization-server",
    "/.well-known/mcp/server-card.json",
  ]) {
    const response = await runtime.dispatchFetch(
      `https://api.metagraph.sh${path}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const resourcePath = path.slice(
        "/.well-known/oauth-protected-resource".length,
      );
      expect(body).toMatchObject({
        resource: `https://api.metagraph.sh${resourcePath}`,
        authorization_servers: ["https://api.metagraph.sh"],
        scopes_supported: ["profile"],
        bearer_methods_supported: ["header"],
      });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      expect(body).toMatchObject({
        issuer: "https://api.metagraph.sh",
        registration_endpoint: "https://api.metagraph.sh/oauth/register",
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["profile"],
        code_challenge_methods_supported: ["S256"],
      });
      expect(body).not.toHaveProperty("agent_auth");
    }
    if (path.endsWith("server-card.json")) {
      expect(body).toMatchObject({
        authentication: "required",
        authentication_detail: { anonymous: { supported: false } },
      });
    }
  }
  const metadata = await runtime.dispatchFetch(
    "https://api.metagraph.sh/.well-known/oauth-authorization-server",
  );
  const { registration_endpoint } = (await metadata.json()) as {
    registration_endpoint: string;
  };
  const registration = await runtime.dispatchFetch(registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Required auth fixture",
      redirect_uris: ["https://client.example/callback"],
    }),
  });
  expect(registration.status).toBe(201);
  expect(
    ((await registration.json()) as { client_id: string }).client_id,
  ).toBeTypeOf("string");
  const preflight = await runtime.dispatchFetch(
    "https://api.metagraph.sh/mcp",
    {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization, signature, signature-input, signature-agent",
      },
    },
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain(
    "authorization",
  );
  for (const header of ["signature", "signature-input", "signature-agent"]) {
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      header,
    );
  }
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
});

test("an expired OAuth token is refused by the compiled provider", async () => {
  // Use the pinned provider's token-key format. Expiry is checked before
  // encrypted grant properties are read; this is not a valid-token fixture.
  const token = "expiry-fixture:grant-fixture:synthetic-secret";
  const hash = createHash("sha256").update(token).digest("hex");
  const kv = await runtime.getKVNamespace("OAUTH_KV");
  await kv.put(
    `token:expiry-fixture:grant-fixture:${hash}`,
    JSON.stringify({ expiresAt: 1 }),
  );
  const response = await runtime.dispatchFetch("https://api.metagraph.sh/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "not JSON",
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    'error="invalid_token"',
  );
  expect(await response.text()).toContain("Access token expired");
});

test("unprovisioned registration declines while normal OAuth token dispatch survives", async () => {
  const unavailable = await runtime.dispatchFetch(
    "https://api.metagraph.sh/agent/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "service_auth",
        login_hint: "owner@example.com",
      }),
    },
  );
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    error: "temporarily_unavailable",
  });
  const ordinary = await runtime.dispatchFetch(
    "https://api.metagraph.sh/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=invalid&client_id=invalid",
    },
  );
  expect(ordinary.status).toBe(400);
  expect(await ordinary.json()).toHaveProperty("error");
});

test("compiled Auth.md discovery exposes a public key and registration cannot issue a preapproval credential", async () => {
  const metadata = await agentRuntime.dispatchFetch(
    "https://api.metagraph.sh/.well-known/oauth-authorization-server",
  );
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    issuer: "https://api.metagraph.sh",
    jwks_uri: "https://api.metagraph.sh/oauth/jwks",
    agent_auth: {
      identity_endpoint: "https://api.metagraph.sh/agent/register",
      identity_types_supported: ["service_auth"],
    },
  });
  const jwks = await agentRuntime.dispatchFetch(
    "https://api.metagraph.sh/oauth/jwks",
  );
  expect(jwks.status).toBe(200);
  const keySet = (await jwks.json()) as { keys: JsonWebKey[] };
  expect(keySet.keys).toHaveLength(1);
  expect(keySet.keys[0]).toMatchObject({
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
  });
  expect(keySet.keys[0]).not.toHaveProperty("d");
  const registered = await agentRuntime.dispatchFetch(
    "https://api.metagraph.sh/agent/register",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
      },
      body: JSON.stringify({
        type: "service_auth",
        login_hint: "owner@example.com",
      }),
    },
  );
  expect(registered.status).toBe(201);
  const registration = (await registered.json()) as { claim_token: string };
  expect(registration).not.toHaveProperty("access_token");
  expect(registration).not.toHaveProperty("identity_assertion");
  const pending = await agentRuntime.dispatchFetch(
    "https://api.metagraph.sh/oauth/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "192.0.2.1",
      },
      body: new URLSearchParams({
        grant_type: "urn:workos:agent-auth:grant-type:claim",
        claim_token: registration.claim_token,
      }).toString(),
    },
  );
  expect(pending.status).toBe(400);
  expect(await pending.json()).toMatchObject({
    error: "authorization_pending",
  });
});

test("compiled owner approval issues provider-recognized credentials and revocation is immediate", async () => {
  const origin = "https://api.metagraph.sh";
  const formHeaders = {
    "content-type": "application/x-www-form-urlencoded",
    "cf-connecting-ip": "192.0.2.2",
  };
  const register = await agentRuntime.dispatchFetch(
    `${origin}/agent/register`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.2",
      },
      body: JSON.stringify({
        type: "service_auth",
        login_hint: "owner@example.com",
        client_name: "Runtime fixture",
      }),
    },
  );
  expect(register.status).toBe(201);
  const registration = (await register.json()) as {
    registration_id: string;
    claim_token: string;
    claim: { user_code: string; verification_uri: string };
  };
  const browser = await agentRuntime.dispatchFetch(
    registration.claim.verification_uri,
    { headers: { "cf-connecting-ip": "192.0.2.2" } },
  );
  expect(browser.status).toBe(200);
  const cookie = browser.headers.get("set-cookie")!.split(";")[0];
  const [state, , csrf] = cookie.slice(cookie.indexOf("=") + 1).split("~");
  const start = await agentRuntime.dispatchFetch(`${origin}/agent/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { ...formHeaders, origin, cookie },
    body: new URLSearchParams({ state, csrf }).toString(),
  });
  expect(start.status).toBe(302);
  expect(
    new URL(start.headers.get("location")!).searchParams.get("scope"),
  ).toBe("read:user user:email");
  const callback = await agentRuntime.dispatchFetch(
    `${origin}/oauth/callback/github?code=synthetic-code&state=${state}`,
    { headers: { cookie } },
  );
  expect(callback.status, await callback.clone().text()).toBe(200);
  expect(await callback.text()).toContain("Approve profile access");
  const db = await agentRuntime.getD1Database("D1_STATE");
  expect(
    await db
      .prepare("SELECT approved_at FROM agent_auth_registrations WHERE id=?")
      .bind(registration.registration_id)
      .first("approved_at"),
  ).toBeNull();
  const approval = await agentRuntime.dispatchFetch(`${origin}/agent/approve`, {
    method: "POST",
    headers: { ...formHeaders, origin, cookie },
    body: new URLSearchParams({
      state,
      csrf,
      user_code: registration.claim.user_code,
      approve: "yes",
    }).toString(),
  });
  expect(approval.status, await approval.clone().text()).toBe(200);
  const claim = await agentRuntime.dispatchFetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: formHeaders,
    body: new URLSearchParams({
      grant_type: "urn:workos:agent-auth:grant-type:claim",
      claim_token: registration.claim_token,
    }).toString(),
  });
  expect(claim.status, await claim.clone().text()).toBe(200);
  const credentials = (await claim.json()) as {
    access_token: string;
    identity_assertion: string;
  };
  const call = (token: string, mount = "/mcp") =>
    agentRuntime.dispatchFetch(`${origin}${mount}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "authmd-runtime", version: "1" },
        },
      }),
    });
  const authenticated = await call(credentials.access_token);
  expect(authenticated.status, await authenticated.clone().text()).toBe(200);
  const exchange = await agentRuntime.dispatchFetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: formHeaders,
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: credentials.identity_assertion,
      resource: `${origin}/mcp/core`,
    }).toString(),
  });
  expect(exchange.status, await exchange.clone().text()).toBe(200);
  const sibling = (await exchange.json()) as { access_token: string };
  expect((await call(sibling.access_token)).status).toBe(401);
  expect((await call(sibling.access_token, "/mcp/core")).status).toBe(200);
  for (const [token, hint] of [
    [credentials.access_token, "access_token"],
    [credentials.identity_assertion, "identity_assertion"],
  ]) {
    const revoked = await agentRuntime.dispatchFetch(
      `${origin}${hint === "access_token" ? "/oauth/token" : "/oauth/revoke"}`,
      {
        method: "POST",
        headers: formHeaders,
        body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
      },
    );
    expect(revoked.status).toBe(200);
    expect((await call(credentials.access_token)).status).toBe(401);
    expect((await call(sibling.access_token, "/mcp/core")).status).toBe(
      hint === "access_token" ? 200 : 401,
    );
  }
});
