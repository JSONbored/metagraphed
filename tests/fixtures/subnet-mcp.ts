import assert from "node:assert/strict";
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
        },
      },
    ],
  };
  const fixtureEnv = {
    ...baseEnv,
    ASSETS: {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname !== "/metagraph/surfaces.json")
          return baseEnv.ASSETS.fetch(request);
        return Response.json(surfaces);
      },
    },
    // Match the existing local artifact environment's in-memory reader shape.
    METAGRAPH_ARCHIVE: {
      get: async (key: unknown) => {
        if (String(key).replace(/^latest\//, "") !== "metagraph/surfaces.json")
          return baseEnv.METAGRAPH_ARCHIVE.get(key);
        return {
          json: async () => surfaces,
          text: async () => JSON.stringify(surfaces),
        };
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
            capabilities: { tools: {} },
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
