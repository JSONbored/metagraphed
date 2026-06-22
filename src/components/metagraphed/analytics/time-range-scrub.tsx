import { classNames } from "@/lib/metagraphed/format";
import { useTimeRange, type TimeRange } from "./time-range-context";

const OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/**
 * Range chip strip. When `value` / `onChange` are omitted, reads/writes the
 * nearest `TimeRangeProvider` automatically — the recommended wiring.
 */
export function TimeRangeScrub({
  value,
  onChange,
  className,
}: {
  value?: TimeRange;
  onChange?: (v: TimeRange) => void;
  className?: string;
}) {
  const ctx = useTimeRange();
  const active = value ?? ctx.range;
  const set = onChange ?? ctx.setRange;
  return (
    <div
      className={classNames(
        "inline-flex items-center rounded border border-border bg-card/60 p-0.5",
        className,
      )}
      role="radiogroup"
      aria-label="Time range"
    >
      {OPTIONS.map((o) => {
        const on = o.value === active;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => set(o.value)}
            className={classNames(
              "px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] rounded-sm transition-colors",
              on ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export type { TimeRange };
