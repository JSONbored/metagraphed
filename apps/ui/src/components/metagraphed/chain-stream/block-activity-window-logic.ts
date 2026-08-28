import type { Block } from "@/lib/metagraphed/types";

/** A compact, discrete activity reading for one real block-result window. */
export type BlockActivityLevel = 0 | 1 | 2 | 3 | 4 | null;

export interface BlockActivityEntry {
  key: string;
  block: Block;
  /** Null means the indexed row did not publish an extrinsic count. */
  level: BlockActivityLevel;
}

/**
 * A higher head is an arrival; a repeated result or a reorg is not. The
 * visual windows use this to make their one update cue describe a real change
 * in the indexed feed rather than an ordinary refetch.
 */
export function arrivedBlock(
  previousHead: number | null | undefined,
  nextHead: number | null | undefined,
): number | null {
  if (
    typeof previousHead !== "number" ||
    typeof nextHead !== "number" ||
    !Number.isFinite(previousHead) ||
    !Number.isFinite(nextHead) ||
    nextHead <= previousHead
  ) {
    return null;
  }
  return nextHead;
}

function activityCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Converts a known count into a small visual ramp without manufacturing a
 * global threshold. The square-root scale keeps a nonzero low-activity block
 * visible beside a genuinely busy one; the exact values stay in text.
 */
export function blockActivityLevel(
  count: number | undefined,
  highestCount: number,
): BlockActivityLevel {
  const knownCount = activityCount(count);
  if (knownCount == null) return null;
  if (knownCount === 0 || highestCount <= 0 || !Number.isFinite(highestCount)) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt(knownCount / highestCount) * 4))) as Exclude<
    BlockActivityLevel,
    null
  >;
}

/**
 * Preserves the API result order (newest first) and keeps missing counts
 * visibly distinct from a true zero rather than treating both as quietness.
 */
export function blockActivityEntries(blocks: readonly Block[]): BlockActivityEntry[] {
  const highestCount = Math.max(
    0,
    ...blocks.flatMap((block) => activityCount(block.extrinsic_count) ?? []),
  );
  return blocks.map((block) => ({
    key: block.block_hash || String(block.block_number),
    block,
    level: blockActivityLevel(block.extrinsic_count, highestCount),
  }));
}
