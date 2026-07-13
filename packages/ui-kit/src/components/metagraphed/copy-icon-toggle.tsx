import { Check, Copy } from "lucide-react";
import { classNames } from "@/lib/format";

const SIZE_CLASS = {
  3: "size-3",
  3.5: "size-3.5",
} as const;

interface Props {
  /** Whether the value was just copied — shows the check glyph while true. */
  copied: boolean;
  /** Icon size in Tailwind `size-*` units. */
  size?: keyof typeof SIZE_CLASS;
  /** Applied to the idle-state copy glyph only (e.g. hover-color overrides). */
  className?: string;
}

/**
 * Shared copy/check icon swap for copy-to-clipboard affordances. Cross-fades
 * from the copy glyph to a green check for however long the caller's
 * `useCopy` holds `copied` true, then back.
 */
export function CopyIconToggle({ copied, size = 3, className }: Props) {
  const sizeClass = SIZE_CLASS[size];
  return (
    <span
      className={classNames(
        "relative inline-flex shrink-0 items-center justify-center",
        sizeClass,
      )}
      aria-hidden
    >
      <Check
        className={classNames(
          "absolute text-health-ok transition-all duration-150",
          sizeClass,
          copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
        )}
      />
      <Copy
        className={classNames(
          "absolute transition-all duration-150",
          sizeClass,
          copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
          className,
        )}
      />
    </span>
  );
}
