import { ApiError } from "@/lib/metagraphed/client";

// A current production observation took 26.79 seconds for a newly visible
// block to move into the decoded-detail window (#11758). Six deliberately
// spaced reads cover that normal handoff without turning a real coverage gap
// into an unbounded polling loop.
export const BLOCK_DETAIL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 7_000, 8_000, 10_000] as const;
export const BLOCK_DETAIL_RETRY_COUNT = BLOCK_DETAIL_RETRY_DELAYS_MS.length;

export function isBlockDetailUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "block_detail_unavailable";
}

export function shouldRetryBlockDetail(
  failureCount: number,
  error: unknown,
  client = typeof window !== "undefined",
): boolean {
  // Keep SSR to one upstream read. The browser owns this recovery because it
  // can preserve the rendered block while the index catches up.
  return client && isBlockDetailUnavailable(error) && failureCount < BLOCK_DETAIL_RETRY_COUNT;
}

export function blockDetailRetryDelay(attemptIndex: number): number {
  const index = Math.min(
    Math.max(0, Math.floor(attemptIndex)),
    BLOCK_DETAIL_RETRY_DELAYS_MS.length - 1,
  );
  return BLOCK_DETAIL_RETRY_DELAYS_MS[index]!;
}
