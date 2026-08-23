import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { dedupeApiSources, type ApiSource } from "./api-source-helpers";

export type { ApiSource };

/**
 * Every API path the mounted page reads, collected from its own components.
 *
 * This carried a whole drawer with it until #11628: `isOpen` / `setOpen` /
 * `open()` and a `restoreFocusRef` existed so `ApiDrawer` could return focus to
 * the header button that opened it (#6418). #11605 cut the header to five links
 * and the drawer went with the button, leaving a registry with no reader —
 * every route declared its sources into a store nothing rendered. The footer
 * reads them now, which is what the declaration was always for.
 */
interface Ctx {
  sources: ApiSource[];
  register: (s: ApiSource[]) => () => void;
}

const ApiSourceCtx = createContext<Ctx | null>(null);

export function ApiSourceProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Map<symbol, ApiSource[]>>(new Map());

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

  const value = useMemo<Ctx>(() => ({ sources, register }), [sources, register]);

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
