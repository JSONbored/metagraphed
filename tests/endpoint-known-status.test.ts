import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { API_QUERY_COLLECTIONS, QUERY_ENUMS } from "../src/contracts.ts";
import {
  applyQueryFilters,
  canonicalListSearch,
} from "../workers/list-query.ts";
import { providerEndpointsQueryUrl } from "../src/provider-endpoints-mcp.ts";
import {
  rpcEndpointsQueryUrl,
  loadRpcEndpointsList,
} from "../src/rpc-endpoints-mcp.ts";
import { subnetEndpointsQueryUrl } from "../src/subnet-endpoints-mcp.ts";
import { buildEndpointResourceArtifact } from "../scripts/lib/endpoint-artifacts.ts";
import type { Row } from "./row-type.ts";

const rows: Row[] = Array.from({ length: 350 }, (_, n) => ({
  id: `endpoint-${String(n).padStart(3, "0")}`,
  kind: "subnet-api",
  provider: "fixture",
  operator: "needle operator",
  url: `https://example.invalid/${n}`,
  netuid: 0,
  status: "unknown",
  latency_ms: n,
  score: 80,
  pool_eligible: false,
  publication_state: "monitored",
  layer: "subnet-app",
}));
for (const [n, status] of [
  [275, "ok"],
  [276, "degraded"],
  [277, "failed"],
  [278, "ok"],
] as const)
  rows[n].status = status;
rows[278].health_stale = true;

