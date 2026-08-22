import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { useEntityMark } from "../interaction/active-entity";
import { markAriaLabel } from "./chart-aria";

/**
 * The leaderboard (#11609): the first `featured` entries as 154px cards in a
 * 3-column grid, the rest as 88px one-row cards in a 4-column grid. Every
 * card is a link and an entity mark. On mobile the featured row scrolls
 * sideways and the compact grid becomes a list.
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
  /** Initials for the watermark and the avatar fallback. */
  initials?: string;
}

export interface LeaderCardsProps {
  items: readonly LeaderCardItem[];
  /** How many lead as featured cards. */
  featured?: number;
  ariaLabel: string;
  source?: string;
  className?: string;
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
}: LeaderCardsProps) {
  const lead = items.slice(0, featured);
  const rest = items.slice(featured);
  return (
    <div
      className={classNames("mg-leaders", className)}
      role="group"
      aria-label={ariaLabel}
      data-marks
      data-mg-leaders=""
    >
      {lead.length > 0 ? (
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
      {rest.length > 0 ? (
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
        {variant === "featured" ? (
          <span className="mg-leader-watermark" aria-hidden="true">
            {initials}
          </span>
        ) : null}
      </a>
    </li>
  );
}
