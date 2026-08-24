import type {
  ReactNode,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";
import { Search } from "lucide-react";
import { classNames } from "@/lib/format";

/**
 * The form controls a filter row is built from: a labelled field, an input
 * and a select, on the shared control height. The `FilterToolbar` that used
 * to arrange them is gone -- `DataTable` owns its own filter row (#11610),
 * and a non-table list arranges these three itself.
 *
 * QUIET BY DEFAULT (#11695). Three of these side by side, each a bordered box
 * with a 10px caption floating above it, put more chrome above a table than
 * the table itself has -- and every one of them sat inside the card, over rows
 * that have no boxes at all. The field name is now for assistive tech only
 * (every filter's resting option already names its own axis: "Any stake",
 * "Any author", "Any domain"), and the control draws its border when a reader
 * hovers or focuses it, not before.
 */
export function FilterField({
  label,
  htmlFor,
  hint,
  children,
  className,
  grow,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Let this field grow to fill remaining space (search inputs). */
  grow?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={classNames(
        "flex min-w-0 flex-col",
        grow ? "flex-1 min-w-[180px]" : null,
        className,
      )}
    >
      <span className="sr-only">
        {label}
        {hint ? <span>{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

// Written as an array rather than concatenated string literals: the previous
// form joined three lines with no trailing spaces, so it emitted
// `text-13text-ink-strong` and `mg-focus-ringhover:border-ink/25` -- four
// class names that never existed. Every filter input and select on the site
// therefore rendered with no size token, no ink colour, no hover and,
// worst, NO VISIBLE FOCUS RING. Prettier keeps reformatting the line breaks
// of a concatenation; it cannot reformat an array's elements together.
const CONTROL_CLASSES = [
  "h-8 min-w-0 w-full rounded border border-transparent bg-transparent px-2.5",
  "text-13 text-ink-strong placeholder:text-ink-subtle-text",
  "mg-focus-ring transition-colors",
  "hover:border-border hover:bg-card focus-visible:border-border",
  "focus-visible:bg-card",
].join(" ");

export function FilterInput({
  className,
  leadingIcon = true,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { leadingIcon?: boolean }) {
  if (!leadingIcon) {
    return (
      <input {...props} className={classNames(CONTROL_CLASSES, className)} />
    );
  }
  return (
    <span className="relative inline-flex w-full items-center">
      <Search
        className="pointer-events-none absolute left-2.5 size-3.5 text-ink-muted"
        aria-hidden
      />
      <input
        {...props}
        className={classNames(CONTROL_CLASSES, "pl-8", className)}
      />
    </span>
  );
}

export function FilterSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={classNames(CONTROL_CLASSES, "pr-6 appearance-none", className)}
    >
      {children}
    </select>
  );
}

/**
 * Layout wrapper composing FilterField children plus a trailing action slot
 * (density toggle, column customizer, freshness pill). Designed to render
 * inside a filter row and stay usable at 375px width.
 */
