# @jsonbored/ui-kit

Internal design-system component library for `apps/ui` — extracted into a real, buildable
package instead of living directly inside the app's `src/`. Not published to npm; consumed by
`apps/ui` as an npm workspace link.

Why this package exists: [#4867](https://github.com/JSONbored/metagraphed/issues/4867).

## Status

Design tokens, the shadcn-style `components/ui/*` primitives, the cross-cutting visual-language
components, and the chart primitives have all migrated
([#4861](https://github.com/JSONbored/metagraphed/issues/4861)-[#4864](https://github.com/JSONbored/metagraphed/issues/4864)).
`apps/ui` consumes everything from `@jsonbored/ui-kit`.

## Boundary rule: no app-specific imports

This package must stay a real, standalone, dependency-free library — the moment a component here
imports something app-specific, the extraction has silently regressed back into the exact problem
this package exists to fix. `eslint.config.ts`'s `no-restricted-imports` rule enforces this in CI:
importing `@tanstack/react-router`, `@tanstack/react-query`, or anything resolving into
`apps/ui/**` fails the build. If a component genuinely needs routing/data, accept it as a prop
from the caller instead. If it needs a small pure helper that's genuinely app-specific (a date
formatter tied to apps/ui's own conventions, a hook that reads apps/ui's config, etc.), duplicate
the specific piece needed rather than importing across the package boundary — see
`src/lib/format.ts` for the established pattern. Generic, app-agnostic helpers (a `cn()`-style
className joiner, etc.) should instead be authored here and exported from the public barrel, with
apps/ui re-exporting them (see `classNames`/`cn` below, #7847) — don't duplicate those.

### `classNames` vs `cn`

Both are exported from the package root. They have different semantics — pick deliberately:

- **`classNames`** — cheap `Boolean`-filter-and-join, no Tailwind conflict resolution. Use for
  static class assembly where nothing can collide.
- **`cn`** — `clsx` + `tailwind-merge`; resolves conflicting Tailwind utilities (e.g. two
  different `px-*` values collapse to the last one). Use where callers may pass a `className` prop
  that could conflict with the component's own classes.

## Build

```sh
npm run build --workspace=packages/ui-kit
```

Emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` (types), and
`dist/index.css` (extracted CSS, exported publicly as `@jsonbored/ui-kit/styles.css`) via
`tsup`. `dist/index.{js,cjs,css}` are committed (see `.gitignore`'s comment for why);
`.d.ts`/`.d.cts` are built fresh, not committed.
