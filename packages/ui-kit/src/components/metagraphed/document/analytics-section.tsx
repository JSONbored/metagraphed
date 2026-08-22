import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * One analytical question, presented the way a data page presents one
 * (#11607, retokened from the codex draft).
 *
 * The heading is ONE line with two weights -- `Name. One sentence.` -- not a
 * title above a caption: a title/caption pair stacks two blocks and reads as
 * documentation; `Top Models. Usage of models across OpenCode.` reads as a
 * statement, and it is the single most recognisable thing about that page's
 * rhythm. The visual comes FIRST, full width; a compact legend under it; the
 * window and source stated quietly last. No icon slot, no actions slot, no
 * deep-link button, no tone rail.
 */
export interface AnalyticsSectionProps {
  /** Anchor target; `SectionNav` scrolls to it. */
  id: string;
  /** The subject, set 600 and terminated with a full stop (a string gets the stop added). */
  name: ReactNode;
  /** What it tells you, in one plain sentence at the same size. */
  question?: ReactNode;
  /** The visual. Renders first, at full width. */
  visual?: ReactNode;
  /** A `RankGrid` or nothing. */
  legend?: ReactNode;
  /** `window · source`, one 11px muted line. */
  footnote?: ReactNode;
  /** One `RangeControl`, right of the heading. */
  controls?: ReactNode;
  /** Content that is not yet a `visual` (a route mid-migration). */
  children?: ReactNode;
  className?: string;
}

export function AnalyticsSection({
  id,
  name,
  question,
  visual,
  legend,
  footnote,
  controls,
  children,
  className,
}: AnalyticsSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      className={classNames("mg-section", className)}
      aria-labelledby={headingId}
      data-mg-section=""
    >
      <div className="mg-section-head">
        <h2 id={headingId} className="mg-section-h">
          <strong>
            {typeof name === "string" ? name.replace(/\.?$/, ".") : name}
          </strong>
          {question ? <> {question}</> : null}
        </h2>
        {controls ? (
          <div className="mg-section-controls">{controls}</div>
        ) : null}
      </div>
      {visual ? <div className="mg-section-visual">{visual}</div> : null}
      {children}
      {legend ? <div className="mg-section-legend">{legend}</div> : null}
      {footnote ? <p className="mg-section-note">{footnote}</p> : null}
    </section>
  );
}

/**
 * The heading row on its own, for content that is not (yet) inside an
 * `AnalyticsSection`. Same `Name. One sentence.` composition.
 */
export function SectionHead({
  id,
  name,
  question,
  controls,
  className,
}: Pick<
  AnalyticsSectionProps,
  "name" | "question" | "controls" | "className"
> & { id?: string }) {
  return (
    <div className={classNames("mg-section-head", className)}>
      <h2 id={id} className="mg-section-h">
        <strong>
          {typeof name === "string" ? name.replace(/\.?$/, ".") : name}
        </strong>
        {question ? <> {question}</> : null}
      </h2>
      {controls ? <div className="mg-section-controls">{controls}</div> : null}
    </div>
  );
}
