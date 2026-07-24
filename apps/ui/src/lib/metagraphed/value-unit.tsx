import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ValueUnit = "tao" | "usd" | "both";

const STORAGE_KEY = "mg:value-unit";
const DEFAULT: ValueUnit = "both";

interface Ctx {
  unit: ValueUnit;
  setUnit: (u: ValueUnit) => void;
}

const ValueUnitContext = createContext<Ctx>({ unit: DEFAULT, setUnit: () => {} });

/**
 * Read the persisted τ/USD/Both preference. SSR-safe and corrupt-data-safe:
 * missing window, blocked storage, or values outside the 3-way allowlist all
 * fall back to DEFAULT without throwing.
 */
export function readStoredValueUnit(): ValueUnit {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "tao" || raw === "usd" || raw === "both") return raw;
    return DEFAULT;
  } catch {
    /* storage blocked — keep default */
    return DEFAULT;
  }
}

/**
 * Provides the τ/USD/Both display preference for money values on the current
 * page. SSR-safe: initial render uses the DEFAULT and rehydrates the persisted
 * choice from localStorage in an effect (so server/client HTML match).
 */
export function ValueUnitProvider({ children }: { children: ReactNode }) {
  const [unit, setUnitState] = useState<ValueUnit>(DEFAULT);

  useEffect(() => {
    setUnitState(readStoredValueUnit());
  }, []);

  const setUnit = (u: ValueUnit) => {
    setUnitState(u);
    try {
      window.localStorage.setItem(STORAGE_KEY, u);
    } catch {
      /* ignore */
    }
  };

  return (
    <ValueUnitContext.Provider value={{ unit, setUnit }}>{children}</ValueUnitContext.Provider>
  );
}

export function useValueUnit() {
  return useContext(ValueUnitContext);
}
