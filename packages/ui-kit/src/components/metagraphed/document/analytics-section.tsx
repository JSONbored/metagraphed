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
  /**
   * What to say when there is nothing to draw.
   *
   * A section whose `visual` resolves to `null` still renders its heading and
   * its footnote, so the reader gets a sentence promising an answer and then
   * blank space before the next rule. #11686 measured it against an API
   * serving empty collections: `/chain` left two of six sections that way,
   * `/health` three, `/subnets` three -- every route had at least one.
   *
   * Defaults to a quiet line rather than nothing, because the honest answer to
   * "what is the chain's throughput" over a window with no extrinsics is "no
   * data in this window", not silence. Pass a string to say it better, or
   * `false` for the rare section whose footnote already says it.
   */
  empty?: ReactNode;
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
  empty,
  className,
}: AnalyticsSectionProps) {
  const headingId = `${id}-heading`;
  // `null` and `false` are what a page passes for "no data"; `0` and `""` are
  // not, so this checks for the two rather than for falsiness.
  const blank = (node: ReactNode) =>
    node === null || node === undefined || node === false;
  const showEmpty =
    blank(visual) && blank(children) && blank(legend) && empty !== false;
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
      {showEmpty ? (
        <p className="mg-section-empty">{empty ?? "No data in this window."}</p>
      ) : null}
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
