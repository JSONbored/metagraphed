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
import {
  decodeWatermarkKey,
  resetDecodeWatermarkCache,
} from "../src/decode-watermark.ts";
import { mockEnv } from "./row-type.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

/**
 * A lakehouse env that also PUBLISHES a decode watermark for both networks.
 *
 * The chain-events readers anchor page one on the watermark rather than on the
 * mainnet seam constant (#8700), so a network with no published watermark
 * declines outright -- correct behaviour, and it would make the namespace
 * assertion below vacuous. Both lanes publish in production; this mirrors that.
 */
const WATERMARKS: Record<string, number> = {
  mainnet: 8_771_082,
  testnet: 7_700_842,
};

function decodedEnv() {
  resetDecodeWatermarkCache();
  return mockEnv({
    ...TOKEN,
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        const network = Object.keys(WATERMARKS).find(
          (n) => key === decodeWatermarkKey(n as "mainnet" | "testnet"),
        );
        if (!network) return null;
        return {
          async text() {
            return JSON.stringify({ decoded_through: WATERMARKS[network] });
          },
        };
      },
    },
  });
}
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
      (network) => loadChainEventsColdTier(decodedEnv(), { limit: 5 }, network),
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
  test("a testnet block inside the decoded range is RETURNED, not blanked", async () => {
    // The bug this pins (#9394 shipped it, caught in production): the detail
    // path reads `aboveSeam` as "too new for the lakehouse, D1 only". With the
    // off-mainnet seam of 0, every real block is > 0, so every testnet block
    // short-circuited to an empty result before reaching the lakehouse that
    // held it.
    //
    // The existing tests missed it because they asserted what must NOT happen
    // (no D1 query) rather than what must: that a block comes back. A negative
    // assertion passes perfectly on a function that returns nothing at all.
    const row = {
      block_number: 7_700_500,
      block_hash: "0xtestnetblockhash",
      parent_hash: "0xparent",
      author: null,
      extrinsic_count: 8,
      event_count: 20,
      spec_version: 441,
      observed_at: 1_700_000_000_000,
    };
    resetDecodeWatermarkCache();
    await withSql([row], async (queries) => {
      const block = (await loadBlockColdTier(
        mockEnv(TOKEN),
        "7700500",
        "testnet",
      )) as Record<string, unknown> | null;
      assert.ok(queries.length > 0, "the lakehouse was never queried");
      assert.ok(
        queries.some((q) => q.includes("chain_testnet.blocks")),
        `queried the wrong namespace: ${queries.join(" | ")}`,
      );
      const inner = (block?.block ?? block) as Record<string, unknown> | null;
      assert.equal(
        inner?.block_hash,
        "0xtestnetblockhash",
        `expected the row back, got ${JSON.stringify(block)}`,
      );
    });
  });

  test("a mainnet block above the seam still short-circuits, unchanged", async () => {
    // The other direction: making the detail path network-aware must not stop
    // mainnet treating a too-new height as a D1-only miss, which is what keeps
    // it from scanning the lakehouse for a block it cannot contain.
    resetDecodeWatermarkCache();
    await withSql([], async (queries) => {
      await loadBlockColdTier(mockEnv(TOKEN), "99999999");
      assert.deepEqual(
        queries,
        [],
        "mainnet scanned the lakehouse for a block above its seam",
      );
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
    // The trap is a route in the same FAMILY that this list must not absorb.
    // /blocks/summary was that route until #9412 gave the projection lanes a
    // network dimension; it is a projection route now, held by
    // tests/projection-networks.test.ts, and the remaining example is the
    // neurons-tier analytics, which read a store no decode lane produces.
    for (const template of ["/api/v1/chain/weights"]) {
      assert.ok(
        !isChainHistoryRouteTemplate(template),
        `${template} is still mainnet-only but the list claims it`,
      );
      // The paired positive: an exclusion assertion is only meaningful while
      // the thing excluded is genuinely still gated.
      assert.ok(
        isMainnetOnlyApiPath(concretePath(template)),
        `${template} must still be gated for that claim to mean anything`,
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
