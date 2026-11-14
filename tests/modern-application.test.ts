import { afterEach, describe, expect, test, vi } from "vitest";
import { isScalarType, parseValue, printSchema } from "graphql";
import { z } from "zod";
import { createModernApplication as createApplication } from "../src/modern-application.ts";
import { createOAuthIssuer } from "../src/v2/oauth.ts";
import { V2OperationError } from "../src/v2/operations.ts";
import { V2InsufficientScopeError } from "../src/v2/runtime.ts";
import { ecosystemFixture } from "../scripts/lib/modern-ecosystem-fixture.ts";

const applications = new Set<ReturnType<typeof createApplication>>();
function createModernApplication(
  ...args: Parameters<typeof createApplication>
) {
  const app = createApplication(...args);
  applications.add(app);
  return app;
}
afterEach(async () => {
  await Promise.all([...applications].map((app) => app.close()));
  applications.clear();
});

const origin = "https://example.test";
const website = "https://metagraph.sh";
const at = "2026-11-05T14:00:00.000Z";
const hash = `0x${"a".repeat(64)}`;
const row = {
  network_id: "finney",
  genesis_hash: hash,
  block_number: "123",
  block_hash: hash,
  parent_hash: `0x${"b".repeat(64)}`,
  metadata_digest: "c".repeat(64),
  producer_revision: "d".repeat(40),
  publication_id: "e".repeat(64),
  observed_at: at,
  published_at: at,
  integrity_verified: true,
  stage: "published",
  spec_version: 486,
  transaction_version: 1,
  finalized_observed_height: "124",
  finalized_observed_hash: hash,
  finalized_observed_at: at,
  complete_from: "120",
  complete_through: "123",
  checkpoint_hash: hash,
  checkpoint_publication_id: "e".repeat(64),
  has_gap: false,
};
const request = (path: string, body: unknown) =>
  new Request(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
const mcpSessions = new WeakMap<
  ReturnType<typeof createModernApplication>,
  Map<string, string>
>();
async function mcpJson(response: Response) {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  )
    return response;
  const messages = (await response.text()).split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    return data ? [JSON.parse(data) as unknown] : [];
  });
  expect(messages).toHaveLength(1);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(messages[0]), {
    status: response.status,
    headers,
  });
}
async function initializeMcp(
  app: ReturnType<typeof createModernApplication>,
  authorization = "",
) {
  let entries = mcpSessions.get(app);
  if (!entries) {
    entries = new Map();
    mcpSessions.set(app, entries);
  }
  const existing = entries.get(authorization);
  if (existing) return existing;
  const initial = request("/mcp", {
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  });
  if (authorization) initial.headers.set("authorization", authorization);
  const response = await app.fetch(initial);
  expect(response.status).toBe(200);
  const id = response.headers.get("mcp-session-id");
  expect(id).toBeTruthy();
  await mcpJson(response);
  entries.set(authorization, id!);
  const ready = request("/mcp", {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  ready.headers.set("mcp-session-id", id!);
  ready.headers.set("mcp-protocol-version", "2025-11-25");
  if (authorization) ready.headers.set("authorization", authorization);
  expect((await app.fetch(ready)).status).toBe(202);
  return id!;
}
async function mcp(
  app: ReturnType<typeof createModernApplication>,
  body: unknown,
  authorization = "",
) {
  const id = await initializeMcp(app, authorization);
  const next = request("/mcp", body);
  next.headers.set("mcp-session-id", id);
  next.headers.set("mcp-protocol-version", "2025-11-25");
  if (authorization) next.headers.set("authorization", authorization);
  return mcpJson(await app.fetch(next));
}

describe("modern shared application", () => {
  test.each([{ value: website }, { value: [42] }])(
    "rejects malformed public-read origin containers before database work",
    ({ value }) => {
      const query = vi.fn(async () => ({ rows: [] }));
      expect(() =>
        createModernApplication(
          { query },
          { origin, publicReadOrigins: value as unknown as readonly string[] },
        ),
      ).toThrow("Public read origins");
      expect(query).not.toHaveBeenCalled();
    },
  );
  test.each([
    "*",
    "null",
    "https://*.metagraph.sh",
    "https://metagraph.sh/",
    "https://metagraph.sh/path",
    "https://metagraph.sh?query=1",
    "https://metagraph.sh#fragment",
    "https://user@metagraph.sh",
    "ftp://metagraph.sh",
  ])(
    "rejects noncanonical public read origin %s before database work",
    (value) => {
      const query = vi.fn(async () => ({ rows: [] }));
      expect(() =>
        createModernApplication(
          { query },
          { origin, publicReadOrigins: [value] },
        ),
      ).toThrow("Public read origins");
      expect(query).not.toHaveBeenCalled();
    },
  );

  test.each([website, "https://testnet.metagraph.sh"])(
    "public reads are opt-in and explicitly allow only %s",
    async (site) => {
      const query = vi.fn(async () => ({ rows: [row] }));
      const incoming = () =>
        new Request(`${origin}/api/v2/networks/finney/head`, {
          headers: { origin: site },
        });
      const closed = createModernApplication({ query }, { origin });
      const refused = await closed.fetch(incoming());
      expect(refused.status).toBe(403);
      expect(refused.headers.has("access-control-allow-origin")).toBe(false);
      expect(query).not.toHaveBeenCalled();
      const app = createModernApplication(
        { query },
        { origin, publicReadOrigins: [site], now: () => new Date(at) },
      );
      const response = await app.fetch(incoming());
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(site);
      expect(response.headers.get("vary")).toBe("Origin");
      expect(response.headers.has("access-control-allow-credentials")).toBe(
        false,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        snapshot: { publication_id: row.publication_id },
      });
      const native = await app.fetch(
        new Request(`${origin}/api/v2/networks/finney/head`),
      );
      expect(native.status).toBe(200);
      expect(native.headers.has("access-control-allow-origin")).toBe(false);
      const sameOrigin = await app.fetch(
        new Request(`${origin}/api/v2/networks/finney/head`, {
          headers: { origin },
        }),
      );
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.has("access-control-allow-origin")).toBe(false);
    },
  );

  test.each([
    "/api/v2/networks/finney/head",
    "/api/v2/networks/finney/blocks/123",
    "/api/v2/networks/finney/blocks",
    "/api/v2/networks/finney/subnets",
    "/api/v2/networks/finney/subnets/0",
    "/api/v2/networks/finney/services/search?task=data",
    "/api/v2/networks/finney/subnets/7/services",
    "/api/v2/networks/finney/subnets/7/services/inference/schema",
    "/api/v2/networks/finney/subnets/7/instructions",
  ])(
    "preflights the exact public GET route without database/account work: %s",
    async (path) => {
      const query = vi.fn(async () => ({ rows: [] }));
      const openContext = vi.fn(async () => {
        throw new Error("Preflight cannot authenticate");
      });
      const app = createModernApplication(
        { query },
        { origin, publicReadOrigins: [website], openContext },
      );
      for (const requestedHeaders of [undefined, "", " aCcEpT "]) {
        const headers = new Headers({
          origin: website,
          "access-control-request-method": "GET",
        });
        if (requestedHeaders !== undefined)
          headers.set("access-control-request-headers", requestedHeaders);
        const response = await app.fetch(
          new Request(origin + path, { method: "OPTIONS", headers }),
        );
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        expect(response.headers.get("access-control-allow-origin")).toBe(
          website,
        );
        expect(response.headers.get("access-control-allow-methods")).toBe(
          "GET",
        );
        expect(response.headers.get("access-control-allow-headers")).toBe(
          requestedHeaders?.trim() ? "Accept" : null,
        );
        expect(response.headers.has("access-control-allow-credentials")).toBe(
          false,
        );
        expect(response.headers.get("vary")?.split(", ").sort()).toEqual([
          "Access-Control-Request-Headers",
          "Access-Control-Request-Method",
          "Origin",
        ]);
      }
      expect(query).not.toHaveBeenCalled();
      expect(openContext).not.toHaveBeenCalled();
    },
  );

  test("public read grants do not broaden origins, credentials, methods or protected routes", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const openContext = vi.fn(async () => {
      throw new Error("Cross-origin denial must precede authentication");
    });
    const resource = `${origin}/mcp`;
    const app = createModernApplication(
      { query },
      {
        origin,
        publicReadOrigins: [website],
        openContext,
        oauth: {
          resource,
          scopes: ["services:invoke"],
          issuer: createOAuthIssuer(
            { query },
            { audiences: [resource], scopes: ["services:invoke"] },
          ),
        },
      },
    );
    const path = "/api/v2/networks/finney/head";
    const denied: Request[] = [
      ...[
        "null",
        "https://attacker.test",
        "https://metagraph.sh.attacker.test",
        "https://www.metagraph.sh",
        "https://testnet.metagraph.sh",
        "http://metagraph.sh",
      ].map(
        (site) => new Request(origin + path, { headers: { origin: site } }),
      ),
      ...[
        "authorization",
        "proxy-authorization",
        "cookie",
        "x-api-key",
        "x-csrf-token",
      ].map(
        (header) =>
          new Request(origin + path, {
            headers: { origin: website, [header]: "controlled" },
          }),
      ),
      ...["POST", "HEAD"].map(
        (method) =>
          new Request(origin + path, { method, headers: { origin: website } }),
      ),
      ...[
        "/mcp",
        "/graphql",
        "/api/v2/graphql",
        "/api/v2/invocations",
        "/api/v2/invocations/prepare",
        "/api/v2/invocations/approve",
        "/api/v2/accounts",
        "/api/v2/networks/finney/subnets/0/services/x/invoke",
        "/api/v2/unknown",
      ].map(
        (target) =>
          new Request(origin + target, {
            method: "POST",
            headers: { origin: website, "content-type": "application/json" },
            body: "{}",
          }),
      ),
      ...[
        "/mcp",
        "/graphql",
        "/api/v2/graphql",
        "/api/v2/invocations",
        "/api/v2/accounts",
        "/api/v2/unknown",
      ].flatMap((target) => [
        new Request(origin + target, { headers: { origin: website } }),
        new Request(origin + target, {
          method: "OPTIONS",
          headers: { origin: website, "access-control-request-method": "GET" },
        }),
      ]),
      ...["POST", "HEAD", "get", ""].map(
        (method) =>
          new Request(origin + path, {
            method: "OPTIONS",
            headers: {
              origin: website,
              "access-control-request-method": method,
            },
          }),
      ),
      ...[
        "authorization",
        "content-type",
        "x-api-key",
        "x-csrf-token",
        "accept, authorization",
        "accept,",
      ].map(
        (headers) =>
          new Request(origin + path, {
            method: "OPTIONS",
            headers: {
              origin: website,
              "access-control-request-method": "GET",
              "access-control-request-headers": headers,
            },
          }),
      ),
      new Request("https://attacker.test" + path, {
        headers: { origin: website, "x-forwarded-host": "example.test" },
      }),
    ];
    for (const incoming of denied) {
      const response = await app.fetch(incoming);
      expect(response.status, incoming.url).toBe(403);
      expect(
        response.headers.has("access-control-allow-origin"),
        incoming.url,
      ).toBe(false);
    }
    for (const target of [
      "/oauth/token",
      "/oauth/register",
      "/oauth/authorize",
    ]) {
      const response = await app.fetch(
        new Request(origin + target, {
          method: "OPTIONS",
          headers: { origin: website, "access-control-request-method": "POST" },
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    const sameOriginHead = await app.fetch(
      new Request(origin + path, { method: "HEAD", headers: { origin } }),
    );
    expect(sameOriginHead.status).toBe(405);
    expect(query).not.toHaveBeenCalled();
    expect(openContext).not.toHaveBeenCalled();
  });

  test("approved browser reads can inspect REST input, missing-data and missing-subnet errors", async () => {
    const incoming = (path: string) =>
      new Request(origin + path, { headers: { origin: website } });
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin, publicReadOrigins: [website] },
    );
    for (const [path, status] of [
      ["/api/v2/networks/finney/head?unexpected=1", 400],
      ["/api/v2/networks/finney/head", 503],
    ] as const) {
      const response = await app.fetch(incoming(path));
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin")).toBe(website);
    }
    const registryQuery = vi.fn(async () => ({
      rows: [
        {
          ...row,
          registry_complete: true,
          registry_expected_netuids: [0],
          actual_netuids: [0],
          actual_operational_netuids: [0],
          actual_mechanisms_complete: true,
          ecosystem: ecosystemFixture({
            snapshot: row,
            publicationId: "f".repeat(64),
            operationalNetuids: [0],
          }).ecosystem,
        },
      ],
    }));
    const registry = createModernApplication(
      { query: registryQuery },
      { origin, publicReadOrigins: [website], now: () => new Date(at) },
    );
    const absent = await registry.fetch(
      incoming("/api/v2/networks/finney/subnets/7"),
    );
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ error: { code: "not_found" } });
    expect(absent.headers.get("access-control-allow-origin")).toBe(website);
    expect(registryQuery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "FROM registry.eligible_ecosystem_publications e",
      ),
      ["finney"],
    );
  });

  test("approved browser reads retain CORS through admission, deadlines and draining", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createModernApplication(
      {
        query: async () => {
          await gate;
          return { rows: [row] };
        },
      },
      {
        origin,
        publicReadOrigins: [website],
        requestTimeoutMillis: 10,
        maxConcurrentRequests: 1,
        now: () => new Date(at),
      },
    );
    const incoming = () =>
      new Request(`${origin}/api/v2/networks/finney/head`, {
        headers: { origin: website },
      });
    try {
      const pending = app.fetch(incoming());
      const busy = await app.fetch(incoming());
      expect(busy.status).toBe(503);
      expect(busy.headers.get("access-control-allow-origin")).toBe(website);
      const timed = await pending;
      expect(timed.status).toBe(504);
      expect(timed.headers.get("access-control-allow-origin")).toBe(website);
      app.close();
      const draining = await app.fetch(incoming());
      expect(draining.status).toBe(503);
      expect(draining.headers.get("access-control-allow-origin")).toBe(website);
    } finally {
      release();
      app.close();
    }
  });

  test.each([
    "not-a-url",
    "ftp://example.test",
    "https://example.test/path",
    "https://user@example.test",
    "https://:password@example.test",
    "https://example.test?override=1",
    "https://example.test#fragment",
  ])("rejects noncanonical origin %s before database work", (origin) => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(() => createModernApplication({ query }, { origin })).toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  test.each([0, 65, 1.5, NaN])("rejects invalid request budget %s", (limit) => {
    expect(() =>
      createModernApplication(
        { query: async () => ({ rows: [] }) },
        { origin, maxConcurrentRequests: limit },
      ),
    ).toThrow("Invalid request budget");
  });

  test.each([0, 30001, 1.5, NaN])(
    "rejects invalid request deadline %s",
    (deadline) => {
      expect(() =>
        createModernApplication(
          { query: async () => ({ rows: [] }) },
          { origin, requestTimeoutMillis: deadline },
        ),
      ).toThrow("Invalid request deadline");
    },
  );

  test("REST, MCP and GraphQL return the same qualified head", async () => {
    const app = createModernApplication(
      { query: async () => ({ rows: [row] }) },
      { origin, now: () => new Date(at) },
    );
    const rest = await app.fetch(
      new Request(`${origin}/api/v2/networks/finney/head`),
    );
    expect(rest.status).toBe(200);
    const expected = await rest.json();
    const mcpResponse = await mcp(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_chain_head", arguments: { network: "finney" } },
    });
    expect(mcpResponse.status).toBe(200);
    expect(
      z
        .object({ result: z.object({ structuredContent: z.unknown() }) })
        .parse(await mcpResponse.json()).result.structuredContent,
    ).toEqual(expected);
    const graph = await app.fetch(
      request("/api/v2/graphql", {
        query:
          '{ get_chain_head(input: {network: "finney"}) { api_version network { id } snapshot { block_number } coverage { from_block through_block contiguous } } }',
      }),
    );
    expect(graph.status).toBe(200);
    expect(await graph.json()).toEqual({
      data: {
        get_chain_head: {
          api_version: "2",
          network: { id: "finney" },
          snapshot: { block_number: "123" },
          coverage: {
            from_block: "120",
            through_block: "123",
            contiguous: true,
          },
        },
      },
    });
  });

  test("real MCP initialization and catalog contain only the new shared operations", async () => {
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin },
    );
    const init = await app.fetch(
      request("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    );
    expect(
      z
        .object({ result: z.object({ serverInfo: z.unknown() }) })
        .parse(await (await mcpJson(init)).json()).result.serverInfo,
    ).toEqual({ name: "metagraphed", version: "2.0.0" });
    const session = init.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    mcpSessions.set(app, new Map([["", session!]]));
    expect(
      (await mcp(app, { jsonrpc: "2.0", method: "notifications/initialized" }))
        .status,
    ).toBe(202);
    const catalog = await mcp(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              annotations: z.object({ readOnlyHint: z.boolean() }),
            }),
          ),
        }),
      })
      .parse(await catalog.json()).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "find_subnet_for_task",
      "get_account_balance",
      "get_api_schema",
      "get_block",
      "get_chain_head",
      "get_subnet",
      "how_do_i_call",
      "list_account_events",
      "list_account_stake",
      "list_blocks",
      "list_subnet_apis",
      "list_subnets",
    ]);
    expect(
      tools.every(
        (tool: { annotations: { readOnlyHint: boolean } }) =>
          tool.annotations.readOnlyHint,
      ),
    ).toBe(true);
  });

  test.each([
    ["prepare_service_invocation", "/mcp"],
    ["approve_service_invocation", "/mcp"],
    ["invoke_service", "/"],
  ])(
    "challenges protected MCP %s for resource %s without a tool error",
    async (name, path) => {
      const query = vi.fn(async () => ({ rows: [] }));
      const openContext = vi.fn(async () => {
        throw new V2OperationError(
          "authorization_required",
          "Authentication is required",
        );
      });
      const resource = `${origin}${path}`;
      const app = createModernApplication(
        { query },
        {
          origin,
          openContext,
          oauth: {
            resource,
            scopes: ["services:invoke"],
            issuer: createOAuthIssuer(
              { query },
              { audiences: [resource], scopes: ["services:invoke"] },
            ),
          },
        },
      );
      const response = await app.fetch(
        request("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path === "/" ? "" : path}", scope="services:invoke"`,
      );
      expect(await response.json()).toMatchObject({
        error: { code: "authorization_required" },
      });
      expect(openContext).toHaveBeenCalledOnce();
      expect(query).not.toHaveBeenCalled();
      app.close();
    },
  );

  test("OAuth discovery and anonymous MCP reads do not open an account context", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    const openContext = vi.fn(async () => {
      throw new Error("Anonymous reads must not authenticate");
    });
    const resource = `${origin}/mcp`;
    const app = createModernApplication(
      { query },
      {
        origin,
        openContext,
        now: () => new Date(at),
        oauth: {
          resource,
          scopes: ["services:invoke"],
          issuer: createOAuthIssuer(
            { query },
            { audiences: [resource], scopes: ["services:invoke"] },
          ),
        },
      },
    );
    const metadata = await app.fetch(
      new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource });
    for (const body of [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_chain_head", arguments: { network: "finney" } },
      },
    ]) {
      const response = await mcp(app, body);
      expect(response.status).toBe(200);
      expect(response.headers.has("www-authenticate")).toBe(false);
    }
    expect(openContext).not.toHaveBeenCalled();
    app.close();
  });

  test.each(["", "/mcp"])(
    "serves separate resource metadata with GET and bodyless HEAD for %s",
    async (path) => {
      const query = vi.fn(async () => ({ rows: [] }));
      const openContext = vi.fn(async () => {
        throw new Error("Metadata must not authenticate an account");
      });
      const resource = origin + path;
      const metadataPath = `/.well-known/oauth-protected-resource${path}`;
      const app = createModernApplication(
        { query },
        { origin, resource, openContext },
      );
      try {
        const get = await app.fetch(new Request(origin + metadataPath));
        expect(get.status).toBe(200);
        expect(await get.json()).toEqual({
          resource,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        });
        const head = await app.fetch(
          new Request(origin + metadataPath, { method: "HEAD" }),
        );
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        expect(await head.text()).toBe("");
        for (const response of [get, head]) {
          expect(response.headers.get("content-type")).toBe(
            "application/json; charset=utf-8",
          );
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("x-content-type-options")).toBe(
            "nosniff",
          );
          expect(response.headers.has("www-authenticate")).toBe(false);
        }
        expect(query).not.toHaveBeenCalled();
        expect(openContext).not.toHaveBeenCalled();
      } finally {
        app.close();
      }
    },
  );

  test("separate resource metadata rejects queries and unsupported methods without database work", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication(
      { query },
      { origin, resource: `${origin}/mcp` },
    );
    const path = `${origin}/.well-known/oauth-protected-resource/mcp`;
    try {
      for (const method of ["GET", "HEAD", "POST"]) {
        const response = await app.fetch(
          new Request(`${path}?resource=override`, { method }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: "invalid_input" },
        });
      }
      for (const method of ["POST", "PUT", "OPTIONS"]) {
        const response = await app.fetch(new Request(path, { method }));
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
        expect(await response.text()).toBe("");
      }
      expect(query).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });

  test("metadata-only serving rejects foreign request URLs and exposes no issuer routes", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication(
      { query },
      { origin, resource: `${origin}/mcp` },
    );
    try {
      const foreign = await app.fetch(
        new Request(
          "https://foreign.example/.well-known/oauth-protected-resource/mcp",
          {
            headers: {
              host: "example.test",
              "x-forwarded-host": "example.test",
            },
          },
        ),
      );
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toMatchObject({
        error: { code: "forbidden" },
      });
      for (const path of [
        "/.well-known/oauth-authorization-server",
        "/oauth/authorize",
        "/oauth/register",
        "/oauth/token",
      ]) {
        const response = await app.fetch(
          new Request(origin + path, {
            method:
              path === "/oauth/register" || path === "/oauth/token"
                ? "POST"
                : "GET",
          }),
        );
        expect(response.status).toBe(404);
      }
      expect(query).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });

  test.each([
    "https://foreign.example/mcp",
    "https://example.test:8443/mcp",
    "http://example.test/mcp",
    "https://user@example.test/mcp",
    "https://example.test/mcp#fragment",
  ])(
    "rejects an invalid or foreign separate resource %s before database work",
    (resource) => {
      const query = vi.fn(async () => ({ rows: [] }));
      expect(() =>
        createModernApplication({ query }, { origin, resource }),
      ).toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );

  test("requires matching explicit and issuer resource identities", () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const resource = `${origin}/mcp`;
    const oauth = {
      resource,
      scopes: ["services:invoke"],
      issuer: createOAuthIssuer(
        { query },
        { audiences: [resource], scopes: ["services:invoke"] },
      ),
    };
    expect(() =>
      createModernApplication(
        { query },
        { origin, resource: `${origin}/other`, oauth },
      ),
    ).toThrow("Conflicting OAuth resource identities");
    const matching = createModernApplication(
      { query },
      { origin, resource, oauth },
    );
    matching.close();
    expect(query).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "valid principals with insufficient scope get HTTP 403, OAuth configured %s",
    async (withOAuth) => {
      const query = vi.fn(async () => ({ rows: [] }));
      const resource = `${origin}/mcp`;
      const app = createModernApplication(
        { query },
        {
          origin,
          openContext: async () => {
            throw new V2InsufficientScopeError();
          },
          ...(withOAuth
            ? {
                oauth: {
                  resource,
                  scopes: ["services:invoke"],
                  issuer: createOAuthIssuer(
                    { query },
                    { audiences: [resource], scopes: ["services:invoke"] },
                  ),
                },
              }
            : {}),
        },
      );
      const response = await app.fetch(
        request("/mcp", {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "prepare_service_invocation", arguments: {} },
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBe(
        withOAuth
          ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="services:invoke", error="insufficient_scope"`
          : 'Bearer scope="services:invoke", error="insufficient_scope"',
      );
      expect(query).not.toHaveBeenCalled();
      app.close();
    },
  );

  test("a protected MCP request owns one authenticated context until its tool response closes", async () => {
    const close = vi.fn();
    const openContext = vi.fn(async () => ({
      caller: { accountId: "fixture-account" },
      close,
    }));
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin, openContext },
    );
    await initializeMcp(app, "Bearer fixture");
    openContext.mockClear();
    close.mockClear();
    const response = await mcp(
      app,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "prepare_service_invocation", arguments: {} },
      },
      "Bearer fixture",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: true } });
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(openContext).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    app.close();
  });

  test("untrusted origins, invalid input and bounded GraphQL fail without a database call", async () => {
    let calls = 0;
    const app = createModernApplication(
      {
        query: async () => {
          calls++;
          return { rows: [] };
        },
      },
      { origin },
    );
    expect(
      (
        await app.fetch(
          new Request("https://attacker.test/api/v2/networks/finney/head"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request(`${origin}/api/v2/networks/finney/head`, {
            headers: { origin: "https://attacker.test" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          request("/graphql", {
            query: "query { __typename } query Two { __typename }",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          request("/graphql", {
            query:
              "{ a:__typename b:__typename c:__typename d:__typename e:__typename }",
          }),
        )
      ).status,
    ).toBe(400);
    expect((await app.fetch(request("/graphql", { query: "{" }))).status).toBe(
      400,
    );
    expect(
      (await app.fetch(request("/graphql", { query: "x".repeat(70000) })))
        .status,
    ).toBe(413);
    expect(
      (
        await mcp(app, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "__proto__", arguments: {} },
        })
      ).status,
    ).toBe(200);
    expect(calls).toBe(0);
  });

  test("database errors cannot disclose credentials through MCP or GraphQL", async () => {
    const app = createModernApplication(
      {
        query: async () => {
          throw new Error("fixture-secret-not-for-response");
        },
      },
      { origin },
    );
    const mcpResponse = await mcp(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_chain_head", arguments: { network: "finney" } },
    });
    expect(await mcpResponse.text()).not.toContain(
      "fixture-secret-not-for-response",
    );
    for (const req of [
      request("/graphql", {
        query: '{ get_chain_head(input: {network: "finney"}) { api_version } }',
      }),
    ]) {
      const response = await app.fetch(req);
      expect(await response.text()).not.toContain(
        "fixture-secret-not-for-response",
      );
    }
  });

  test("GraphQL preserves qualified operation failures without replacing their public reason", async () => {
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin },
    );
    const response = await app.fetch(
      request("/graphql", {
        query: '{ get_chain_head(input: {network: "finney"}) { api_version } }',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { get_chain_head: null },
      errors: [{ message: "No contiguous publication is available" }],
    });
  });

  test("introspection and excessive nesting are refused before query execution", async () => {
    let calls = 0;
    const app = createModernApplication(
      {
        query: async () => {
          calls++;
          return { rows: [] };
        },
      },
      { origin },
    );
    for (const query of [
      "{ __schema { types { name } } }",
      "{ a { b { c { d { e { f { g { h { i } } } } } } } } }",
    ]) {
      expect((await app.fetch(request("/graphql", { query }))).status).toBe(
        400,
      );
    }
    expect(calls).toBe(0);
  });

  test("active requests enforce admission and close rejects new work", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createModernApplication(
      {
        query: async () => {
          await gate;
          return { rows: [row] };
        },
      },
      { origin, maxConcurrentRequests: 1, now: () => new Date(at) },
    );
    const active = app.fetch(
      new Request(`${origin}/api/v2/networks/finney/head`),
    );
    expect(
      (await app.fetch(new Request(`${origin}/api/v2/networks/finney/head`)))
        .status,
    ).toBe(503);
    release();
    expect((await active).status).toBe(200);
    app.close();
    expect(
      (await app.fetch(new Request(`${origin}/api/v2/networks/finney/head`)))
        .status,
    ).toBe(503);
  });

  test("deadline responses retain query slots until the underlying work finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createModernApplication(
      {
        query: async () => {
          await gate;
          return { rows: [row] };
        },
      },
      {
        origin,
        requestTimeoutMillis: 10,
        maxConcurrentRequests: 1,
        now: () => new Date(at),
      },
    );
    const timed = await app.fetch(
      new Request(`${origin}/api/v2/networks/finney/head`),
    );
    expect(timed.status).toBe(504);
    expect(
      (await app.fetch(new Request(`${origin}/api/v2/networks/finney/head`)))
        .status,
    ).toBe(503);
    release();
    await gate;
    app.close();
  });

  test("shutdown waits for a timed-out ordinary query before releasing its runtime owners", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createModernApplication(
      {
        query: async () => {
          await gate;
          return { rows: [row] };
        },
      },
      {
        origin,
        requestTimeoutMillis: 10,
        now: () => new Date(at),
      },
    );
    expect(
      (await app.fetch(new Request(origin + "/api/v2/networks/finney/head")))
        .status,
    ).toBe(504);
    let drained = false;
    const closing = app.close();
    expect(app.close()).toBe(closing);
    void closing.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await closing;
    expect(drained).toBe(true);
  });

  test("MCP execution shares ordinary query admission and drains after actual SQL settlement", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = createModernApplication(
      {
        query: async () => {
          started();
          await gate;
          return { rows: [row] };
        },
      },
      {
        origin,
        maxConcurrentRequests: 1,
        now: () => new Date(at),
      },
    );
    const id = await initializeMcp(app);
    const call = request("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_chain_head", arguments: { network: "finney" } },
    });
    call.headers.set("mcp-session-id", id);
    call.headers.set("mcp-protocol-version", "2025-11-25");
    const response = await app.fetch(call);
    await active;
    expect(
      (await app.fetch(new Request(origin + "/api/v2/networks/finney/head")))
        .status,
    ).toBe(503);
    let drained = false;
    const closing = app.close();
    void closing.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await closing;
    expect(drained).toBe(true);
    expect(await response.text()).not.toContain('"structuredContent"');
  });

  test("unfinished request bodies expire and cancel their source", async () => {
    let cancelled = false;
    let resolveCancel!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
        resolveCancel();
      },
    });
    const requestInit = {
      method: "POST",
      body,
      duplex: "half" as const,
      headers: { "content-type": "application/json" },
    };
    const req = new Request(`${origin}/mcp`, requestInit);
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin, requestTimeoutMillis: 10 },
    );
    const response = await app.fetch(req);
    expect([408, 504]).toContain(response.status);
    await cancellation;
    expect(cancelled).toBe(true);
  });

  test("unsupported routes, methods and media types cannot reach the database", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication({ query }, { origin });
    for (const [path, method, headers, expected] of [
      ["/missing", "GET", {}, 404],
      ["/mcp", "GET", {}, 400],
      ["/graphql", "GET", {}, 405],
      ["/api/v2/graphql", "GET", {}, 405],
      ["/graphql", "POST", {}, 415],
      ["/graphql", "POST", { "content-type": "text/plain" }, 415],
    ] as const) {
      const response = await app.fetch(
        new Request(origin + path, { method, headers }),
      );
      expect(response.status).toBe(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(query).not.toHaveBeenCalled();
  });

  test("missing, malformed and schema-invalid bodies fail before database work", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication({ query }, { origin });
    for (const body of [
      undefined,
      "{",
      "null",
      '{"query":3}',
      '{"query":"{ __typename }","extra":true}',
    ]) {
      const response = await app.fetch(
        new Request(origin + "/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
    }
    const emptyMcp = await app.fetch(
      new Request(origin + "/mcp", { method: "POST" }),
    );
    expect(emptyMcp.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  test("streamed JSON preserves chunk boundaries and trusts only the canonical origin", async () => {
    const app = createModernApplication(
      { query: async () => ({ rows: [row] }) },
      { origin, now: () => new Date(at) },
    );
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        query:
          "query Head($network: String!) { get_chain_head(input: {network: $network}) { snapshot { block_number } } }",
        variables: { network: "finney" },
      }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 11));
        controller.enqueue(encoded.slice(11));
        controller.close();
      },
    });
    const response = await app.fetch(
      new Request(origin + "/graphql", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", origin },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { get_chain_head: { snapshot: { block_number: "123" } } },
    });
  });

  test("large or faulted body streams cancel without exposing their errors", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication({ query }, { origin });
    let cancelled = false;
    const large = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled = true;
      },
    });
    const tooLarge = await app.fetch(
      new Request(origin + "/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: large,
        duplex: "half",
      } as RequestInit),
    );
    expect(tooLarge.status).toBe(413);
    expect(cancelled).toBe(true);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-body-source-error"));
      },
    });
    const failed = await app.fetch(
      new Request(origin + "/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: broken,
        duplex: "half",
      } as RequestInit),
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private-body-source-error");
    expect(query).not.toHaveBeenCalled();
  });

  test("field-count limits and invalid GraphQL fields are rejected before execution", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication({ query }, { origin });
    const wide = `{ get_chain_head(input: {network: "finney"}) { ${Array.from({ length: 101 }, (_, i) => `a${i}:api_version`).join(" ")} } }`;
    expect((await app.fetch(request("/graphql", { query: wide }))).status).toBe(
      400,
    );
    const invalid = await app.fetch(
      request("/graphql", { query: "{ unsupported }" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      errors: [{ message: expect.stringContaining("unsupported") }],
    });
    expect(query).not.toHaveBeenCalled();
  });

  test("MCP defaults absent arguments and returns bodyless notification acknowledgements", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createModernApplication({ query }, { origin });
    const invalid = await mcp(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_chain_head" },
    });
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ result: { isError: true } });
    const acknowledgement = await mcp(app, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(acknowledgement.status).toBe(202);
    expect(await acknowledgement.text()).toBe("");
    expect(query).not.toHaveBeenCalled();
  });

  test("ExactJSON preserves scalar inputs and exact numeric strings", () => {
    const app = createModernApplication(
      { query: async () => ({ rows: [] }) },
      { origin },
    );
    const scalar = app.graphqlSchema.getType("ExactJSON");
    expect(isScalarType(scalar)).toBe(true);
    if (!isScalarType(scalar)) throw new Error("ExactJSON scalar missing");
    const value = {
      amount: "18446744073709551615",
      active: true,
      nested: [null, 3],
    };
    expect(scalar.serialize(value)).toBe(value);
    expect(scalar.parseValue(value)).toBe(value);
    expect(
      scalar.parseLiteral(
        parseValue(
          '{ amount: "18446744073709551615", active: true, nested: [null, 3] }',
        ),
        {},
      ),
    ).toEqual(value);
  });

  test("schema conversion preserves nullable values, optional arrays and JSON records", async () => {
    vi.resetModules();
    vi.doMock("../schemas-src/v2/contracts.ts", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../schemas-src/v2/contracts.ts")>();
      return {
        ...actual,
        V2_OPERATION_SCHEMAS: {
          ...actual.V2_OPERATION_SCHEMAS,
          get_chain_head: {
            input: z.object({
              network: z.string(),
              flags: z.array(z.boolean()).optional(),
              threshold: z.number().optional(),
              metadata: z.unknown().optional(),
              options: z.object({ enabled: z.boolean().optional() }).optional(),
            }),
            output: z.object({
              amount: z.number().nullable(),
              details: z.record(z.string(), z.unknown()),
              mixed: z.union([z.string(), z.number()]),
              flags: z.array(z.boolean()),
              optional: z.string().optional(),
              metadata: z.object({ label: z.string().optional() }),
            }),
          },
        },
      };
    });
    try {
      const { createModernApplication: create } =
        await import("../src/modern-application.ts");
      const app = create({ query: async () => ({ rows: [] }) }, { origin });
      const schema = printSchema(app.graphqlSchema);
      expect(schema).toContain("flags: [Boolean]");
      expect(schema).toContain("threshold: Float");
      expect(schema).toContain("metadata: ExactJSON");
      expect(schema).toContain("amount: Float");
      expect(schema).toContain("details: ExactJSON!");
      expect(schema).toContain("mixed: ExactJSON!");
      expect(schema).toContain("optional: String");
      expect(schema).toContain("enabled: Boolean");
      expect(schema).toContain("label: String");
    } finally {
      vi.doUnmock("../schemas-src/v2/contracts.ts");
      vi.resetModules();
    }
  });

  test("unconstrained JSON schema properties remain JSON scalars and are optional by default", async () => {
    vi.resetModules();
    vi.doMock("zod", async (importOriginal) => {
      const actual = await importOriginal<typeof import("zod")>();
      return {
        ...actual,
        z: {
          ...actual.z,
          // A boolean JSON Schema is the standard representation for a field
          // accepting any JSON value. It does not declare object properties.
          toJSONSchema: () => ({
            type: "object",
            properties: { freeform: true },
          }),
        },
      };
    });
    try {
      const { createModernApplication: create } =
        await import("../src/modern-application.ts");
      const app = create({ query: async () => ({ rows: [] }) }, { origin });
      const input = app.graphqlSchema.getType("Input_get_chain_head");
      const output = app.graphqlSchema.getType("Result_get_chain_head");
      expect(String(input)).toBe("Input_get_chain_head");
      expect(String(output)).toBe("Result_get_chain_head");
      const schema = printSchema(app.graphqlSchema);
      expect(schema).toContain(
        "input Input_get_chain_head {\n  freeform: ExactJSON\n}",
      );
      expect(schema).toContain(
        "type Result_get_chain_head {\n  freeform: ExactJSON\n}",
      );
    } finally {
      vi.doUnmock("zod");
      vi.resetModules();
    }
  });

  test("response faults and byte limits release admission without leaking their source", async () => {
    vi.resetModules();
    let response: Response;
    vi.doMock("../src/v2/api.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/v2/api.ts")>()),
      createV2Handler: () => async () => response,
    }));
    try {
      const { createModernApplication: create } =
        await import("../src/modern-application.ts");
      const app = create(
        { query: async () => ({ rows: [] }) },
        { origin, publicReadOrigins: [website], maxConcurrentRequests: 1 },
      );
      const incoming = () =>
        new Request(`${origin}/api/v2/networks/finney/head`, {
          headers: { origin: website },
        });
      let cancelled = false;
      response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1048577));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      const tooLarge = await app.fetch(incoming());
      expect(tooLarge.status).toBe(503);
      expect(tooLarge.headers.get("access-control-allow-origin")).toBe(website);
      expect(await tooLarge.json()).toMatchObject({
        error: { code: "data_unavailable" },
      });
      expect(cancelled).toBe(true);
      response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("private-response-source-error"));
          },
        }),
      );
      const failed = await app.fetch(incoming());
      expect(failed.status).toBe(500);
      expect(failed.headers.get("access-control-allow-origin")).toBe(website);
      expect(await failed.text()).not.toContain(
        "private-response-source-error",
      );
      response = new Response(null, {
        status: 204,
        headers: {
          vary: "Accept-Encoding, origin",
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
        },
      });
      const empty = await app.fetch(incoming());
      expect(empty.status).toBe(204);
      expect(empty.headers.get("access-control-allow-origin")).toBe(website);
      expect(empty.headers.has("access-control-allow-credentials")).toBe(false);
      expect(empty.headers.get("vary")).toBe("Accept-Encoding, origin");
    } finally {
      vi.doUnmock("../src/v2/api.ts");
      vi.resetModules();
    }
  });
});
