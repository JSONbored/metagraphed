import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getApiBase,
  setApiBase,
  onApiBaseChange,
  DEFAULT_API_BASE,
} from "@/lib/metagraphed/config";

/**
 * Subscribe to the runtime API base. Returns the current value plus a
 * `change()` helper that persists, broadcasts, and invalidates queries
 * so all consumers refetch against the new origin.
 */
export function useApiBase() {
  const [base, setBase] = useState<string>(() => getApiBase());
  const qc = useQueryClient();

  useEffect(() => onApiBaseChange((next) => setBase(next)), []);

  const change = (next: string) => {
    setApiBase(next);
    // Drop everything; we just changed origins.
    qc.invalidateQueries({ queryKey: ["metagraphed"] });
  };

  return { base, change, isDefault: base === DEFAULT_API_BASE };
}
