import { RangeControl, type RangeOption } from "./document/range-control";

export type ViewMode = "table" | "grid" | "matrix";

const OPTIONS: Array<RangeOption<ViewMode>> = [
  {
    value: "table",
    label: "Table",
  },
  {
    value: "grid",
    label: "Grid",
  },
  {
    value: "matrix",
    label: "Matrix",
  },
];

/**
 * Segmented toggle for list routes that support multiple layouts.
 * The one segmented control, with the three layout names as labels.
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
    <RangeControl
      options={available}
      value={value}
      onChange={onChange}
      label="View mode"
      className={className}
    />
  );
}
