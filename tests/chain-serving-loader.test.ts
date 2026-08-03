// One question, three surfaces, one answer (#9229).
//
// #9216 wired the lakehouse rollup into the REST handler alone, so
// `GET /api/v1/chain/serving` reported 20 subnets and 2,931 servers while
// `get_chain_serving` (MCP) and `chain_serving` (GraphQL) each answered a
// zeroed card -- and no field in any of the three payloads told a caller which
// to believe. The parity is the contract here, so it is asserted by driving all
// three entry points against ONE fake lakehouse and comparing their output,
// rather than by three separate unit tests that could each pass while the
// surfaces disagreed.
//
// The mutation checks this file is built to survive: unwiring either MCP or
// GraphQL, and deriving the network-wide distinct by summing the per-subnet
// rows (which overstates it -- one hotkey serving five subnets is five rows and
// one server).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadChainServingRollup } from "../src/chain-serving-loader.ts";
import { handleRequest } from "../workers/api.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";

type Row = Record<string, unknown>;

const NOW = 1_785_000_000_000;

/**
 * Per-subnet rows whose distinct-server counts SUM to 12, against a network
 * block that reports 7.
 *
 * The gap is the point: 7 is what the ungrouped query measured, 12 is what
 * summing the rows would produce. Any implementation that derives the network
 * total from the rows reports 12 and fails.
 */
const SUBNET_ROWS = [
  { netuid: 1, announcements: 30, distinct_servers: 5 },
  { netuid: 2, announcements: 18, distinct_servers: 4 },
  { netuid: 3, announcements: 9, distinct_servers: 3 },
];
const NETWORK_ROWS = [{ distinct_servers: 7, newest_observed: NOW - 60_000 }];
const SUMMED_DISTINCT = 12;

/** Answers the two rollup halves by SQL shape, the way the engine would. */
function fakeQuery(
  answers: { rows?: Row[] | null; network?: Row[] | null } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    return sql.includes("GROUP BY netuid")
      ? pick(answers.rows, SUBNET_ROWS)
      : pick(answers.network, NETWORK_ROWS);
  };
  return { query, seen };
}

/**
 * An env whose R2 SQL calls are served from memory.
 *
 * Only R2_SQL_TOKEN gates `isR2SqlConfigured`, so stubbing `fetch` is enough to
 * put a lakehouse behind all three surfaces without any of them knowing.
 */
function lakehouseEnv(extra: Row = {}) {
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const sql = String(JSON.parse(String(init.body)).query);
    const rows = sql.includes("GROUP BY netuid") ? SUBNET_ROWS : NETWORK_ROWS;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  };
  return {
    env: { R2_SQL_TOKEN: "test-token", ...extra } as unknown as Row,
    fetchImpl,
  };
}

