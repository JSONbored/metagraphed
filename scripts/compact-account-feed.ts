import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import type { HistoryObject } from "../schemas-src/artifacts/history-generation.ts";
import { validateAccountFeed } from "../src/history-account-feed.ts";
import { decodeAccountPage } from "../src/history-account-page.ts";
import type { ParquetRangeSource } from "../src/indexed-parquet.ts";
import { createAccountPageDigest } from "./lib/account-page-digest.ts";
import { encodeAccountPage } from "./lib/account-page-encoding.ts";
import { compactHistoryFeed } from "./lib/compact-history-feed.ts";

/** Stage a bounded account subtree; publication and retirement remain separate. */
export function compactAccountFeed(
  input: unknown,
  selection: HistoryAccountFeed["selection"],
  store: ParquetRangeSource & {
    write(key: string, bytes: Uint8Array): Promise<HistoryObject>;
  },
  options: unknown = {},
) {
  return compactHistoryFeed(
    {
      name: "Account",
      validate: validateAccountFeed,
      base: (feed) =>
        `metagraph/indexed-history/v1/${feed.network}/account_events/generations/${feed.generation}/accounts/v1/`,
      encoding: "account-mixed-gzip-v2",
      decode: decodeAccountPage,
      encode: encodeAccountPage,
      digest: createAccountPageDigest(),
    },
    input,
    selection,
    store,
    options,
  );
}
