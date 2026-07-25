import type { ReactNode } from "react";
import { Panel } from "./panel";

/**
 * Segmented container for one-shot page actions (share, download, reset
 * filters) — the `bare`-variant sibling of `SegmentedToggle`'s pill treatment,
 * so a row of fire-and-forget actions reads as one deliberate control cluster
 * instead of a wrapping line of individually-bordered boxes. Children should
 * render with each button's own `bare` prop set so they lose their standalone
 * border/background and pick up this shared one instead.
 */
export function ActionBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Panel
      as="div"
      flush
      className={className}
      bodyClassName="inline-flex items-center gap-0.5 p-0.5"
    >
      {children}
    </Panel>
  );
}
