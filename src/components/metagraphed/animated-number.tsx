import { useEffect, useRef, useState } from "react";
import { classNames } from "@/lib/metagraphed/format";

type Formatter = (n: number) => string;

interface Props {
  /** Target numeric value. `null`/`undefined` renders the fallback. */
  value: number | null | undefined;
  /** Format the tweened numeric value at each frame. Defaults to localized integer. */
  format?: Formatter;
  /** Fallback string when value is missing. */
  fallback?: string;
  /** Tween duration in ms. */
  duration?: number;
  /** Flash a tint when the value changes (up = accent, down = health-down). */
  flashOnChange?: boolean;
  className?: string;
}

const defaultFormat: Formatter = (n) =>
  new Intl.NumberFormat("en-US").format(Math.round(n));

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Tween numeric values between renders, taostats-style. Falls back to instant
 * swap when the user prefers reduced motion or when SSR is rendering.
 */
export function AnimatedNumber({
  value,
  format = defaultFormat,
  fallback = "—",
  duration = 600,
  flashOnChange = true,
  className,
}: Props) {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [display, setDisplay] = useState<number | null>(safe);
  const [flash, setFlash] = useState<"" | "mg-flash-up" | "mg-flash-down">("");
  const fromRef = useRef<number | null>(safe);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (safe === null) {
      setDisplay(null);
      fromRef.current = null;
      return;
    }
    const from = fromRef.current;
    if (from === null || prefersReducedMotion() || from === safe) {
      setDisplay(safe);
      fromRef.current = safe;
      return;
    }
    if (flashOnChange) {
      setFlash(safe > from ? "mg-flash-up" : "mg-flash-down");
      window.setTimeout(() => setFlash(""), 720);
    }
    const start = performance.now();
    const delta = safe - from;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = safe;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [safe, duration, flashOnChange]);

  return (
    <span className={classNames("tabular-nums inline-block px-0.5", flash, className)}>
      {display === null ? fallback : format(display)}
    </span>
  );
}
