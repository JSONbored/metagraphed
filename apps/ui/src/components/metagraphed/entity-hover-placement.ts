/**
 * Placement / timing tokens for EntityHoverCard and mega-menu previews (#5337).
 *
 * Mega-menu live rows prefer a faster open delay and a right-side popover so
 * the card doesn't cover the filtered list; entity cells elsewhere keep the
 * slower top placement.
 */

export type EntityHoverCardSide = "top" | "right" | "bottom" | "left";
export type EntityHoverCardAlign = "start" | "center" | "end";

export const ENTITY_HOVER_DEFAULTS = {
  side: "top" as EntityHoverCardSide,
  align: "start" as EntityHoverCardAlign,
  openDelayMs: 250,
  closeDelayMs: 120,
  sideOffset: 8,
} as const;

/** Mega-menu live-row preview placement — opens beside the list, not over it. */
export const MEGA_MENU_HOVER_DEFAULTS = {
  side: "right" as EntityHoverCardSide,
  align: "start" as EntityHoverCardAlign,
  openDelayMs: 150,
  closeDelayMs: 80,
  sideOffset: 8,
} as const;

export type EntityHoverPlacement = {
  side: EntityHoverCardSide;
  align: EntityHoverCardAlign;
  openDelayMs: number;
  closeDelayMs: number;
  sideOffset: number;
};

/**
 * Merge caller overrides onto the default entity-hover placement.
 * Used by EntityHoverCard so mega-menu and table cells share one compositor.
 */
export function resolveEntityHoverPlacement(
  overrides: Partial<EntityHoverPlacement> = {},
  defaults: EntityHoverPlacement = ENTITY_HOVER_DEFAULTS,
): EntityHoverPlacement {
  return {
    side: overrides.side ?? defaults.side,
    align: overrides.align ?? defaults.align,
    openDelayMs: overrides.openDelayMs ?? defaults.openDelayMs,
    closeDelayMs: overrides.closeDelayMs ?? defaults.closeDelayMs,
    sideOffset: overrides.sideOffset ?? defaults.sideOffset,
  };
}
