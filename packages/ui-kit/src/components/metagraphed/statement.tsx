import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * A finding, stated at reading size with its subject marked.
 *
 * Borrowed structure: one large sentence where the claim carries a highlight
 * and the qualifying clause goes muted. It says a thing and its caveat in one
 * breath, at a size a reader actually stops on — which a caption under a chart
 * never achieves and a paragraph of body copy buries.
 *
 * `lede` is the claim, `tail` the qualification. Both are required, because a
 * claim with no qualification on a data page is usually a claim that has not
 * been checked.
 */
export function Statement({
  index,
  eyebrow,
  lede,
  tail,
  className,
}: {
  /** A stable position marker, rendered `[01]`. */
  index?: number;
  /** The section's own name, tiny and uppercase beside the index. */
  eyebrow?: string;
  lede: ReactNode;
  tail?: ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("mg-statement", className)}>
      {index != null || eyebrow ? (
        <p className="mg-statement-eyebrow">
          {index != null ? (
            <span className="mg-statement-index">
              [{String(index).padStart(2, "0")}]
            </span>
          ) : null}
          {eyebrow ? <span>{eyebrow}</span> : null}
        </p>
      ) : null}
      <p className="mg-statement-body">
        <mark className="mg-statement-mark">{lede}</mark>
        {tail ? <span className="mg-statement-tail"> {tail}</span> : null}
      </p>
    </div>
  );
}
