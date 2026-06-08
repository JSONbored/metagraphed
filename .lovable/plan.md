# Metagraphed UX Audit & Fixes

## 1. Provider routing & list bugs (root cause)

The `/api/v1/providers` payload uses `id`, `website_url`, `github_url` — it does **not** include `slug`, `homepage`, `endpoints_count`, or `surfaces_count`. Today:

- `providersQuery` returns raw items unchanged, so `p.slug` is `undefined` on cards → clicking sends you to `/providers/undefined`.
- The list cards render hardcoded "endpoints / surfaces" tiles that always read `—` because those fields aren't in the list response.

**Fixes**
- Add a `normalizeProviderListItem` in `queries.ts` and map every row in `providersQuery` (mirroring `normalizeProvider`): `slug = id ?? slug`, hoist `website_url → website/homepage`, `github_url → repo`, preserve `kind`, `authority`, `name`, `notes`.
- In `src/routes/providers.index.tsx`: use the normalized `slug` everywhere; replace the empty endpoint/surface count tiles with fields the list actually provides (authority + kind chips, website host, github host). Add accent-tinted hover ring + a small lime "verified/official" dot when `authority === "official"`.

## 2. Accent (Soft Lime) is invisible

Today only one progress bar uses `bg-accent`. Add tasteful accent moments without going neon:

- Active profile tab: underline + label tint in `--accent`.
- KPI tiles: 2px accent top-rule on the hero stat strip.
- Section anchors: copy-link icon hover → accent.
- Curation chips: `native` and `verified` chips use accent-tinted background (`color-mix(in oklab, var(--accent) 14%, transparent)`).
- `HealthDot` `ok` state: switch to accent in dark mode (keep emerald in light for contrast).
- Primary CTA links (`ExternalLink`, "Browse all …" recovery buttons): accent underline on hover.
- Brand wordmark: accent dot after "Metagraphed".

All driven by tokens already in `src/styles.css` — no new colors.

## 3. Provider profile audit (every section)

Walk `src/routes/providers.$slug.tsx` + every loader/panel:

- Overview → `EndpointsGlance`, `SubnetsServedGrid (compact)`
- Endpoints tab → `EndpointList`
- Subnets served tab → `SubnetsServedGrid`
- API tab → canonical URLs
- Sidebar → `BreakdownCard` (by kind / status / layer)

For each: confirm the render returns exactly one of *data*, `EmptyState`, `StaleBanner`, or `ErrorState`. Every empty/error state passes `lastChecked={meta?.generated_at}` and a recovery `action`. Remove any "—" / skeleton-as-permanent block. Sidebar breakdowns: when undefined, show one consolidated `EmptyState` instead of three blank cards.

## 4. Standardized recovery links

Centralize in `src/components/metagraphed/states.tsx`:

```ts
export const RECOVERY = {
  schemas:   { label: "Browse all schemas",   href: "/schemas" },
  endpoints: { label: "Browse all endpoints", href: "/endpoints" },
  providers: { label: "Browse all providers", href: "/providers" },
  subnets:   { label: "Browse all subnets",   href: "/subnets" },
  surfaces:  { label: "Browse all surfaces",  href: "/surfaces" },
  openapi:   { label: "Open API reference",   href: "/schemas#openapi" },
};
```

Replace ad-hoc `action={{ label, href }}` literals across subnet + provider profiles with these constants so labels are identical everywhere. Schema-drift / API-related empty states default to `RECOVERY.openapi` + `RECOVERY.schemas`; endpoint-related ones to `RECOVERY.endpoints`.

## 5. Endpoints-at-a-glance polish (mobile-first)

In `endpoints-glance.tsx`:

- Tap targets ≥44px on each bucket row.
- Replace pure `display:none` with a `max-height` + `opacity` transition (160ms) for "feels fast" expansion.
- On expand, `scrollIntoView({ behavior: "smooth", block: "nearest" })` on the inline list wrapper so the first row is in view on small screens.
- Sticky "Hide full list" button at the bottom of the expanded panel on `< md`.
- Default `defaultOpen` to `true` on `≥ md`, `false` on `< md` (read once via `useIsMobile`).
- Add `aria-controls` + a unique `id` on the expanded panel.

## 6. Full route audit (one-by-one)

For each route, verify: data loads, no placeholder blocks, empty/error/stale states use the standard components + `RECOVERY` link, deep-links work, mobile layout is clean.

| Route | Checks |
|---|---|
| `/` | Coverage + freshness tiles populated; featured pilots visible; search works. |
| `/subnets` | List, search, filter, sort all wired; rows link via `params`. |
| `/subnets/:netuid` | Hero, EndpointsGlance, Surfaces, Schema Drift, Endpoints, Candidates, Evidence, API tabs; deep-link hashes. |
| `/providers` | **Fix #1 above** + accent treatment. |
| `/providers/:slug` | **Section audit #3 + #4.** |
| `/surfaces` | Filters by kind / provider / netuid / public_safe; results render. |
| `/endpoints` | Root RPC pool table + incidents; no hydration mismatch. |
| `/health` | Global + per-subnet health + source health. |
| `/schemas` | OpenAPI link, schema index, drift, copyable URLs; add `#openapi` anchor for RECOVERY. |
| `/gaps` | Profile completeness, adapter candidates, enrichment queue. |
| `/about` | Static copy; verify external links. |

Bugs surfaced during audit get fixed in the same pass (e.g. the `IncidentsTable` TimeAgo hydration mismatch on `/endpoints` — already have the `TimeAgo` mount-gate, but the `IncidentsTable` row uses `formatRelative` directly; swap to `<TimeAgo />`).

## Files touched

- `src/lib/metagraphed/queries.ts` — add list-item normalizer, use in `providersQuery`.
- `src/routes/providers.index.tsx` — use normalized slug, drop dead count tiles, accent polish.
- `src/components/metagraphed/states.tsx` — export `RECOVERY` map.
- `src/routes/providers.$slug.tsx`, `src/routes/subnets.$netuid.tsx` — adopt `RECOVERY`, audit sections.
- `src/components/metagraphed/endpoints-glance.tsx` — mobile polish + smooth expand.
- `src/styles.css` + `src/components/metagraphed/{profile-tabs,profile-hero,chips,section-anchor,app-shell}.tsx` — accent moments.
- `src/routes/endpoints.tsx` (and any other routes found during audit) — replace direct `formatRelative` with `<TimeAgo />` where it caused hydration mismatch.

## Out of scope

No API changes, no new data sources, no in-app contribution flows, no routing topology changes.

## Verification

- Click any provider card → lands on `/providers/<real-slug>`, no `undefined`.
- `/providers` list shows kind + authority + host info, no "—" placeholder tiles.
- Toggle light/dark — accent is visibly present on tabs, KPIs, brand dot, chips.
- Every empty/error state on subnet & provider profiles shows the same labeled recovery buttons.
- Mobile: expand "Endpoints at a glance" — animation is smooth and the full list scrolls into view.
- Walk all 11 routes in preview — no blank sections, no console hydration warnings.
