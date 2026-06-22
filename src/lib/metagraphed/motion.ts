import { useEffect, useState } from "react";

/**
 * Centralized motion tokens for the registry. Use these instead of ad-hoc
 * `duration-150` / `ease-in-out` so motion identity stays consistent and
 * one change here propagates everywhere.
 *
 * Register: confident but quiet. Never bouncy.
 */
export const DURATION = {
  xs: 120,
  sm: 180,
  md: 260,
  lg: 380,
  xl: 520,
} as const;

export const EASE = {
  /** Default UI easing — soft start, quick settle. Matches --mg-ease-out. */
  standard: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** Emphasis exit. */
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  /** Smooth in/out for hovers. */
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/** Tailwind-friendly transition string, e.g. `transition-[opacity,transform] ${MOTION.md}` */
export const MOTION = {
  xs: `duration-[${DURATION.xs}ms] ease-[cubic-bezier(0.22,1,0.36,1)]`,
  sm: `duration-[${DURATION.sm}ms] ease-[cubic-bezier(0.22,1,0.36,1)]`,
  md: `duration-[${DURATION.md}ms] ease-[cubic-bezier(0.22,1,0.36,1)]`,
  lg: `duration-[${DURATION.lg}ms] ease-[cubic-bezier(0.22,1,0.36,1)]`,
} as const;

/** Inline-style helper. */
export function transition(
  props: string,
  duration: keyof typeof DURATION = "sm",
  easing: keyof typeof EASE = "standard",
): React.CSSProperties {
  return {
    transitionProperty: props,
    transitionDuration: `${DURATION[duration]}ms`,
    transitionTimingFunction: EASE[easing],
  };
}

/** Synchronous read of the user's reduced-motion preference. SSR-safe. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Live-binding hook. Re-renders when the preference toggles. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
