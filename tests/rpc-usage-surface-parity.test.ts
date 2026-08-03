// REST, MCP and GraphQL must answer /api/v1/rpc/usage the SAME way (#9269).
//
// The bug: #9207 wired the lakehouse cold tier into the REST handler only.
// The MCP tool and the GraphQL resolver still ran `tryPostgresTier ->
// loadRpcUsage`, and with the Postgres box destroyed that tier always missed,
// so both fell to the schema-stable ZEROED card. Measured live 2026-08-03:
// REST reported 118,309 requests on its top endpoint while
// `rpc_usage(window:"7d")` reported `total_requests: 0, endpoints: []`. An MCP
// client cannot tell that apart from a genuinely idle proxy.
//
// It was the second instance of the shape (#9263 was the accounts one), and it
// recurs because a cascade written at the call site has to be REMEMBERED at
// every call site. So this file pins both halves of the fix:
//
//   1. STRUCTURAL -- no surface reaches a tier reader directly. Read from
//      source, because "it happens to agree today" is exactly the state the
//      route was already in before #9207 landed on one leg of it.
//   2. BEHAVIOURAL -- given one set of store responses, all three surfaces
//      publish the same totals, the same endpoint list, and the same coverage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test } from "vitest";
import {
  configureRpcProxy,
  handleRpcUsage,
} from "../workers/request-handlers/rpc-proxy.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

const NOW = Date.now();
const HOUR = 3_600_000;

/** Where each surface's rpc-usage code lives. */
const SURFACE_SOURCES = {
  REST: "workers/request-handlers/rpc-proxy.ts",
  MCP: "src/mcp-server.ts",
  GraphQL: "src/graphql.ts",
} as const;

/** The tier readers a surface must NOT reach for. Each one is a decision the
 * composer owns: which store to ask, in what order, and when the zeroed floor
 * is actually the right answer. */
const TIER_READERS = [
  "loadRpcUsageHotTier",
  "loadRpcUsageColdTier",
  "loadRpcUsage",
  "rpc-usage-loader.ts",
  "rpc-usage-hot-tier.ts",
  "rpc-usage-cold-tier.ts",
];

/** Import lines only -- prose in a comment naming the old cascade is history,
 * not a call. */
function importLines(path: string): string[] {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^\s*(import|} from|\s+from)\b/.test(line.trim()));
}

describe("no surface owns the tier cascade", () => {
  for (const [surface, path] of Object.entries(SURFACE_SOURCES)) {
    test(`${surface} imports the composer and nothing below it`, () => {
      const source = readFileSync(
        new URL(`../${path}`, import.meta.url),
        "utf8",
      );
      assert.match(
        source,
        /answerRpcUsage/,
        `${surface} must answer through the composer`,
      );
      const imports = importLines(path).join("\n");
      for (const reader of TIER_READERS) {
        assert.ok(
          !imports.includes(reader),
          `${surface} imports ${reader} directly -- the cascade belongs to src/rpc-usage-answer.ts`,
        );
      }
    });
  }
});

// --- behavioural parity ------------------------------------------------------

const ENV = {
  ANALYTICS_ENGINE_SQL_TOKEN: "test-token",
  R2_SQL_TOKEN: "test-token",
};

/** Analytics Engine's four rollups, in the order the hot tier issues them. */
const AE_RESULTS: Row[][] = [
  [
    {
      total: 100,
      ok_count: 98,
      failover_count: 1,
      cache_hits: 20,
      latency_sum: 5_000,
      p50: 41,
      p95: 190,
      observed_from_s: Math.trunc((NOW - 2 * HOUR) / 1000),
      observed_at_s: Math.trunc(NOW / 1000),
    },
  ],
  [
    {
      endpoint_id: "alpha",
      provider: "acme",
      network: "finney",
      requests: 100,
      ok_count: 98,
      latency_sum: 5_000,
    },
  ],
  [{ network: "finney", requests: 100, ok_count: 98, latency_sum: 5_000 }],
  [
    {
      ts: Math.trunc(NOW / 1000),
      requests: 100,
      ok_count: 98,
      latency_sum: 5_000,
    },
  ],
];

/** The lakehouse's four rollups, routed by the SQL each one carries. */
function lakehouseRows(sql: string): Row[] {
  if (sql.includes("GROUP BY endpoint_id"))
    return [
      {
        endpoint_id: "alpha",
        provider: "acme",
        network: "finney",
        requests: 700,
        ok_count: 690,
        avg_latency_ms: 100,
      },
      {
        endpoint_id: "beta",
        provider: "acme",
        network: "finney",
        requests: 200,
        ok_count: 195,
        avg_latency_ms: 120,
      },
    ];
  if (sql.includes("GROUP BY network"))
    return [
      {
        network: "finney",
        requests: 900,
        ok_count: 885,
        avg_latency_ms: 105,
      },
    ];
  if (sql.includes("% "))
    return [
      {
        ts: NOW - 12 * HOUR,
        requests: 900,
        ok_count: 885,
        avg_latency_ms: 105,
      },
    ];
  return [
    {
      total: 900,
      ok_count: 885,
      failover_count: 9,
      cache_hits: 300,
      avg_latency_ms: 105,
      observed_from: NOW - 6 * 24 * HOUR,
      observed_at: NOW - 12 * HOUR,
    },
  ];
}

