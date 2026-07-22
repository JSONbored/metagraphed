import { List, LayoutGrid, Grid3x3, ScatterChart } from "lucide-react";
import type { ComponentType } from "react";
import type { ViewMode } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

/**
 * #6884: the /subnets view axis, extended with a fourth `bubble` option beyond
 * ui-kit's closed `ViewMode` (table | grid | matrix). ui-kit's `ViewModeToggle`
 * only renders those three, so this route-local segmented toggle mirrors that
 * primitive's markup + tokens exactly (`role="tablist"`/`tab`/`aria-selected`,
 * the same bone/ink surface classes) while adding the bubble segment — no ui-kit
 * change, so the whole feature stays inside apps/ui.
 */
export type SubnetView = ViewMode | "bubble";

interface Option {
  value: SubnetView;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  ariaLabel: string;
}

const OPTIONS: Option[] = [
  { value: "table", label: "Table", Icon: List, ariaLabel: "Switch to table view" },
  { value: "grid", label: "Grid", Icon: LayoutGrid, ariaLabel: "Switch to grid view" },
  { value: "matrix", label: "Matrix", Icon: Grid3x3, ariaLabel: "Switch to matrix view" },
  { value: "bubble", label: "Bubble", Icon: ScatterChart, ariaLabel: "Switch to bubble view" },
];

export function SubnetViewToggle({
  value,
  onChange,
  className,
}: {
  value: SubnetView;
  onChange: (v: SubnetView) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className={classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {OPTIONS.map(({ value: v, label, Icon, ariaLabel }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={ariaLabel}
            title={label}
            onClick={() => onChange(v)}
            className={classNames(
              "inline-flex min-h-8 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors",
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
