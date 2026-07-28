import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * Canonical section header — the uppercase display label that opens a page
 * section, with an optional one-line prose intro and an optional right-aligned
 * slot (meta, window toggles). Use this instead of hand-writing the <h2> classes
 * so every section reads identically across the app. Spacing below the heading
 * is owned here; sections sit on the `space-y-section` rhythm token.
 *
 * `step` turns a run of sections into a numbered sequence (01, 02, …) for
 * pages that are a procedure rather than a directory — the reader is meant to
 * work top to bottom, and the rail says so. Use it on every section of such a
 * page or none of them; a lone number reads as an orphan.
 */
export function SectionHeading({
  title,
  step,
  intro,
  right,
  className,
  id,
}: {
  title: string;
  /** 1-based position in a numbered page sequence; rendered zero-padded. */
  step?: number;
  intro?: ReactNode;
  right?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      className={classNames(
        "mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div className="max-w-2xl">
        <h2
          id={id}
          className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong"
        >
          {step != null ? (
            <span className="mr-2 tabular-nums text-accent-text">
              {String(step).padStart(2, "0")}
            </span>
          ) : null}
          {title}
        </h2>
        {intro ? (
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            {intro}
          </p>
        ) : null}
      </div>
      {right ? (
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      ) : null}
    </div>
  );
}
