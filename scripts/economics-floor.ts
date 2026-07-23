// Content floor for the live economics writer (refresh-economics.ts). The live KV
// tier ('economics:current') must never be overwritten with an empty / near-empty
// blob: a partial chain-fetch (0 rows, or far below the subnet count) or a missing
// captured_at must not clobber the last good value — the serve path keeps the last
// live value (or falls back to R2) instead. Pure + side-effect-free so the writer
// stays a thin script and the boundaries are unit-tested directly.

// Publish only when at least this fraction of subnets carry economics. At exactly
// the ratio the blob publishes (the check is strictly "below").
export const ECONOMICS_FLOOR_RATIO = 0.5;

interface PublishDecision {
  publish: boolean;
  reason: string;
}

// Decide whether an economics blob clears the content floor.
//   summary: { with_economics_count, captured_at }
//   expectedCount: subnet count the run was built from (0 ⇒ skip the ratio gate)
// Returns { publish: boolean, reason: string }.
export function shouldPublishEconomics(
  {
    with_economics_count,
    captured_at,
  }: { with_economics_count?: unknown; captured_at?: unknown } = {},
  expectedCount = 0,
): PublishDecision {
  if (!Number.isFinite(with_economics_count) || with_economics_count === 0) {
    return { publish: false, reason: "no-economics-rows" };
  }
  if (!captured_at) {
    return { publish: false, reason: "missing-captured-at" };
  }
  const count = with_economics_count as number;
  if (expectedCount > 0 && count < expectedCount * ECONOMICS_FLOOR_RATIO) {
    return {
      publish: false,
      reason: `below-floor (${count} of ~${expectedCount})`,
    };
  }
  return { publish: true, reason: "ok" };
}
