# design-sync notes

## Repo shape

`apps/ui` is a TanStack Start **application** (SSR, routes, `nitro`/Cloudflare Worker
output), not a publishable component library — no `dist/`, no `main`/`module`/`exports`/
`types` in `package.json`. This forces the **package shape, synth-entry fallback**
(no `.storybook/` or `*.stories.*` exist anywhere in the monorepo either — confirmed
2026-07-11, both at `apps/ui` and repo-wide).

Tracked epic to fix this properly (extract a real `packages/ui-kit` library package
with a `tsup` build, following `packages/client`'s precedent):
https://github.com/JSONbored/metagraphed/issues/4867

## Interim scope (this sync)

Synth-entry mode's synthesized bundle entry `export *`s **every** `.tsx`/`.jsx` file
under `cfg.srcDir` — there's no per-file inclusion knob for the entry itself, only for
the discovered _component list_ (`cfg.componentSrcMap`). `apps/ui/src/components/`
has 144 files total, and most of `components/metagraphed/` (~100 files) are deep
product components tied to routing (`@tanstack/react-router`) or data-fetching
(`@tanstack/react-query`) — bundling them standalone would either fail outright or
render broken (no router/query context).

Fix: `cfg.srcDir` points at a **staged, symlinked, scoped copy**:
`apps/ui/.design-sync/.cache/scope-src/{primitives,core,charts}/` — symlinks (not
copies) into the real `src/components/{ui,metagraphed,metagraphed/charts}/` files,
so nothing goes stale. This directory is gitignored and rebuilt on demand — it is
**not** a source of truth, just a bundling-scope fence.

Every file was verified (2026-07-11) to import only `@/*`-aliased app modules (never
relative cross-component imports) and no `@tanstack/react-router`/`@tanstack/react-query`/
context hooks. **Explicitly excluded this round** (real app-context dependencies —
candidates for the packages/ui-kit epic once refactored to accept data via props):
`entity-hover-card.tsx`, `panel-shell.tsx`, `states.tsx`, `table-controls.tsx`,
`verify-surface-button.tsx`, `charts/activity-heatmap.tsx`, `charts/economics-mini.tsx`,
`charts/latency-heatmap.tsx`, `charts/subnet-pulse-grid.tsx`,
`charts/validator-subnet-heatmap.tsx`, `states/registry-empty.tsx`.

`cfg.componentSrcMap` explicitly enumerates every top-level component name (55 names
across the 44 files) rather than relying on `deriveComponentsFromSrc`'s blind
PascalCase scan — the 8 shadcn/Radix primitives (`ui/*.tsx`) export many compound
sub-parts (e.g. `dialog.tsx` → `Dialog, DialogTrigger, DialogContent, DialogHeader,
DialogFooter, DialogTitle, DialogDescription`) that can't render solo; there's no
`.d.ts` here for the tool's normal subcomponent-grouping (`dts.compounds`) to kick in,
so only the root compound name is pinned per primitive file. The `metagraphed/` and
`charts/` files export flat families of independent, genuinely standalone components
(e.g. `chips.tsx` → 5 chip variants) — all pinned individually.

`cfg.provider = {component: "TooltipProvider"}` — Radix's `Tooltip` needs an ancestor
`TooltipProvider`; wrapping it globally is harmless for every other component.

## Known render warns

Triaged 2026-07-11 by reading the actual screenshots — all benign, `[RENDER_THIN]`
false-positives from the text-node heuristic on components that are legitimately
icon/SVG-only (no text to detect, but real visual content confirmed by eye):

- `charts/MiniRadial` — a completeness ring icon, no label by design.
- `charts/SparkLegend` — authored; screenshot clearly shows a real sparkline under
  a "DEFAULT" cell label. The sparkline itself has no text nodes.
- `metagraphed/CopyIconToggle` — authored; both `Copied`/`Idle` cells show the
  real check/copy glyphs, just no text.
- `metagraphed/InfoTooltip` — a bare (i) icon, unauthored (floor card default is
  fine — it's inherently a tiny icon-only trigger).
- `metagraphed/Wordmark` — the real "metagraphed" logo mark + wordmark renders
  correctly; it's an SVG mark + styled text with no plain-text DOM the heuristic
  can see as "content".

`metagraphed/AccentBand` tripped `[GRID_OVERFLOW]` (full-bleed by design — it's
meant to escape its container) — fixed via `cfg.overrides.AccentBand.cardMode:
"column"`.

## Font weights — verified, not guessed

First pass shipped 400/500/600/700 for DM Sans and Space Grotesk, 400/500 for
JetBrains Mono — a rough guess from skimming a few files. Corrected 2026-07-11
by grepping every `font-(thin|extralight|light|normal|medium|semibold|bold|
extrabold|black|\[N\])` utility class across the whole of `apps/ui/src` (not
just the synced scope): the app uses exactly **400 (`font-normal`), 500
(`font-medium`), 600 (`font-semibold`)** — nowhere, in any component, does
`font-bold`/700 appear. Cross-checked which weights pair with `font-mono` in
the same `className` string specifically, since JetBrains Mono's real usage
(`font-mono ... font-semibold`, e.g. `rpc-proxy.tsx:152`,
`extrinsics.$hash.tsx:577`) would otherwise have been missed — the first pass
had only shipped 400/500 for mono. All three families now ship exactly
400/500/600 woff2, no more, no less. Re-run this grep if new weight classes
get added to the app before re-syncing — don't re-guess.

## Other findings (out of scope for this sync)

- `apps/ui/src/components/metagraphed/freshness.tsx`'s `FreshnessIndicator` JSDoc
  says "default 5 min" staleness threshold; the actual default in
  `isStaleFreshness` (`@/lib/metagraphed/format.ts:60`) is 12h (changed in a past
  fix — the old 5-minute default fired constantly and was noise). The comment is
  stale documentation, not a behavior bug. Worth a one-line doc fix separately;
  not touched here.

## Re-sync risks

- The excluded-file list above is **not enforced by tooling** — if `packages/ui-kit`
  (#4867) lands and this repo re-syncs against a real library build instead, this
  whole scope-src staging mechanism should be deleted and `cfg.srcDir`/
  `componentSrcMap` reset to point at the real package.
- Symlinks in `scope-src/` point at absolute local paths — regenerate on a fresh
  clone (see the staging script logic in the sync session, not yet turned into a
  committed script — a future re-sync should write one rather than re-deriving the
  file list by hand).
- No preview authoring happened for the full 44/55 in one pass — see the sync
  session's final report for which components got rich authored previews vs. shipped
  the honest floor card.
