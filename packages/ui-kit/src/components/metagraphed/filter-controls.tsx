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
        "flex flex-col gap-1 min-w-0",
        grow ? "flex-1 min-w-[180px]" : null,
        className,
      )}
    >
      <span className="text-10 text-ink-muted inline-flex items-center gap-1.5">
        {label}
        {hint ? <span className="opacity-70">{hint}</span> : null}
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
  "h-9 min-w-0 w-full rounded border border-border bg-card px-2.5",
  "text-13 text-ink-strong placeholder:text-ink-subtle-text",
  "mg-focus-ring hover:border-ink/25 transition-colors",
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
