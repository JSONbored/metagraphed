import { useCallback, useEffect, useState } from "react";

export type ValueUnit = "tao" | "usd" | "both";

export const VALUE_UNIT_STORAGE_KEY = "mg:value-unit";
export const DEFAULT_VALUE_UNIT: ValueUnit = "both";

/**
 * Read the persisted τ/USD/Both preference. SSR-safe and corrupt-data-safe:
 * missing window, blocked storage, or values outside the 3-way allowlist all
 * fall back to DEFAULT_VALUE_UNIT without throwing.
 */
export function readStoredValueUnit(): ValueUnit {
  if (typeof window === "undefined") return DEFAULT_VALUE_UNIT;
  try {
    const raw = window.localStorage.getItem(VALUE_UNIT_STORAGE_KEY);
    if (raw === "tao" || raw === "usd" || raw === "both") return raw;
    return DEFAULT_VALUE_UNIT;
  } catch {
    /* storage blocked — keep default */
    return DEFAULT_VALUE_UNIT;
  }
}

/**
 * The τ / USD / Both preference as state, persisted to this browser.
 *
 * Lives beside `readStoredValueUnit` and the storage key rather than in
 * `hooks/` so the reader, the writer and the key cannot drift apart — the
 * same shape `useHealthPalette` and `useTheme` already use. Reads on mount
 * rather than during render: the server has no localStorage, and seeding
 * state from it directly is a hydration mismatch on every value on the page.
 */
export function useValueUnit() {
  const [unit, setUnitState] = useState<ValueUnit>(DEFAULT_VALUE_UNIT);
  useEffect(() => setUnitState(readStoredValueUnit()), []);
  const setUnit = useCallback((next: ValueUnit) => {
    try {
      window.localStorage.setItem(VALUE_UNIT_STORAGE_KEY, next);
    } catch {
      /* storage blocked — the choice still applies for this session */
    }
    setUnitState(next);
  }, []);
  return { unit, setUnit };
}
