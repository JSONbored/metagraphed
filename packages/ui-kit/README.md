# @jsonbored/ui-kit

Internal design-system component library for `apps/ui` — extracted into a real, buildable
package instead of living directly inside the app's `src/`. Not published to npm; consumed by
`apps/ui` as an npm workspace link.

Why this package exists: [#4867](https://github.com/JSONbored/metagraphed/issues/4867).

## Status

Scaffold only ([#4860](https://github.com/JSONbored/metagraphed/issues/4860)) — no real
components have migrated yet. `PlaceholderCard` exists only to prove the build pipeline (JS +
`.d.ts` + CSS extraction) works end to end; it's removed once the first real component lands.

## Build

```sh
npm run build --workspace=packages/ui-kit
```

Emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` (types), and
`dist/index.css` (extracted CSS, exported publicly as `@jsonbored/ui-kit/styles.css`) via
`tsup`. `dist/index.{js,cjs,css}` are committed (see `.gitignore`'s comment for why);
`.d.ts`/`.d.cts` are built fresh, not committed.
