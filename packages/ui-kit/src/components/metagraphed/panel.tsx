import type { ReactNode, ComponentPropsWithoutRef } from "react";
import { classNames } from "@/lib/format";

interface PanelOwnProps {
  /** Heading text (13px, 600). */
  title?: ReactNode;
  /** Controls right of the heading. */
  action?: ReactNode;
  /** One line under the heading. */
  caption?: ReactNode;
  /** Body without padding (tables, lists that pad their own rows). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export type PanelProps = PanelOwnProps &
  Omit<ComponentPropsWithoutRef<"section">, keyof PanelOwnProps>;

/**
 * A plain `min-width: 0` block with an optional heading row (#11607). No
 * border, no background, no tone, no hover lift -- the hairline framing is
 * `AnalyticsSection`'s. Deleted for good in #11628; until then it is only a
 * grouping element for content a C issue has not rewritten yet.
 *
 * Forwards any other HTML/ARIA attribute (id, aria-label, aria-live, role,
 * data-*, …) to the outer element (#7848).
 */
export function Panel({
  title,
  action,
  caption,
  flush,
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const hasHeader = title != null || action != null || caption != null;
  return (
    <section {...rest} className={classNames("min-w-0", className)}>
      {hasHeader ? (
        <header className="flex items-start justify-between gap-3 mg-panel-pad pb-2">
          <div className="min-w-0">
            {title != null ? (
              <h3 className="text-13 font-semibold text-ink-strong">{title}</h3>
            ) : null}
            {caption != null ? (
              <p className="mt-1 text-13 text-ink-muted">{caption}</p>
            ) : null}
          </div>
          {action != null ? (
            <div className="shrink-0 flex items-center gap-2">{action}</div>
          ) : null}
        </header>
      ) : null}
      <div
        className={classNames(
          flush ? "mg-panel-pad-flush" : "mg-panel-pad",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