function artifact(endpoints = rows) {
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
    METAGRAPH_ARCHIVE: { get: async () => ({ json: async () => blob }) },
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
function transform(endpoints: Row[], known?: boolean) {
  const url = new URL("https://metagraph.sh/api/v1/endpoints");
  if (known !== undefined) url.searchParams.set("known_status", String(known));
  const result = applyQueryFilters(artifact(endpoints), url, "endpoints");
  assert.equal(result.error, undefined);
  return result.data as Row;
}

describe("catalog-wide known endpoint status", () => {
  test("uses the canonical status vocabulary, independent of classifications and freshness", () => {
    assert.deepEqual(
      API_QUERY_COLLECTIONS.endpoints.value_set_filters.known_status.values,
      QUERY_ENUMS.healthStatus.filter((status) => status !== "unknown"),
    );
    const values = [
      "ok",
      "degraded",
      "failed",
      "unknown",
      undefined,
      null,
      "live",
      "not-monitored",
      "OK",
      0,
    ];
    const fixture = values.map((status, n) => ({
      id: n,
      status,
      classification: "live",
      health_stale: true,
    }));
    assert.deepEqual(
      transform(fixture, true).endpoints.map((row: Row) => row.id),
      [0, 1, 2],
    );
    assert.deepEqual(
      transform(fixture, false).endpoints.map((row: Row) => row.id),
      [3, 4, 5, 6, 7, 8, 9],
    );
    assert.deepEqual(transform(fixture).endpoints, fixture);
  });

  test("producer keeps configured but never observed and disabled resources unknown", () => {
    const surfaces = [true, false].map((enabled, n) => ({
      id: `surface-${n}`,
      key: `key-${n}`,
      netuid: 0,
      kind: "subnet-api",
      subnet_slug: "root",
      subnet_name: "Root",
      provider: "fixture",
      url: `https://example.invalid/${n}`,
      public_safe: true,
      auth_required: false,
      probe: { enabled },
      source_urls: [],
    }));
    const result = buildEndpointResourceArtifact({
      surfaces,
      healthSurfaces: [
        {
          surface_id: "surface-1",
          status: "ok",
          classification: "live",
          last_checked: "2026-09-05T00:00:00Z",
        },
      ],
      generatedAt: "2026-09-05T00:00:00Z",
      contractVersion: "fixture",
      source: "test",
    });
    assert.deepEqual(
      result.endpoints.map((row: Row) => [row.monitoring_status, row.status]),
      [
        ["monitored", "unknown"],
        ["not_monitored", "unknown"],
      ],
    );
    assert.equal(transform(result.endpoints, true).endpoints.length, 0);
  });

  test("filters the entire REST catalog before pagination, projection and matching totals", async () => {
    for (const path of [
      "/api/v1/endpoints",
      "/api/v1/subnets/0/endpoints",
      "/api/v1/providers/fixture/endpoints",
      "/api/v1/rpc/endpoints",
    ]) {
      const first = await rest(
        { known_status: "true", q: "needle", fields: "id,status", limit: "2" },
        path,
      );
      assert.equal(first.response.status, 200, path);
      assert.deepEqual(first.body.data.endpoints, [
        { id: "endpoint-275", status: "ok" },
        { id: "endpoint-276", status: "degraded" },
      ]);
      assert.equal(first.body.meta.pagination.total, 4);
      assert.equal(first.body.meta.pagination.next_cursor, 2);
      assert.equal(first.body.data.summary.endpoint_count, 350);
      assert.match(
        first.response.headers.get("link") ?? "",
        /known_status=true/,
      );
      const next = await rest(
        { known_status: "true", cursor: "2", fields: "id", limit: "2" },
        path,
      );
      assert.deepEqual(next.body.data.endpoints, [
        { id: "endpoint-277" },
        { id: "endpoint-278" },
      ]);
      assert.equal(next.body.meta.pagination.next_cursor, null);
      const unknown = await rest({ known_status: "false", limit: "1" }, path);
      assert.equal(unknown.body.meta.pagination.total, 346);
    }
  });

  test("combines exact root netuid, q, health and capability facets without changing freshness", async () => {
    const result = await rest({
      known_status: "true",
      netuid: "0",
      q: "needle",
      status: "ok",
      pool_eligible: "false",
      provider: "fixture",
      kind: "subnet-api",
      min_latency_ms: "276",
      sort: "latency_ms",
      order: "desc",
      fields: "id,status,health_stale",
    });
    assert.deepEqual(result.body.data.endpoints, [
      { id: "endpoint-278", status: "ok", health_stale: true },
    ]);
    assert.equal(result.body.meta.pagination.total, 1);
    const incompatible = await rest({
      known_status: "true",
      status: "unknown",
    });
    assert.equal(incompatible.body.meta.pagination.total, 0);
  });

  test("all five MCP list consumers preserve true/false, paging and invalid-boolean contracts", async () => {
    for (const [name, base] of [
      ["list_endpoints", {}],
      ["list_rpc_endpoints", {}],
      ["get_subnet_endpoints", { netuid: 0 }],
      ["list_subnet_endpoints", { netuid: 0 }],
      ["list_provider_endpoints", { slug: "fixture" }],
    ] as const) {
      for (const known_status of [true, false]) {
        const result = await mcp(name, {
          ...base,
          known_status,
          q: "needle",
          cursor: 1,
          limit: 1,
          fields: "id",
          pool_eligible: false,
        });
        assert.equal(result.result.isError, false, JSON.stringify(result));
        assert.equal(
          result.result.structuredContent.total,
          known_status ? 4 : 346,
          name,
        );
        assert.deepEqual(result.result.structuredContent.endpoints, [
          { id: known_status ? "endpoint-276" : "endpoint-001" },
        ]);
      }
      const omitted = await mcp(name, { ...base, known_status: null });
      assert.equal(omitted.result.isError, false, name);
      assert.equal(omitted.result.structuredContent.total, 350, name);
      for (const known_status of ["yes", 1]) {
        const invalid = await mcp(name, { ...base, known_status });
        assert.equal(invalid.result.isError, true, name);
      }
    }
  });

  test("scoped query builders preserve Boolean words and reject unsupported values", () => {
    for (const [parse, base] of [
      [providerEndpointsQueryUrl, {}],
      [rpcEndpointsQueryUrl, {}],
      [subnetEndpointsQueryUrl, { netuid: 0 }],
    ] as const) {
      for (const known_status of [true, false])
        assert.equal(
          parse({ ...base, known_status }).searchParams.get("known_status"),
          String(known_status),
        );
      assert.throws(
        () => parse({ ...base, known_status: "yes" }),
        (error: Row) => error.code === "invalid_params",
      );
    }
  });

  test("REST rejects malformed flags before artifact reads and keeps distinct cache identities", async () => {
    let reads = 0;
    const env = {
      METAGRAPH_ARCHIVE: {
        get: async () => {
          reads++;
          throw new Error("must not read");
        },
      },
    } as unknown as Env;
    for (const known_status of ["yes", "1", "null", ""]) {
      const result = await rest({ known_status }, undefined, env);
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error.code, "invalid_query");
    }
    assert.equal(reads, 0);
    const keys = ["", "known_status=true", "known_status=false"].map((query) =>
      canonicalListSearch(
        new URL("https://metagraph.sh/api/v1/endpoints?" + query),
        "endpoints",
      ),
    );
    assert.equal(new Set(keys).size, 3);
  });

  test("live overlay precedes known status filtering and missing readings stay unknown", async () => {
    const endpoints = rows.map((row, n) => ({
      ...row,
      surface_id: `surface-${n}`,
    }));
    const stamp = new Date().toISOString();
    const live = {
      last_run_at: stamp,
      surfaces: [
        {
          surface_id: "surface-301",
          netuid: 0,
          status: "failed",
          classification: "dead",
          last_checked: stamp,
        },
        {
          surface_id: "surface-302",
          netuid: 0,
          status: "unknown",
          classification: "live",
          last_checked: stamp,
        },
      ],
    };
    const blob = artifact(endpoints);
    const api = await rest(
      { known_status: "true", fields: "id,status", limit: "1" },
      undefined,
      envFor(blob, live),
    );
    assert.equal(api.body.meta.pagination.total, 1);
    assert.deepEqual(api.body.data.endpoints, [
      { id: "endpoint-301", status: "failed" },
    ]);
    for (const [name, args] of [
      ["list_endpoints", {}],
      ["get_subnet_endpoints", { netuid: 0 }],
      ["list_subnet_endpoints", { netuid: 0 }],
      ["list_provider_endpoints", { slug: "fixture" }],
    ] as const) {
      const result = await mcp(
        name,
        { ...args, known_status: true, fields: "id,status", limit: 1 },
        blob,
        live,
      );
      assert.deepEqual(
        result.result.structuredContent.endpoints,
        api.body.data.endpoints,
        name,
      );
    }
    const unavailable = await rest(
      { known_status: "true" },
      undefined,
      envFor(blob),
    );
    assert.equal(unavailable.body.meta.pagination.total, 0);
  });

  test("GraphQL root accepts Boolean variables and treats null as omission", async () => {
    for (const known of [true, false, null, undefined]) {
      const response = await handleGraphQLRequest(
        new Request("https://metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              'query($known: Boolean) { endpoints(known_status: $known, netuid: 0, q: "needle", limit: 2) { total items { id } } }',
            variables: { known },
          }),
        }),
        envFor(),
        {},
      );
      const body = (await response.json()) as Row;
      assert.equal(body.errors, undefined, JSON.stringify(body));
      assert.equal(
        body.data.endpoints.total,
        known === true ? 4 : known === false ? 346 : 350,
      );
      assert.deepEqual(body.data.endpoints.items, [
        { id: known === true ? "endpoint-275" : "endpoint-000" },
        { id: known === true ? "endpoint-276" : "endpoint-001" },
      ]);
    }
  });

  test("scoped and GraphQL collections preserve current, missing, stale and disabled health evidence", async () => {
    const stamp = new Date().toISOString();
    const endpoints = [
      { ...rows[275], surface_id: "current" },
      { ...rows[276], surface_id: "missing" },
      {
        ...rows[277],
        surface_id: "disabled",
        status: "unknown",
        monitoring_status: "not_monitored",
        health_source: "not-monitored",
        health_stale: false,
        last_checked: null,
      },
    ];
    const fields = "id,status,health_source,health_stale,last_checked";
    const blob = {
      ...artifact(endpoints),
      subnet: { netuid: 0, name: "Root", slug: "root" },
      provider: { id: "fixture", name: "Fixture" },
      surfaces: [],
    };
    for (const state of ["current", "missing", "stale"] as const) {
      const live =
        state === "missing"
          ? null
          : {
              last_run_at: state === "stale" ? "2000-01-01T00:00:00Z" : stamp,
              surfaces: [
                {
                  surface_id: "current",
                  status: "failed",
                  last_checked: stamp,
                },
                { surface_id: "disabled", status: "ok", last_checked: stamp },
              ],
            };
      const env = envFor(blob, live);
      const all = await rest({ fields }, undefined, env);
      const expected = all.body.data.endpoints;
      assert.equal(
        expected[0].status,
        state === "current" ? "failed" : "unknown",
      );
      assert.equal(expected[0].health_stale, state !== "current");
      assert.equal(
        expected[0].last_checked,
        state === "current" ? stamp : null,
      );
      assert.equal(expected[1].status, "unknown");
      assert.equal(expected[1].health_source, "unavailable");
      assert.equal(expected[2].health_source, "not-monitored");
      assert.equal(expected[2].health_stale, false);

      for (const [path, name, args, field, subject] of [
        [
          "/api/v1/subnets/0/endpoints",
          "list_subnet_endpoints",
          { netuid: 0 },
          "subnet_endpoints",
          "netuid: 0",
        ],
        [
          "/api/v1/providers/fixture/endpoints",
          "list_provider_endpoints",
          { slug: "fixture" },
          "provider_endpoints",
          'slug: "fixture"',
        ],
      ] as const) {
        for (const known_status of [true, false]) {
          const wanted = expected.filter(
            (row: Row) => (row.status !== "unknown") === known_status,
          );
          const api = await rest(
            { known_status: String(known_status), fields },
            path,
            env,
          );
          assert.deepEqual(api.body.data.endpoints, wanted, `${state} ${path}`);
          const tool = await mcp(
            name,
            { ...args, known_status, fields },
            blob,
            live,
          );
          assert.deepEqual(
            tool.result.structuredContent.endpoints,
            wanted,
            `${state} ${name}`,
          );
          assert.equal(tool.result.structuredContent.total, wanted.length);
          const response = await handleGraphQLRequest(
            new Request("https://metagraph.sh/api/v1/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query: `{ ${field}(${subject}, known_status: ${known_status}, fields: "${fields}") }`,
              }),
            }),
            env,
            {},
          );
          const body = (await response.json()) as Row;
          assert.equal(body.errors, undefined, JSON.stringify(body));
          assert.deepEqual(
            body.data[field].endpoints,
            wanted,
            `${state} ${field}`,
          );
        }
      }
      const response = await handleGraphQLRequest(
        new Request("https://metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{
          endpoints(known_status: true) { total items { id status health_source last_checked } }
          subnet(netuid: 0) { endpoints(known_status: true) { id status health_source last_checked } }
          provider(id: "fixture") { endpoints { id status health_source last_checked } }
        }`,
          }),
        }),
        env,
        {},
      );
      const body = (await response.json()) as Row;
      assert.equal(body.errors, undefined, JSON.stringify(body));
      const projected = expected.map(
        ({ id, status, health_source, last_checked }: Row) => ({
          id,
          status,
          health_source,
          last_checked,
        }),
      );
      const known = projected.filter((row: Row) => row.status !== "unknown");
      assert.deepEqual(body.data.endpoints.items, known, `${state} root`);
      assert.equal(body.data.endpoints.total, known.length);
      assert.deepEqual(
        body.data.subnet.endpoints,
        known,
        `${state} nested subnet`,
      );
      assert.deepEqual(
        body.data.provider.endpoints,
        projected,
        `${state} nested provider`,
      );
    }
  });

  test("RPC's existing overlay and static fallback are filtered without claiming freshness", async () => {
    const blob = artifact(rows.slice(275, 279));
    const result = await loadRpcEndpointsList(
      {
        env: {} as Env,
        readArtifact: async () => ({
          ok: true,
          data: blob,
          source: "r2",
          storage_tier: "r2",
        }),
        readHealthKv: async () => ({
          last_run_at: "2026-09-05T00:00:00Z",
          endpoints: [
            { id: "endpoint-275", status: "unknown", classification: "live" },
            { id: "endpoint-276", status: "failed", classification: "dead" },
          ],
        }),
      },
      { known_status: true, fields: "id,status,health_stale" },
    );
    assert.equal(result.total, 3);
    assert.deepEqual(
      result.endpoints.map((row) => row.id),
      ["endpoint-276", "endpoint-277", "endpoint-278"],
    );
    assert.equal(result.endpoints.at(-1)?.health_stale, true);
  });

  test("GraphQL scoped endpoint consumers forward the canonical Boolean flag", async () => {
    for (const [field, subject] of [
      ["provider_endpoints", 'slug: "fixture", '],
      ["subnet_endpoints", "netuid: 0, "],
      ["rpc_endpoints", ""],
    ]) {
      const response = await handleGraphQLRequest(
        new Request("https://metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{ ${field}(${subject}known_status: true, limit: 1) }`,
          }),
        }),
        envFor(),
        {},
      );
      const body = (await response.json()) as Row;
      assert.equal(body.errors, undefined, JSON.stringify(body));
      assert.equal(body.data[field].total, 4, field);
      assert.equal(body.data[field].endpoints[0].id, "endpoint-275", field);
    }
  });

  test("GraphQL memoizes health and unavailable fallback across root and nested endpoint fields", async () => {
    const stamp = new Date().toISOString();
    const blob = {
      ...artifact([{ ...rows[0], surface_id: "current" }]),
      providers: Array.from({ length: 3 }, (_, n) => ({ id: `provider-${n}` })),
      subnet: { netuid: 0, name: "Root", slug: "root" },
      surfaces: [],
    };
    for (const snapshot of ["current", "missing", "malformed"] as const) {
      let healthReads = 0;
      let fallbackReads = 0;
      const env = {
        ...envFor(blob),
        METAGRAPH_HEALTH_SOURCE: "data-api",
        DATA_API: {
          fetch: async (request: Request) => {
            assert.equal(
              new URL(request.url).pathname,
              "/api/v1/internal/health-status-live",
            );
            fallbackReads++;
            return new Response("unavailable", { status: 503 });
          },
        },
        METAGRAPH_CONTROL: {
          get: async (key: string) => {
            assert.equal(key, "health:current");
            healthReads++;
            if (snapshot === "missing") return null;
            if (snapshot === "malformed") return "invalid-snapshot";
            return {
              last_run_at: stamp,
              surfaces: [
                {
                  surface_id: "current",
                  status: "failed",
                  last_checked: stamp,
                },
              ],
            };
          },
        },
      } as unknown as Env;
      const response = await handleGraphQLRequest(
        new Request("https://metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{
        providers(limit: 3) { items { endpoints { id status } } }
        endpoints(known_status: true) { total }
        subnet(netuid: 0) { endpoints(known_status: true) { id } }
        provider_endpoints(slug: "fixture", known_status: true, fields: "id,status")
        subnet_endpoints(netuid: 0, known_status: true, fields: "id,status")
      }`,
          }),
        }),
        env,
        {},
      );
      const body = (await response.json()) as Row;
      assert.equal(body.errors, undefined, JSON.stringify(body));
      assert.equal(body.data.providers.items.length, 3);
      for (const provider of body.data.providers.items)
        assert.equal(
          provider.endpoints[0].status,
          snapshot === "current" ? "failed" : "unknown",
        );
      const total = snapshot === "current" ? 1 : 0;
      assert.equal(body.data.endpoints.total, total);
      assert.equal(body.data.subnet.endpoints.length, total);
      assert.equal(body.data.provider_endpoints.total, total);
      assert.equal(body.data.subnet_endpoints.total, total);
      assert.equal(healthReads, 1);
      assert.equal(fallbackReads, snapshot === "current" ? 0 : 1);
    }
  });

  test("nested GraphQL endpoint rows apply known status before paging", async () => {
    const blob = {
      ...artifact(),
      subnet: { netuid: 0, name: "Root", slug: "root" },
      surfaces: [],
    };
    const response = await handleGraphQLRequest(
      new Request("https://metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "{ subnet(netuid: 0) { endpoints(known_status: true, limit: 1) { id } } }",
        }),
      }),
      envFor(blob),
      {},
    );
    const body = (await response.json()) as Row;
    assert.equal(body.errors, undefined, JSON.stringify(body));
    assert.deepEqual(body.data.subnet.endpoints, [{ id: "endpoint-275" }]);
  });

  test("overlay cache keeps known and unknown result pages isolated", async () => {
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
              ? {
                  last_run_at: stamp,
                  surfaces: [
                    {
                      surface_id: "endpoint-275",
                      netuid: 0,
                      status: "ok",
                      last_checked: stamp,
                    },
                  ],
                  subnets: [],
                }
              : null,
      },
    } as unknown as Env;
    try {
      for (const known of [true, false, true]) {
        const pending: Promise<unknown>[] = [];
        const response = await handleRequest(
          new Request(
            `https://metagraph.sh/api/v1/endpoints?known_status=${known}&limit=1&fields=id`,
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
        assert.equal(body.meta.pagination.total, known ? 1 : 349);
        assert.deepEqual(body.data.endpoints, [
          { id: known ? "endpoint-275" : "endpoint-000" },
        ]);
      }
      assert.equal(reads, 2);
      assert.equal(cached.size, 2);
    } finally {
      globalCache.caches = previous;
    }
  });
});
