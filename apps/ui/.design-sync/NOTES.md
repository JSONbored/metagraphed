# design-sync notes

## Repo shape (RESOLVED 2026-07-26 — was the interim-scope blocker below)

`packages/ui-kit` (`@jsonbored/ui-kit`) is now a real, buildable component
library package — the extraction epic (#4867) landed. It has a real
`tsup src/index.ts --format esm,cjs --dts --dts-resolve --clean --treeshake`
build, ships `main`/`module`/`types`/`exports` in `package.json`, and
`npm run build` (verified 2026-07-26) produces a genuine `dist/index.js`,
`dist/index.cjs`, `dist/index.d.ts` (86KB, real declarations), `dist/index.css`
(30KB, tokens + `@font-face` for all three families baked in), and the woff2
font files alongside it. `dist/index.js`/`dist/index.cjs`/`dist/index.css`/
`*.woff2` are committed (see `packages/ui-kit/.gitignore`'s comment — the
runtime bundle ships so `apps/ui`'s Cloudflare Workers Build never needs to
rebuild a sibling workspace package); `dist/index.d.ts`/`.d.cts` are gitignored
and built fresh by CI/local dev.

`apps/ui` no longer has its own copy of these components at all — everything
that used to live at `apps/ui/src/components/{ui,metagraphed,metagraphed/charts}/`
was migrated into `packages/ui-kit/src/components/{ui,metagraphed}/` (charts
now sit at `metagraphed/charts/`, same as before). `apps/ui` consumes the
package like any other workspace dependency (`@jsonbored/ui-kit`, resolved via
the npm workspaces symlink at `node_modules/@jsonbored/ui-kit` ->
`packages/ui-kit`) and imports its styles via
`@import "@jsonbored/ui-kit/styles.css"`.

**This closes out the "synth-entry fallback" workaround described below** —
that whole section is now historical. `cfg.srcDir`/`cfg.tsconfig`/
`cfg.cssEntry` were repointed at the real package (`../../packages/ui-kit/...`,
relative to `apps/ui/` — same root every other path in `config.json` resolves
against) instead of the old staged/symlinked/gitignored scope-src cache, and
`cfg.extraFonts` was dropped entirely since `dist/index.css` already ships
every `@font-face` rule needed (verified 2026-07-26: 9 `@font-face` blocks
covering all three families' 400/500/600 weights, pointing at the co-located,
committed woff2 files in the same `dist/` directory — no separate fonts-src
build step needed anymore). `cfg.pkg` changed from `"metagraphed-ui"` (the
`apps/ui` app's own `package.json` name — never correct for this purpose, but
was the only package-shaped thing available at the time) to
`"@jsonbored/ui-kit"`, the real published-shape package name.

Whether `cfg.shape: "package"` still needs an explicit `srcDir` at all once
pointed at a genuinely real package (vs. resolving `pkg` purely through normal
module resolution against `dist/index.d.ts`) is an open question the sync
tool's own internals would have to answer — this repo has no visibility into
the `/design-sync` tool's implementation, only its config contract. Left
`srcDir` set (repointed at the real source) as the safe choice: harmless if
unnecessary, required if the tool still wants a source tree to scan per-file
for the component list. A future live sync session, which does have the
interactive tooling, should try dropping it first.

### Original text, for context (now historical)

`apps/ui` is a TanStack Start **application** (SSR, routes, `nitro`/Cloudflare
Worker output), not a publishable component library — no `dist/`, no
`main`/`module`/`exports`/`types` in `package.json`. This forced the
**package shape, synth-entry fallback** (no `.storybook/` or `*.stories.*`
exist anywhere in the monorepo either — confirmed 2026-07-11, both at
`apps/ui` and repo-wide).

## Interim scope (historical — this sync predates the packages/ui-kit extraction)

Synth-entry mode's synthesized bundle entry `export *`s **every** `.tsx`/`.jsx`
file under `cfg.srcDir` — there's no per-file inclusion knob for the entry
itself, only for the discovered _component list_ (`cfg.componentSrcMap`).
`apps/ui/src/components/` had 144 files total at the time, and most of
`components/metagraphed/` (~100 files) were deep product components tied to
routing (`@tanstack/react-router`) or data-fetching (`@tanstack/react-query`)
— bundling them standalone would either fail outright or render broken (no
router/query context).

The old fix: `cfg.srcDir` pointed at a **staged, symlinked, scoped copy**:
`apps/ui/.design-sync/.cache/scope-src/{primitives,core,charts}/` — symlinks
(not copies) into the real `src/components/{ui,metagraphed,metagraphed/charts}/`
files, so nothing went stale. That directory was gitignored and rebuilt on
demand — never a source of truth, just a bundling-scope fence. **This staging
mechanism no longer exists and should not be recreated** — `packages/ui-kit`
already only contains the presentational, context-free component layer (the
Phase 0 audit, #4859, did the same "which components are safe to bundle
standalone" classification that this staging step used to do by hand), so
`cfg.srcDir` can point straight at its real `src/`.

Every file was verified (2026-07-11) to import only `@/*`-aliased app modules
(never relative cross-component imports) and no `@tanstack/react-router`/
`@tanstack/react-query`/context hooks. **Explicitly excluded that round** (real
app-context dependencies): `entity-hover-card.tsx`, `panel-shell.tsx`,
`states.tsx`, `table-controls.tsx`, `verify-surface-button.tsx`,
`charts/activity-heatmap.tsx`, `charts/economics-mini.tsx`,
`charts/latency-heatmap.tsx`, `charts/subnet-pulse-grid.tsx`,
`charts/validator-subnet-heatmap.tsx`, `states/registry-empty.tsx` — none of
these are part of `packages/ui-kit` today either (`packages/ui-kit` only ever
took the presentational layer; app-context components correctly stayed behind
in `apps/ui`), so this exclusion list is now enforced structurally by the
package boundary itself rather than by hand-curation.

`cfg.componentSrcMap` explicitly enumerates every top-level component name
rather than relying on `deriveComponentsFromSrc`'s blind PascalCase scan — the
8 shadcn/Radix primitives (`ui/*.tsx`) export many compound sub-parts (e.g.
`dialog.tsx` -> `Dialog, DialogTrigger, DialogContent, DialogHeader,
DialogFooter, DialogTitle, DialogDescription`) that can't render solo; only
the root compound name is pinned per primitive file. The `metagraphed/` and
`charts/` files export flat families of independent, genuinely standalone
components (e.g. `chips.tsx` -> 5 chip variants) — all pinned individually.
This reasoning still holds and is why the map stays a hand-curated allowlist
rather than switching to auto-discovery now that a real `.d.ts` exists.

`cfg.provider = {component: "TooltipProvider"}` — Radix's `Tooltip` needs an
ancestor `TooltipProvider`; wrapping it globally is harmless for every other
component.

## componentSrcMap staleness fix (2026-07-26)

All 44 file paths (55 component names) in `cfg.componentSrcMap` pointed at
`apps/ui/src/components/...` paths that no longer exist — the `packages/ui-kit`
migration (#4867 and its component-migration sub-issues, #4862-#4864) moved
every one of those files into `packages/ui-kit/src/components/...` and the
config was never updated to follow. Audited every entry against the new
package (2026-07-26):

- **53 of 55 names** mapped cleanly 1:1 onto their new
  `packages/ui-kit/src/components/...` path — same filename, same directory
  structure, just rooted differently. Repointed, confirmed each still exports
  the exact named symbol the config claims (regex-checked against the real
  file, then confirmed via `tsc --noEmit` against the real package + a
  standalone typecheck of every `.design-sync/previews/*.tsx` file importing
  from `"@jsonbored/ui-kit"` through the npm-workspaces symlink).
- **`FreshnessBadge`** (`freshness-badge.tsx`) — **dropped**. The file, its
  test, and all four of its exports (`FreshnessTier`, `freshnessTierLabel`,
  `freshnessDotClass`, `freshnessBadgeTimeCopy`, `FreshnessBadge`) were deleted
  outright in #6448 ("drop the dead FreshnessBadge family from the barrel") —
  it was never adopted anywhere in `apps/ui`, unlike its sibling
  `FreshnessIndicator`. `FreshnessTier` survived (moved into `freshness.tsx`,
  its only remaining consumer) but the component itself is gone. There is
  nothing left to point this entry at.
- **`ListCard`** (was mapped to `list-shell.tsx` alongside `ListShell` and
  `LoadMore`) — **dropped**. Removed as an unused export in #6379/#6538
  ("drop the unused ListCard export"). `list-shell.tsx` now only exports
  `ListShell` and `LoadMore`. Its stale preview,
  `.design-sync/previews/ListCard.tsx`, was deleted alongside the config
  entry — it authored variants of a component that no longer exists.
- **`DailyRollupFreshness`** — **added**. Not in the old map, but it lives in
  `freshness.tsx` (already an in-scope file via `FreshnessIndicator`) as a
  standalone, independently-exported, already-in-production component (used in
  `metagraph-panel.tsx`, `neuron-detail-card.tsx`, `validators-panel.tsx`).
  See "#4872 status" below — this closes that issue's `componentSrcMap`
  requirement specifically, not the whole issue.

Net: 55 names -> 54 (2 dropped, 1 added), 44 files -> 43 (the `freshness-badge.tsx`
path is gone entirely; `list-shell.tsx` was already counted once for its
remaining two exports).

## #4872 status ("Add DailyRollupFreshness to the design-sync scope")

**Partially resolved by this fix, not fully closed.** #4872 had five
requirements:

1. Add `DailyRollupFreshness` to `cfg.componentSrcMap` — **done**, as part of
   the staleness sweep above (it would have been added regardless, since
   `freshness.tsx` was already in scope and `DailyRollupFreshness` is a real
   standalone export of it).
2. Symlink it into the old `scope-src/core/` staging directory — **moot**,
   that staging mechanism no longer exists (see "Repo shape" above); nothing
   to symlink into anymore.
3. Author a `.design-sync/previews/DailyRollupFreshness.tsx` preview —
   **still outstanding**. Not done here; this pass was scoped to fixing
   config/NOTES drift, not authoring new previews.
4. Rebuild, validate (0 `bad` in the render check), capture, grade `good` —
   **still outstanding**, requires the live `/design-sync` interactive
   tooling this pass explicitly did not run.
5. Re-upload to the live Claude Design project — **still outstanding**, same
   reason.

So #4872 remains open as a real, distinct task — items 3-5 need a live sync
session with the interactive tooling. Item 1 (and item 2, by virtue of no
longer applying) are done as a side effect of this fix, not as a substitute
for the rest of the issue.

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
"column"`. Still applies; `AccentBand` migrated into `packages/ui-kit` unchanged
on this front.

These render warns predate the `packages/ui-kit` migration and haven't been
re-verified against the new package build — a future live sync session should
re-run the render check rather than assume these still hold, since the
component source did move (even if the specific files listed above didn't
change their layout logic in the move).

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

Verified 2026-07-26: `packages/ui-kit/dist/index.css` still ships exactly
these three weights per family (9 `@font-face` blocks total), now built from
`packages/ui-kit/src/styles.css` (the token system's new home, extracted from
`apps/ui/src/styles.css` in #4861) rather than the old fonts-src cache step.

## Other findings (out of scope for this sync)

- `packages/ui-kit/src/components/metagraphed/freshness.tsx`'s
  `FreshnessIndicator` JSDoc said "default 5 min" staleness threshold; the
  actual default in `isStaleFreshness` (`@/lib/metagraphed/format.ts:60`) is
  12h (changed in a past fix — the old 5-minute default fired constantly and
  was noise). Was stale documentation, not a behavior bug, as of 2026-07-11 —
  not re-checked in this pass; if still present it's still just a one-line
  doc fix, not touched here either.

## Re-sync risks

- `cfg.srcDir` now points at `packages/ui-kit/src` directly (real, canonical
  source, not a staged copy) — regenerating a scope-src cache is no longer
  part of the workflow. Don't recreate it.
- No preview authoring happened for `DailyRollupFreshness` in this pass — see
  "#4872 status" above. A future sync session should treat that as the next
  concrete gap to close, not re-derive it from scratch.
- This pass did not re-run the live `/design-sync` tooling (interactive-only,
  out of scope here) — `cfg.json`/`NOTES.md` are corrected and every path was
  confirmed to resolve via `tsc --noEmit` (both `packages/ui-kit`'s own
  typecheck and a standalone check of all `.design-sync/previews/*.tsx` files
  against the real package through the npm-workspaces symlink), but nothing
  was re-uploaded to the live Claude Design project. That's the next session's
  job, starting from an accurate map instead of a broken one.
