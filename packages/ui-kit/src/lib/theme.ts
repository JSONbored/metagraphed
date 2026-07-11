// Duplicated from apps/ui/src/lib/theme.ts -- that file also owns the app's
// pre-hydration bootstrap script (THEME_BOOTSTRAP_SCRIPT/bootstrapTheme),
// which isn't needed here. Only the live useTheme() hook BrandIcon reads
// (theme-aware icon sourcing) comes along; keep both copies' choice/resolve
// logic in sync if either changes.

import { useEffect, useState, useCallback } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "mg-theme";

/** Normalizes a stored/local value to a valid theme choice. */
export function normalizeThemeChoice(
  value: string | null | undefined,
): ThemeChoice {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/** Resolved mode (what the document actually shows). */
export type ResolvedTheme = "light" | "dark";

/** Resolves the document theme from a choice and the current system preference. */
export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): ResolvedTheme {
  return choice === "system" ? (prefersDark ? "dark" : "light") : choice;
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function readChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const resolved = resolveTheme(choice, systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  return resolved;
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readChoice());
  // Initialize to a fixed "light" so the server render and the first client
  // render agree -- the effect below syncs `resolved` to the real theme right
  // after mount, and the app's THEME_BOOTSTRAP_SCRIPT has already set the
  // document class for a flash-free first paint.
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

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
      window.setTimeout(
        () => document.documentElement.classList.remove("theme-transition"),
        220,
      );
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore quota / privacy-mode errors
    }
    setChoiceState(next);
  }, []);

  return { choice, resolved, setChoice };
}
