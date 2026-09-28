import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { buildBlock, buildBlockFeed } from "../src/blocks.ts";
import { answerBlock, answerBlockFeed } from "../src/blocks-answer.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import {
  handleBlock,
  handleBlocks,
} from "../workers/request-handlers/entities.ts";
import { KV_TAO_USD_CURRENT } from "../src/kv-keys.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const readers = vi.hoisted(() => ({ feed: vi.fn(), detail: vi.fn() }));
vi.mock("../src/blocks-cold-tier.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/blocks-cold-tier.ts")>()),
  loadBlockFeedColdTier: readers.feed,
  loadBlockColdTier: readers.detail,
}));
afterEach(() => vi.restoreAllMocks());

const blockFields = [
  "block_number",
  "block_hash",
  "parent_hash",
  "author",
  "extrinsic_count",
  "event_count",
  "spec_version",
  "observed_at",
  "decode_status",
  "native_transfer_tao",
  "stake_flow_tao",
  "economic_activity_tao",
  "fee_tao",
  "tip_tao",
  "issuance_tao",
  "subnet_ids",
  "economic_activity_usd",
  "usd_per_tao",
  "tao_usd_block",
  "tao_usd_observed_at",
  "tao_usd_basis",
  "tao_usd_unavailable",
];
const request = (path: string) => new Request(`https://api.test${path}`);
function fixture(amount: number | null, age: number | null = 1000) {
  const now = Date.now();
  const row = {
    block_number: 123,
    block_hash: `0x${"a".repeat(64)}`,
    observed_at: new Date(now - 10_000).toISOString(),
    decode_status: amount === null ? "unavailable" : "complete",
    economic_activity_tao: amount,
    native_transfer_tao: amount,
    stake_flow_tao: 0,
    fee_tao: 0,
    tip_tao: 0,
    issuance_tao: 0.5,
    subnet_ids: [7],
  };
  readers.feed.mockResolvedValue(
    buildBlockFeed([row], { limit: 1, offset: 0, nextCursor: "next" }),
  );
  readers.detail.mockResolvedValue(buildBlock(row, "123"));
  let priceReads = 0;
  const env = mockEnv({
    METAGRAPH_CONTROL: {
      async get(key: string) {
        if (key !== KV_TAO_USD_CURRENT) return null;
        priceReads++;
        return age === null
          ? null
          : {
              usd_per_tao: 2,
              observed_at: new Date(now - age).toISOString(),
              block_number: 456,
              price_basis: "wrapped_onchain_median",
            };
      },
    },
  });
  return { env, priceReads: () => priceReads };
}
async function graphql(env: Env, query: string) {
  const response = await handleGraphQLRequest(
    new Request("https://api.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    env,
  );
  const result = await jsonBody(response);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data as Row;
}
function graphqlShape(block: Row) {
  return Object.fromEntries(
    blockFields.map((key) => [key, block[key] ?? null]),
  );
}

for (const [label, amount, age, expectedUsd] of [
  ["measured activity", 2.5, 1000, 5],
  ["measured zero", 0, 1000, 0],
  ["unavailable native economics", null, 1000, null],
  ["stale price", 2.5, 3 * 3600_000, null],
  ["missing price", 2.5, null, null],
] as const) {
  test(`REST, MCP and GraphQL block detail and feed preserve ${label}`, async () => {
    const { env, priceReads } = fixture(amount, age);
    const restDetail = (
      await jsonBody(
        await handleBlock(request("/api/v1/blocks/123"), env, "123"),
      )
    ).data as Row;
    const url = new URL("https://api.test/api/v1/blocks?limit=1&offset=0");
    const restFeed = (
      await jsonBody(
        await handleBlocks(request(url.pathname + url.search), env, url),
      )
    ).data as Row;
    assert.equal(restDetail.block.economic_activity_usd, expectedUsd);
    assert.equal(restFeed.blocks[0].economic_activity_usd, expectedUsd);
    const mcpDetail = await MCP_TOOLS.find(
      (t) => t.name === "get_block",
    )!.handler({ ref: "123" } as never, { env } as never);
    const mcpFeed = await MCP_TOOLS.find(
      (t) => t.name === "list_blocks",
    )!.handler({ limit: 1, offset: 0 } as never, { env } as never);
    assert.deepEqual(mcpDetail, restDetail);
    assert.deepEqual(mcpFeed, restFeed);
    const detail = await graphql(
      env,
      `{block(ref:"123"){block{${blockFields.join(" ")}}}}`,
    );
    const feed = await graphql(
      env,
      `{blocks(limit:1,offset:0){items{${blockFields.join(" ")}} total next_cursor}}`,
    );
    assert.deepEqual(detail.block.block, graphqlShape(restDetail.block));
    assert.deepEqual(feed.blocks.items, restFeed.blocks.map(graphqlShape));
    assert.equal(feed.blocks.total, restFeed.block_count);
    assert.equal(feed.blocks.next_cursor, restFeed.next_cursor);
    if (age !== null)
      assert.equal(
        priceReads(),
        1,
        "all surfaces share the existing bounded price memo",
      );
  });
}

test("testnet never acquires a mainnet USD valuation", async () => {
  const { env, priceReads } = fixture(2.5);
  const detail = await answerBlock(env, "123", "testnet");
  const feed = await answerBlockFeed(env, { limit: 1, offset: 0 }, "testnet");
  assert.equal(detail.block!.economic_activity_usd, null);
  assert.equal(feed.blocks[0].economic_activity_usd, null);
  assert.equal(priceReads(), 0);
  assert.equal(readers.detail.mock.lastCall![2], "testnet");
  assert.equal(readers.feed.mock.lastCall![2], "testnet");
});

test("missing blocks, feed absence, navigation and decline details survive composition", async () => {
  const { env } = fixture(2.5);
  const missing = buildBlock(undefined, "999");
  readers.detail.mockResolvedValueOnce(missing).mockResolvedValueOnce(null);
  assert.deepEqual(await answerBlock(env, "999"), missing);
  assert.deepEqual(await answerBlock(env, "999"), missing);
  readers.feed.mockResolvedValueOnce(null);
  assert.deepEqual(
    await answerBlockFeed(env, { limit: 1, offset: 2 }),
    buildBlockFeed([], { limit: 1, offset: 2, nextCursor: null }),
  );
  const detail = {
    ...buildBlock({ block_number: 123, economic_activity_tao: 2.5 }, "123"),
    prev_block_number: 121,
    next_block_number: 125,
  };
  readers.detail.mockResolvedValueOnce(detail);
  const answer = await answerBlock(env, "123");
  assert.equal(answer.prev_block_number, 121);
  assert.equal(answer.next_block_number, 125);
  const declined = { ...missing, degraded: { reason: "history_unavailable" } };
  readers.detail.mockResolvedValueOnce(declined);
  assert.deepEqual(await answerBlock(env, "999"), declined);
});
