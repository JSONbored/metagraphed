import { Rows3, Rows2 } from "lucide-react";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";

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
    <SegmentedToggle
      ariaLabel="Row density"
      value={value}
      onChange={onChange}
      className={className}
      options={options.map(({ value: v, label, Icon }) => ({
        value: v,
        label,
        Icon,
        ariaLabel: `${label} row density`,
        title: `${label} rows`,
      }))}
    />
  );
}
