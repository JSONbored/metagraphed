import { useHydrated as useRouterHydrated } from "@tanstack/react-router";

/**
 * False for SSR and the first browser render, then true after hydration.
 * Use this for non-suspense queries whose cache may be restored before React
 * hydrates HTML that was rendered with their fallback state.
 */
export function useHydrated(): boolean {
  return useRouterHydrated();
}
