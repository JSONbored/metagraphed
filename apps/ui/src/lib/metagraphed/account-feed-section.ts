/** Render phase for optional account feed sections (extrinsics, transfers, …). */
export type AccountFeedSectionPhase = "skeleton" | "error" | "empty" | "content";

/**
 * Shared branching for non-blocking account feed sections.
 * Error wins over stale cached rows by default — matches AccountEventsSection (#3434).
 */
export function accountFeedSectionPhase({
  isPending,
  isError,
  rowCount,
  preferErrorWithRows = true,
}: {
  isPending?: boolean;
  isError?: boolean;
  rowCount: number;
  preferErrorWithRows?: boolean;
}): AccountFeedSectionPhase {
  if (isPending && rowCount === 0) return "skeleton";
  if (isError && (preferErrorWithRows || rowCount === 0)) return "error";
  if (rowCount === 0) return "empty";
  return "content";
}
