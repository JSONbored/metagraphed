import { HistoryRuntimeSummarySchema } from "../schemas-src/artifacts/history-runtime-summary.ts";
import { readSelectedHistorySegments } from "./indexed-history-store.ts";
import { loadHistoryBlockGeneration } from "./history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";
import { buildRuntimeVersionHistory } from "./runtime-versions.ts";
import { resolveDecodeWatermark } from "./decode-watermark.ts";

type Bucket = Pick<R2Bucket, "get">;

/** Summaries follow the same selected generations as block reads. A missing
 * summary keeps the migration fallback; invalid or partial data never does. */
export async function loadIndexedRuntimeHistory(env: unknown) {
  try {
    const segments = await readSelectedHistorySegments(env, "blocks");
    if (!segments) return undefined;
    // Publication can trail a successful decode. Keep the migration fallback
    // until the selected range covers that table's advertised head; a valid
    // old timeline must not silently hide a newly captured runtime upgrade.
    const watermark = await resolveDecodeWatermark(env);
    const decodedHead = watermark?.perTable?.blocks;
    if (
      decodedHead == null ||
      segments[segments.length - 1].lastBlock < decodedHead
    )
      return undefined;
    const bucket = (env as { METAGRAPH_ARCHIVE: Bucket }).METAGRAPH_ARCHIVE;
    const source = r2ParquetSource(bucket);
    const budget = parquetReadBudget();
    const transitions = new Map<
      number,
      { spec_version: number; block_number: number; observed_at: number | null }
    >();
    let latest: { spec_version: number; block_number: number } | null = null;
    for (const segment of segments) {
      const key = `metagraph/indexed-history/v1/mainnet/blocks/generations/${segment.generation}/runtime.json`;
      const object = await bucket.get(key);
      if (!object) return undefined;
      if (object.size > 1024 * 1024)
        throw new Error("Runtime summary exceeds size budget");
      const summary = HistoryRuntimeSummarySchema.parse(await object.json());
      const generation = await loadHistoryBlockGeneration(
        source,
        segment.blockManifest,
        segment,
        budget,
      );
      if (
        summary.network !== segment.network ||
        summary.generation !== segment.generation ||
        summary.sourceSnapshot !== generation.sourceSnapshot ||
        summary.rows !== generation.rows ||
        summary.versionedRows > summary.rows ||
        summary.transitions.length > summary.versionedRows ||
        (summary.versionedRows === 0) !== (summary.latest === null) ||
        (summary.versionedRows === 0) !== (summary.transitions.length === 0)
      )
        throw new Error("Runtime summary scope or census mismatch");
      const seen = new Set<number>();
      let previous = -1;
      for (const row of summary.transitions) {
        if (
          seen.has(row.spec_version) ||
          row.block_number < previous ||
          row.block_number < segment.firstBlock ||
          row.block_number > segment.lastBlock ||
          (summary.latest !== null &&
            row.block_number > summary.latest.block_number)
        )
          throw new Error("Runtime transition coverage mismatch");
        seen.add(row.spec_version);
        previous = row.block_number;
        const old = transitions.get(row.spec_version);
        transitions.set(row.spec_version, {
          ...row,
          block_number: old
            ? Math.min(old.block_number, row.block_number)
            : row.block_number,
          observed_at:
            old?.observed_at == null
              ? row.observed_at
              : row.observed_at === null
                ? old.observed_at
                : Math.min(old.observed_at, row.observed_at),
        });
      }
      if (summary.latest) {
        if (
          !seen.has(summary.latest.spec_version) ||
          summary.latest.block_number > segment.lastBlock
        )
          throw new Error("Runtime latest block exceeds coverage");
        latest = summary.latest;
      }
    }
    if (!transitions.size) return null;
    return buildRuntimeVersionHistory(
      [...transitions.values()].sort(
        (a, b) =>
          a.block_number - b.block_number || a.spec_version - b.spec_version,
      ),
      latest,
    );
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
