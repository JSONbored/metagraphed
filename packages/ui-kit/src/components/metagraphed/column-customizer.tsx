import { useState } from "react";
import { Columns3, RotateCcw } from "lucide-react";
import { classNames } from "@/lib/format";
import type { ColumnDef } from "./use-column-visibility";

export interface ColumnCustomizerProps {
  columns: ColumnDef[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string) => void;
  onReset: () => void;
  className?: string;
}

/**
 * Popover checklist that toggles visible columns on a table. Kept as a
 * lightweight uncontrolled disclosure so it doesn't drag in a popover
 * library — the sheet is anchored inside a positioned wrapper and closes
 * via the outside-click on the backdrop.
 */
export function ColumnCustomizer({
  columns,
  isVisible,
  onToggle,
  onReset,
  className,
}: ColumnCustomizerProps) {
  const [open, setOpen] = useState(false);
  const visibleCount = columns.filter((c) => isVisible(c.id)).length;
  return (
    <div className={classNames("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Customize visible columns"
        className="mg-focus-ring inline-flex items-center gap-1.5 h-9 rounded border border-border bg-card px-2.5 mg-type-micro text-ink-muted hover:text-ink-strong hover:border-ink/25 transition-colors"
      >
        <Columns3 className="size-3" aria-hidden />
        <span className="hidden sm:inline">Columns</span>
        <span className="text-ink-strong tabular-nums normal-case tracking-normal">
          {visibleCount}/{columns.length}
        </span>
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close column menu"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-40 mt-1.5 w-64 rounded border border-border bg-card p-1 mg-card-glow"
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="mg-type-micro text-ink-muted">Columns</span>
              <button
                type="button"
                onClick={onReset}
                className="mg-focus-ring inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted hover:text-ink-strong"
                title="Reset to defaults"
              >
                <RotateCcw className="size-3" aria-hidden /> Reset
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto py-0.5">
              {columns.map((c) => {
                const checked = isVisible(c.id);
                return (
                  <label
                    key={c.id}
                    className={classNames(
                      "flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-ink hover:bg-surface-2 cursor-pointer",
                      c.required ? "opacity-60 cursor-not-allowed" : null,
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={c.required}
                      onChange={() => onToggle(c.id)}
                      className="accent-accent size-3.5"
                    />
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.required ? (
                      <span className="mg-type-micro text-ink-subtle-text">
                        Locked
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
