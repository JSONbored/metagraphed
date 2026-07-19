import { LayoutGrid, List, Grid3x3, ScatterChart } from "lucide-react";
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/segmented-toggle";

export type ViewMode = "table" | "grid" | "matrix" | "bubble";

const OPTIONS: Array<SegmentedToggleOption<ViewMode>> = [
  {
    value: "table",
    label: "Table",
    Icon: List,
    ariaLabel: "Switch to table view",
  },
  {
    value: "grid",
    label: "Grid",
    Icon: LayoutGrid,
    ariaLabel: "Switch to grid view",
  },
  {
    value: "matrix",
    label: "Matrix",
    Icon: Grid3x3,
    ariaLabel: "Switch to matrix view",
  },
  {
    value: "bubble",
    label: "Bubble",
    Icon: ScatterChart,
    ariaLabel: "Switch to bubble view",
  },
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
      options={available}
      value={value}
      onChange={onChange}
      ariaLabel="View mode"
      className={className}
    />
  );
}
