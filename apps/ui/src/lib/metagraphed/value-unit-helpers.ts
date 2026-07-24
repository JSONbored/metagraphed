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
