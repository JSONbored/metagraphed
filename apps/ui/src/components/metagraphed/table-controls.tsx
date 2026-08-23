import { Link } from "@tanstack/react-router";
import type { HTMLAttributes } from "react";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { classNames } from "@/lib/metagraphed/format";

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
          "w-full rounded border border-border bg-paper pl-8 pr-16 py-1.5 text-13 text-ink-strong",
          "placeholder:text-ink-muted focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-ring transition-colors",
        )}
      />
      {shortcut ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 text-10 text-ink-muted"
        >
          /
        </kbd>
      ) : null}
    </div>
  );
}

// Re-export for parity / convenience
export { Link };
