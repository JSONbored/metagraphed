import * as React from "react";
import { PopoverContent } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

/** Viewport gutter kept on every side (px). Matches the `max-w` inset below so
 * a clamped panel is centred within the gutter rather than flush to one edge. */
const VIEWPORT_GUTTER = 12;

/**
 * A drop-in `PopoverContent` that always fits — and is legible — inside the
 * viewport, on every screen size. The base primitive has three gaps that make
 * these fixed-width header panels (`w-80` / `w-72`) read as broken on small
 * screens (#3945):
 *
 *  - **Width:** Radix keeps a panel on-screen but never shrinks its fixed
 *    width, so it pins flush to (or spills past) the edge. `max-w` of the
 *    viewport-minus-gutters makes the caller's width a *maximum*, and a matching
 *    `collisionPadding` stops Radix pinning it flush.
 *  - **Height:** a tall panel (network list, settings sections) ran off the
 *    bottom of short viewports with no way to reach the cut-off content. Cap the
 *    height to Radix's collision-aware available height and let it scroll.
 *  - **Surface:** the base `bg-popover` token renders transparent in this app's
 *    theme, so page content showed straight through the panel. Paint an explicit
 *    solid card surface so the panel is always opaque.
 *
 * Panels that already fit with room to spare are visually unchanged; only the
 * constrained cases are corrected. Callers keep passing their usual width class.
 */
export const ClampedPopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverContent>,
  React.ComponentPropsWithoutRef<typeof PopoverContent>
>(({ className, collisionPadding = VIEWPORT_GUTTER, ...props }, ref) => (
  <PopoverContent
    ref={ref}
    collisionPadding={collisionPadding}
    className={classNames(
      "max-w-[calc(100vw-1.5rem)]",
      "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-1.5rem))] overflow-y-auto",
      "bg-card text-ink",
      className,
    )}
    {...props}
  />
));
ClampedPopoverContent.displayName = "ClampedPopoverContent";
