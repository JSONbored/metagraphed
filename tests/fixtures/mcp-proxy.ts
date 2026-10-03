import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RegistryManifestSchema } from "../../schemas-src/registry-kv.ts";
import { SubnetsArtifactSchema } from "../../schemas-src/routes/subnets.ts";
import { COVERAGE_LEVEL_VALUES, CURATION_LEVEL_VALUES } from "../../schemas-src/shared.ts";
import { authLookupCacheWrite } from "../../src/auth-lookup-cache.ts";
import { registryManifestKey, registryObjectKey } from "../../src/registry-kv.ts";
import { METAGRAPH_LATEST_KEY } from "../../workers/config.ts";
import type { Row } from "../row-type.ts";

const endpoints = {
  finney: "https://bittensor-finney.api.onfinality.io/public",
  test: "https://test.chain.opentensor.ai/",
} as const;
const stamp = "2026-10-01T00:00:00.000Z";
const entry = (netuid: number, network: "finney" | "test") => ({
  netuid, name: `${network} fixture ${netuid}`, slug: `${network}-fixture-${netuid}`,
  coverage_level: COVERAGE_LEVEL_VALUES[0], curation_level: CURATION_LEVEL_VALUES[0],
  status: "active", subnet_type: "application", surface_count: 0,
  categories: netuid === 7 ? ["inference"] : ["data"], description: null,
});

/** Immutable current registry and transport doubles only. The real trusted
 * origin names exercise proxy admission; every fetch is intercepted here. */
export async function withMcpProxyFixture<T>(
  baseEnv: Row,
  action: (env: Row, state: {
    requests: { url: string; body: string; headers: Headers; network: "finney" | "test" }[];
    responseBody: string | null;
    responseStatus: number;
  }) => Promise<T>,
) {
  const artifacts: Record<string, unknown> = {
    "/metagraph/rpc/pools.json": {
      pools: Object.entries(endpoints).map(([network, url]) => ({
        id: `${network}-rpc`,
        endpoints: [{ id: `fixture-${network}`, provider: `fixture-${network}`, pool_eligible: true, status: "ok", score: 100, url }],
      })),
    },
  };
  for (const network of ["finney", "test"] as const) {
    const prefix = network === "test" ? "/metagraph/testnet" : "/metagraph";
    artifacts[`${prefix}/subnets.json`] = SubnetsArtifactSchema.parse({
      schema_version: 1, generated_at: stamp, network, source: { kind: "offline-fixture" },
      captured_at: stamp, native_snapshot_captured_at: stamp,
      subnets: [entry(7, network), entry(8, network)],
    });
    artifacts[`${prefix}/subnets/7.json`] = { ...entry(7, network), surfaces: [], endpoints: [] };
  }
  const objects = new Map<string, Uint8Array>();
  const rows = Object.entries(artifacts).map(([path, value]) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    objects.set(registryObjectKey(sha256), bytes);
    return { path, sha256, size_bytes: bytes.byteLength };
  });
  const manifest = RegistryManifestSchema.parse({ version: 1, artifacts: rows });
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const env = {
    ...baseEnv,
    METAGRAPH_ARCHIVE: undefined,
    METAGRAPH_VALIDATE_RESPONSES: "true",
    METAGRAPH_ENABLE_RPC_PROXY: "true",
    METAGRAPH_CONTROL: {
      async get(key: string, options: unknown) {
        if (key === METAGRAPH_LATEST_KEY) return { registry_manifest_sha256: digest };
        if (key === registryManifestKey(digest)) return manifest;
        const bytes = objects.get(key);
        if (bytes) return bytes.slice().buffer;
        if (key === "oauth-account-tier:v2:7") return JSON.parse(authLookupCacheWrite(
          { found: true, tier: "free" }, { positiveTtlSeconds: 300, negativeTtlSeconds: 30 },
        ).value);
        return baseEnv.METAGRAPH_CONTROL?.get?.(key, options) ?? null;
      },
    },
  };
  const state: Parameters<typeof action>[1] = { requests: [], responseBody: null, responseStatus: 200 };
  const previousFetch = globalThis.fetch;
  let unmatched = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const network = request.url === endpoints.finney ? "finney" : request.url === endpoints.test ? "test" : null;
    if (!network) {
      unmatched++;
      throw new Error("Unmocked MCP proxy fixture request");
    }
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cf-connecting-ip"), null);
    const body = await request.text();
    const parsed = JSON.parse(body);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, 1);
    assert.ok(Array.isArray(parsed.params));
    state.requests.push({ url: request.url, body, headers: request.headers, network });
    return new Response(state.responseBody ?? JSON.stringify({
      jsonrpc: "2.0", id: 1, result: { network, wide: "18446744073709551615", nullable: null },
    }), { status: state.responseStatus, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await action(env, state);
    assert.equal(unmatched, 0, "No swallowed unmocked proxy fixture fetch");
    return result;
  } finally {
    globalThis.fetch = previousFetch;
  }
}
