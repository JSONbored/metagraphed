// RPC usage over the historical portion not covered by live telemetry.
// Verified native snapshots preserve complete weighted observations.
import { ANALYTICS_WINDOW_DAYS, RPC_USAGE_BUCKETS } from "../workers/config.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadRpcUsageNative } from "./rpc-usage-native.ts";

/** Canonical supported window and timestamp validation. */
export function windowCutoffMs(
  window: string,
  now: number,
): { cutoff: number; bucketMs: number; granularity: string } | null {
  const days = (ANALYTICS_WINDOW_DAYS as Record<string, number>)[window];
  const bucket = (
    RPC_USAGE_BUCKETS as Record<
      string,
      { granularity: string; bucketMs: number }
    >
  )[window];
  if (typeof days !== "number" || !bucket) return null;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return null;
  return { cutoff, bucketMs: bucket.bucketMs, granularity: bucket.granularity };
}

/**
 * Serve one verified usage window, or null when native coverage cannot answer.
 *
 * Missing or failed ownership declines rather than publishing a partial answer. A rollup that silently lost its
 * endpoint breakdown would read as "no endpoints served traffic", which is a
 * different and wrong claim.
 */
export async function loadRpcUsageColdTier(
  env: HistoryReadEnv | null | undefined,
  {
    window = "7d",
    now = Date.now(),
    // Exclusive upper bound, epoch ms. src/rpc-usage-answer.ts sets it to the
    // OLDEST event the hot tier holds so the two stores describe strictly
    // disjoint ranges and their counts can be summed -- without it a merge
    // would double-count any overlap, and "counts are additive" would stop
    // being true the moment the two stores share a second. Undefined keeps
    // the whole window, which is what a lakehouse-only answer wants.
    until,
  }: {
    window?: string;
    now?: number;
    until?: number | null;
  } = {},
): Promise<Record<string, unknown> | null> {
  const windowLabel = Object.hasOwn(ANALYTICS_WINDOW_DAYS, window)
    ? window
    : "7d";
  const bounds = windowCutoffMs(windowLabel, now);
  if (!bounds) return null;
  const { cutoff, bucketMs, granularity } = bounds;
  // Preserve the public ceiling guard: an unusable bound is ignored while
  // the supported window cutoff still applies.
  const ceiling =
    typeof until === "number" && Number.isSafeInteger(until) && until > 0
      ? until
      : null;
  const native = await loadRpcUsageNative(env, {
    window: windowLabel,
    cutoff,
    bucketMs,
    granularity,
    until: ceiling,
    now,
  });
  return native ?? null;
}