/**
 * One fetch double answering BOTH engines, routed by URL.
 *
 * The two clients post to different hosts and take different body shapes, so
 * this drives the real readers rather than the injectable query seams -- the
 * point of the exercise is that three surfaces reach the same wiring, and a
 * seam injected per surface would prove nothing about the wiring.
 */
function bothStores(): typeof fetch {
  let aeIndex = 0;
  return (async (url: string, init: RequestInit) => {
    if (String(url).includes("/analytics_engine/sql")) {
      const data = AE_RESULTS[aeIndex] ?? [];
      aeIndex += 1;
      return Response.json({ meta: [], data, rows: data.length });
    }
    const sql = (JSON.parse(String(init.body)) as { query: string }).query;
    return Response.json({
      success: true,
      result: { rows: lakehouseRows(sql) },
    });
  }) as unknown as typeof fetch;
}

async function withBothStores<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = bothStores();
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function restCard(): Promise<Row> {
  const res = await handleRpcUsage(
    new Request("https://api.metagraph.sh/api/v1/rpc/usage?window=7d"),
    mockEnv(ENV),
    new URL("https://api.metagraph.sh/api/v1/rpc/usage?window=7d"),
  );
  return ((await res.json()) as Row).data as Row;
}

async function mcpCard(): Promise<Row> {
  const tool = MCP_TOOLS.find((entry) => entry.name === "get_rpc_usage")!;
  return (await tool.handler({ window: "7d" }, {
    env: mockEnv(ENV),
  } as never)) as Row;
}

async function graphqlCard(): Promise<Row> {
  const res = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ rpc_usage(window: "7d") {
          window
          summary { total_requests ok_requests error_requests cache_hits latency_ms { p50 p95 avg } }
          endpoints { endpoint_id requests }
          coverage { start end segments { source start end } latency_percentiles { start end } }
        } }`,
      }),
    }),
    mockEnv(ENV),
  );
  const body = (await res.json()) as Row;
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return (body.data as Row).rpc_usage as Row;
}

describe("all three surfaces publish the same card", () => {
  beforeEach(() => {
    configureRpcProxy({
      readHealthMetaKv: async () => ({ last_run_at: null }),
    });
  });

  test("REST, MCP and GraphQL agree on totals, endpoints and coverage", async () => {
    const rest = await withBothStores(restCard);
    const mcp = await withBothStores(mcpCard);
    const graphql = await withBothStores(graphqlCard);

    // Both stores contributed: 900 lakehouse + 100 Analytics Engine. Neither a
    // hot-tier-only 100 (#9293) nor a zeroed 0 (#9269) is an acceptable answer
    // on ANY of the three.
    for (const [surface, card] of [
      ["REST", rest],
      ["MCP", mcp],
      ["GraphQL", graphql],
    ] as const) {
      const summary = card.summary as Row;
      assert.equal(summary.total_requests, 1_000, `${surface} total_requests`);
      assert.equal(summary.ok_requests, 983, `${surface} ok_requests`);
      assert.equal(summary.error_requests, 17, `${surface} error_requests`);
      assert.equal(summary.cache_hits, 320, `${surface} cache_hits`);
      assert.equal(
        (card.endpoints as Row[]).length,
        2,
        `${surface} endpoint count`,
      );
      // Percentiles are Analytics Engine's, on every surface, scoped to the
      // span AE measured rather than to the whole 7d label.
      assert.equal((summary.latency_ms as Row).p50, 41, `${surface} p50`);
      const coverage = card.coverage as Row;
      assert.equal(
        (coverage.segments as Row[]).length,
        2,
        `${surface} coverage segments`,
      );
      assert.deepEqual(
        (coverage.segments as Row[]).map((segment) => segment.source),
        ["lakehouse", "analytics-engine"],
        `${surface} coverage sources`,
      );
      assert.equal(
        (coverage.latency_percentiles as Row).end,
        Math.trunc(NOW / 1000) * 1000,
        `${surface} percentile scope`,
      );
    }

    // Not just "each is right" -- byte-identical where the surfaces share a
    // field, which is the property that stops one leg drifting again.
    assert.deepEqual(rest.summary, mcp.summary);
    assert.deepEqual(rest.endpoints, mcp.endpoints);
    assert.deepEqual(rest.coverage, mcp.coverage);
    assert.deepEqual(graphql.coverage, rest.coverage);
    assert.equal(
      (graphql.summary as Row).total_requests,
      (rest.summary as Row).total_requests,
    );
  });
});
