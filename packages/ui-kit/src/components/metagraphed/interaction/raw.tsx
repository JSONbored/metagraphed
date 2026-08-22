import type { ReactNode } from "react";
import { CopyButton } from "../copy-button";

/**
 * The raw-details disclosure (#11606): a `<details>` row that is the ONLY
 * place API URLs, curl snippets, embed badges, hashes and coldkeys may live
 * outside a hero sentence or a table cell. Mount it as the last section of a
 * page. Rows are full, copyable, mono identifiers; `children` takes code
 * blocks (`<RawCode>`) or anything else that belongs behind the fold.
 */
export interface RawRow {
  label: string;
  /** The full value. Rendered in full (wrapping), never truncated. */
  value: string;
  /** Optional link for the value (an endpoint, a source URL). */
  href?: string;
  /** Accessible label for the copy button; defaults to `label`. */
  copyLabel?: string;
}

export interface RawProps {
  title?: string;
  rows?: readonly RawRow[];
  children?: ReactNode;
  /** Start open (specimens, tests). */
  defaultOpen?: boolean;
  className?: string;
  id?: string;
}

export function Raw({
  title = "Raw identifiers & sources",
  rows = [],
  children,
  defaultOpen,
  className,
  id,
}: RawProps) {
  return (
    <details
      id={id}
      className={["mg-raw", className].filter(Boolean).join(" ")}
      open={defaultOpen}
      data-mg-raw=""
    >
      <summary>
        {title}
        <span className="mg-raw-chip" aria-hidden>
          RAW
        </span>
      </summary>
      <div className="mg-raw-body">
        {rows.length > 0 ? (
          <dl>
            {rows.map((row) => (
              <div key={row.label} className="mg-raw-row">
                <dt>{row.label}</dt>
                <dd>
                  {row.href ? (
                    <a href={row.href} className="text-accent hover:underline">
                      <code title={row.value}>{row.value}</code>
                    </a>
                  ) : (
                    <code title={row.value}>{row.value}</code>
                  )}
                </dd>
                <CopyButton
                  value={row.value}
                  label={row.copyLabel ?? row.label}
                  compact
                  className="mg-raw-copy"
                />
              </div>
            ))}
          </dl>
        ) : null}
        {children}
      </div>
    </details>
  );
}

/** A code block inside `Raw` -- curl, an embed snippet, a JSON-LD payload. */
export function RawCode({
  children,
  label,
}: {
  children: string;
  label?: string;
}) {
  return (
    <div className="relative">
      <pre className="mg-raw-code" aria-label={label}>
        <code>{children}</code>
      </pre>
      <CopyButton
        value={children}
        label={label ?? "snippet"}
        className="absolute top-1 right-1"
      />
    </div>
  );
}
