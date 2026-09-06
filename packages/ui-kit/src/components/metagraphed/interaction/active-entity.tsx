import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  isRovingKey,
  markTabIndex,
  reduceActiveEntity,
  rovingTarget,
  tapIntent,
  type ActiveEntityState,
} from "./active-entity-logic";

/**
 * The page-wide "active entity" contract (#11606).
 *
 * One provider per route holds at most one active entity key. Any mark, row,
 * card or path registers itself with `useEntityMark(key)`; hovering, focusing
 * or tapping any one of them lights up every element on the page that carries
 * the same key (`[data-entity][data-active="true"]`). Nothing is dimmed --
 * inactive marks keep full colour; the active ones gain emphasis.
 *
 * Touch has no hover, so a tap *pins* the entity (the tooltip and highlight
 * stay up); a second tap on the pinned mark fires `onActivate` (navigation).
 * Escape, or a pointer-down outside any mark of the pinned key, unpins.
 */

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  /** A CSS colour for the 9px swatch; omitted = no swatch. */
  swatch?: string;
}

/** What the owning chart wants `ChartTooltip` to show for the active mark. */
export interface ActiveEntityData {
  title: string;
  total?: string;
  rows?: TooltipRow[];
  note?: string;
}

export interface ActiveEntity {
  key: string;
  /** Which surface set it -- "emissions-chart", "leaderboard", … */
  source: string;
  /** The element that set it; tooltips anchor to its bounding box. */
  element: Element | null;
  data?: ActiveEntityData;
}

export interface ActiveEntityContextValue {
  active: ActiveEntity | null;
  pinned: boolean;
  /** Hover / focus. Ignored while another key is pinned. */
  set: (next: ActiveEntity) => void;
  /** Tap. Pins `next`; pinning the already-pinned key is a no-op. */
  pin: (next: ActiveEntity) => void;
  /** Leave / blur. Ignored while pinned unless `force` (Escape, outside tap). */
  clear: (options?: { force?: boolean }) => void;
}

const ActiveEntityContext = createContext<ActiveEntityContextValue | null>(
  null,
);

