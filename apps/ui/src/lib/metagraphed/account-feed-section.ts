/** Render phase for optional account feed sections (extrinsics, transfers, …). */
export type AccountFeedSectionPhase = "skeleton" | "error" | "empty" | "content";

/**
 * Shared branching for non-blocking account feed sections.
 * Error wins over stale cached rows — matches AccountEventsSection (#3434).
 */
export function accountFeedSectionPhase({
  isPending,
  isError,
  rowCount,
}: {
  isPending?: boolean;
  isError?: boolean;
  rowCount: number;
}): AccountFeedSectionPhase {
  if (isPending && rowCount === 0) return "skeleton";
  if (isError) return "error";
  if (rowCount === 0) return "empty";
  return "content";
}
