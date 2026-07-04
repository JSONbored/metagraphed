import { useEffect, useState, useCallback } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const STORAGE_KEY = "mg-theme";

/** Resolved mode (what the document actually shows). */
export type ResolvedTheme = "light" | "dark";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function readChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const resolved: ResolvedTheme =
    choice === "system" ? (systemPrefersDark() ? "dark" : "light") : choice;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  return resolved;
}

/**
 * Pre-hydration script. Inlined in <head> so the first paint matches the
 * stored or system preference and there's no flash of the wrong theme.
 * Mirrors readChoice() + apply() above; keep them in sync.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  try {
    var v = localStorage.getItem("${STORAGE_KEY}");
    if (v !== "light" && v !== "dark") v = "system";
    var dark = v === "dark" || (v === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    var r = document.documentElement;
    if (dark) r.classList.add("dark"); else r.classList.remove("dark");
    r.dataset.theme = dark ? "dark" : "light";
  } catch (_) {}
})();`;

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());
  // Initialize to a fixed "light" so the server render and the first client
  // render agree — the effect below syncs `resolved` to the real theme right
  // after mount, and the pre-hydration THEME_BOOTSTRAP_SCRIPT has already set
  // the document class for a flash-free first paint. Reading the (bootstrap-set)
  // document class during the initial render instead diverges from the server's
  // "light" and trips a hydration mismatch on every theme-param'd value — e.g.
  // BrandIcon's `?theme=light|dark` icon-proxy URL.
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  // Apply choice + listen to system changes while in `system` mode.
  useEffect(() => {
    setResolved(apply(choice));
    if (choice !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(apply("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.add("theme-transition");
      window.setTimeout(() => document.documentElement.classList.remove("theme-transition"), 220);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore quota / privacy-mode errors
    }
    setChoiceState(next);
  }, []);

  return { choice, resolved, setChoice };
}
