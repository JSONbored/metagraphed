import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { API_QUERY_COLLECTIONS, listQuerySchema } from "../src/contracts.ts";
import { ListEndpointsInputSchema } from "../schemas-src/mcp-tools/endpoints-catalog.ts";
import { providerEndpointsQueryUrl } from "../src/provider-endpoints-mcp.ts";
import { rpcEndpointsQueryUrl } from "../src/rpc-endpoints-mcp.ts";
import { subnetEndpointsQueryUrl } from "../src/subnet-endpoints-mcp.ts";
import {
  applyQueryFilters,
  canonicalListSearch,
} from "../workers/list-query.ts";
import type { Row } from "./row-type.ts";

const rows = Array.from({ length: 350 }, (_, n) => ({
  id: `endpoint-${String(n).padStart(3, "0")}`,
  kind: "subnet-api",
  provider: "fixture",
  operator: "operator",
  url: `https://example.invalid/${n}`,
  subnet_name: "Example subnet",
  subnet_slug: "example-subnet",
  netuid: 0,
  status: "ok",
  latency_ms: n,
  score: 80,
  pool_eligible: false,
  publication_state: "monitored",
  layer: "subnet-app",
}));
for (const n of [275, 279, 301]) rows[n].operator = "Needle operator";
rows[301].status = "failed";

function artifact(endpoints: Row[] = rows) {
  return {
    schema_version: 1,
    generated_at: "2026-09-05T00:00:00Z",
    source: "artifact-build",
    summary: { endpoint_count: endpoints.length },
    endpoints,
  };
}

function envFor(blob = artifact(), live: Row | null = null): Env {
  return {
    METAGRAPH_ARCHIVE: {
      get: async () => ({ json: async () => blob }),
    },
    METAGRAPH_CONTROL: {
      get: async (key: string) => (key === "health:current" ? live : null),
    },
  } as unknown as Env;
}

async function rest(
  params: Record<string, string>,
  path = "/api/v1/endpoints",
  env = envFor(),
) {
  const url = new URL(path, "https://metagraph.sh");
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await handleRequest(new Request(url), env, {});
  return { response, body: (await response.json()) as Row };
}

