import { HistorySourceCeilingSchema } from "../schemas-src/artifacts/history-source-ceiling.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { TESTNET_RAW_CAPTURE_GENESIS_FLOOR } from "./raw-capture-sync.ts";
import { readSelectedHistorySegments } from "./indexed-history-store.ts";
import { loadHistoryBlockGeneration } from "./history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";
import {
  iterateAccountFeed,
  mergeAccountFeedPage,
  validateAccountFeed,
  type AccountFeedSelector,
} from "./history-account-feed.ts";

type Bucket = Pick<R2Bucket, "get">;

/** Missing qualification preserves the migration path. A corrupt selected
 * index fails closed, and must never turn into either an empty page or SQL. */
export async function loadIndexedAccountFeedPage(
  env: unknown,
  selectors: readonly AccountFeedSelector[],
  limit: number,
  offset = 0,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<AccountEventsRow[] | null | undefined> {
  try {
    if (selectors.length < 1 || selectors.length > 2)
      throw new Error("Account feed selector count exceeds budget");
    const segments = await readSelectedHistorySegments(
      env,
      "account_events",
      network,
    );
    if (!segments) return undefined;
    const floor = network === "mainnet" ? 0 : TESTNET_RAW_CAPTURE_GENESIS_FLOOR;
    const requestedStart = Math.max(
      floor,
      Math.min(...selectors.map((s) => s.blockStart ?? floor)),
    );
    if (segments[0].firstBlock > requestedStart) return undefined;
    const bucket = (env as { METAGRAPH_ARCHIVE: Bucket }).METAGRAPH_ARCHIVE;
    const base = `metagraph/indexed-history/v1/${network}/account_events`;
    const ceilingKey = `${base}/source-ceiling.json`;
    const before = await bucket.get(ceilingKey);
    if (!before) return undefined;
    if (before.size > 8192)
      throw new Error("Account feed source ceiling exceeds budget");
    const ceiling = HistorySourceCeilingSchema.parse(await before.json());
    if (
      ceiling.network !== network ||
      ceiling.table !== "account_events" ||
      !before.etag
    )
      throw new Error("Account feed source ceiling scope mismatch");
    const requestedEnd = Math.min(
      ceiling.through,
      Math.max(...selectors.map((s) => s.blockEnd ?? ceiling.through)),
    );
    if (segments[segments.length - 1].lastBlock < requestedEnd)
      return undefined;
    const source = r2ParquetSource(bucket);
    const budget = parquetReadBudget(24 * 1024 * 1024, 128);
    const streams = [];
    for (const segment of segments) {
      const object = await bucket.get(
        `${base}/generations/${segment.generation}/accounts/v1/manifest.json`,
      );
      if (!object) return undefined;
      if (object.size > 16 * 1024)
        throw new Error("Account feed manifest exceeds budget");
      const feed = validateAccountFeed(await object.json(), {
        ...segment,
        table: "account_events",
      });
      const generation = await loadHistoryBlockGeneration(
        source,
        segment.blockManifest,
        segment,
        budget,
      );
      if (
        feed.rows !== generation.rows ||
        feed.sourceSnapshot !== generation.sourceSnapshot
      )
        throw new Error(
          "Account feed source census differs from its generation",
        );
      for (const selector of selectors)
        streams.push(iterateAccountFeed(source, feed, selector, budget));
    }
    const rows = await mergeAccountFeedPage(streams, limit, offset);
    const after = await bucket.get(ceilingKey);
    return after !== null && after.etag === before.etag ? rows : undefined;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
