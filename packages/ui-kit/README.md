# @jsonbored/ui-kit

The design system for [metagraph.sh](https://metagraph.sh). A real, buildable package rather
than a folder inside the app ([#4867](https://github.com/JSONbored/metagraphed/issues/4867)) —
not published to npm, consumed by `apps/ui` as an npm workspace link.

**The live document is [`/design/primitives`](https://metagraph.sh/design/primitives).** Every
primitive below has a section there: a working specimen, a table of its props read off the
component's own `interface`, and a footnote of measured anatomy. Read it before reaching for a
raw value or re-implementing something that exists.

## The contract

Two faces of one family (Geist for text, Geist Mono for identifiers, figures and code). Three text sizes in the body
(10 / 11 / 13) and three display sizes (16 / 28 / 40, plus 64 on the home hero). `letter-spacing:
normal` everywhere except a table header. **One** border radius, 4px — the only round element on
the site is the 8×8 status dot. Flat surfaces: no resting shadow, no gradient, no hover lift, no
perpetual animation except the 2px route-transition bar, which stops under
`prefers-reduced-motion`.

Eleven categorical chart colours (`--chart-1`…`--chart-11`), reserved for distinct series and
stable across a page. The brand accent identifies, focuses and marks live state; it is never a
series colour, and semantic good / warn / bad are separate again.

**A page answers one question in at most seven sections.** `AnalyticsPage` throws above seven
outside production, and the `token-inventory` e2e asserts it for every route. Each section is a
name, one sentence, one visual, and a measured footnote — never a KPI grid restating the visual
above it.

**Every number is evidence.** A value on screen is read from an API the page declares with
`useRegisterApiSource`, which the shell footer shows and the HAR-coverage gate reads. A value with
no source does not go on the page.

## The primitives

| Primitive                                                                          | What it is                                                                                     |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `AnalyticsPage` · `AnalyticsSection` · `SectionHead` · `SectionNav`                | The document layer: a page of at most seven named sections and the nav over their headings.    |
| `EntityHero`                                                                       | Crumbs, name, avatar, one sentence, a fact strip, a live stamp — the top of every entity page. |
| `FactSentence` · `Fact` · `FactStrip` · `FactCell`                                 | A claim in a sentence, and the two-to-six numbers under it.                                    |
| `LiveMeta`                                                                         | "as of block N · 4s ago" — one per page.                                                       |
| `RangeControl`                                                                     | A window switch (7d / 30d / 90d). One tablist idiom, site-wide.                                |
| `Raw` · `RawRow` · `RawCode`                                                       | The identifiers and source URLs behind a page, in a disclosure.                                |
| `Definition`                                                                       | A `?` beside a label that explains the term where it is used.                                  |
| `DataTable`                                                                        | Every table: sort, page, column menu, CSV, row expansion, entity marks, cards below 640px.     |
| `StackedColumns` · `LineWithWindow`                                                | Composition over time; one series with a window and markers.                                   |
| `RankedRails` · `MarkerRail` · `RankGrid` · `LeaderCards` · `CompositionBreakdown` | Five answers to "which is largest?", sharing entity keys so hovering one lights the rest.      |
| `CompareLedger`                                                                    | Two-to-four entities, one row per measure.                                                     |
| `FilterField` · `FilterInput` · `FilterSelect` · `LoadMore`                        | Narrowing a list and fetching more of it.                                                      |
| `ActiveEntity` · `useEntityMark` · `ChartTooltip`                                  | One active-entity flag, fanned out page-wide; the tooltip every mark shares.                   |
| `CopyableCode` · `Sheet` · `BrandIcon`                                             | A copyable value, a side panel, an entity's icon.                                              |

## Boundary rule: no app-specific imports

This package stays standalone: the moment a component here imports something app-specific, the
extraction has regressed into the problem it exists to fix. `eslint.config.ts`'s
`no-restricted-imports` enforces it — `@tanstack/react-router`, `@tanstack/react-query` or
anything resolving into `apps/ui/**` fails the build. A component that needs routing or data
accepts it as a prop (`link`, `rows`); a genuinely app-specific helper is duplicated rather than
imported across the boundary. Generic helpers are authored HERE and re-exported by apps/ui.

### `classNames` vs `cn`

Both are exported. **`classNames`** is a cheap Boolean-filter-and-join with no Tailwind conflict
resolution — for static assembly where nothing can collide. **`cn`** is `clsx` +
`tailwind-merge`, which collapses conflicting utilities — for anywhere a caller's `className`
prop could fight the component's own classes.

## Build

```sh
npm run build --workspace=packages/ui-kit
```

Emits `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` (types) and
`dist/index.css` (exported as `@jsonbored/ui-kit/styles.css`) via `tsup`.
`dist/index.{js,cjs,css}` are committed (see `.gitignore`'s comment for why); the `.d.ts` files
are built fresh.
