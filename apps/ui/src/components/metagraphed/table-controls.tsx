import { Link } from "@tanstack/react-router";
import { ArrowUp, ArrowDown, X } from "lucide-react";
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
        "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest hover:text-ink-strong transition-colors",
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder ?? "Search…"}
      className="flex-1 min-w-[180px] rounded border border-border bg-paper px-2.5 py-1.5 text-sm placeholder:text-ink-muted focus:outline-none focus:border-ink/30"
    />
  );
}

export function SelectFilter({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  label: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-xs">
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-ink-strong text-xs focus:outline-none"
      >
        <option value="">all</option>
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
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        per page
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Results per page"
        className="bg-transparent text-ink-strong text-xs focus:outline-none min-h-7"
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
export function ResetFiltersButton({ active, onReset }: { active: boolean; onReset: () => void }) {
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[11px] font-medium text-ink hover:border-ink/30 min-h-7"
      title="Clear search, filters, and pagination"
    >
      <X className="size-3" /> Reset filters
    </button>
  );
}

// Re-export for parity / convenience
export { Link };