/** Runs `body` with globalThis.fetch stubbed, restoring it afterwards. */
async function withFetch<T>(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe("loadChainServingRollup", () => {
  test("builds the card from both rollup halves", async () => {
    const { query } = fakeQuery();
    const card = await loadChainServingRollup({} as never, {
      window: "7d",
      limit: 20,
      now: NOW,
      query: query as never,
    });
    assert.equal(card?.window, "7d");
    assert.equal(card?.subnet_count, 3);
    assert.equal(card?.network.distinct_servers, 7);
    assert.equal(card?.network.announcements, 57);
  });

  test("the network distinct is measured, never summed from the rows", async () => {
    const { query } = fakeQuery();
    const card = await loadChainServingRollup({} as never, {
      window: "7d",
      limit: 20,
      now: NOW,
      query: query as never,
    });
    assert.equal(
      card?.network.distinct_servers,
      7,
      "must come from the ungrouped query",
    );
    assert.notEqual(
      card?.network.distinct_servers,
      SUMMED_DISTINCT,
      "summing the per-subnet distincts overstates the network total: one " +
        "hotkey serving five subnets is five rows and one server",
    );
  });

  // Null, not the zeroed card: each surface's fallback is its own published
  // contract, and returning the empty card here would make all three identical
  // and unreachable.
  test("declines with null when either half misses", async () => {
    for (const answers of [{ rows: null }, { network: null }]) {
      const { query } = fakeQuery(answers);
      const card = await loadChainServingRollup({} as never, {
        window: "7d",
        limit: 20,
        now: NOW,
        query: query as never,
      });
      assert.equal(
        card,
        null,
        `expected a decline for ${JSON.stringify(answers)}`,
      );
    }
  });

  test("an unknown window narrows to 7d in BOTH the scan and the label", async () => {
    // The failure this prevents is not a 4xx -- all three callers validate
    // before getting here -- it is windowDays going undefined and silently
    // widening the scan past what was asked for, while the card still claims
    // the window it was handed.
    const { query, seen } = fakeQuery();
    const card = await loadChainServingRollup({} as never, {
      window: "90d",
      limit: 20,
      now: NOW,
      query: query as never,
    });
    assert.equal(card?.window, "7d");
    // The cutoff is an epoch-millisecond literal, since R2 SQL takes no bound
    // parameters. Asserting the 7d one appears in BOTH halves is what proves
    // the scan narrowed rather than just the label.
    const sevenDay = `observed_at >= ${NOW - 7 * 86_400_000}`;
    const thirtyDay = `observed_at >= ${NOW - 30 * 86_400_000}`;
    assert.ok(
      seen.length === 2 && seen.every((sql) => sql.includes(sevenDay)),
      `expected both queries pinned to "${sevenDay}": ${seen.join(" | ")}`,
    );
    assert.ok(
      seen.every((sql) => !sql.includes(thirtyDay)),
      "an unrecognized window must never widen the scan",
    );
  });

  test("one resolved limit feeds the scan and the builder", async () => {
    // Left to their own defaults these disagree -- loadChainEventRollup caps at
    // 200 and buildChainServing at 20 -- which would scan ten times the rows
    // the response can carry.
    const { query, seen } = fakeQuery();
    const card = await loadChainServingRollup({} as never, {
      window: "7d",
      now: NOW,
      query: query as never,
    });
    assert.ok(card);
    const grouped = seen.find((sql) => sql.includes("GROUP BY netuid"))!;
    assert.ok(
      grouped.includes("LIMIT 20"),
      `expected the scan capped at the builder's default: ${grouped}`,
    );
  });
});

describe("chain/serving answers identically on REST, MCP and GraphQL", () => {
  test("all three surfaces report the same numbers from one lakehouse", async () => {
    const { env, fetchImpl } = lakehouseEnv();

    const [rest, mcp, graphql] = await withFetch(fetchImpl, async () => {
      const restRes = await handleRequest(
        new Request("https://api.metagraph.sh/api/v1/chain/serving?window=7d"),
        env as never,
        {},
      );
      const restBody = (await restRes.json()) as Row;

      const mcpRes = await handleMcpRequest(
        new Request("https://api.metagraph.sh/api/v1/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get_chain_serving", arguments: { window: "7d" } },
          }),
        }),
        env as never,
        {},
      );
      const mcpBody = JSON.parse(await mcpRes.text()) as Row;

      const gqlRes = await handleGraphQLRequest(
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              '{ chain_serving(window:"7d"){ subnet_count network{ distinct_servers announcements } } }',
          }),
        }),
        env as never,
      );
      const gqlBody = (await gqlRes.json()) as Row;

      return [restBody, mcpBody, gqlBody];
    });

    const restData = (rest.data ?? {}) as Row;
    const mcpData = JSON.parse(
      String(
        (((mcp.result as Row)?.content as Row[])?.[0] as Row | undefined)
          ?.text ?? "{}",
      ),
    ) as Row;
    const gqlData = ((graphql.data ?? {}) as Row).chain_serving as Row;

    // The regression: these were 3 / 0 / 0 before the shared loader.
    for (const [name, data] of [
      ["REST", restData],
      ["MCP", mcpData],
      ["GraphQL", gqlData],
    ] as const) {
      assert.equal(data.subnet_count, 3, `${name} subnet_count`);
      assert.equal(
        (data.network as Row).distinct_servers,
        7,
        `${name} network distinct_servers`,
      );
      assert.notEqual(
        (data.network as Row).distinct_servers,
        SUMMED_DISTINCT,
        `${name} must not sum the per-subnet distincts`,
      );
      assert.equal(
        (data.network as Row).announcements,
        57,
        `${name} network announcements`,
      );
    }
  });
});
