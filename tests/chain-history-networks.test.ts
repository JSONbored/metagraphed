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
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The hot tier is Postgres now (#10179), reached through `new Client(...)`
// inside src/read-store.ts. The two namespace tests below assert WHETHER that
// store was consulted at all, so the seam has to be the `pg` module itself --
// see tests/helpers/pg-mock.ts for why, and for why the controller is built
// inside vi.hoisted.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { chainTable, LAKEHOUSE_NAMESPACES } from "../src/chain-network.ts";
import {
  CHAIN_HISTORY_ROUTE_PATHS,
  isChainHistoryRouteTemplate,
} from "../src/chain-history-routes.ts";
import { isMainnetOnlyApiPath } from "../workers/api.ts";
import { API_ROUTES } from "../src/contracts.ts";
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

describe("the hot tier is mainnet's alone", () => {
  /** An env whose hot tier is reachable, plus a live view of the statements it
   * was asked. Subscribed rather than read back so the array the caller holds
   * stays live across the loader call. */
  function hotTierEnv() {
    const queries: string[] = [];
    pg.control.queries.length = 0;
    pg.control.rows = [];
    pg.control.onQuery = (q) => queries.push(q.text);
    return { env: mockEnv({ ...TOKEN, ...pgMockEnv() }), queries };
  }

  test("the seam is 0 off mainnet, so nothing is 'above' it", async () => {
    // blocks_head has no network column, so there are no non-mainnet hot rows
    // to reach. A non-zero seam would make the feed believe a hot range exists.
    resetDecodeWatermarkCache();
    assert.equal(await resolveBlocksSeam(mockEnv(), {}, "testnet"), 0);
  });

  test("a testnet feed never queries blocks_head", async () => {
    // The leak this guards against is silent: blocks_head rows are heights and
    // hashes, so mainnet blocks spliced into a testnet feed look entirely real.
    const { env, queries } = hotTierEnv();
    resetDecodeWatermarkCache();
    await withSql([], async () => {
      await loadBlockFeedColdTier(env, { limit: 5, offset: 0 }, "testnet");
      await loadBlockColdTier(env, "7700001", "testnet");
    });
    assert.deepEqual(
      queries,
      [],
      `a testnet read touched the hot tier: ${queries.join(" | ")}`,
    );
  });

  test("a mainnet feed still uses the hot tier, unchanged", async () => {
    // The other direction: skipping the hot tier for testnet must not skip it
    // for mainnet, which would silently drop every block above the seam. The
    // env is identical to the testnet case's, so the two together prove the
    // network is what decides -- not a store that was simply unreachable.
    const { env, queries } = hotTierEnv();
    resetDecodeWatermarkCache();
    await withSql([], async () => {
      await loadBlockFeedColdTier(env, { limit: 5, offset: 0 });
    });
    assert.ok(
      queries.some((q) => q.includes("blocks_head")),
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

// The readers that hardcode `chain.` -- and why that is CORRECT, which is not
// obvious and was very nearly "fixed" into a bug.
//
// Nine cold tiers embed the mainnet namespace in their FROM clause instead of
// going through chainTable(). That looks exactly like the mistake this file's
// header warns about, and an audit reported it as one. It is not: every route
// they back is declared in MAINNET_ONLY_ROUTE_PATHS, and the reason is
// physical rather than a policy choice --
//
//   chain_testnet holds FOUR tables: blocks, extrinsics, chain_events,
//   account_events. Verified against the live catalog 2026-08-11.
//
// -- so there is no chain_testnet.subnet_hyperparams to read. Threading a
// network through these readers would let them build a FROM clause naming a
// table that does not exist. The 42 network-scoped routes are precisely the
// chain-history surface those four tables can serve; the other 168 are backed
// by producers that only run for mainnet.
//
// WHAT THIS GUARDS. The day a testnet counterpart appears and its route leaves
// MAINNET_ONLY_ROUTE_PATHS, these nine keep reading mainnet and serve it as
// testnet -- well-formed, plausible, wrong. Nothing else would notice.
const NAMESPACE_HARDCODED_READERS: Readonly<Record<string, readonly string[]>> =
  {
    "src/account-feeds-cold-tier.ts": [
      "/api/v1/accounts/{ss58}/events",
      "/api/v1/accounts/{ss58}/transfers",
    ],
    "src/account-history-cold-tier.ts": ["/api/v1/accounts/{ss58}/history"],
    "src/account-identity-cold-tier.ts": [
      "/api/v1/accounts/{ss58}/identity",
      "/api/v1/accounts/{ss58}/identity-history",
    ],
    "src/rpc-usage-cold-tier.ts": ["/api/v1/rpc/usage"],
    "src/runtime-versions-cold-tier.ts": ["/api/v1/runtime"],
    "src/subnet-event-summary-cold-tier.ts": [
      "/api/v1/subnets/{netuid}/event-summary",
    ],
    "src/subnet-hyperparams-cold-tier.ts": [
      "/api/v1/subnets/{netuid}/hyperparameters",
      "/api/v1/subnets/{netuid}/hyperparameters/history",
    ],
    "src/subnet-identity-cold-tier.ts": [
      "/api/v1/subnets/{netuid}/identity-history",
      "/api/v1/chain/identity-history",
    ],
    "src/subnet-ownership-cold-tier.ts": [
      "/api/v1/subnets/{netuid}/ownership-history",
    ],
    // src/chain-event-rollup-cold-tier.ts IS NO LONGER HERE (#11419): it takes
    // a `network` and builds its table with `chainTable(...)`, because
    // /chain/serving and /chain/prometheus moved to per-network projection
    // cards and this gate is what forced the threading rather than a gate the
    // change worked around. /chain/weights is still mainnet-only, and now for
    // its own reason (no lane yet) rather than because its reader could not
    // read another chain.
    "src/nominator-positions-cold-tier.ts": [
      "/api/v1/validators/{hotkey}/nominators",
    ],
    "src/self-health-cold-tier.ts": ["/api/v1/self-health"],
    "src/subnet-ohlc-cold-tier.ts": ["/api/v1/subnets/{netuid}/ohlc"],
  };

/**
 * Hardcodes the namespace but serves no route.
 *
 * lakehouse-seam-watchdog runs on LAKEHOUSE_SEAM_CRON and asks how far the
 * decode lane has got. There is one seam to watch and it is mainnet's, so
 * there is no network to thread -- but it still has to be declared, or the
 * completeness check below cannot tell it from a reader that forgot.
 */
const NAMESPACE_HARDCODED_NON_ROUTES: readonly string[] = [
  "src/lakehouse-seam-watchdog.ts",
];

describe("readers that hardcode the mainnet namespace", () => {
  test("every route they claim to back actually EXISTS", () => {
    // THE TEST THAT WOULD HAVE CAUGHT MY OWN ERROR. Membership in a set answers
    // "is this string present", and an invented path is absent -- so a typo
    // ("hyperparams" for "hyperparameters", "chain/runtime" for "runtime")
    // reads as "not mainnet-only" and inverts the conclusion. Assert existence
    // BEFORE asserting the property.
    const declared = new Set(API_ROUTES.map((r) => r.path));
    for (const [file, routes] of Object.entries(NAMESPACE_HARDCODED_READERS)) {
      for (const route of routes) {
        assert.ok(
          declared.has(route),
          `${file} claims to back ${route}, which is not in API_ROUTES -- ` +
            `fix the path here rather than trusting the assertion below`,
        );
      }
    }
  });

  test("every one of those routes is mainnet-only", () => {
    for (const [file, routes] of Object.entries(NAMESPACE_HARDCODED_READERS)) {
      for (const route of routes) {
        assert.ok(
          isMainnetOnlyApiPath(concretePath(route)),
          `${route} is no longer mainnet-only, but ${file} still hardcodes ` +
            `the \`chain.\` namespace -- it would serve mainnet data for a ` +
            `testnet request. Thread a network through it, or keep the route gated.`,
        );
      }
    }
  });

  test("no OTHER source file hardcodes the namespace without declaring it", () => {
    // Keeps the map complete by construction: a new reader that embeds `chain.`
    // has to justify itself here, rather than joining a list nobody rereads.
    const dir = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const rel = `src/${entry}`;
      if (NAMESPACE_HARDCODED_READERS[rel]) continue;
      if (NAMESPACE_HARDCODED_NON_ROUTES.includes(rel)) continue;
      const code = readFileSync(path.join(dir, entry), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      if (/\b(FROM|JOIN)\s+chain(_testnet)?\.[a-z_]+/.test(code)) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these embed a lakehouse namespace but are not declared above. Either ` +
        `use chainTable(), or add them with the routes they back:\n${offenders.join("\n")}`,
    );
  });
});
