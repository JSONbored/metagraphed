import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";
export const DENSITY_STORAGE_KEY = "mg-density";

/** Normalizes a stored/local value to a valid density choice. */
export function normalizeDensityChoice(value: string | null | undefined): Density {
  return value === "compact" ? "compact" : "comfortable";
}

/** Mirrors the pre-hydration bootstrap IIFE for drift tests. */
export function bootstrapDensity(stored: string | null): Density {
  return stored === "compact" ? "compact" : "comfortable";
}

const STORAGE_KEY = DENSITY_STORAGE_KEY;

function readChoice(): Density {
  if (typeof window === "undefined") return "comfortable";
  return normalizeDensityChoice(window.localStorage.getItem(STORAGE_KEY));
}

function apply(d: Density) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = d;
}

/**
 * Pre-hydration script. Inlined in <head> so the first paint matches the
 * stored density and there's no layout shift after hydration.
 */
export const DENSITY_BOOTSTRAP_SCRIPT = `(() => {
  try {
    var v = localStorage.getItem("${STORAGE_KEY}");
    document.documentElement.dataset.density = v === "compact" ? "compact" : "comfortable";
  } catch (_) {}
})();`;

export function useDensity() {
  const [density, setDensityState] = useState<Density>(() => readChoice());
  useEffect(() => apply(density), [density]);
  const setDensity = useCallback((d: Density) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, d);
    } catch {
      /* best-effort persist */
    }
    setDensityState(d);
  }, []);
  return { density, setDensity };
}
