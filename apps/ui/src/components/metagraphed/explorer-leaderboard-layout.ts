/**
 * Layout tokens for explorer leaderboard tables (#3932).
 *
 * Three chain-direct leaderboards on `/explorer` render wide monospace account /
 * subnet columns beside several right-aligned numeric columns. Without a
 * dedicated horizontal scroll shell the table pins to the section width and
 * forces the page body to overflow on narrow viewports — the same treatment
 * `ListShell` applies to paginated list tables.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3932
 */

/** Horizontal scroll shell — table scrolls inside the card, not the page. */
export const EXPLORER_LEADERBOARD_SCROLL_CLASS = "overflow-x-auto";

/** Default table width inside the scroll shell. */
export const EXPLORER_LEADERBOARD_TABLE_CLASS = "w-full text-left text-sm";

/**
 * Stake-transfer leaderboard uses stacked mobile cards below `md`; the table
 * variant only renders from tablet up and still needs its own scroll shell.
 */
export const EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS = "hidden md:block overflow-x-auto";

/** data-attribute values for the three in-scope leaderboards (screenshot + e2e hooks). */
export const EXPLORER_LEADERBOARD_IDS = {
  feePayers: "fee-payers",
  activeAccounts: "active-accounts",
  stakeTransfers: "stake-transfers",
} as const;

export type ExplorerLeaderboardId =
  (typeof EXPLORER_LEADERBOARD_IDS)[keyof typeof EXPLORER_LEADERBOARD_IDS];

export type ExplorerLeaderboardVisibility = "always" | "desktop-only";

/** Resolve the scroll-shell class for a leaderboard table visibility mode. */
export function explorerLeaderboardScrollClass(
  visibility: ExplorerLeaderboardVisibility = "always",
): string {
  return visibility === "desktop-only"
    ? EXPLORER_LEADERBOARD_TABLE_DESKTOP_ONLY_CLASS
    : EXPLORER_LEADERBOARD_SCROLL_CLASS;
}
