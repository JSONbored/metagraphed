import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";
const STORAGE_KEY = "mg-density";

function readChoice(): Density {
  if (typeof window === "undefined") return "comfortable";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "compact" ? "compact" : "comfortable";
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
      // ignore: persistence is best-effort (private mode / storage disabled)
    }
    setDensityState(d);
  }, []);
  return { density, setDensity };
}
