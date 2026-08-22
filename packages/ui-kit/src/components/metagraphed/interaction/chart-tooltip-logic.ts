/** Pure placement for `ChartTooltip` (#11606). */
export interface Box {
  left: number;
  right: number;
  width: number;
}

export const TOOLTIP_GAP_PX = 8;

/**
 * Left offset (px, relative to the container) of a tooltip `width` wide
 * anchored to `mark`: to the right of the mark, flipped to its left when that
 * would overflow the container, clamped at 0 when neither side fits.
 */
export function placeTooltip(
  mark: Box,
  container: Box,
  width: number,
  gap = TOOLTIP_GAP_PX,
): number {
  let left = mark.right - container.left + gap;
  if (left + width > container.width)
    left = mark.left - container.left - gap - width;
  return Math.max(0, Math.round(left));
}

export type TooltipPlacement = "float" | "static";

/** Below 640px the tooltip is a static panel above the visual, never floating. */
export function tooltipPlacement(viewportWidth: number): TooltipPlacement {
  return viewportWidth < 640 ? "static" : "float";
}
