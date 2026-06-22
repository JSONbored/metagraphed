import { LayoutGrid, List, Grid3x3 } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

export type ViewMode = "table" | "grid" | "matrix";

const OPTIONS: Array<{ value: ViewMode; label: string; Icon: typeof List }> = [
  { value: "table", label: "Table", Icon: List },
  { value: "grid", label: "Grid", Icon: LayoutGrid },
  { value: "matrix", label: "Matrix", Icon: Grid3x3 },
];

/**
 * Segmented toggle for list routes that support multiple layouts.
 * Compact, icon-first; falls back to icon-only on narrow viewports.
 */
export function ViewModeToggle({
  value,
  onChange,
  options = ["table", "grid", "matrix"],
  className,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  options?: ViewMode[];
  className?: string;
}) {
  const available = OPTIONS.filter((o) => options.includes(o.value));
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className={classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {available.map(({ value: v, label, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`Switch to ${label.toLowerCase()} view`}
            title={label}
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
