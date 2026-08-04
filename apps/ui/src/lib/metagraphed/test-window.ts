/**
 * A minimal browser `window` for tests that exercise the CSR paths.
 *
 * ONE copy. There were five, and they had already diverged — 16, 18, 18, 19 and
 * 31 lines — with only config.test.ts's carrying the `location`/`assign`
 * support that per-network hostname resolution needs. Anyone writing a sixth
 * test that needed a hostname would have copied the long one again, and any fix
 * to the storage shim would have had to be made five times to stick.
 *
 * Real `EventTarget` + real `CustomEvent` (both global in Node 22), so
 * `window.dispatchEvent(new CustomEvent(...))` broadcasts are exercised for
 * real rather than mocked. `localStorage` is Map-backed.
 *
 * `location` is attached ONLY when a caller passes a hostname, so the cases
 * that must prove the app never assumes a DOM keep exercising the absent-
 * location path.
 */
export interface TestWindow extends EventTarget {
  localStorage: Storage;
  store: Map<string, string>;
  location?: { hostname: string; href: string; assign: (url: string) => void };
  assigned: string[];
  /**
   * Make every `localStorage.getItem` throw, the way a browser does when
   * storage is disabled or the quota/permission is denied. Two of the five
   * original copies grew this independently — it is the only way to prove the
   * "degrades to [] when localStorage access throws" paths, and consolidating
   * without it would have silently deleted those cases' teeth.
   */
  throwOnRead?: boolean;
}

export function makeWindow(seed: Record<string, string> = {}, hostname?: string): TestWindow {
  const store = new Map<string, string>(Object.entries(seed));
  const win = new EventTarget() as TestWindow;
  win.store = store;
  win.assigned = [];
  if (hostname !== undefined) {
    win.location = {
      hostname,
      href: `https://${hostname}/subnets?view=table`,
      assign: (url: string) => void win.assigned.push(url),
    };
  }
  win.localStorage = {
    getItem: (k: string) => {
      if (win.throwOnRead) throw new Error("blocked");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  return win;
}