export function ActiveEntityProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceActiveEntity<ActiveEntity>, {
    active: null,
    pinned: false,
  } as ActiveEntityState<ActiveEntity>);

  const set = useCallback(
    (entity: ActiveEntity) => dispatch({ type: "set", entity }),
    [],
  );
  const pin = useCallback(
    (entity: ActiveEntity) => dispatch({ type: "pin", entity }),
    [],
  );
  const clear = useCallback(
    (options?: { force?: boolean }) =>
      dispatch({ type: "clear", force: options?.force }),
    [],
  );

  // A pinned entity is released by a pointer-down anywhere that is not one of
  // its own marks, so a touch user can always get the page back.
  useEffect(() => {
    if (!state.pinned || !state.active) return;
    const key = state.active.key;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest("[data-entity]");
      if (mark && mark.getAttribute("data-entity") === key) return;
      dispatch({ type: "clear", force: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [state.pinned, state.active]);

  const value = useMemo<ActiveEntityContextValue>(
    () => ({ active: state.active, pinned: state.pinned, set, pin, clear }),
    [state.active, state.pinned, set, pin, clear],
  );
  return (
    <ActiveEntityContext.Provider value={value}>
      {children}
    </ActiveEntityContext.Provider>
  );
}

const NOOP_CONTEXT: ActiveEntityContextValue = {
  active: null,
  pinned: false,
  set: () => {},
  pin: () => {},
  clear: () => {},
};

/**
 * The provider's value, or an inert one outside a provider so a primitive can
 * render in isolation (tests, the specimen page, a route that has not mounted
 * the provider yet) without throwing.
 */
export function useActiveEntity(): ActiveEntityContextValue {
  return useContext(ActiveEntityContext) ?? NOOP_CONTEXT;
}

/** `true` while `key` is the page's active entity. */
export function useIsActive(key: string): boolean {
  return useActiveEntity().active?.key === key;
}

export interface EntityMarkOptions {
  /** Defaults to "mark". Tooltips use it to decide whose anchor to follow. */
  source?: string;
  /** Accessible name. Required in spirit: pass it, or synthesize one with `markAriaLabel`. */
  label?: string;
  /** Rows / totals for the owning chart's `ChartTooltip`. */
  data?: ActiveEntityData;
  /** Click (pointer), Enter / Space (keyboard), or the second tap on a pinned mark (touch). */
  onActivate?: () => void;
  disabled?: boolean;
}

export interface EntityMarkProps {
  ref: (el: Element | null) => void;
  "data-entity": string;
  "data-active": "true" | undefined;
  tabIndex: number;
  role: "button";
  "aria-label": string;
  "aria-disabled": true | undefined;
  onPointerDown: (event: PointerEvent<Element>) => void;
  onPointerEnter: (event: PointerEvent<Element>) => void;
  onPointerLeave: (event: PointerEvent<Element>) => void;
  onFocus: (event: FocusEvent<Element>) => void;
  onBlur: (event: FocusEvent<Element>) => void;
  onKeyDown: (event: KeyboardEvent<Element>) => void;
  onClick: (event: MouseEvent<Element>) => void;
}

const MARKS_SELECTOR = "[data-marks]";
// Native links retain their link semantics. Decorative parts (for example a
// stacked column's segments) also carry data-entity but are not controls.
const MARK_SELECTOR =
  '[data-entity][role="button"], a[data-entity][href], button[data-entity]';

function siblingsOf(el: Element): Element[] {
  const group = el.closest(MARKS_SELECTOR);
  if (!group) return [el];
  return Array.from(group.querySelectorAll(MARK_SELECTOR)).filter(
    (m) =>
      m.closest(MARKS_SELECTOR) === group &&
      m.getAttribute("aria-disabled") !== "true" &&
      !m.hasAttribute("disabled"),
  );
}

/**
 * Props to spread on a mark: an accessible name, a default button role and
 * roving tabindex. Native anchors omit the role and keep their href behavior.
 * ArrowLeft/Right/Home/End move focus inside the nearest `[data-marks]` group.
 */
export function useEntityMark(
  key: string,
  opts: EntityMarkOptions = {},
): EntityMarkProps {
  const ctx = useActiveEntity();
  const { source = "mark", label, data, onActivate, disabled = false } = opts;
  const elRef = useRef<Element | null>(null);
  const [isFirst, setIsFirst] = useState(false);
  const lastPointerType = useRef<string>("mouse");
  const isActive = ctx.active?.key === key;
  const isPinnedHere = isActive && ctx.pinned;

  const ref = useCallback((el: Element | null) => {
    elRef.current = el;
  }, []);

  // At rest the first enabled mark is tabbable. Groups have static membership;
  // re-key a changed group when its membership or disabled states change.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    setIsFirst(siblingsOf(el)[0] === el);
  }, [key, disabled]);

  const entity = useCallback(
    (): ActiveEntity => ({ key, source, element: elRef.current, data }),
    [key, source, data],
  );

  const onPointerDown = useCallback((event: PointerEvent<Element>) => {
    lastPointerType.current = event.pointerType || "mouse";
  }, []);
  const onPointerEnter = useCallback(
    (event: PointerEvent<Element>) => {
      if (disabled || event.pointerType === "touch") return;
      ctx.set(entity());
    },
    [ctx, entity, disabled],
  );
  const onPointerLeave = useCallback(
    (event: PointerEvent<Element>) => {
      if (event.pointerType === "touch") return;
      ctx.clear();
    },
    [ctx],
  );
  const onFocus = useCallback(() => {
    if (disabled) return;
    // A touch tap focuses the mark before its click arrives; setting here
    // would mount the tooltip and shift the layout under the finger, and the
    // click is what pins on touch. Keyboard focus is the real case.
    if (lastPointerType.current === "touch") return;
    ctx.set(entity());
  }, [ctx, entity, disabled]);
  const onBlur = useCallback(() => {
    ctx.clear();
  }, [ctx]);
  const onClick = useCallback(
    (event: MouseEvent<Element>) => {
      // Table rows share the highlight contract, but their links, disclosure
      // buttons and inputs own their activation, including a first touch tap.
      const control =
        event.target instanceof Element
          ? event.target.closest(
              'a[href], button, input, select, textarea, [role="button"], [role="link"]',
            )
          : null;
      if (control && control !== event.currentTarget) return;
      if (disabled) {
        event.preventDefault();
        return;
      }
      // Native keyboard clicks have no pointer detail, even when this mark
      // was last touched on a device that also has a keyboard.
      const pointerType =
        event.detail === 0 ? "keyboard" : lastPointerType.current;
      if (tapIntent(pointerType, isPinnedHere) === "pin") {
        // A first touch tap pins; it must not also follow a link.
        event.preventDefault();
        ctx.pin(entity());
        return;
      }
      onActivate?.();
    },
    [ctx, entity, disabled, isPinnedHere, onActivate],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<Element>) => {
      // Do not cancel a link, disclosure or input's native key event when it
      // bubbles through an entity-marked table row.
      if (event.target !== event.currentTarget) return;
      const el = elRef.current;
      if (!el) return;
      if (event.key === "Escape") {
        ctx.clear({ force: true });
        event.stopPropagation();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        if (disabled) {
          event.preventDefault();
          return;
        }
        // Enter follows an anchor; Space keeps its native scrolling behavior.
        // Button marks still invoke their callback once, without a second
        // synthetic click from the browser.
        if (el.matches("a[href]")) return;
        event.preventDefault();
        onActivate?.();
        return;
      }
      if (!isRovingKey(event.key)) return;
      const marks = siblingsOf(el);
      const target = rovingTarget(event.key, marks.indexOf(el), marks.length);
      if (target === null) return;
      event.preventDefault();
      (marks[target] as HTMLElement | SVGElement).focus();
    },
    [ctx, disabled, onActivate],
  );

  return {
    ref,
    "data-entity": key,
    "data-active": isActive ? "true" : undefined,
    tabIndex: markTabIndex({ disabled, active: isActive, first: isFirst }),
    role: "button",
    "aria-label": label ?? key,
    "aria-disabled": disabled ? true : undefined,
    onPointerDown,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    onKeyDown,
    onClick,
  };
}
