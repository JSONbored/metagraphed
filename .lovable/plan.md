
# Metagraphed UX/Design Overhaul

## 1. Design system swap — "Soft Lime on Graphite"

Rewrite `src/styles.css` tokens (keep variable names so nothing else changes):

- Light (default, paper-white + citron)
  - `--paper #FFFFFF`, `--surface #F4F5F7`, `--ink-strong #0B0F14`, `--ink-muted` ~ slate-500, `--ink-subtle` ~ slate-400
  - `--accent #B8E000` (muted citron), `--accent-foreground #0B0F14`
  - `--border` = 8% ink, `--ring` = 40% accent
- Dark (graphite + soft lime)
  - `--paper #0F1115`, `--surface #1A1D23`, `--card #161A20`, `--ink-strong #E7E9EC`
  - `--accent #C8F26C`, `--accent-foreground #0F1115`
- Health stays traffic-light (green / amber / red / slate-unknown), tuned for both modes
- Curation: native = ink, verified = accent (lime), pilot = green, machine = soft violet, candidate = muted
- Typography unchanged (Space Grotesk display + DM Sans body + JetBrains Mono)
- Default density bumped to **Spacious**: increase base card padding, table row height, KPI tile size. Compact mode in Settings still works via existing `data-density="compact"` hook.

## 2. Decongestion + modern-minimal pass (global)

Component-level refinements (no business-logic changes):

- `ProfileHero`: drop redundant subline chips that repeat KPI strip values; merge chips into a single line; move "Last checked" + share button to a quiet meta row.
- `KPI strip`: max 4 tiles per row, larger numerals, smaller labels, hairline dividers only.
- Cards: remove double borders, switch to single 1px hairline + subtle elevation only on hover.
- Replace inline definitions with `Tooltip` icons (info `i` next to titles for: Curation, Completeness, Drift, Freshness, Surfaces, Candidates, Pool eligibility).
- Add `MetricChip` micro-component with hover tooltip for numeric badges.
- Add subtle row hover + focus rings using accent at 25% alpha.
- Empty/stale/error states reuse `EmptyState` / `ErrorState` / `StaleBanner` with consistent "Last checked <TimeAgo/>" + "Open API URL" + back-link recovery.

## 3. Provider profile (`/providers/$slug`) cleanup

- Audit every tab section (Overview, Endpoints, Surfaces, Schemas, Evidence, API). Each section MUST render exactly one of: data, `EmptyState`, `StaleBanner`, `ErrorState` — no placeholder blocks.
- Add "Last checked" line to Overview, Endpoints, Schemas, Evidence cards.
- Recovery links: EmptyState → `/providers`, ErrorState → API URL + retry; Schemas drift empty → `/schemas`.
- Remove the duplicated provider description appearing in both hero and overview card.

## 4. "Endpoints at a glance" compact card

New `EndpointsGlance` component used on `/subnets/$netuid` (top of Overview, above current Endpoints table) and `/providers/$slug` Overview:

- 3 mini-rows: Root RPC/WSS, SSE/Data streams, Incidents (24h)
- Each shows: count, top 1 example endpoint (host masked), health dot
- Right-side "Expand" toggle → smoothly reveals the full endpoint table inline (no nav). Closed by default on mobile.
- Honors current endpoint source (`subnetEndpointsQuery` / `providerEndpointsQuery`); no new API calls.

## 5. Mobile-friendly tables (stacked cards)

New shared `ResponsiveTable` wrapper (or `useBreakpoint('md')` switch) in `src/components/metagraphed/`:

- ≥ md: existing table layout (kept).
- < md: each row becomes a card with label : value pairs, primary cell as card title, secondary chips below, action row at bottom.
- Filters / sort controls move into a sticky `TableControls` bar that wraps and stacks: search input full-width, then chip-style filter dropdowns, then a sort `Select`. No horizontal scroll required.
- Applied to: subnets index, providers index, endpoints, surfaces, schemas, gaps, plus inline tables on subnet/provider profile pages.

## 6. Deep-linkable section anchors on profile pages

- Each major section inside the active profile tab gets a stable `id` (`endpoints`, `surfaces`, `schema-drift`, `gaps`, `evidence`, `candidates`, `api`).
- Section headers render an "anchor" copy-icon button that:
  - sets `location.hash` (`#endpoints`)
  - copies the absolute URL to clipboard with a toast
- On mount + on hash change, smooth-scroll to the matching `id`. Plays nicely with existing `?tab=` deep links (`/subnets/7?tab=overview#endpoints`).
- If the hash references a section that lives under a different tab, the page auto-switches tabs before scrolling.

## 7. Files to add / edit

Add:
- `src/components/metagraphed/endpoints-glance.tsx`
- `src/components/metagraphed/responsive-table.tsx`
- `src/components/metagraphed/section-anchor.tsx`
- `src/components/metagraphed/metric-chip.tsx`
- `src/components/metagraphed/info-tooltip.tsx`

Edit:
- `src/styles.css` — full token rewrite (Soft Lime on Graphite + paper-white)
- `src/components/metagraphed/profile-hero.tsx`, `profile-tabs.tsx`, `coverage-card.tsx`, `primary-links-rail.tsx`, `states.tsx`, `table-controls.tsx`, `freshness.tsx`
- `src/routes/subnets.$netuid.tsx`, `providers.$slug.tsx`, `providers.index.tsx`, `subnets.index.tsx`, `endpoints.tsx`, `surfaces.tsx`, `schemas.tsx`, `gaps.tsx`, `health.tsx`, `index.tsx`, `about.tsx`

## 8. Out of scope (intentionally)

- No changes to `src/lib/metagraphed/queries.ts` or API contracts.
- No new data sources; "Endpoints at a glance" reuses existing endpoint payloads.
- No in-app contribution forms; gap recovery links continue pointing to GitHub.
- Routing topology (`subnets.index.tsx`, `subnets.$netuid.tsx`, etc.) stays as-is.

## Verification

After build:
- Toggle light/dark — confirm accent renders as citron/soft-lime, contrast passes on text.
- Visit `/subnets/5`, `/subnets/1`, `/providers/<slug>` — every section shows data or a proper state; no empty rectangles.
- Resize to mobile — tables collapse to cards, filters/sort remain reachable without horizontal scroll.
- Hit `/subnets/7?tab=overview#endpoints` directly — scrolls to Endpoints section.
- Click section anchor icon — clipboard receives the deep link, toast fires.
