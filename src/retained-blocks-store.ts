import type { ChainNetworkId } from "./chain-network.ts";
import type { RetainedBlocksSyncInput } from "./retained-blocks-sync.ts";

export interface RetainedBlockReadOptions {
  minEvents?: number | null;
  minExtrinsics?: number | null;
  heightOrder?: boolean;
  heightUpper?: number;
}

/** One explicitly selected owner for retained reads and synchronization. */
export interface RetainedBlocksStore {
  sync(input: RetainedBlocksSyncInput, now: number): Promise<Response>;
  rows(
    where: readonly string[],
    count: number,
    network: ChainNetworkId,
    now: number,
    options: RetainedBlockReadOptions,
  ): Promise<Record<string, unknown>[] | null>;
  observedAt(
    height: number,
    network: ChainNetworkId,
    now: number,
  ): Promise<string | null>;
  census(
    network: ChainNetworkId,
    now: number,
  ): Promise<{
    lo: number | null;
    hi: number | null;
    n: number;
  } | null>;
}
