import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Labeled toolbar control primitive. Every filter (search input, select,
 * segmented toggle) renders with a consistent mono micro-label, hairline
 * border, and 36px min-height so the sticky filter bar looks uniform on
 * every list route.
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
      <span className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted inline-flex items-center gap-1.5">
        {label}
        {hint ? <span className="opacity-70">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const CONTROL_CLASSES =
  "h-9 min-w-0 w-full rounded border border-border bg-card px-2.5 text-[12px] " +
  "text-ink-strong placeholder:text-ink-subtle-text mg-focus-ring " +
  "hover:border-ink/25 transition-colors";

export function FilterInput({
  className,
  leadingIcon = true,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { leadingIcon?: boolean }) {
  if (!leadingIcon) {
    return <input {...props} className={classNames(CONTROL_CLASSES, className)} />;
  }
  return (
    <span className="relative inline-flex w-full items-center">
      <Search
        className="pointer-events-none absolute left-2.5 size-3.5 text-ink-muted"
        aria-hidden
      />
      <input {...props} className={classNames(CONTROL_CLASSES, "pl-8", className)} />
    </span>
  );
}

export function FilterSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={classNames(CONTROL_CLASSES, "pr-6 appearance-none", className)}>
      {children}
    </select>
  );
}

/**
 * Layout wrapper composing FilterField children plus a trailing action slot
 * (density toggle, column customizer, freshness pill). Designed to render
 * inside ListShell's sticky filter row and stay usable at 375px width.
 */
export function FilterToolbar({
  children,
  trailing,
  className,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("flex w-full flex-wrap items-end gap-2 md:gap-3", className)}>
      <div className="flex flex-1 flex-wrap items-end gap-2 md:gap-3 min-w-0">{children}</div>
      {trailing ? (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">{trailing}</div>
      ) : null}
    </div>
  );
}
