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
  runtime = new Miniflare({
    modules: names.map((name) => ({
      type: name.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
      path: path.join(outdir, name),
    })),
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
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
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
