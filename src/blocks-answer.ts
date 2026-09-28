// REST, MCP and GraphQL share both the stored block and its current-price
// conversion. Pricing only in the REST handler left the other two surfaces
// reporting null USD values for complete, measured blocks.
import { buildBlock, buildBlockFeed } from "./blocks.ts";
import {
  loadBlockColdTier,
  loadBlockFeedColdTier,
} from "./blocks-cold-tier.ts";
import { blockEconomicsUsd } from "./block-economics.ts";
import { DEFAULT_CHAIN_NETWORK, type ChainNetworkId } from "./chain-network.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import type { BlockFeedQuery } from "./r2-sql-blocks.ts";
import { readTaoUsdCurrentKv } from "../workers/tao-usd-current.ts";

function currentPrice(env: unknown, network: ChainNetworkId, now: number) {
  // Testnet TAO has no mainnet dollar valuation.
  return network === DEFAULT_CHAIN_NETWORK
    ? readTaoUsdCurrentKv(env, now)
    : Promise.resolve(null);
}

export async function answerBlockFeed(
  env: HistoryReadEnv | null | undefined,
  query: BlockFeedQuery,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
) {
  const now = Date.now();
  const [loaded, price] = await Promise.all([
    loadBlockFeedColdTier(env, query, network),
    currentPrice(env, network, now),
  ]);
  const data =
    loaded ??
    buildBlockFeed([], {
      limit: query.limit,
      offset: query.offset,
      nextCursor: null,
    });
  return {
    ...data,
    blocks: data.blocks.map((block) => ({
      ...block,
      ...blockEconomicsUsd(block.economic_activity_tao, price, now),
    })),
  };
}

export async function answerBlock(
  env: HistoryReadEnv | null | undefined,
  ref: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
) {
  const now = Date.now();
  const [loaded, price] = await Promise.all([
    loadBlockColdTier(env, ref, network),
    currentPrice(env, network, now),
  ]);
  const data = loaded ?? buildBlock(undefined, ref);
  return data.block
    ? {
        ...data,
        block: {
          ...data.block,
          ...blockEconomicsUsd(data.block.economic_activity_tao, price, now),
        },
      }
    : data;
}
