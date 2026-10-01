// Exercise the compiled deploy entry in workerd, where native Node imports,
// cloudflare:workers, WASM and deferred ESM chunks must all resolve together.
// Source-only handler tests cannot catch a broken deployed module graph.
import { Miniflare } from "miniflare";
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
    bindings: {
      METAGRAPH_NEURONS_SOURCE: "data-api",
      METAGRAPH_AUDIT_RESPONSES: "enforce",
    },
  });
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
      priced_registered_stake_tao: 0,
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
      },
    },
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-headers")).toContain(
    "authorization",
  );
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
