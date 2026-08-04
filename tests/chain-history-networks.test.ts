// #8700: the chain-history cold tier, per network.
//
// The property under test is which NAMESPACE each read targets, because that is
// the one thing a shape assertion cannot see. Both chains' tables have the same
// columns and produce the same row shapes, so a reader that queries `chain.*`
// while serving a testnet request returns a perfectly well-formed page of the
// wrong chain's history. The SQL string is the only place that difference is
// visible before it reaches a caller.
//
// The mainnet half matters just as much: every assertion here that pins
// `chain.` for a default call is guarding against the reverse mistake, where
// threading a network through makes mainnet start reading `chain_testnet`.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { chainTable, LAKEHOUSE_NAMESPACES } from "../src/chain-network.ts";
import {
  CHAIN_HISTORY_ROUTE_PATHS,
  isChainHistoryRouteTemplate,
} from "../src/chain-history-routes.ts";
import { isMainnetOnlyApiPath } from "../workers/api.ts";
import { concretePath } from "./concrete-path.ts";
import {
  loadBlockFeedFromR2Sql,
  loadBlockFromR2Sql,
} from "../src/r2-sql-blocks.ts";
import {
  loadBlockFeedColdTier,
  loadBlockColdTier,
  resolveBlocksSeam,
} from "../src/blocks-cold-tier.ts";
import { loadExtrinsicFeedColdTier } from "../src/extrinsics-cold-tier.ts";
import { loadChainEventsColdTier } from "../src/chain-events-cold-tier.ts";
import { loadAccountEventsColdTier } from "../src/events-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import { mockEnv } from "./row-type.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

/** Captures the SQL actually sent — the assertion surface for every case here. */
function sqlFetch(rows: unknown[] = []) {
  const queries: string[] = [];
  const impl = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, queries };
}

function withSql<T>(rows: unknown[], fn: (queries: string[]) => Promise<T>) {
  const real = globalThis.fetch;
  const { impl, queries } = sqlFetch(rows);
  globalThis.fetch = impl;
  return Promise.resolve(fn(queries)).finally(() => {
    globalThis.fetch = real;
  });
}

describe("chainTable", () => {
  test("mainnet keeps the bare `chain` namespace", () => {
    // Compatibility contract with every table already written and every reader
    // that predates networks — not a naming preference.
    assert.equal(chainTable("blocks"), "chain.blocks");
    assert.equal(chainTable("blocks", "mainnet"), "chain.blocks");
    assert.equal(LAKEHOUSE_NAMESPACES.mainnet, "chain");
  });

  test("testnet resolves to its own namespace", () => {
    assert.equal(chainTable("blocks", "testnet"), "chain_testnet.blocks");
    assert.equal(
      chainTable("account_events", "testnet"),
      "chain_testnet.account_events",
    );
    assert.notEqual(LAKEHOUSE_NAMESPACES.testnet, LAKEHOUSE_NAMESPACES.mainnet);
  });
});

describe("every chain-history reader targets its network's namespace", () => {
  // One case per reader. Each asserts BOTH directions, because a reader that
  // ignored the argument would pass a testnet-only assertion by accident if the
  // default happened to be wrong.
  const cases: [
    string,
    (network?: "mainnet" | "testnet") => Promise<unknown>,
  ][] = [
    [
      "blocks feed",
      (network) =>
        loadBlockFeedFromR2Sql(
          mockEnv(TOKEN),
          { limit: 5, offset: 0 },
          network,
        ),
    ],
    [
      "block detail",
      (network) => loadBlockFromR2Sql(mockEnv(TOKEN), "100", network),
    ],
    [
      "extrinsics feed",
      (network) =>
        loadExtrinsicFeedColdTier(
          mockEnv(TOKEN),
          { limit: 5, offset: 0 },
          network,
        ),
    ],
    [
      "chain events",
      (network) =>
        loadChainEventsColdTier(mockEnv(TOKEN), { limit: 5 }, network),
    ],
    [
      "account events",
      (network) =>
        loadAccountEventsColdTier(
          mockEnv(TOKEN),
          SS58,
          { limit: 5, offset: 0 },
          network,
        ),
    ],
  ];

  for (const [name, run] of cases) {
    test(`${name}: testnet reads chain_testnet, default reads chain`, async () => {
      await withSql([], async (queries) => {
        await run("testnet");
        assert.ok(queries.length > 0, `${name} issued no query`);
        for (const q of queries) {
          assert.match(
            q,
            /\bchain_testnet\.\w+/,
            `${name} testnet query hit the wrong namespace: ${q}`,
          );
          assert.doesNotMatch(
            q,
            /\bFROM chain\.\w+/,
            `${name} testnet query still reads mainnet: ${q}`,
          );
        }
      });

      await withSql([], async (queries) => {
        await run();
        assert.ok(queries.length > 0, `${name} issued no default query`);
        for (const q of queries) {
          assert.doesNotMatch(
            q,
            /chain_testnet/,
            `${name} default query leaked into testnet: ${q}`,
          );
        }
      });
    });
  }
});

