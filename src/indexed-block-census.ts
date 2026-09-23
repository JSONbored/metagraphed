import { HistorySourceCeilingSchema } from "../schemas-src/artifacts/history-source-ceiling.ts";
import { readSelectedHistorySegments } from "./indexed-history-store.ts";
import { readHistoryBlockCensus } from "./history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";

/** Fence the whole census against decoder movement, including empty segments. */
export async function loadIndexedBlockCensus(env: unknown) {
  try {
    const segments = await readSelectedHistorySegments(env, "blocks");
    if (!segments) return undefined;
    const bucket = (env as { METAGRAPH_ARCHIVE: Pick<R2Bucket, "get"> })
      .METAGRAPH_ARCHIVE;
    const key =
      "metagraph/indexed-history/v1/mainnet/blocks/source-ceiling.json";
    const before = await bucket.get(key);
    if (!before) return undefined;
    if (before.size > 8192 || !before.etag)
      throw new Error(
        "Block census source ceiling exceeds budget or lacks identity",
      );
    const ceiling = HistorySourceCeilingSchema.parse(await before.json());
    if (ceiling.network !== "mainnet" || ceiling.table !== "blocks")
      throw new Error("Block census source ceiling scope mismatch");
    if (
      segments[0].firstBlock !== 0 ||
      segments.at(-1)!.lastBlock < ceiling.through
    )
      return null;
    const source = r2ParquetSource(bucket);
    const budget = parquetReadBudget(32 * 1024 * 1024, 128);
    let lo: number | null = null,
      hi: number | null = null,
      n = 0;
    for (const segment of segments) {
      const current = await readHistoryBlockCensus(
        source,
        segment.blockManifest,
        { ...segment, table: "blocks" },
        budget,
      );
      if (current.lo !== null) {
        if (current.lo < segment.firstBlock || current.hi! > segment.lastBlock)
          throw new Error("Block census exceeds selected coverage");
        lo = lo === null ? current.lo : Math.min(lo, current.lo);
        hi = hi === null ? current.hi : Math.max(hi, current.hi!);
      }
      n += current.n;
    }
    if (!Number.isSafeInteger(n))
      throw new Error("Block census exceeds numeric range");
    const after = await bucket.get(key);
    return after !== null && after.etag === before.etag ? { lo, hi, n } : null;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
