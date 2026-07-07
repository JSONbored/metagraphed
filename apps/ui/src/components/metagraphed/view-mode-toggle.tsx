import { LayoutGrid, List, Grid3x3 } from "lucide-react";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";

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
    <SegmentedToggle
      ariaLabel="View mode"
      value={value}
      onChange={onChange}
      className={className}
      options={available.map(({ value: v, label, Icon }) => ({
        value: v,
        label,
        Icon,
        ariaLabel: `Switch to ${label.toLowerCase()} view`,
        title: label,
      }))}
    />
  );
}
