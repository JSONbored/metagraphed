// #6643: subnet "age since registration" derived client-side from the
// already-fetched block fields, with no new backend work.
//
// The subnet index/detail response carries `registered_at_block` (the block a
// subnet was registered at) and `block` (the snapshot's current chain height),
// but no registration *timestamp*. Finney produces a block roughly every 12s,
// so the age in whole days is (currentBlock - registeredAtBlock) * 12 / 86400.
// This is an estimate — block time drifts slightly — which is why the label
// reads "~N days old" rather than a precise date.

/** Nominal Finney block time in seconds (~12s/block). */
export const FINNEY_BLOCK_SECONDS = 12;

const SECONDS_PER_DAY = 86_400;

/**
 * Whole days since a subnet was registered, from its registration block and the
 * snapshot's current block height. Returns null when either input is missing /
 * non-finite, or when the registration block is ahead of the current block
 * (a stale or inconsistent snapshot), so callers can hide the field rather than
 * render a nonsensical negative age.
 */
export function subnetAgeDays(
  registeredAtBlock: number | null | undefined,
  currentBlock: number | null | undefined,
  blockSeconds: number = FINNEY_BLOCK_SECONDS,
): number | null {
  if (
    typeof registeredAtBlock !== "number" ||
    typeof currentBlock !== "number" ||
    !Number.isFinite(registeredAtBlock) ||
    !Number.isFinite(currentBlock)
  ) {
    return null;
  }
  const elapsedBlocks = currentBlock - registeredAtBlock;
  if (elapsedBlocks < 0) return null;
  return Math.floor((elapsedBlocks * blockSeconds) / SECONDS_PER_DAY);
}

/**
 * Human label for a whole-day age, e.g. "~1 day old" / "~42 days old". Days
 * below 1 read "less than a day old". Returns null for a null age so callers
 * can omit the field entirely.
 */
export function formatSubnetAge(days: number | null): string | null {
  if (days == null || !Number.isFinite(days) || days < 0) return null;
  if (days < 1) return "less than a day old";
  if (days === 1) return "~1 day old";
  return `~${days.toLocaleString()} days old`;
}
