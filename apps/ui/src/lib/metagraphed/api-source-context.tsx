import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ApiSource {
  path: string;
  artifact?: string;
  label?: string;
}

/** Merges registered source groups with first-wins path deduplication. */
export function dedupeApiSources(groups: Iterable<ApiSource[]>): ApiSource[] {
  const out: ApiSource[] = [];
  const seen = new Set<string>();
  for (const arr of groups) {
    for (const s of arr) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push(s);
    }
  }
  return out;
}

interface Ctx {
  sources: ApiSource[];
  register: (s: ApiSource[]) => () => void;
  isOpen: boolean;
  setOpen: (v: boolean) => void;
  open: () => void;
}

const ApiSourceCtx = createContext<Ctx | null>(null);

export function ApiSourceProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Map<symbol, ApiSource[]>>(new Map());
  const [isOpen, setOpen] = useState(false);

  const register = useCallback((items: ApiSource[]) => {
    const key = Symbol();
    setRegistry((prev) => {
      const next = new Map(prev);
      next.set(key, items);
      return next;
    });
    return () => {
      setRegistry((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    };
  }, []);

  const sources = useMemo(() => dedupeApiSources(registry.values()), [registry]);

  const value = useMemo<Ctx>(
    () => ({ sources, register, isOpen, setOpen, open: () => setOpen(true) }),
    [sources, register, isOpen],
  );

  return <ApiSourceCtx.Provider value={value}>{children}</ApiSourceCtx.Provider>;
}

export function useApiSourceCtx() {
  const ctx = useContext(ApiSourceCtx);
  if (!ctx) throw new Error("useApiSourceCtx must be used within ApiSourceProvider");
  return ctx;
}

/** Pages call this to declare which API paths power the current view. */
export function useRegisterApiSource(paths: string[], artifacts: string[] = []) {
  const { register } = useApiSourceCtx();
  // Stable joined key so we don't re-register on every render.
  const pathsKey = paths.join("|");
  const artifactsKey = artifacts.join("|");
  useEffect(() => {
    const items: ApiSource[] = [
      ...paths.map((p) => ({ path: p })),
      ...artifacts.map((p) => ({ path: p, artifact: p })),
    ];
    return register(items);
    // paths/artifacts omitted on purpose: pathsKey/artifactsKey capture content changes
    // without re-registering when the parent passes a fresh array identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic deps are the keys
  }, [pathsKey, artifactsKey, register]);
}
