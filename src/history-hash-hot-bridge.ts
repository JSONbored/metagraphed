import { HistorySourceCeilingSchema } from "../schemas-src/artifacts/history-source-ceiling.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { selectedD1Store } from "./d1-store.ts";

type Bucket = Pick<R2Bucket, "get">;
interface Coverage {
  first: number | null;
  last: number | null;
  rows: number;
  hot_head: number | null;
  matches: number;
}

/** Prove the unindexed tail in one D1 snapshot. The producer publishes a
 * monotone ceiling BEFORE adding catalog rows, including interrupted runs.
 * Two uncached reads bracket D1 so an advancing source cannot hide a hash.
 * Missing qualification keeps the migration fallback; read failures throw. */
export async function historyHashAbsentFromHotBridge(
  env: unknown,
  table: "blocks" | "extrinsics",
  hash: string,
  through: number,
  network: ChainNetworkId,
): Promise<boolean> {
  if (network !== "mainnet") return false;
  const hotTable =
    table === "blocks" ? "chain_detail_blocks" : "chain_detail_extrinsics";
  const store = selectedD1Store(env, ["chain_detail_blocks", hotTable]);
  const bucket = (env as { METAGRAPH_ARCHIVE?: Bucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!store || !bucket) return false;
  const key = `metagraph/indexed-history/v1/${network}/${table}/source-ceiling.json`;
  const before = await bucket.get(key);
  if (!before) return false;
  if (before.size > 8192)
    throw new Error("History source ceiling exceeds budget");
  const ceiling = HistorySourceCeilingSchema.parse(await before.json());
  if (ceiling.network !== network || ceiling.table !== table || !before.etag)
    throw new Error("History source ceiling scope mismatch");
  const column =
    table === "blocks" ? "lower(block_hash)" : "lower(extrinsic_hash)";
  const [coverage] = await store.query<Coverage>(
    `SELECT MIN(block_number) AS first, MAX(block_number) AS last, COUNT(*) AS rows,
      (SELECT MAX(block_number) FROM chain_detail_blocks) AS hot_head,
      EXISTS(SELECT 1 FROM ${hotTable} WHERE ${column} = ? LIMIT 1) AS matches
      FROM chain_detail_blocks WHERE block_number > ? AND block_number <= ?`,
    [hash.toLowerCase(), through, through + 32768],
  );
  if (!coverage) return false;
  const coveredThrough = coverage.last ?? through;
  if (
    (coverage.rows > 0 && coverage.first !== through + 1) ||
    coverage.rows !== coveredThrough - through ||
    (coverage.hot_head !== null && coverage.hot_head > coveredThrough) ||
    coveredThrough < ceiling.through ||
    coverage.matches !== 0
  )
    return false;
  const after = await bucket.get(key);
  return after !== null && after.etag === before.etag;
}
