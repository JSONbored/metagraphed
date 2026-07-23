// Client-side blank-screen watchdog.
//
// Runs after hydration to detect the "hydrated but the viewport is empty"
// failure mode (bad CSS override, animation stuck at opacity:0, provider
// crash below the boundary). A separate inline bootstrap below covers failures
// that happen before React mounts, when no React boundary/effect can run.
//
// SSR-safe: every DOM access is guarded; the mount helper only wires listeners
// in the browser.

const BLANK_MIN_HEIGHT_PX = 40;
const FIRST_CHECK_DELAY_MS = 1500;
const SECOND_CHECK_DELAY_MS = 1500;
const RECOVERY_FLAG = "mg:blank-recovery";
const CRASH_FLAG = "mg:last-crash";
const RECOVERY_TTL_MS = 30_000;

/**
 * Runs from <head>, independently of the client bundle. This is deliberately
 * dependency-free: if a chunk fails to load or hydration throws before React
 * effects mount, it still captures the failure and retries once. It never
 * replaces server-rendered markup: preserving the original DOM lets React's
 * own error boundaries report the real failure instead of introducing a
 * second hydration mismatch. React sets __MG_HYDRATED__ on mount.
 */
export const PRE_HYDRATION_RECOVERY_SCRIPT = `(() => {
  var KEY = "${RECOVERY_FLAG}:boot";
  var fatal = null;
  function remember(value) {
    fatal = value && (value.message || String(value));
  }
  addEventListener("error", function (event) {
    remember(event.error || event.message || (event.target && event.target.src) || "Resource failed to load");
  }, true);
  addEventListener("unhandledrejection", function (event) { remember(event.reason); });
  function inspect() {
    if (window.__MG_HYDRATED__) {
      try { sessionStorage.removeItem(KEY); } catch (_) {}
      return;
    }
    var main = document.querySelector("main");
    var mainStyle = main && getComputedStyle(main);
    var bodyStyle = getComputedStyle(document.body);
    var hidden = !mainStyle || mainStyle.display === "none" || mainStyle.visibility === "hidden" || Number(mainStyle.opacity) === 0 || bodyStyle.display === "none" || bodyStyle.visibility === "hidden" || Number(bodyStyle.opacity) === 0;
    var blank = !main || main.getBoundingClientRect().height < 40 || !document.body.innerText.trim() || hidden;
    if (!fatal && !blank) return;
    setTimeout(function () {
      if (window.__MG_HYDRATED__) return;
      var confirmMain = document.querySelector("main");
      var confirmStyle = confirmMain && getComputedStyle(confirmMain);
      var confirmBlank = !confirmMain || confirmMain.getBoundingClientRect().height < 40 || !document.body.innerText.trim() || !confirmStyle || confirmStyle.display === "none" || confirmStyle.visibility === "hidden" || Number(confirmStyle.opacity) === 0;
      if (!fatal && !confirmBlank) return;
      var recent = 0;
      try { recent = Number(sessionStorage.getItem(KEY) || 0); } catch (_) {}
      if (recent && Date.now() - recent < ${RECOVERY_TTL_MS}) return;
      try { sessionStorage.setItem(KEY, String(Date.now())); } catch (_) {}
      location.reload();
    }, 1500);
  }
  setTimeout(inspect, 8000);
})();`;

declare global {
  interface Window {
    __MG_HYDRATED__?: boolean;
  }
}

export type BlankScreenMetrics = {
  visibleHeight: number;
  childCount: number;
  visuallyHidden: boolean;
};

/** Pure measurement — accepts any element so it's unit-testable in jsdom. */
export function measureRenderedHeight(root: Element | null): BlankScreenMetrics {
  if (!root) return { visibleHeight: 0, childCount: 0, visuallyHidden: true };
  const rect = root.getBoundingClientRect();
  let visuallyHidden = false;
  if (typeof window !== "undefined" && root instanceof HTMLElement) {
    let current: HTMLElement | null = root;
    while (current) {
      const style = window.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        visuallyHidden = true;
        break;
      }
      current = current.parentElement;
    }
  }
  return { visibleHeight: rect.height, childCount: root.childElementCount, visuallyHidden };
}

/** Pure predicate: is this measurement "blank"? */
export function isBlank(m: BlankScreenMetrics): boolean {
  return m.visibleHeight < BLANK_MIN_HEIGHT_PX || m.childCount === 0 || m.visuallyHidden;
}

function readRecentSessionFlag(key: string): boolean {
  try {
    const stored = Number(sessionStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 && Date.now() - stored < RECOVERY_TTL_MS;
  } catch {
    return false;
  }
}

function writeSessionFlag(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* noop */
  }
}

function clearSessionFlag(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

export type WatchdogOptions = {
  onReport?: (metrics: BlankScreenMetrics) => void;
};

/** Mounts the watchdog. Returns a cleanup fn. Safe to call from useEffect. */
export function mountBlankScreenWatchdog(opts: WatchdogOptions): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  // Avoid competing with a freshly rendered error boundary, but do not disable
  // recovery for the rest of the browser session after one historical crash.
  if (readRecentSessionFlag(CRASH_FLAG)) return () => {};

  // Preview is where stale HMR frames and interrupted portals are most likely,
  // so it needs the same protection as production. Keep an explicit opt-out
  // for tests or unusual local debugging sessions.
  const explicitlyDisabled =
    (import.meta.env?.VITE_ENABLE_BLANK_WATCHDOG as string | undefined) === "0";
  if (explicitlyDisabled) return () => {};

  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const measureRoot = () =>
    document.querySelector("main") ?? document.getElementById("app-root") ?? document.body;

  const runCheck = () => {
    if (cancelled) return;
    if (document.visibilityState !== "visible") return;

    const first = measureRenderedHeight(measureRoot());
    if (!isBlank(first)) {
      clearSessionFlag(RECOVERY_FLAG);
      return;
    }

    opts.onReport?.(first);

    timers.push(
      setTimeout(() => {
        if (cancelled) return;
        const second = measureRenderedHeight(measureRoot());
        if (!isBlank(second)) {
          clearSessionFlag(RECOVERY_FLAG);
          return;
        }
        // Guarded single hard reload per session.
        if (readRecentSessionFlag(RECOVERY_FLAG)) return;
        writeSessionFlag(RECOVERY_FLAG, String(Date.now()));
        window.location.reload();
      }, SECOND_CHECK_DELAY_MS),
    );
  };

  timers.push(setTimeout(runCheck, FIRST_CHECK_DELAY_MS));

  return () => {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
  };
}
