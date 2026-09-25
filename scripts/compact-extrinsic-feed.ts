import type { HistoryExtrinsicFeed } from "../schemas-src/artifacts/history-extrinsic-feed.ts";
import type { HistoryObject } from "../schemas-src/artifacts/history-generation.ts";
import { validateExtrinsicFeed } from "../src/history-extrinsic-feed.ts";
import { decodeExtrinsicPage } from "../src/history-extrinsic-page.ts";
import type { ParquetRangeSource } from "../src/indexed-parquet.ts";
import { createAccountPageDigest } from "./lib/account-page-digest.ts";
import { encodeExtrinsicPage } from "./lib/extrinsic-page-encoding.ts";
import { compactHistoryFeed } from "./lib/compact-history-feed.ts";

/** Stage exact transaction pointers without publishing or deleting source packs. */
export function compactExtrinsicFeed(
  input: unknown,
  selection: HistoryExtrinsicFeed["selection"],
  store: ParquetRangeSource & {
    write(key: string, bytes: Uint8Array): Promise<HistoryObject>;
  },
  options: unknown = {},
) {
  const digest = createAccountPageDigest();
  return compactHistoryFeed(
    {
      name: "Extrinsic",
      validate: validateExtrinsicFeed,
      base: (feed) =>
        `metagraph/indexed-history/v1/${feed.network}/extrinsics/generations/${feed.generation}/feeds/v1/`,
      encoding: "extrinsic-mixed-gzip-v1",
      decode: decodeExtrinsicPage,
      encode: encodeExtrinsicPage,
      // The validated tuple permits only boolean/null in column six. Mapping
      // booleans to 0/1 is injective within that column; null retains its own tag.
      digest: (entries) =>
        digest(
          entries.map(({ token, values }) => ({
            token,
            values: values.map((value) =>
              typeof value === "boolean" ? Number(value) : value,
            ),
          })),
        ),
    },
    input,
    selection,
    store,
    options,
  );
}
