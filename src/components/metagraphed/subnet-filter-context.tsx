import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

export type Severity = "ok" | "warn" | "down" | "unknown";
export const ALL_SEVERITIES: Severity[] = ["ok", "warn", "down", "unknown"];

interface Ctx {
  severity: Set<Severity>;
  isAll: boolean;
  isActive: (s: Severity) => boolean;
  toggle: (s: Severity) => void;
  only: (s: Severity) => void;
  reset: () => void;
}

const SubnetFilterContext = createContext<Ctx | null>(null);

function parseSev(raw?: string): Set<Severity> {
  if (!raw) return new Set(ALL_SEVERITIES);
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is Severity => ALL_SEVERITIES.includes(p as Severity));
  return parts.length ? new Set(parts) : new Set(ALL_SEVERITIES);
}

function serializeSev(set: Set<Severity>): string | undefined {
  if (set.size === 0 || set.size === ALL_SEVERITIES.length) return undefined;
  return ALL_SEVERITIES.filter((s) => set.has(s)).join(",");
}

export function SubnetFilterProvider({ children }: { children: ReactNode }) {
  const search = useSearch({ strict: false }) as { sev?: string };
  const navigate = useNavigate();

  const severity = useMemo(() => parseSev(search.sev), [search.sev]);
  const isAll = severity.size === ALL_SEVERITIES.length;

  const apply = useCallback(
    (next: Set<Severity>) => {
      const sev = serializeSev(next);
      navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, sev }),
        replace: true,
      });
    },
    [navigate],
  );

  const value = useMemo<Ctx>(
    () => ({
      severity,
      isAll,
      isActive: (s) => severity.has(s),
      toggle: (s) => {
        const next = new Set(severity);
        if (next.has(s)) next.delete(s);
        else next.add(s);
        if (next.size === 0) apply(new Set(ALL_SEVERITIES));
        else apply(next);
      },
      only: (s) => {
        if (severity.size === 1 && severity.has(s)) apply(new Set(ALL_SEVERITIES));
        else apply(new Set([s]));
      },
      reset: () => apply(new Set(ALL_SEVERITIES)),
    }),
    [severity, isAll, apply],
  );

  return <SubnetFilterContext.Provider value={value}>{children}</SubnetFilterContext.Provider>;
}

export function useSubnetFilter(): Ctx {
  const v = useContext(SubnetFilterContext);
  if (!v) {
    // Safe no-op fallback so components rendered outside the provider still work.
    return {
      severity: new Set(ALL_SEVERITIES),
      isAll: true,
      isActive: () => true,
      toggle: () => {},
      only: () => {},
      reset: () => {},
    };
  }
  return v;
}
