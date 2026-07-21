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

## `workers/` specifics: typing `env` and Workers runtime globals

Do **not** hand-roll an `Env` interface or reach for `@cloudflare/workers-types`. Wrangler generates
accurate types directly from each `wrangler*.jsonc`'s actual bindings via `npm run types:workers`,
which writes three committed, generated `.d.ts` files:

- `workers/worker-configuration.d.ts` — full Workers runtime types (`Request`, `Response`,
  `KVNamespace`, `R2Bucket`, `DurableObjectNamespace`, ...) plus the `api` Worker's `Env` bindings,
  generated from `wrangler.jsonc`.
- `workers/data-api.worker-configuration.d.ts` / `workers/registry-sync-api.worker-configuration.d.ts`
  — `Env`-only (`--include-runtime=false`, to avoid ~14.7k lines of duplicate runtime-type
  boilerplate per file), generated from `wrangler.data.jsonc` / `wrangler.registry.jsonc`.

All three declare a global ambient `Env` interface; TypeScript's interface merging combines them into
one superset covering every binding across all three Workers (`workers/http.mjs`-style leaf files are
imported by more than one Worker, so a single shared `Env` is simpler than threading three distinct
per-Worker types through shared files). This is a deliberate, known trade-off: a file can reference an
`env.SOME_OTHER_WORKERS_BINDING` field that doesn't actually exist in its own Worker's real deployment
without `tsc` catching it. Accept this — do not attempt to build separate precise per-Worker `Env`
types for shared files; the complexity isn't worth it for what it would catch.

Re-run `npm run types:workers` and commit the result whenever `wrangler*.jsonc`'s bindings change —
same generated-artifact discipline as `packages/contract/index.d.ts`, never hand-edit these files.

A field/const in Env not declared in any wrangler\*.jsonc `vars` block (a dashboard-set secret, a
`wrangler secret put` value) needs a hand-written entry in `workers/env-extra.d.ts` instead — see that
file's own header comment. Add fields there as you encounter a real `env.X` access that needs one;
don't add one speculatively.

**`setTimeout`/`clearTimeout` return-type gotcha:** this repo's root `tsconfig.json` has no `types`
restriction (Phase 0), so `@types/node`'s global `setTimeout` (returning `NodeJS.Timeout`) and the
Workers-generated one (returning `number`) are both ambient — TypeScript resolves the global
`setTimeout`/`clearTimeout` to Node's versions repo-wide, even inside a `workers/` file that only ever
actually runs under real Workers runtime (or under Vitest's Node-based test environment). Don't type a
timer-handle field as `ReturnType<typeof setTimeout> | null` and expect it to round-trip cleanly through
`clearTimeout` — a `Timeout | null` union doesn't cleanly match either of `clearTimeout`'s overloads even
though each half individually would. Cast at the `clearTimeout(...)` call site instead
(`as unknown as number`, with a one-line comment pointing back here) rather than fighting the global
ambiguity file-by-file.
