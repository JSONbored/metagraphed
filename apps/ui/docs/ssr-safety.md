# SSR safety checklist

Metagraphed renders on the edge (SSR) and hydrates in the browser. Any
browser-only API touched during module init, render, or a `useState`
initializer will either crash SSR or cause a hydration mismatch that blanks
the page.

Use this checklist before shipping code that touches `window`, `document`,
`navigator`, `localStorage`, `sessionStorage`, `matchMedia`, `WebSocket`,
`IntersectionObserver`, `ResizeObserver`, or `requestIdleCallback`.

## Rules

1. **Never read a browser API at module scope.** No top-level
   `const foo = window.matchMedia(...)`. Wrap in a function that callers
   invoke from `useEffect`, or gate with `typeof window !== "undefined"`.
2. **Never read a browser API inside a `useState` initializer.** Even a
   `typeof window` guard produces a hydration mismatch when the returning
   client render reads a stored value while the server rendered the default.
   Read it inside `useEffect` and `setState` from there.
3. **`useEffect` and event handlers are safe** — they only run in the browser.
4. **Shared helpers must self-guard.** If a util in `src/lib/*` may be imported
   by both a server-only file and a route file, start it with
   `if (typeof window === "undefined") return`.

## Automated check

The blank-screen watchdog (`src/lib/blank-screen-watchdog.ts`) plus the
`GlobalErrorBoundary` (`src/components/metagraphed/global-error-boundary.tsx`,
mounted in `src/routes/__root.tsx`) catch runtime regressions in production —
window error/rejection handlers and a rendered-height check report through
`reportLovableError`. The eslint `no-restricted-syntax` rules in
`eslint.config.js` block the two most common regressions (reading
`localStorage`/`matchMedia` inside a `useState` initializer) at PR time.

## Known safe entry points

- `THEME_BOOTSTRAP_SCRIPT` (`src/lib/theme.ts`), `DENSITY_BOOTSTRAP_SCRIPT`
  (`src/lib/density.ts`), and the health-palette bootstrap
  (`src/lib/health-palette.ts`) — inline scripts in `<head>` that set data
  attributes before hydration. Do not migrate these to React state.
- `useHydrated()` (`src/hooks/use-hydrated.ts`) — returns `false` during SSR
  and the first client render, `true` afterward. Use for render decisions
  that MUST differ between the two.
