import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/format";
import { InfoTooltip } from "@/components/metagraphed/info-tooltip";
import { Panel } from "@/components/metagraphed/panel";

interface Props {
  icon?: LucideIcon;
  eyebrow: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
  tone?: "default" | "accent" | "ok" | "warn" | "down";
  className?: string;
  /**
   * When false, the hint wraps freely on its own line instead of being
   * clipped to one — for a hint too long to reliably fit at every
   * breakpoint (e.g. "Validators / miners" in a 2-column mobile grid).
   * Defaults to true, unchanged for every other consumer.
   *
   * NOTE this no longer governs the eyebrow: the label is the tile's
   * identity and is never ellipsized in either mode (see below).
   */
  truncate?: boolean;
  /**
   * Optional hover/focus explainer shown as an info icon next to the eyebrow —
   * what the statistic means and what a healthy value looks like. Matches the
   * HeroStatCell tooltip pattern.
   */
  tooltip?: string;
}

/**
 * Compact KPI tile. Flat hairline, generous baseline. Used in tighter
 * stat strips where the hero KPI grid would feel oversized.
 */
export function StatTile({
  icon: Icon,
  eyebrow,
  value,
  hint,
  chart,
  tone = "default",
  className,
  truncate = true,
  tooltip,
}: Props) {
  return (
    <Panel
      as="div"
      dense
      tintBorderOnly
      tone={tone}
      className={className}
      // `flex-wrap` + a text-column floor: a `chart` (e.g. the APY window
      // SegmentedToggle) is shrink-0, so in a 2-column 375px grid it took the
      // whole row and squeezed the label/value column to *2px* — the eyebrow
      // rendered as a vertical sliver of punctuation. Wrapping drops the chart
      // onto its own line instead, and gap-x-3 buys back a few more pixels of
      // an already tight column.
      bodyClassName="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      {Icon ? (
        <Icon
          aria-hidden
          className={classNames(
            "size-4 shrink-0",
            tone === "accent"
              ? "text-accent"
              : tone === "ok"
                ? "text-health-ok"
                : tone === "warn"
                  ? "text-health-warn"
                  : tone === "down"
                    ? "text-health-down"
                    : "text-ink-muted",
          )}
        />
      ) : null}
      {/* min-w-[6rem] is the floor that makes the wrap above actually fire:
          without it flex would keep shrinking this column to fit the chart
          beside it rather than pushing the chart to the next line. */}
      <div className="min-w-[6rem] flex-1">
        <div className="flex items-center gap-1 mg-type-caption text-ink-muted">
          {/* The eyebrow names the statistic -- clipping it mid-word is the
              one thing a KPI tile can't afford ("Take rate" became "Take
              rat…", "Avg validator trust" became "Avg vali…" in a 2-column
              375px grid). Wrapping to a second line costs a few pixels of
              height and keeps the label readable, so it replaces the old
              `truncate`/`leading-tight` split in BOTH modes; a label that
              already fit on one line renders identically. Bounded at 3 lines
              so a pathological label still can't grow the tile without limit
              — 3 rather than 2 because the tightest real case ("Avg validator
              trust" in a 66px column) genuinely needs three. */}
          <span className="line-clamp-3 leading-tight">{eyebrow}</span>
          {tooltip ? (
            <InfoTooltip label={tooltip} className="shrink-0" />
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
          {/* #3940: shrink-0 so the hint (already truncate-clipped) absorbs constrained width instead of the value wrapping. */}
          <span className="shrink-0 font-display text-base font-semibold tabular-nums leading-none text-ink-strong sm:text-xl md:text-2xl">
            {value}
          </span>
          {hint && truncate ? (
            <span className="min-w-0 truncate mg-type-data-sm text-ink-muted">
              {hint}
            </span>
          ) : null}
        </div>
        {/* Non-truncating hints get their own full-width line rather than
            staying a wrapping flex sibling of the value. As a sibling, the
            hint kept whatever space the (shrink-0) value left over -- often
            only its longest word -- and then wrapped ONE WORD PER LINE
            ("30d / history / · / net / of / take"), which is what made these
            tiles run ~2x taller than their truncating neighbours in the same
            grid. On its own line it wraps normally. */}
        {hint && !truncate ? (
          <div className="mt-0.5 mg-type-data-sm leading-tight text-ink-muted">
            {hint}
          </div>
        ) : null}
      </div>
      {chart ? <div className="shrink-0 opacity-80">{chart}</div> : null}
    </Panel>
  );
}
