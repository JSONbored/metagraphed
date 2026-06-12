import { CurationChip } from "@/components/metagraphed/chips";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import type { CurationLevel } from "@/lib/metagraphed/types";

interface CoverageCardProps {
  curationLevel?: CurationLevel | string;
  coverageLevel?: string;
  reviewState?: string;
  reviewedAt?: string;
  confidence?: string;
  completeness?: number; // 0..1
  missingKinds?: string[];
  gapNotes?: string[];
}

/**
 * Right-rail card summarizing how well-curated this entity is. Mirrors
 * the cosmos-directory "this entry has X verified resources" panel.
 */
export function CoverageCard({
  curationLevel,
  coverageLevel,
  reviewState,
  reviewedAt,
  confidence,
  completeness,
  missingKinds,
  gapNotes,
}: CoverageCardProps) {
  const pct =
    typeof completeness === "number"
      ? Math.round(Math.max(0, Math.min(1, completeness)) * 100)
      : null;

  return (
    <section className="rounded border border-border bg-card p-3">
      <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-ink-strong mb-2">
        Coverage
      </h3>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {curationLevel ? <CurationChip level={curationLevel as CurationLevel} /> : null}
        {coverageLevel ? (
          <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            {coverageLevel}
          </span>
        ) : null}
        {reviewState ? (
          <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            {reviewState}
          </span>
        ) : null}
        {confidence ? (
          <span className="rounded border border-border bg-surface/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            conf · {confidence}
          </span>
        ) : null}
      </div>

      {pct != null ? (
        <div className="mb-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Completeness
            </span>
            <span className="font-display text-sm font-semibold text-ink-strong tabular-nums">
              {pct}%
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded bg-surface"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-ink-strong transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      {reviewedAt ? (
        <div className="mb-2 text-[11px] text-ink-muted">
          Last reviewed <TimeAgo at={reviewedAt} />
        </div>
      ) : null}

      {missingKinds && missingKinds.length > 0 ? (
        <div className="mb-2">
          <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted mb-1">
            Missing
          </div>
          <div className="flex flex-wrap gap-1">
            {missingKinds.map((k) => (
              <span
                key={k}
                className="rounded border border-dashed border-ink-subtle bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {gapNotes && gapNotes.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2 text-[11px] text-ink-muted">
          {gapNotes.map((n, i) => (
            <li key={i} className="leading-relaxed">
              · {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
