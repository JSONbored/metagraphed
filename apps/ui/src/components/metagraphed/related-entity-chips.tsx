import { Link } from "@tanstack/react-router";
import { Chip } from "@/components/metagraphed/primitives";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { ReactNode } from "react";

/**
 * Compact related-entity chip row for explorer detail mastheads (#8373).
 * Every chip is a real link; only render chips for data the page already has.
 */
export function RelatedEntityChipRow({ children }: { children: ReactNode }) {
  if (children == null || children === false) return null;
  return (
    <nav
      aria-label="Related entities"
      className="mb-6 flex flex-wrap items-center gap-1.5 -mt-2 md:-mt-4"
    >
      {children}
    </nav>
  );
}

export const relatedEntityChipLinkClass =
  "rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Presentational chip body — wrap with a typed `<Link>` or hash `<a>`. */
export function RelatedEntityChip({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Chip label={label} title={title} className="hover:border-ink/30">
      {children}
    </Chip>
  );
}

/** Same-page hash chip (e.g. extrinsic count → #extrinsics). */
export function RelatedEntityChipHash({
  label,
  title,
  hash,
  children,
}: {
  label: string;
  title?: string;
  hash: string;
  children: ReactNode;
}) {
  return (
    <a href={`#${hash}`} className={relatedEntityChipLinkClass}>
      <RelatedEntityChip label={label} title={title}>
        {children}
      </RelatedEntityChip>
    </a>
  );
}

/** Masthead ← #N−1 · #N+1 → controls; next disabled at chain tip (#8373). */
export function BlockNeighborNav({
  prev,
  next,
  hash,
}: {
  prev: number | null;
  next: number | null;
  /** Preserve the current section hash when stepping blocks. */
  hash?: string;
}) {
  const hashProp = hash && hash.length > 0 ? hash.replace(/^#/, "") : undefined;
  return (
    <nav
      aria-label="Adjacent blocks"
      className="inline-flex items-center gap-1.5 mg-type-data-sm tabular-nums"
    >
      {prev != null ? (
        <Link
          to="/blocks/$ref"
          params={{ ref: String(prev) }}
          hash={hashProp}
          className="inline-flex items-center gap-0.5 rounded border border-border bg-card px-2 py-1 text-ink-strong hover:border-ink/30"
          title={`Previous block #${formatNumber(prev)}`}
        >
          <span aria-hidden>←</span>
          <span>#{formatNumber(prev)}</span>
        </Link>
      ) : (
        <span
          className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-surface-2 px-2 py-1 text-ink-muted"
          aria-disabled="true"
          title="Genesis — no previous block"
        >
          <span aria-hidden>←</span>
          <span>—</span>
        </span>
      )}
      <span className="text-ink-subtle" aria-hidden>
        ·
      </span>
      {next != null ? (
        <Link
          to="/blocks/$ref"
          params={{ ref: String(next) }}
          hash={hashProp}
          className="inline-flex items-center gap-0.5 rounded border border-border bg-card px-2 py-1 text-ink-strong hover:border-ink/30"
          title={`Next block #${formatNumber(next)}`}
        >
          <span>#{formatNumber(next)}</span>
          <span aria-hidden>→</span>
        </Link>
      ) : (
        <span
          className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-surface-2 px-2 py-1 text-ink-muted"
          aria-disabled="true"
          title="At chain tip"
        >
          <span>—</span>
          <span aria-hidden>→</span>
        </span>
      )}
    </nav>
  );
}

export function shortSs58Chip(ss58: string): string {
  return shortHash(ss58, 6) ?? ss58;
}
