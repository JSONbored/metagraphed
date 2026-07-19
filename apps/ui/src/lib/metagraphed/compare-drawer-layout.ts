/**
 * Layout tokens for the subnets compare drawer, kept out of the components so
 * both expanded views share one definition and it can be asserted in tests —
 * mirroring explorer-leaderboard-layout.ts.
 *
 * Below `md` the expanded drawer is a bottom sheet: the body takes the leftover
 * height of a flex column (`min-h-0 flex-1`) so long content scrolls inside the
 * sheet instead of pushing the card past the viewport. From `md` up it keeps the
 * original fixed `55vh` cap and normal block flow, so desktop is unchanged.
 *
 * The codebase is mobile-first (no `max-*` variants anywhere), so the mobile
 * sheet behaviour is the BASE and `md:` restores the original dock.
 */
export const COMPARE_BODY_CLASS =
  "min-h-0 flex-1 overflow-auto border-t border-border md:max-h-[55vh] md:flex-none";

/** Full-screen sheet on mobile when expanded; bottom-anchored dock from md up. */
export const COMPARE_SHEET_ROOT_CLASS = "top-0 md:top-auto";

/** Pins the sheet's card to the bottom and lets it grow to the available height. */
export const COMPARE_SHEET_WRAPPER_CLASS =
  "relative flex h-full flex-col justify-end pt-3 md:block md:h-auto md:pt-0";

/** Makes the card a flex column so the body can size against it. */
export const COMPARE_SHEET_CARD_CLASS = "flex max-h-full min-h-0 flex-col md:block md:max-h-none";

/** Tap-outside-to-close scrim, mobile only. Matches the mg-mega-scrim look. */
export const COMPARE_SCRIM_CLASS =
  "pointer-events-auto absolute inset-0 bg-[color-mix(in_oklab,var(--paper)_78%,transparent)] backdrop-blur-[2px] md:hidden";
