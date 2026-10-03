import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RegistryManifestSchema } from "../../schemas-src/registry-kv.ts";
import {
  registryManifestKey,
  registryObjectKey,
} from "../../src/registry-kv.ts";
import { METAGRAPH_LATEST_KEY } from "../../workers/config.ts";
import type { Row } from "../row-type.ts";

export const SUBNET_MCP_FIXTURE_ID = "sn-107-validator-mcp";
const endpoint = "https://subnet-mcp-fixture.example/mcp";
const schema = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { type: "string" } },
};

/** Offline protocol responses and one registry row for the contract validator.
 * Unknown network calls fail instead of falling back to a real provider. */
export async function withSubnetMcpFixture<T>(
  baseEnv: Row,
  action: (env: Row) => Promise<T>,
) {
  const surfaces = {
    surfaces: [
      {
        id: SUBNET_MCP_FIXTURE_ID,
        kind: "subnet-api",
        url: endpoint,
        auth_required: false,
        public_safe: true,
        mcp: {
          transport: "streamable-http",
          read_tools: ["read"],
          write_tools: ["write"],
          read_prompts: ["plan"],
          read_resources: ["fixture://taxonomy"],
        },
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(surfaces));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = RegistryManifestSchema.parse({
    version: 1,
    artifacts: [
      {
        path: "/metagraph/surfaces.json",
        sha256: digest,
        size_bytes: bytes.byteLength,
      },
    ],
  });
  const manifestDigest = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const fixtureEnv = {
    ...baseEnv,
    // Exercise the current immutable KV registry without a storage service.
    METAGRAPH_ARCHIVE: undefined,
    METAGRAPH_CONTROL: {
      ...baseEnv.METAGRAPH_CONTROL,
      get: async (key: string, options: unknown) => {
        if (key === METAGRAPH_LATEST_KEY)
          return { registry_manifest_sha256: manifestDigest };
        if (key === registryManifestKey(manifestDigest)) return manifest;
        if (key === registryObjectKey(digest)) return bytes.slice().buffer;
        return baseEnv.METAGRAPH_CONTROL.get(key, options);
      },
    },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://cloudflare-dns.com")
      return Response.json({ Answer: [{ type: 1, data: "18.160.0.1" }] });
    assert.equal(url.href, endpoint, "Unmocked provider URL");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, prompts: {}, resources: {} },
            serverInfo: { name: "validator-fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: ["read", "write"].map((name) => ({
                name,
                inputSchema: schema,
                outputSchema: schema,
              })),
            }
          : message.method === "tools/call"
            ? {
                content: [
                  { type: "text", text: "exact validator fixture response" },
                ],
                structuredContent: { value: message.params.arguments.value },
              }
            : message.method === "prompts/list"
              ? {
                  prompts: [
                    {
                      name: "plan",
                      arguments: [{ name: "login", required: true }],
                    },
                  ],
                }
              : message.method === "prompts/get"
                ? {
                    messages: [
                      {
                        role: "user",
                        content: {
                          type: "text",
                          text: "validator prompt fixture",
                        },
                      },
                    ],
                  }
                : message.method === "resources/list"
                  ? {
                      resources: [
                        { name: "taxonomy", uri: "fixture://taxonomy" },
                      ],
                    }
                  : message.method === "resources/read"
                    ? {
                        contents: [
                          {
                            uri: "fixture://taxonomy",
                            mimeType: "application/json",
                            text: '{"fixture":true}',
                          },
                        ],
                      }
                    : null;
    assert.ok(result, "Unmocked protocol method");
    return Response.json(
      { jsonrpc: "2.0", id: message.id, result },
      { headers: { "mcp-session-id": "validator-fixture-session" } },
    );
  };
  try {
    return await action(fixtureEnv);
  } finally {
    globalThis.fetch = previousFetch;
  }
}
