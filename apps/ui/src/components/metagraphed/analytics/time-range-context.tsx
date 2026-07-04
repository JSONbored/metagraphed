import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type TimeRange = "1h" | "24h" | "7d" | "30d";

export const RANGE_HOURS: Record<TimeRange, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export const RANGE_BUCKETS: Record<TimeRange, number> = {
  "1h": 12,
  "24h": 24,
  "7d": 14,
  "30d": 30,
};

export const RANGE_LABEL: Record<TimeRange, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
};

interface Ctx {
  range: TimeRange;
  setRange: (r: TimeRange) => void;
}

const TimeRangeCtx = createContext<Ctx | null>(null);

export function TimeRangeProvider({
  children,
  defaultRange = "24h",
  value,
  onChange,
}: {
  children: ReactNode;
  defaultRange?: TimeRange;
  /** Controlled value (e.g. URL-synced). */
  value?: TimeRange;
  onChange?: (r: TimeRange) => void;
}) {
  const [internal, setInternal] = useState<TimeRange>(defaultRange);
  const range = value ?? internal;
  const setRange = (r: TimeRange) => {
    if (onChange) onChange(r);
    else setInternal(r);
  };
  const ctx = useMemo(() => ({ range, setRange }), [range]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TimeRangeCtx.Provider value={ctx}>{children}</TimeRangeCtx.Provider>;
}

export function useTimeRange(): Ctx {
  const c = useContext(TimeRangeCtx);
  if (c) return c;
  // Soft fallback so consumers can render outside a provider without crashing.
  return { range: "24h", setRange: () => undefined };
}
