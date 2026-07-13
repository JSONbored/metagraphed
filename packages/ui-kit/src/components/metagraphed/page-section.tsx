import type { ReactNode } from "react";
import { Link } from "lucide-react";
import { classNames } from "@/lib/format";

interface Props {
  eyebrow?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot in the header — toolbar, link, etc. */
  actions?: ReactNode;
  /** Optional secondary row beneath the header (filters, search, tabs). */
  toolbar?: ReactNode;
  id?: string;
  className?: string;
  /** Hairline above the header. Defaults to `hairline`; use `none` for first section after hero. */
  divider?: "hairline" | "none";
  /** `muted` paints a faint bone wash behind the section. */
  tone?: "default" | "muted";
  children: ReactNode;
}

/**
 * Canonical page section. Every route uses this for consistent vertical rhythm
 * (Blockmachine-style hairline above an eyebrow + oversized H2, optional
 * description, right-aligned actions slot, and a toolbar row).
 */
export function PageSection({
  eyebrow,
  title,
  description,
  actions,
  toolbar,
  id,
  className,
  divider = "hairline",
  tone = "default",
  children,
}: Props) {
  const hasHeader = !!(eyebrow || title || actions);
  return (
    <section
      id={id}
      data-section-anchor={id ? "" : undefined}
      className={classNames(
        "mg-section",
        tone === "muted" &&
          "rounded-2xl bg-surface-2/40 px-5 md:px-8 py-8 md:py-10",
        className,
      )}
    >
      {hasHeader ? (
        <header
          className={classNames(
            "grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end",
            divider === "hairline" &&
              tone !== "muted" &&
              "mg-section-rule pt-8",
            "pb-6",
          )}
        >
          <div className="min-w-0">
            {eyebrow ? (
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted inline-flex items-center gap-2">
                {eyebrow}
              </div>
            ) : null}
            {title ? (
              <h2 className="group/anchor mt-2 flex items-baseline gap-2 font-display text-2xl md:text-[1.875rem] font-semibold tracking-[-0.02em] text-ink-strong">
                <span>{title}</span>
                {id ? (
                  <a
                    href={`#${id}`}
                    aria-label="Permalink"
                    className="mg-anchor-btn -mb-0.5 inline-flex size-5 items-center justify-center rounded text-ink-muted hover:text-accent"
                  >
                    <Link className="size-3.5" />
                  </a>
                ) : null}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-2 max-w-2xl text-sm text-ink-muted leading-relaxed">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              {actions}
            </div>
          ) : null}
        </header>
      ) : null}
      {toolbar ? (
        <div className="mb-6 -mt-2 flex flex-wrap items-center gap-2 border-b border-border pb-4">
          {toolbar}
        </div>
      ) : null}
      <div className={hasHeader || toolbar ? "" : ""}>{children}</div>
    </section>
  );
}
