// REST, MCP and GraphQL must answer /api/v1/rpc/usage the SAME way (#9269).
//
// The bug: #9207 wired the lakehouse cold tier into the REST handler only.
// The MCP tool and the GraphQL resolver still ran `tryDataApiTier ->
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
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  configureRpcProxy,
  handleRpcUsage,
} from "../workers/request-handlers/rpc-proxy.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

import { gunzipSync } from "node:zlib";
const nativeFixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/native-rpc/telemetry.json.gz", import.meta.url),
    ),
  ).toString(),
);
const NOW: number = nativeFixture.now;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());
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
  R2_SQL_TOKEN: "legacy-must-not-be-used",
  METAGRAPH_ARCHIVE: {
    async get(key: string) {
      const item = nativeFixture.objects[key];
      if (!item) return null;
      const raw = Buffer.from(item.body, "base64");
      return {
        etag: item.etag,
        size: item.size,
        json: async () => JSON.parse(raw.toString()),
        body: new Blob([raw]).stream(),
      };
    },
  },
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

/** HTTP is reserved for Analytics Engine; cold telemetry uses real immutable objects. */
function bothStores(): typeof fetch {
  let aeIndex = 0;
  return (async (url: string, _init: RequestInit) => {
    if (String(url).includes("/analytics_engine/sql")) {
      const data = AE_RESULTS[aeIndex] ?? [];
      aeIndex += 1;
      return Response.json({ meta: [], data, rows: data.length });
    }
    throw Error(`Unexpected network request: ${url}`);
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

    // Independently count the physical weighted fixture rows before AE's floor.
    const rows: unknown[][] = nativeFixture.rows.filter(
      (r: unknown[]) =>
        Number(r[0]) >= NOW - 7 * 24 * HOUR &&
        Number(r[0]) < Math.trunc((NOW - 2 * HOUR) / 1000) * 1000,
    );
    const count = (predicate: (r: unknown[]) => boolean) =>
      rows.reduce((n, r) => n + (predicate(r) ? Number(r[8] ?? 1) : 0), 0);
    const total = count(() => true),
      ok = count((r) => r[4] === true),
      hits = count((r) => r[7] === "hit");
    assert.ok(total > 0);
    for (const [surface, card] of [
      ["REST", rest],
      ["MCP", mcp],
      ["GraphQL", graphql],
    ] as const) {
      const summary = card.summary as Row;
      assert.equal(
        summary.total_requests,
        total + 100,
        `${surface} total_requests`,
      );
      assert.equal(summary.ok_requests, ok + 98, `${surface} ok_requests`);
      assert.equal(
        summary.error_requests,
        total - ok + 2,
        `${surface} error_requests`,
      );
      assert.equal(summary.cache_hits, hits + 20, `${surface} cache_hits`);
      assert.ok(
        (card.endpoints as Row[]).length > 1,
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
