import * as React from "react";
import { PopoverContent } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

/** Viewport gutter kept on every side (px). Matches the `max-w` inset below so
 * a clamped panel is centred within the gutter rather than flush to one edge. */
const VIEWPORT_GUTTER = 12;

/**
 * A `PopoverContent` that never renders wider than the viewport, with a small
 * gutter on every side. Radix's collision-avoidance repositions a panel to keep
 * it on-screen but does not shrink its fixed width — so a `w-80` (320px) /
 * `w-72` (288px) panel is pinned flush against (and on the narrowest devices
 * spills past) the screen edge, with no breathing room (#3945). Two things fix
 * that together: a `max-w` of the viewport minus the gutters turns the caller's
 * fixed width into a *maximum* (so it can shrink to fit), and a matching
 * `collisionPadding` keeps Radix from pinning that width flush to an edge. The
 * panel is unchanged where it already fits with room to spare; on narrow
 * viewports it shrinks and sits inside a consistent gutter instead of bleeding
 * to the device edge. Callers keep passing their usual width class.
 */
export const ClampedPopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverContent>,
  React.ComponentPropsWithoutRef<typeof PopoverContent>
>(({ className, collisionPadding = VIEWPORT_GUTTER, ...props }, ref) => (
  <PopoverContent
    ref={ref}
    collisionPadding={collisionPadding}
    className={classNames("max-w-[calc(100vw-1.5rem)]", className)}
    {...props}
  />
));
ClampedPopoverContent.displayName = "ClampedPopoverContent";
