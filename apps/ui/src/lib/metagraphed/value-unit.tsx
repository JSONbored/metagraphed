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

/** Compact τ / $ / Both toggle for explorer mastheads. */
export function ValueUnitControl() {
  const { unit, setUnit } = useValueUnit();
  const opts: Array<{ v: ValueUnit; label: string; title: string }> = [
    { v: "tao", label: "τ", title: "Show TAO only" },
    { v: "usd", label: "$", title: "Show USD only" },
    { v: "both", label: "Both", title: "Show TAO and USD" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Value display unit"
      className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
    >
      {opts.map((o) => {
        const active = o.v === unit;
        return (
          <button
            key={o.v}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title}
            onClick={() => setUnit(o.v)}
            className={
              "inline-flex items-center rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8 " +
              (active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
