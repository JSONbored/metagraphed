import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type MetaStripItem = {
  label: ReactNode;
  value: ReactNode;
  /** Optional tooltip on the paired label/value. */
  title?: string;
};

export type MetaStripProps = {
  items: readonly MetaStripItem[];
  /** Dot separator between items (default) or hairline pipes. */
  separator?: "dot" | "pipe";
  className?: string;
};

/**
 * Compact inline metadata strip: `label · value  ·  label · value …`
 * Used in row footers, breadcrumb subtitles, and card subheads. Extracts the
 * recurring `<span>label</span><span aria-hidden>·</span><span>value</span>`
 * pattern to keep separators, spacing, and tone consistent.
 */
export function MetaStrip({
  items,
  separator = "dot",
  className,
}: MetaStripProps) {
  const sep = separator === "pipe" ? "|" : "·";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted",
        className,
      )}
    >
      {items.map((it, i) => (
        <span
          key={i}
          title={it.title}
          className="inline-flex items-center gap-1.5"
        >
          {i > 0 ? (
            <span aria-hidden className="text-ink-subtle-text">
              {sep}
            </span>
          ) : null}
          <span className="mg-type-micro">{it.label}</span>
          <span className="text-ink-strong">{it.value}</span>
        </span>
      ))}
    </div>
  );
}
