import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * One analytical question, presented the way a data page presents one.
 *
 * The reference's entire page is nine of these and nothing else: a heading
 * that reads `Name. One sentence.`, a large visual, and a compact legend or
 * table under it — with 80px of air above and below, and a hairline between.
 *
 * The header is deliberately ONE line with two weights rather than a title
 * above a caption. A title/caption pair stacks two blocks and reads as
 * documentation; `Top Models. Usage of models across OpenCode.` reads as a
 * statement, and it is the single most recognisable thing about that page's
 * rhythm.
 *
 * The visual comes FIRST inside the section, before any table. A page whose
 * sections open with prose and hide their charts below the fold is a document
 * about data; one whose sections open with the chart is a data page.
 */
export function AnalyticsSection({
  id,
  name,
  question,
  actions,
  children,
  legend,
  footnote,
  className,
}: {
  /** Anchor target, so a section nav can scroll to it. */
  id?: string;
  /** The subject, set bold and terminated with a full stop. */
  name: ReactNode;
  /** What it tells you, in one plain sentence at the same size. */
  question?: ReactNode;
  /** Controls belonging to this question only — a window, a unit toggle. */
  actions?: ReactNode;
  /** The visual. Renders first, at full width. */
  children: ReactNode;
  /** A compact ranked list or table beneath the visual. */
  legend?: ReactNode;
  /** The window, source, or qualification, stated quietly last. */
  footnote?: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={classNames("mg-analytics-section", className)}
      aria-labelledby={id ? `${id}-heading` : undefined}
    >
      <header className="mg-analytics-section-header">
        <h2 id={id ? `${id}-heading` : undefined}>
          <strong>{name}</strong>
          {question ? <span> {question}</span> : null}
        </h2>
        {actions ? (
          <div className="mg-analytics-section-actions">{actions}</div>
        ) : null}
      </header>
      <div className="mg-analytics-section-visual">{children}</div>
      {legend ? (
        <div className="mg-analytics-section-legend">{legend}</div>
      ) : null}
      {footnote ? (
        <p className="mg-analytics-section-note">{footnote}</p>
      ) : null}
    </section>
  );
}
