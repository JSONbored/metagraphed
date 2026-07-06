import { classNames } from "@/lib/metagraphed/format";

export interface BarMiniDatum {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  data: BarMiniDatum[];
  max?: number;
  className?: string;
  /** Show numeric value to the right of each bar. */
  showValue?: boolean;
  /** Accessible name; synthesized from `data` when omitted. */
  ariaLabel?: string;
}

function synthesizeBarMiniAriaLabel(data: BarMiniDatum[]): string {
  if (data.length === 0) return "Bar chart with no data";
  return data.map((d) => `${d.label} ${d.value}`).join(", ");
}

/**
 * Tiny horizontal bar chart, no dependencies. Each row is a label +
 * proportional bar + optional value. Used for distribution rows
 * (gaps by severity, surfaces by kind, etc.).
 */
export function BarMini({ data, max, className, showValue = true, ariaLabel }: Props) {
  const cap = max ?? Math.max(1, ...data.map((d) => d.value));
  const label = ariaLabel ?? synthesizeBarMiniAriaLabel(data);
  return (
    <ul role="img" aria-label={label} className={classNames("space-y-1.5", className)}>
      {data.map((d) => {
        const pct = cap > 0 ? Math.max(2, Math.round((d.value / cap) * 100)) : 0;
        return (
          <li key={d.label} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted truncate">
              {d.label}
            </span>
            <span className="relative h-1.5 rounded-full bg-surface overflow-hidden">
              <span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ width: `${pct}%`, background: d.color ?? "var(--accent)" }}
              />
            </span>
            {showValue ? (
              <span className="font-mono text-[10px] tabular-nums text-ink-strong">{d.value}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
