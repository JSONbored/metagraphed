import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { RegistryManifestSchema } from "../../schemas-src/registry-kv.ts";
import { registryManifestKey, registryObjectKey } from "../../src/registry-kv.ts";
import { SURFACE_CREDENTIAL_KV_PREFIX } from "../../src/mcp-surface-credentials.ts";
import { METAGRAPH_LATEST_KEY } from "../../workers/config.ts";
import type { Row } from "../row-type.ts";

export const SUBNET_HTTP_FIXTURE_ID = "sn-107-validator-http";
export const SUBNET_VERIFY_FIXTURE_ID = "sn-107-validator-verify";
export const SUBNET_HTTP_FIXTURE_CREDENTIAL = "Bearer fixture-http-credential";
const origin = "https://subnet-http-fixture.example";

/** Current immutable registry, encrypted credential store and offline HTTP.
 * Unmatched requests fail; no fetch is delegated to a real endpoint. */
export async function withSubnetHttpFixture<T>(
  baseEnv: Row,
  action: (env: Row, state: {
    requests: { url: string; method: string; headers: Headers; body: string }[];
    encrypted: Map<string, { value: string; metadata: Row }>;
  }) => Promise<T>,
) {
  const surfaces = {
    surfaces: [
      {
        id: SUBNET_HTTP_FIXTURE_ID,
        surface_id: SUBNET_HTTP_FIXTURE_ID,
        surface_key: "fixture:validator:http",
        netuid: 107,
        kind: "subnet-api",
        url: `${origin}/v1/status`,
        public_safe: true,
        auth_required: true,
        auth: {
          scheme: "bearer",
          location: "header",
          name: "Authorization",
          format: "Bearer <token>",
        },
        probe: { enabled: false, method: "GET", expect: "any" },
        http: {
          operations: [
            { method: "GET", path: "/v1/status", parameters: [] },
            {
              method: "POST",
              path: "/v1/echo",
              request_body_required: true,
              request_content_types: ["application/json"],
              parameters: [],
            },
          ],
        },
      },
      {
        id: SUBNET_VERIFY_FIXTURE_ID,
        surface_id: SUBNET_VERIFY_FIXTURE_ID,
        surface_key: "fixture:validator:verify",
        netuid: 107,
        kind: "subnet-api",
        url: `${origin}/v1/public`,
        public_safe: true,
        auth_required: false,
        probe: { enabled: true, method: "GET", expect: "any" },
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(surfaces));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = RegistryManifestSchema.parse({
    version: 1,
    artifacts: ["surfaces", "operational-surfaces"].map((name) => ({
      path: `/metagraph/${name}.json`,
      sha256: digest,
      size_bytes: bytes.byteLength,
    })),
  });
  const manifestDigest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const encrypted = new Map<string, { value: string; metadata: Row }>();
  const requests: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[] = [];
  const fixtureEnv = {
    ...baseEnv,
    METAGRAPH_ARCHIVE: undefined,
    MCP_SURFACE_CREDENTIAL_SECRET: randomBytes(32).toString("hex"),
    METAGRAPH_CONTROL: {
      async get(key: string, options: unknown) {
        if (key === METAGRAPH_LATEST_KEY)
          return { registry_manifest_sha256: manifestDigest };
        if (key === registryManifestKey(manifestDigest)) return manifest;
        if (key === registryObjectKey(digest)) return bytes.slice().buffer;
        if (key.startsWith(SURFACE_CREDENTIAL_KV_PREFIX)) {
          const entry = encrypted.get(key);
          return entry ? JSON.parse(entry.value) : null;
        }
        return baseEnv.METAGRAPH_CONTROL.get(key, options);
      },
      async put(key: string, value: string, options: { metadata: Row }) {
        assert.ok(key.startsWith(SURFACE_CREDENTIAL_KV_PREFIX));
        assert.ok(!value.includes(SUBNET_HTTP_FIXTURE_CREDENTIAL));
        encrypted.set(key, { value, metadata: options.metadata });
      },
      async delete(key: string) {
        assert.ok(key.startsWith(SURFACE_CREDENTIAL_KV_PREFIX));
        encrypted.delete(key);
      },
      async list(options: { prefix: string }) {
        assert.ok(options.prefix.startsWith(SURFACE_CREDENTIAL_KV_PREFIX));
        return {
          keys: [...encrypted.entries()]
            .filter(([name]) => name.startsWith(options.prefix))
            .map(([name, entry]) => ({ name, metadata: entry.metadata })),
          list_complete: true,
        };
      },
    },
  };
  const previousFetch = globalThis.fetch;
  let unmatchedRequests = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    if (
      url.origin !== origin ||
      url.search !== "" ||
      !(
        (request.method === "GET" &&
          ["/v1/status", "/v1/public"].includes(url.pathname)) ||
        (request.method === "POST" && url.pathname === "/v1/echo")
      )
    ) {
      unmatchedRequests++;
      throw new Error("Unmocked HTTP fixture request");
    }
    if (url.pathname === "/v1/public")
      assert.equal(request.headers.get("authorization"), null);
    else
      assert.equal(
        request.headers.get("authorization"),
        SUBNET_HTTP_FIXTURE_CREDENTIAL,
      );
    const body = await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });
    return Response.json({
      value: "18446744073709551615",
      items: [{ id: "fixture-http", optional: null }],
      ...(body ? { received: JSON.parse(body) } : {}),
    });
  };
  try {
    const result = await action(fixtureEnv, { requests, encrypted });
    assert.equal(unmatchedRequests, 0, "No swallowed unmocked HTTP request");
    return result;
  } finally {
    globalThis.fetch = previousFetch;
  }
}
