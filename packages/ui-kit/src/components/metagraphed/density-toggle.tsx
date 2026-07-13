import { Rows3, Rows2 } from "lucide-react";
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/segmented-toggle";

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
  const options: Array<SegmentedToggleOption<Density>> = [
    {
      value: "comfortable",
      label: "Comfortable",
      Icon: Rows3,
      ariaLabel: "Comfortable row density",
      title: "Comfortable rows",
    },
    {
      value: "compact",
      label: "Compact",
      Icon: Rows2,
      ariaLabel: "Compact row density",
      title: "Compact rows",
    },
  ];
  return (
    <SegmentedToggle
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel="Row density"
      className={className}
    />
  );
}
