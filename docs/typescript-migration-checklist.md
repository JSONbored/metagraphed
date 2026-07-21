# TypeScript migration — per-file conversion checklist

Canonical checklist for the TypeScript migration tracked at
[#7510](https://github.com/JSONbored/metagraphed/issues/7510). Every phase issue under that epic
links here instead of restating this list — if a step here turns out to be wrong or incomplete once
exercised on real files, fix it here (and explain the change in the PR that found the gap), don't
fork a divergent copy in an issue body.

For every file in a batch:

1. `git mv <file>.mjs <file>.ts` — never copy+delete, preserve history.
2. Fix every relative import specifier repo-wide that pointed at the old filename, from `./foo.mjs`
   to `./foo.ts` — literal `.ts` extension, not `.js`. (The `.js`-specifier-resolves-to-`.ts`-file
   convention is a `tsc`-only trick that assumes a compile step emitting real `.js` output; it does
   **not** work here, verified empirically: plain `node` throws `ERR_MODULE_NOT_FOUND` when an
   `.mjs`/`.ts` file imports `"./foo.js"` and only `foo.ts` exists on disk, since `scripts/` and much
   of `tests/` run directly under `node`, not through a bundler. Root `tsconfig.json` sets
   `allowImportingTsExtensions: true` for exactly this reason — Wrangler's esbuild bundler and Vitest
   both resolve a literal `.ts` specifier natively too, so this one convention works everywhere in
   this repo: plain `node`, Wrangler, and Vitest alike.) Check dynamic `import()` calls too, not just
   static `import`/`export from`.
3. Add real type annotations for every exported function's parameters/return type and every exported
   constant's shape. Do not just rename-and-ship untyped. Module-local helpers can rely on inference
   where TS already infers correctly.
4. Replace any JSDoc `@param`/`@type`/`@typedef` blocks with real TS types/interfaces and delete the
   JSDoc.
5. Where a shape already exists in the generated OpenAPI types (`packages/contract`,
   `public/metagraph/types.d.ts`), import and reuse it — do not hand-redeclare it.
6. `npx tsc --noEmit` must be clean for the file. No `any` / `@ts-ignore` / `@ts-expect-error` without
   an inline comment explaining the specific reason (e.g. a genuinely untyped third-party import).
7. Confirm the file is covered by `vitest.config.mjs`'s `coverage.include` (widened to `.{mjs,ts}`
   repo-wide in #7511, so after that PR this is a verification step, not an edit).
8. Run `npm run lint`, `npm run typecheck`, `npm run test:coverage`, and `npm run validate:types`
   locally — all must stay green, and the file's own coverage % must not regress.
9. Do not touch any file outside the batch's explicit list in the same PR.
