import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";
const STORAGE_KEY = "mg-density";

export function readChoice(): Density {
  if (typeof window === "undefined") return "comfortable";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "compact" ? "compact" : "comfortable";
  } catch {
    // Match theme.ts's readChoice: a throwing localStorage (Safari private
    // browsing, storage blocked by policy/extension) degrades to the default
    // instead of throwing during the initial render.
    return "comfortable";
  }
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
