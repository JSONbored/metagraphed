import { Star } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import { useWatchlist, type WatchlistKind } from "@/lib/metagraphed/watchlist";

/**
 * Masthead star toggle for an entity detail page (#8256).
 *
 * The index pages grew stars first, which left the odd gap that you could
 * star a subnet from the list but not from the subnet's own page — the one
 * place you're most likely to decide you care about it. Same store, same
 * icon, same cross-tab sync; this is only the detail-page presentation of it.
 *
 * Sized for the ActionBar rather than a dense row, so it clears 44px on touch
 * without needing the `mg-tap-target` slop the index-row stars use.
 */
export function WatchStarButton({
  kind,
  id,
  label,
  iconOnly,
}: {
  kind: WatchlistKind;
  /** The same id the index page stars by — netuid for subnets, hotkey/ss58 otherwise. */
  id: string | number;
  /** Entity noun for the accessible name, e.g. "SN64" or a validator name. */
  label: string;
  /**
   * Drop the "Watch"/"Watched" text and render just the star, matching
   * `ShareButton bare iconOnly` exactly (same padding, min-height, icon size,
   * and hover treatment) so the two sit in an ActionBar as one uniform pair
   * of icon segments instead of a labelled pill beside an icon. A star is a
   * universally-recognized affordance; the label still reaches assistive tech
   * via `aria-label`/`title`, and the watched state stays legible through the
   * filled/accent icon.
   */
  iconOnly?: boolean;
}) {
  const watchlist = useWatchlist(kind);
  const watched = watchlist.isWatched(id);

  return (
    <button
      type="button"
      onClick={() => watchlist.toggle(id)}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${label} from watchlist` : `Add ${label} to watchlist`}
      title={watched ? "Watched — click to unstar" : "Star to pin this to your homepage"}
      className={classNames(
        iconOnly
          ? "inline-flex items-center justify-center rounded p-1 min-h-8 transition-colors mg-focus-ring"
          : "inline-flex min-h-11 items-center gap-1.5 rounded px-2 py-1 mg-type-caption font-medium transition-colors mg-focus-ring",
        watched
          ? "text-accent-text hover:bg-surface"
          : "text-ink-muted hover:bg-surface hover:text-ink-strong",
      )}
    >
      <Star
        className={classNames(
          iconOnly ? "size-3" : "size-3.5",
          watched && "fill-accent text-accent",
        )}
        aria-hidden
      />
      {iconOnly ? null : watched ? "Watched" : "Watch"}
    </button>
  );
}
