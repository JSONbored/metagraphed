import { Link } from "@tanstack/react-router";
import type { HTMLAttributes } from "react";
import { ArrowUp, ArrowDown, X, Filter, Search as SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Maps the live sort state of a column to the WAI-ARIA `aria-sort` value for
 * its `<th>`. Apply the result to the column-header cell (the element with the
 * implicit `columnheader` role) — `aria-sort` is only honored there, not on a
 * nested button. Columns that aren't the active sort report `"none"`.
 */
export function ariaSort(
  active?: boolean,
  order?: "asc" | "desc",
): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return order === "asc" ? "ascending" : "descending";
}

export function SortHeader({
  label,
  field,
  active,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  field: string;
  active?: boolean;
  order?: "asc" | "desc";
  onSort: (field: string) => void;
  align?: "left" | "right";
}) {
  const sortHint = active ? `, sorted ${order === "asc" ? "ascending" : "descending"}` : "";
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      aria-label={`Sort by ${label}${sortHint}`}
      className={classNames(
        "inline-flex items-center gap-1 mg-type-micro hover:text-ink-strong transition-colors",
        active ? "text-ink-strong" : "text-ink-muted",
        align === "right" && "justify-end w-full",
      )}
    >
      <span>{label}</span>
      {active ? (
        order === "asc" ? (
          <ArrowUp className="size-3" aria-hidden />
        ) : (
          <ArrowDown className="size-3" aria-hidden />
        )
      ) : null}
    </button>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  inputMode,
  className,
  shortcut,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  className?: string;
  /** Show a `/` keyboard shortcut hint and bind `/` to focus the input. */
  shortcut?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't hijack when the user is already typing somewhere.
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);
  return (
    <div className={classNames("relative flex-1 min-w-[200px]", className)}>
      <SearchIcon
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-ink-muted"
        aria-hidden
      />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Search…"}
        inputMode={inputMode}
        // Give the control an accessible name (a placeholder is not one for assistive tech); mirrors
        // the aria-labelled sibling controls (SortButton, PageSizeSelect) in this file.
        aria-label={placeholder ?? "Search"}
        className={classNames(
          "w-full rounded border border-border bg-paper pl-8 pr-14 py-1.5 text-sm text-ink-strong",
          "placeholder:text-ink-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-ring transition-colors",
        )}
      />
      {shortcut ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
        >
          /
        </kbd>
      ) : null}
    </div>
  );
}

export function SelectFilter({
  value,
  onChange,
  options,
  label,
  allowEmpty = true,
  fill = false,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  label: string;
  // When false, omit the empty "all" option — for always-selected controls like
  // a sort key where a blank value is not meaningful.
  allowEmpty?: boolean;
  // When true, the control stretches to fill its flex track (label stays fixed,
  // the select grows) so a row of filters can be justified edge-to-edge.
  fill?: boolean;
  // Extra classes on the wrapping <label> — e.g. a max-w-[...] cap for option
  // lists with a few long entries, so the closed control doesn't size itself
  // to its widest option (native <select> sizing behavior).
  className?: string;
}) {
  return (
    <label
      className={classNames(
        "items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-xs",
        fill ? "flex w-full min-w-0" : "inline-flex",
        className,
      )}
    >
      <span className="shrink-0 mg-type-micro text-ink-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Native <select> doesn't inherit the surrounding font by default — pin it
        // to font-mono so the value matches the label instead of falling back to
        // the sans body font, which reads as unstyled next to the mono label.
        className={classNames(
          "min-w-0 truncate bg-transparent font-mono text-ink-strong text-xs rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          fill ? "flex-1" : "",
        )}
      >
        {allowEmpty ? <option value="">all</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Pill-shaped filter chip matching the EndpointKindTabs / window-toggle idiom
 * used elsewhere for compact filters, rather than the generic bordered-box
 * label+select pattern (SelectFilter) — a native <select> still drives it for
 * a11y and mobile-native option picking, the Filter icon carries the label so
 * the chip stays narrow enough that it never pushes a section title onto
 * multiple lines.
 */
export function FilterChip({
  value,
  onChange,
  options,
  ariaLabel,
  label,
  placeholder = "All",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  /** Optional prefix label (e.g. "Health") shown inside the chip. */
  label?: string;
  placeholder?: string;
  className?: string;
}) {
  const active = value !== "";
  const activeOption = options.find((o) => o.value === value);
  return (
    <label
      className={classNames(
        "group relative inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors cursor-pointer",
        active
          ? "border-accent/50 bg-accent/8 text-ink-strong hover:border-accent/70"
          : "border-border bg-card text-ink-muted hover:border-ink/25 hover:text-ink-strong",
      )}
    >
      <Filter
        className={classNames("size-3 shrink-0", active ? "text-accent" : "text-ink-muted")}
        aria-hidden
      />
      {label ? <span className="mg-type-micro opacity-80 shrink-0">{label}</span> : null}
      <span
        className={classNames(
          "font-mono text-[11px] truncate max-w-[100px]",
          active ? "text-ink-strong" : "text-ink-muted",
        )}
      >
        {activeOption?.label ?? placeholder}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={classNames("absolute inset-0 opacity-0 cursor-pointer", className)}
        style={{ position: "absolute" }}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Page-size (limit) control. Changing the limit resets the cursor so the
 * next request starts a fresh page from the server.
 */
export function PageSizeSelect({
  value,
  onChange,
  options = [10, 25, 50, 100, 200],
}: {
  value: number;
  onChange: (n: number) => void;
  options?: number[];
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-xs">
      <span className="mg-type-micro text-ink-muted">per page</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Results per page"
        className="bg-transparent text-ink-strong text-xs rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-7"
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Reset-filters button. Hidden when nothing is set, so the bar stays quiet.
 * Calls `onReset` to let the route decide which keys to clear (typically
 * search, sort, filters, and cursor; preserves user's page-size choice).
 */
export function ResetFiltersButton({
  active,
  onReset,
  bare,
}: {
  active: boolean;
  onReset: () => void;
  /** Borderless variant for grouping inside an `ActionBar` segmented pill. */
  bare?: boolean;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      className={
        bare
          ? "inline-flex items-center gap-1 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
          : "inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] font-medium text-ink hover:border-ink/30 min-h-7"
      }
      title="Clear search, filters, and pagination"
    >
      <X className="size-3" /> Reset filters
    </button>
  );
}

// Re-export for parity / convenience
export { Link };
