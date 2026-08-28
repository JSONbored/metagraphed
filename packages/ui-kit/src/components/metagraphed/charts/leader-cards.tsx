import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Skeleton } from "../skeleton";
import { useEntityMark } from "../interaction/active-entity";
import { markAriaLabel } from "./chart-aria";

/**
 * The leaderboard (#11609): the first `featured` entries lead a three-column
 * ranked grid, followed by a denser supporting grid. Every entry keeps the
 * same rank, identity, and value geometry so a directory reads as evidence,
 * not as a set of miniature profile cards. On a phone the lead entries become
 * compact full-width rows: a partial carousel makes the first result look cut
 * off instead of making the comparison legible.
 */
export interface LeaderCardItem {
  key: string;
  name: string;
  /** Author / operator / domain under the name. */
  sub?: string;
  /** Formatted value, e.g. "254T". */
  value: string;
  /** Fractional change; `"new"` for a first appearance; omitted = no delta. */
  delta?: number | "new";
  href: string;
  avatar?: ReactNode;
  /** Initials for the avatar fallback. */
  initials?: string;
}

export interface LeaderCardsProps {
  items: readonly LeaderCardItem[];
  /** How many lead as featured cards. */
  featured?: number;
  ariaLabel: string;
  source?: string;
  className?: string;
  /** Preserve the featured and compact leaderboard geometry until its ranking answers. */
  loading?: boolean;
  /** Number of leaderboard rows to reserve while loading. */
  loadingItems?: number;
}

export function deltaLabel(delta: number | "new" | undefined): {
  text: string;
  state: "positive" | "negative" | "flat" | "new" | "none";
} {
  if (delta === undefined) return { text: "", state: "none" };
  if (delta === "new") return { text: "New", state: "new" };
  const pct = Math.round(delta * 100);
  if (pct === 0) return { text: "0%", state: "flat" };
  return pct > 0
    ? { text: `+${pct}%`, state: "positive" }
    : { text: `−${Math.abs(pct)}%`, state: "negative" };
}

export function LeaderCards({
  items,
  featured = 3,
  ariaLabel,
  source = "leader-cards",
  className,
  loading = false,
  loadingItems = featured,
}: LeaderCardsProps) {
  const placeholders = Math.max(featured, loadingItems);
  const leadCount = Math.min(featured, placeholders);
  const compactCount = Math.max(0, placeholders - leadCount);
  const lead = items.slice(0, featured);
  const rest = items.slice(featured);
  return (
    <div
      className={classNames("mg-leaders", className)}
      role="group"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      data-marks={loading ? undefined : ""}
      data-mg-leaders=""
    >
      {loading ? <span className="sr-only">Loading {ariaLabel}</span> : null}
      {loading ? (
        <ol className="mg-leaders-featured" start={1}>
          {Array.from({ length: leadCount }, (_, index) => (
            <LeaderSkeleton key={`featured-${index}`} variant="featured" />
          ))}
        </ol>
      ) : lead.length > 0 ? (
        <ol className="mg-leaders-featured" start={1}>
          {lead.map((item, i) => (
            <LeaderCard
              key={item.key}
              item={item}
              rank={i + 1}
              variant="featured"
              source={source}
            />
          ))}
        </ol>
      ) : null}
      {loading && compactCount > 0 ? (
        <ol className="mg-leaders-compact" start={leadCount + 1}>
          {Array.from({ length: compactCount }, (_, index) => (
            <LeaderSkeleton key={`compact-${index}`} variant="compact" />
          ))}
        </ol>
      ) : rest.length > 0 ? (
        <ol className="mg-leaders-compact" start={lead.length + 1}>
          {rest.map((item, i) => (
            <LeaderCard
              key={item.key}
              item={item}
              rank={lead.length + i + 1}
              variant="compact"
              source={source}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** The settled leaderboard's reading geometry, without invented ranks or values. */
function LeaderSkeleton({ variant }: { variant: "featured" | "compact" }) {
  return (
    <li aria-hidden="true">
      <div className="mg-leader" data-variant={variant}>
        <span className="mg-leader-rank">
          <Skeleton className="h-3 w-4" />
        </span>
        <span className="mg-leader-avatar">
          <Skeleton className="size-5" />
        </span>
        <span className="mg-leader-copy">
          <Skeleton className="h-3 w-24 max-w-full" />
          <Skeleton className="h-3 w-14 max-w-full" />
        </span>
        <span className="mg-leader-figures">
          <Skeleton className="h-3 w-12" />
        </span>
      </div>
    </li>
  );
}

function LeaderCard({
  item,
  rank,
  variant,
  source,
}: {
  item: LeaderCardItem;
  rank: number;
  variant: "featured" | "compact";
  source: string;
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(`#${rank} ${item.name}`, item.value),
  });
  const { role: _role, ...linkMark } = mark;
  void _role;
  const delta = deltaLabel(item.delta);
  const initials = item.initials ?? item.name.slice(0, 2).toUpperCase();
  return (
    <li>
      <a
        {...linkMark}
        href={item.href}
        className="mg-leader"
        data-variant={variant}
      >
        <span className="mg-leader-rank">{String(rank).padStart(2, "0")}</span>
        <span className="mg-leader-avatar" aria-hidden="true">
          {item.avatar ?? initials}
        </span>
        <span className="mg-leader-copy">
          <strong>{item.name}</strong>
          {item.sub ? <span>{item.sub}</span> : null}
        </span>
        <span className="mg-leader-figures">
          <span className="mg-leader-value">{item.value}</span>
          {delta.state !== "none" ? (
            <span className="mg-leader-delta" data-state={delta.state}>
              {delta.text}
            </span>
          ) : null}
        </span>
      </a>
    </li>
  );
}
