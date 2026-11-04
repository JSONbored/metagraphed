import {
  fetchBlockAt,
  fetchHeadNumber,
  type HeadBlock,
} from "./head-poller.ts";
import { mirrorBlocksHeadToNeon } from "./capture-state-neon-write.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { LaneHealthDb } from "./lane-health.ts";

export interface ChainHeadProvider {
  head(signal: AbortSignal): Promise<number>;
  block(height: number, signal: AbortSignal): Promise<HeadBlock>;
  write(block: HeadBlock, signal: AbortSignal): Promise<void>;
}
export interface NativeChainHeadOptions {
  rpcUrl: string;
  requestTimeoutMillis: number;
  withEventCount: boolean;
  withAuthor: boolean;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now(): number;
  laneHealthDb?: LaneHealthDb;
}

/** Explicit RPC and SQL capabilities; constructing this source sends no request. */
export function createNativeChainHeadSource(
  runtime: Pick<PgStoreRuntime, "producer">,
  requested: NativeChainHeadOptions,
): ChainHeadProvider {
  const options = { ...requested };
  const endpoint = new URL(options.rpcUrl);
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new Error(
      "Native chain RPC requires an HTTP endpoint without credentials or fragment",
    );
  if (
    !Number.isSafeInteger(options.requestTimeoutMillis) ||
    options.requestTimeoutMillis < 1 ||
    options.requestTimeoutMillis > 60000
  )
    throw new RangeError("Native chain RPC deadline is invalid");
  if (
    typeof options.fetch !== "function" ||
    typeof options.now !== "function" ||
    typeof options.withEventCount !== "boolean" ||
    typeof options.withAuthor !== "boolean"
  )
    throw new TypeError("Native chain RPC capabilities are required");
  const fetcher =
    (signal: AbortSignal): typeof fetch =>
    (input, init) => {
      signal.throwIfAborted();
      return options.fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(options.requestTimeoutMillis),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    };
  return {
    head: (signal) => fetchHeadNumber(endpoint.href, fetcher(signal)),
    block: (height, signal) =>
      fetchBlockAt(
        endpoint.href,
        height,
        fetcher(signal),
        options.now,
        options.withEventCount,
        options.withAuthor,
      ),
    async write(block, signal) {
      signal.throwIfAborted();
      const result = await mirrorBlocksHeadToNeon(undefined, undefined, block, {
        sql: { unsafe: (text, values) => runtime.producer.query(text, values) },
        laneHealthDb: options.laneHealthDb,
        now: options.now,
      });
      signal.throwIfAborted();
      if (result.result?.ok !== true)
        throw new Error("Native blocks_head write was not committed");
    },
  };
}