async function mcp(
  name: string,
  args: Row,
  blob = artifact(),
  live: Row | null = null,
) {
  const response = await handleMcpRequest(
    new Request("https://metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    {} as Env,
    {
      readArtifact: async () => ({
        ok: true,
        data: blob,
        source: "test",
        storage_tier: "git",
      }),
      readHealthKv: async (_env: Env, key: string) =>
        key === "health:current" ? live : null,
    },
  );
  return (await response.json()) as Row;
}

function transform(
  q: string,
  endpoints: Row[] = rows,
  extra: Record<string, string> = {},
) {
  const url = new URL("https://metagraph.sh/api/v1/endpoints");
  for (const [key, value] of Object.entries({ q, ...extra }))
    url.searchParams.set(key, value);
  const result = applyQueryFilters(artifact(endpoints), url, "endpoints");
  assert.equal(result.error, undefined);
  return result as { data: Row; meta: Row };
}

describe("complete endpoint catalog search", () => {
  test("finds rows beyond the first 200 and pages matching rows with stable counts/projection", async () => {
    const params = {
      q: "needle",
      limit: "2",
      fields: "id",
      sort: "latency_ms",
    };
    const first = await rest(params);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.data.endpoints, [
      { id: "endpoint-275" },
      { id: "endpoint-279" },
    ]);
    assert.equal(first.body.meta.pagination.total, 3);
    assert.equal(first.body.meta.pagination.next_cursor, 2);
    assert.equal(first.body.data.summary.endpoint_count, 350);
    assert.match(first.response.headers.get("link") ?? "", /q=needle/);
    const second = await rest({ ...params, cursor: "2" });
    assert.deepEqual(second.body.data.endpoints, [{ id: "endpoint-301" }]);
    assert.equal(second.body.meta.pagination.total, 3);
    assert.equal(second.body.meta.pagination.next_cursor, null);
    const changed = await rest({
      ...params,
      q: "nothing-matches",
      cursor: "0",
    });
    assert.deepEqual(changed.body.data.endpoints, []);
    assert.equal(changed.body.meta.pagination.total, 0);
  });

  test("searches every documented string identity field, including stable/display aliases", () => {
    for (const field of API_QUERY_COLLECTIONS.endpoints.search_keys) {
      assert.equal(
        transform("unique-marker", [{ [field]: "Unique-Marker" }]).data
          .endpoints.length,
        1,
        field,
      );
    }
    assert.equal(transform("0", [{ netuid: 0 }]).data.endpoints.length, 0);
    assert.equal(
      transform("", [{ netuid: 0 }], { netuid: "0" }).data.endpoints.length,
      1,
    );
  });

  test("ANDs case-insensitive whitespace terms across fields and treats punctuation literally", () => {
    const fixture = [
      {
        provider: "Example",
        operator: "Other",
        url: "https://example.invalid/a?x=1&y=two+three#frag",
        id: "special%_*[]\"'",
      },
    ];
    assert.equal(
      transform("  EXAMPLE\tother\n", fixture).data.endpoints.length,
      1,
    );
    assert.equal(
      transform("example missing", fixture).data.endpoints.length,
      0,
    );
    for (const q of ["", " \t\n ", "?x=1&y=two+three#frag", "%_*[]\"'"]) {
      assert.equal(transform(q, fixture).data.endpoints.length, 1, q);
    }
    assert.equal(
      transform("*", [{ id: "not-a-wildcard-match" }]).data.endpoints.length,
      0,
    );
  });

  test("the canonical schema bounds untrimmed queries and preserves empty queries", () => {
    for (const schema of [
      listQuerySchema("endpoints"),
      ListEndpointsInputSchema,
    ]) {
      for (const q of ["", " \t ", "a".repeat(200), "😀".repeat(100)])
        assert.equal(schema.safeParse({ q }).success, true);
      for (const q of [
        "a".repeat(201),
        " ".repeat(201),
        "😀".repeat(101),
        42,
        null,
        ["one"],
      ])
        assert.equal(schema.safeParse({ q }).success, false);
    }
  });

  test("invalid REST queries reject before artifact reads", async () => {
    let reads = 0;
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          reads++;
          throw new Error("must not read");
        },
      },
    } as unknown as Env;
    const result = await rest({ q: "x".repeat(201) }, undefined, env);
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "invalid_query");
    assert.equal(reads, 0);
    const duplicate = await handleRequest(
      new Request("https://metagraph.sh/api/v1/endpoints?q=one&q=two"),
      env,
      {},
    );
    assert.equal(duplicate.status, 400);
    assert.equal(reads, 0);
  });

  test("combines search with existing filters, ranges, ordering and exact root netuid", async () => {
    const result = await rest({
      q: "needle",
      status: "ok",
      provider: "fixture",
      kind: "subnet-api",
      netuid: "0",
      min_latency_ms: "276",
      max_score: "90",
      fields: "id,status",
      order: "desc",
      sort: "latency_ms",
    });
    assert.deepEqual(result.body.data.endpoints, [
      { id: "endpoint-279", status: "ok" },
    ]);
    assert.equal(result.body.meta.pagination.total, 1);
  });

  test("REST global/subnet/provider scopes and CSV apply the same search before paging", async () => {
    for (const path of [
      "/api/v1/endpoints",
      "/api/v1/subnets/0/endpoints",
      "/api/v1/providers/fixture/endpoints",
      "/api/v1/rpc/endpoints",
    ]) {
      const result = await rest(
        { q: "needle", limit: "1", fields: "id" },
        path,
      );
      assert.equal(result.response.status, 200, path);
      assert.deepEqual(result.body.data.endpoints, [{ id: "endpoint-275" }]);
      assert.equal(result.body.meta.pagination.total, 3);
    }
    const response = await handleRequest(
      new Request(
        "https://metagraph.sh/api/v1/endpoints?q=needle&format=csv&fields=id&limit=1",
      ),
      envFor(),
      {},
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /endpoint-275/);
  });

  test("MCP global/subnet/provider tools preserve search, blank and malformed query semantics", async () => {
    for (const [name, base] of [
      ["list_endpoints", {}],
      ["list_rpc_endpoints", {}],
      ["list_subnet_endpoints", { netuid: 0 }],
      ["get_subnet_endpoints", { netuid: 0 }],
      ["list_provider_endpoints", { slug: "fixture" }],
    ] as const) {
      const result = await mcp(name, {
        ...base,
        q: "needle",
        fields: "id",
        limit: 2,
        cursor: 1,
      });
      assert.equal(result.result.isError, false, JSON.stringify(result));
      assert.deepEqual(result.result.structuredContent.endpoints, [
        { id: "endpoint-279" },
        { id: "endpoint-301" },
      ]);
      assert.equal(result.result.structuredContent.total, 3);
      for (const q of ["", " \t "]) {
        const empty = await mcp(name, { ...base, q, limit: 1 });
        assert.equal(empty.result.structuredContent.total, 350);
      }
      const invalid = await mcp(name, { ...base, q: "x".repeat(201) });
      assert.equal(invalid.result.isError, true);
    }
  });

  test("direct scoped loaders reject invalid q without coercing or trimming its bound", () => {
    for (const [parse, base] of [
      [providerEndpointsQueryUrl, {}],
      [rpcEndpointsQueryUrl, {}],
      [subnetEndpointsQueryUrl, { netuid: 0 }],
    ] as const) {
      for (const q of [42, null, " ".repeat(201)])
        assert.throws(
          () => parse({ ...base, q }),
          (error: Row) => error.code === "invalid_params",
        );
      assert.equal(parse({ ...base, q: " \t " }).searchParams.get("q"), " \t ");
    }
  });

  test("search composes with live health before filtering in REST and MCP", async () => {
    const endpoints = rows.map((row, n) => ({
      ...row,
      surface_id: `surface-${n}`,
    }));
    const stamp = new Date().toISOString();
    const live = {
      last_run_at: stamp,
      surfaces: [
        {
          surface_id: "surface-275",
          netuid: 0,
          status: "failed",
          classification: "down",
          last_checked: stamp,
        },
      ],
    };
    const blob = artifact(endpoints);
    const api = await rest(
      { q: "needle", status: "failed", fields: "id,status", limit: "1" },
      undefined,
      envFor(blob, live),
    );
    assert.deepEqual(api.body.data.endpoints, [
      { id: "endpoint-275", status: "failed" },
    ]);
    assert.equal(api.body.meta.pagination.total, 1);
    const tool = await mcp(
      "list_endpoints",
      { q: "needle", status: "failed", fields: "id,status", limit: 1 },
      blob,
      live,
    );
    assert.deepEqual(
      tool.result.structuredContent.endpoints,
      api.body.data.endpoints,
    );
    assert.equal(tool.result.structuredContent.total, 1);
  });

  test("query and cursor remain distinct in cache identity", () => {
    const key = (suffix: string) =>
      canonicalListSearch(
        new URL(`https://metagraph.sh/api/v1/endpoints?${suffix}`),
        "endpoints",
      );
    assert.notEqual(key("q=needle"), key("q=other"));
    assert.notEqual(key("q=needle&cursor=0"), key("q=needle&cursor=2"));
    assert.equal(key("q=needle&limit=2"), key("limit=2&q=needle"));
  });

  test("encoded URL-reserved search text remains literal at REST and MCP boundaries", async () => {
    const q = "?x=one%_&y=two+three#fragment";
    const blob = artifact([
      { ...rows[0], url: `https://example.invalid/${q}` },
    ]);
    const api = await rest({ q }, undefined, envFor(blob));
    assert.equal(api.body.meta.pagination.total, 1);
    const tool = await mcp("list_endpoints", { q }, blob);
    assert.equal(tool.result.structuredContent.total, 1);
  });

  test("live-overlay cache does not reuse another query's page", async () => {
    const globalCache = globalThis as unknown as { caches: unknown };
    const previous = globalCache.caches;
    const cached = new Map<string, Response>();
    globalCache.caches = {
      default: {
        match: async (request: Request) => cached.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cached.set(request.url, response.clone());
        },
      },
    };
    const stamp = new Date().toISOString();
    let reads = 0;
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          reads++;
          return {
            json: async () =>
              artifact(rows.map((row) => ({ ...row, surface_id: row.id }))),
          };
        },
      },
      METAGRAPH_CONTROL: {
        get: async (key: string) =>
          key === "health:meta"
            ? { last_run_at: stamp }
            : key === "health:current"
              ? { last_run_at: stamp, surfaces: [], subnets: [] }
              : null,
      },
    } as unknown as Env;
    try {
      for (const q of ["needle", "absent", "needle"]) {
        const pending: Promise<unknown>[] = [];
        const response = await handleRequest(
          new Request(
            `https://metagraph.sh/api/v1/endpoints?q=${q}&limit=1&fields=id`,
          ),
          env,
          {
            waitUntil: (promise: Promise<unknown>) => {
              pending.push(promise);
            },
          },
        );
        const body = (await response.json()) as Row;
        await Promise.all(pending);
        assert.equal(body.meta.pagination.total, q === "needle" ? 3 : 0);
        assert.deepEqual(
          body.data.endpoints,
          q === "needle" ? [{ id: "endpoint-275" }] : [],
        );
      }
      assert.equal(reads, 2);
      assert.equal(cached.size, 2);
    } finally {
      globalCache.caches = previous;
    }
  });

  test("existing GraphQL endpoint consumer preserves generated q parity", async () => {
    const response = await handleGraphQLRequest(
      new Request("https://metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            '{ endpoints(q: "needle", limit: 2) { total items { id } next_cursor } }',
        }),
      }),
      envFor(),
      {},
    );
    const body = (await response.json()) as Row;
    assert.equal(body.errors, undefined, JSON.stringify(body));
    assert.equal(body.data.endpoints.total, 3);
    assert.deepEqual(body.data.endpoints.items, [
      { id: "endpoint-275" },
      { id: "endpoint-279" },
    ]);
  });
});
