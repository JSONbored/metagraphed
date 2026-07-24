import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  readStoredValueUnit,
  VALUE_UNIT_STORAGE_KEY,
  DEFAULT_VALUE_UNIT,
  type ValueUnit,
} from "./value-unit-helpers";

export type { ValueUnit };

interface Ctx {
  unit: ValueUnit;
  setUnit: (u: ValueUnit) => void;
}

const ValueUnitContext = createContext<Ctx>({
  unit: DEFAULT_VALUE_UNIT,
  setUnit: () => {},
});

/**
 * Provides the τ/USD/Both display preference for money values on the current
 * page. SSR-safe: initial render uses the DEFAULT and rehydrates the persisted
 * choice from localStorage in an effect (so server/client HTML match).
 */
export function ValueUnitProvider({ children }: { children: ReactNode }) {
  const [unit, setUnitState] = useState<ValueUnit>(DEFAULT_VALUE_UNIT);

  useEffect(() => {
    setUnitState(readStoredValueUnit());
  }, []);

  const setUnit = (u: ValueUnit) => {
    setUnitState(u);
    try {
      window.localStorage.setItem(VALUE_UNIT_STORAGE_KEY, u);
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
