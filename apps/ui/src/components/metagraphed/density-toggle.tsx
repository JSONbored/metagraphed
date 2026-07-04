import { Rows3, Rows2 } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

export type Density = "comfortable" | "compact";

/**
 * Segmented compact/comfortable density toggle for table views.
 * Density only affects spacing & widget sizes — never hides columns
 * or strips information. Tooltips remain the source of truth for context.
 */
export function DensityToggle({
  value,
  onChange,
  className,
}: {
  value: Density;
  onChange: (v: Density) => void;
  className?: string;
}) {
  const options: Array<{ value: Density; label: string; Icon: typeof Rows3 }> = [
    { value: "comfortable", label: "Comfortable", Icon: Rows3 },
    { value: "compact", label: "Compact", Icon: Rows2 },
  ];
  return (
    <div
      role="tablist"
      aria-label="Row density"
      className={classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {options.map(({ value: v, label, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`${label} row density`}
            title={`${label} rows`}
            onClick={() => onChange(v)}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
              active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
