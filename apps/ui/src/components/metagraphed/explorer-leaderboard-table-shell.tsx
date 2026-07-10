import type { ReactNode } from "react";
import {
  EXPLORER_LEADERBOARD_TABLE_CLASS,
  explorerLeaderboardScrollClass,
  type ExplorerLeaderboardId,
} from "./explorer-leaderboard-layout";

type ExplorerLeaderboardTableShellProps = {
  children: ReactNode;
  /** Stable hook for screenshot scripts and overflow regression tests. */
  leaderboardId: ExplorerLeaderboardId;
  /**
   * `always` — scroll shell at every viewport (fee payers, active accounts).
   * `desktop-only` — hidden below `md` when a mobile card fallback is shown.
   */
  visibility?: "always" | "desktop-only";
  tableClassName?: string;
};

/**
 * Horizontally scrollable wrapper for explorer leaderboard `<table>` blocks.
 * Mirrors `ListShell`'s inner `overflow-x-auto` treatment without pulling in
 * sort/pagination/mobile-card machinery these static boards do not use.
 */
export function ExplorerLeaderboardTableShell({
  children,
  leaderboardId,
  visibility = "always",
  tableClassName = EXPLORER_LEADERBOARD_TABLE_CLASS,
}: ExplorerLeaderboardTableShellProps) {
  const scrollClass = explorerLeaderboardScrollClass(visibility);

  return (
    <div className={scrollClass} data-explorer-leaderboard={leaderboardId}>
      <table className={tableClassName}>{children}</table>
    </div>
  );
}
