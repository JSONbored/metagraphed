import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export type CalloutTone = "accent" | "warn" | "down" | "ok" | "muted";

/**
 * Something the reader needs to notice, and why.
 *
 * This is what `Panel`'s `tone` prop actually meant. It was expressed as a
 * tinted card, so it looked like every other card on the page and the one
 * block that needed to stand out was the one that could not — a tone applied
 * to a component that is a box by default cannot signal anything, because
 * everything around it is already a box.
 *
 * A callout keeps a container precisely because its neighbours no longer have
 * one: a low-alpha fill and a hairline in the tone's own colour, against
 * grouping that is otherwise unboxed.
 */
export function Callout({
  tone = "muted",
  title,
  children,
  className,
}: {
  tone?: CalloutTone;
  /** A short label, set in the tone's colour. */
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("mg-callout", className)} data-tone={tone}>
      {title != null ? <p className="mg-callout-title">{title}</p> : null}
      <div className="mg-callout-body">{children}</div>
    </div>
  );
}
