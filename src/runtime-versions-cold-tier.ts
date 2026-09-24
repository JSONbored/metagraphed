// Runtime transitions and the current version come from verified block indexes.
// Missing coverage declines instead of reviving an archive-wide SQL scan.
import type { HistoryReadEnv } from "./history-readers.ts";
import { buildRuntimeVersionHistory } from "./runtime-versions.ts";
import { loadIndexedRuntimeHistory } from "./indexed-runtime-history.ts";

export async function loadRuntimeVersionHistoryColdTier(
  env: HistoryReadEnv | null | undefined,
): Promise<ReturnType<typeof buildRuntimeVersionHistory> | null> {
  return (await loadIndexedRuntimeHistory(env)) ?? null;
}