describe("the D1 hot tier is mainnet's alone", () => {
  test("the seam is 0 off mainnet, so nothing is 'above' it", async () => {
    // blocks_head has no network column, so there are no non-mainnet hot rows
    // to reach. A non-zero seam would make the feed believe a hot range exists.
    resetDecodeWatermarkCache();
    assert.equal(await resolveBlocksSeam(mockEnv(), {}, "testnet"), 0);
  });

  test("a testnet feed never queries blocks_head", async () => {
    // The leak this guards against is silent: blocks_head rows are heights and
    // hashes, so mainnet blocks spliced into a testnet feed look entirely real.
    const d1Queries: string[] = [];
    const env = mockEnv({
      ...TOKEN,
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          d1Queries.push(sql);
          return {
            bind: () => ({ all: async () => ({ results: [] }) }),
          };
        },
      },
    });
    resetDecodeWatermarkCache();
    await withSql([], async () => {
      await loadBlockFeedColdTier(env, { limit: 5, offset: 0 }, "testnet");
      await loadBlockColdTier(env, "7700001", "testnet");
    });
    assert.deepEqual(
      d1Queries,
      [],
      `a testnet read touched D1: ${d1Queries.join(" | ")}`,
    );
  });

  test("a mainnet feed still uses D1, unchanged", async () => {
    // The other direction: skipping D1 for testnet must not skip it for
    // mainnet, which would silently drop every block above the seam.
    const d1Queries: string[] = [];
    const env = mockEnv({
      ...TOKEN,
      METAGRAPH_HEALTH_DB: {
        prepare(sql: string) {
          d1Queries.push(sql);
          return {
            bind: () => ({ all: async () => ({ results: [] }) }),
          };
        },
      },
    });
    resetDecodeWatermarkCache();
    await withSql([], async () => {
      await loadBlockFeedColdTier(env, { limit: 5, offset: 0 });
    });
    assert.ok(
      d1Queries.some((q) => q.includes("blocks_head")),
      "the mainnet feed stopped consulting its hot tier",
    );
  });

  test("a testnet feed is not capped at block 0 by the seam", async () => {
    // Regression guard. The lake leg bounds itself with `block_number < seam+1`
    // to avoid re-serving rows the D1 leg covered. With a seam of 0 and no D1
    // leg, that ceiling would cap the entire feed at block 0 — an empty testnet
    // feed that looks exactly like "this chain has no blocks".
    resetDecodeWatermarkCache();
    await withSql([], async (queries) => {
      await loadBlockFeedColdTier(
        mockEnv(TOKEN),
        { limit: 5, offset: 0 },
        "testnet",
      );
      assert.ok(queries.length > 0, "no lakehouse query was issued");
      for (const q of queries) {
        assert.doesNotMatch(
          q,
          /block_number < 1\b/,
          `testnet feed was ceilinged at block 0: ${q}`,
        );
      }
    });
  });
});

// The list feeds the capability matrix, so it must match the router in BOTH
// directions. A route in the list the router still gates would make the matrix
// promise a 404; a route the router serves that the list omits would make the
// matrix hide a working route. Neither shows up as an error anywhere.
describe("the chain-history route list is derived from the router", () => {
  test("every listed route is served off mainnet, and none is still gated", () => {
    for (const template of CHAIN_HISTORY_ROUTE_PATHS) {
      assert.equal(
        isMainnetOnlyApiPath(concretePath(template)),
        false,
        `${template} is in CHAIN_HISTORY_ROUTE_PATHS but the router still gates it`,
      );
      assert.ok(
        isChainHistoryRouteTemplate(template),
        `${template} is listed but the predicate does not recognise it`,
      );
    }
  });

  test("it does not claim routes that are still mainnet-only", () => {
    // /blocks/summary is the trap: same family, same prefix, still gated —
    // because it is cross-subnet analytics rather than one subnet's history.
    for (const template of [
      "/api/v1/blocks/summary",
      "/api/v1/chain-events",
      "/api/v1/blocks/{ref}/chain-events",
    ]) {
      assert.ok(
        !isChainHistoryRouteTemplate(template),
        `${template} is still mainnet-only but the list claims it`,
      );
    }
  });

  test("the list is sorted and free of duplicates", () => {
    const sorted = [...CHAIN_HISTORY_ROUTE_PATHS].sort();
    assert.deepEqual([...CHAIN_HISTORY_ROUTE_PATHS], sorted);
    assert.equal(
      new Set(CHAIN_HISTORY_ROUTE_PATHS).size,
      CHAIN_HISTORY_ROUTE_PATHS.length,
    );
  });
});
