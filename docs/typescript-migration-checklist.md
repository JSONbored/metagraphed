# TypeScript migration — per-file conversion checklist

Canonical checklist for the TypeScript migration tracked at
[#7510](https://github.com/JSONbored/metagraphed/issues/7510). Every phase issue under that epic
links here instead of restating this list — if a step here turns out to be wrong or incomplete once
exercised on real files, fix it here (and explain the change in the PR that found the gap), don't
fork a divergent copy in an issue body.

For every file in a batch:

1. `git mv <file>.mjs <file>.ts` — never copy+delete, preserve history.
2. Fix every relative import specifier repo-wide that pointed at the old filename, from `./foo.mjs`
   to `./foo.js` (TypeScript+NodeNext convention: the import specifier keeps a `.js`-shaped extension
   even though the source file is now `.ts` — never use `.ts` in an import specifier). Check dynamic
   `import()` calls too, not just static `import`/`export from`.
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
