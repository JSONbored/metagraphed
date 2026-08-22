import { useCallback, useId } from "react";
import { classNames } from "@/lib/format";
import { rovingTabIndex, useRovingGroup } from "@/hooks/use-roving-group";

/**
 * The one segmented control (#11607): `7d 30d 90d`, `1h 24h 7d`, `TAO α USD`.
 * A 28px `--layer` track with 4px radius; the active option is `--raised` +
 * ink. `role="radiogroup"` with arrow-key movement and one Tab stop.
 */
export interface RangeOption<V extends string = string> {
  value: V;
  label: string;
}

export interface RangeControlProps<V extends string = string> {
  options: readonly RangeOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group, e.g. "Window". */
  label: string;
  className?: string;
}

export function RangeControl<V extends string = string>({
  options,
  value,
  onChange,
  label,
  className,
}: RangeControlProps<V>) {
  const id = useId();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const select = useCallback(
    (index: number) => {
      const next = options[index];
      if (next && next.value !== value) onChange(next.value);
    },
    [options, value, onChange],
  );
  const { itemRef, onKeyDown } = useRovingGroup(options.length, select);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      id={id}
      className={classNames("mg-range", className)}
      data-mg-range=""
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={itemRef(i)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={rovingTabIndex(i, activeIndex)}
          onClick={() => select(i)}
          onKeyDown={onKeyDown(i)}
          className="mg-range-option"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
