import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
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
  /**
   * The element focused when the drawer was opened, for ApiDrawer to restore on
   * close (#6418). The drawer's <Sheet> has no <SheetTrigger> in its own tree
   * (the trigger is a separate component, and ⌘J can open it from anywhere), so
   * Radix cannot return focus on its own — it drops to <body>. `open()` records
   * document.activeElement here; ApiDrawer's onCloseAutoFocus restores it.
   */
  restoreFocusRef: RefObject<HTMLElement | null>;
}

const ApiSourceCtx = createContext<Ctx | null>(null);

export function ApiSourceProvider({ children }: { children: ReactNode }) {
  const [registry, setRegistry] = useState<Map<symbol, ApiSource[]>>(new Map());
  const [isOpen, setOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Record the element to return focus to before opening — the header button,
  // or whatever had focus when ⌘J fired (#6418).
  const open = useCallback(() => {
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    setOpen(true);
  }, []);

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
    () => ({ sources, register, isOpen, setOpen, open, restoreFocusRef }),
    [sources, register, isOpen, open],
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
