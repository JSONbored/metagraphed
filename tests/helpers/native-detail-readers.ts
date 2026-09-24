import { afterEach, vi } from "vitest";
import * as history from "../../src/indexed-history-store.ts";
import * as feeds from "../../src/indexed-extrinsic-feeds.ts";
import * as blocks from "../../src/retained-blocks-d1.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type Row = Record<string, unknown>;
/** Surface-wiring fixture at the native storage boundary. The actual formatters,
 * input guards, seam/cursor composition and REST/MCP/GraphQL dispatch still run.
 * Real D1, immutable Parquet and feed-tree semantics have separate integration
 * fixtures in retained-blocks-d1, history-generation and indexed-extrinsic-feeds. */
export function nativeDetailReaders(input: {
  blocks?: Row[];
  extrinsics?: Row[];
  account_events?: Row[] | null;
  chain_events?: Row[];
}) {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  const blockFeed = vi
    .spyOn(blocks, "readRetainedBlockRows")
    .mockResolvedValue(input.blocks ?? []);
  const extrinsicFeed = vi
    .spyOn(feeds, "loadIndexedExtrinsicFeedPage")
    .mockResolvedValue(
      (input.extrinsics ?? []).map((row) =>
        Object.assign(
          {
            block_number: null,
            extrinsic_index: null,
            extrinsic_hash: null,
            signer: null,
            call_module: null,
            call_function: null,
            success: null,
            fee_tao: null,
            tip_tao: null,
            call_args: null,
            observed_at: null,
          },
          row,
        ),
      ),
    );
  const block = vi
    .spyOn(history, "readSelectedHistoryBlock")
    .mockImplementation(async (_env, table, height) =>
      input[table] === null
        ? null
        : (input[table] ?? []).filter(
            (row) => Number(row.block_number) === height,
          ),
    );
  const hash = vi
    .spyOn(history, "readSelectedHistoryHash")
    .mockImplementation(
      async (_env, table, value) =>
        (input[table] ?? []).find(
          (row) =>
            row[table === "blocks" ? "block_hash" : "extrinsic_hash"] === value,
        ) ?? [],
    );
  const restore = () => {
    blockFeed.mockRestore();
    extrinsicFeed.mockRestore();
    block.mockRestore();
    hash.mockRestore();
  };
  cleanups.push(restore);
  return {
    get length() {
      return (
        blockFeed.mock.calls.length +
        extrinsicFeed.mock.calls.length +
        block.mock.calls.length +
        hash.mock.calls.length
      );
    },
    blockFeed,
    extrinsicFeed,
    block,
    hash,
    env: { METAGRAPH_ARCHIVE: { get: async () => null } },
    restore,
  };
}
