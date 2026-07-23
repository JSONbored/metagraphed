import { useCallback, useEffect, useMemo, useState } from "react";

export interface ColumnDef {
  id: string;
  label: string;
  /** Cannot be hidden (e.g. primary identifier). */
  required?: boolean;
  /** Default visibility if no persisted state exists. */
  defaultVisible?: boolean;
}

const STORAGE_PREFIX = "mg:cols:v1:";

function readPersisted(key: string): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

function writePersisted(key: string, visible: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(visible));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function defaultVisible(columns: ColumnDef[]): string[] {
  return columns.filter((c) => c.required || c.defaultVisible !== false).map((c) => c.id);
}

/**
 * Per-page column visibility with `localStorage` persistence. Required
 * columns are always kept visible even if a persisted state omits them,
 * so a schema change can't leave a table without a primary key column.
 */
export function useColumnVisibility(pageKey: string, columns: ColumnDef[]) {
  // SSR and the first browser render must match. Load persistence after
  // hydration rather than reading localStorage in the state initializer.
  const initial = useMemo(() => defaultVisible(columns), [columns]);
  const [visible, setVisible] = useState<string[]>(initial);

  useEffect(() => {
    const persisted = readPersisted(pageKey);
    if (!persisted) return;
    const set = new Set(persisted);
    for (const c of columns) if (c.required) set.add(c.id);
    const known = new Set(columns.map((c) => c.id));
    setVisible(Array.from(set).filter((id) => known.has(id)));
  }, [pageKey, columns]);

  useEffect(() => {
    writePersisted(pageKey, visible);
  }, [pageKey, visible]);

  const isVisible = useCallback((id: string) => visible.includes(id), [visible]);

  const toggle = useCallback(
    (id: string) => {
      const col = columns.find((c) => c.id === id);
      if (col?.required) return;
      setVisible((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
    },
    [columns],
  );

  const reset = useCallback(() => {
    setVisible(defaultVisible(columns));
  }, [columns]);

  return { visible, isVisible, toggle, reset, setVisible };
}
