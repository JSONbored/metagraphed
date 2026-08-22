/**
 * The pure half of the active-entity contract (#11606): the state machine
 * and the keyboard model, with no DOM, so the suite's plain-node vitest can
 * pin every transition. `active-entity.tsx` wires these to React and the DOM;
 * the Playwright interaction spec covers that wiring in a real browser.
 */
export interface ActiveEntityState<E = unknown> {
  active: E | null;
  pinned: boolean;
}

export type ActiveEntityAction<E> =
  | { type: "set"; entity: E }
  | { type: "pin"; entity: E }
  | { type: "clear"; force?: boolean };

export function reduceActiveEntity<E extends { key: string }>(
  state: ActiveEntityState<E>,
  action: ActiveEntityAction<E>,
): ActiveEntityState<E> {
  switch (action.type) {
    case "set":
      // Hover / focus never steals from a pinned (tapped) entity.
      return state.pinned ? state : { active: action.entity, pinned: false };
    case "pin":
      return state.pinned && state.active?.key === action.entity.key
        ? state
        : { active: action.entity, pinned: true };
    case "clear":
      if (state.pinned && !action.force) return state;
      return state.active === null && !state.pinned
        ? state
        : { active: null, pinned: false };
  }
}

export const EMPTY_ACTIVE_ENTITY: ActiveEntityState<never> = {
  active: null,
  pinned: false,
};

export type RovingKey =
  "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp" | "Home" | "End";

export function isRovingKey(key: string): key is RovingKey {
  return (
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * Index of the mark that receives focus after `key` is pressed on the mark at
 * `index` in a group of `length`. Arrows wrap; Home / End clamp. Returns
 * `null` when nothing should move (one mark, or an index outside the group).
 */
export function rovingTarget(
  key: RovingKey,
  index: number,
  length: number,
): number | null {
  if (length < 2 || index < 0 || index >= length) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % length;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
  }
}

/**
 * What a click on a mark means. A pointer click activates; a touch tap pins
 * first and activates only on the second tap of the already-pinned mark.
 */
export type TapIntent = "activate" | "pin";

export function tapIntent(pointerType: string, pinnedHere: boolean): TapIntent {
  if (pointerType !== "touch") return "activate";
  return pinnedHere ? "activate" : "pin";
}

/**
 * Roving tabindex: at rest exactly one mark per group is tabbable -- the
 * first -- and the active mark joins it so Tab returns to where the user
 * was. Disabled marks never are.
 */
export function markTabIndex(options: {
  disabled: boolean;
  active: boolean;
  first: boolean;
}): -1 | 0 {
  if (options.disabled) return -1;
  return options.active || options.first ? 0 : -1;
}
