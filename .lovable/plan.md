# Rebuild profile pages (subnet + provider)

## Why the current pages look empty

The API returns the profile envelope nested:

```
GET /api/v1/subnets/7/profile → { data: { profile: {...}, subnet: {...},
                                          surfaces, endpoints,
                                          candidate_surfaces, gaps } }
```

`subnetProfileQuery` returns `data` as-is, but `SubnetDetailPage` reads
`profile.name`, `profile.symbol`, `profile.participants`, `profile.docs`,
`profile.repo`, `profile.homepage`, `profile.completeness` directly from
that top-level wrapper. None of those keys exist there — they live under
`data.subnet.*` (chain identity) and `data.profile.*` (curation/completeness)
and `data.profile.primary_links.*` (website/docs/repo/dashboard). Result:
hero shows "—" everywhere, Quick Access is empty, completeness is wrong,
description is missing.

The same bug exists on `/providers/$slug` — API returns
`data: { provider: {...}, endpoint_summary }`, the page reads
`data.name`, `data.homepage`, `data.docs` directly, so the provider header
shows just the slug.

## What I'll do

### 1. Fix data normalization (`src/lib/metagraphed/queries.ts`)

- Add `normalizeSubnetProfile()` that flattens the envelope into one object
  the UI can consume:
  - identity: `name`, `native_name`, `slug`, `symbol`, `description/notes`,
    `subnet_type`, `categories`, `block`, `registered_at_block`, `tempo`,
    `participants` (← `subnet.participant_count`), `mechanism_count`.
  - curation: `curation_level`, `coverage_level`, `review_state`,
    `reviewed_at`, `confidence`, `completeness` (0-1 from
    `profile.completeness.score / 100` or `completeness_score / 100`).
  - primary links: `website`, `docs`, `repo`, `dashboard` from
    `profile.primary_links` with fallback to `subnet.{website_url,
    docs_url, source_repo, dashboard_url}`.
  - counts: `surface_count`, `endpoint_count`, `candidate_count`,
    `monitored_endpoint_count`, `operational_interface_kinds`,
    `supported_interface_kinds`, `missing_kinds`, `gap_notes`,
    `primary_app_surface`.
  - embedded `surfaces`, `endpoints`, `candidate_surfaces` so the
    detail page can render them without extra fetches.
- Add `normalizeProvider()` to flatten `data.provider` + `endpoint_summary`.
- Update `SubnetProfile` and `Provider` types in
  `src/lib/metagraphed/types.ts` to match.

### 2. Rebuild `/subnets/$netuid` as a clean profile page

Layout (taostats/cosmos-directory inspired):

```text
┌──────────────────────────────────────────────────────────────┐
│ Eyebrow: NETUID 007 · subnet-type · categories              │
│ H1: Allways  ·  symbol  ·  CurationChip · HealthPill        │
│ One-line description / notes                                 │
│ Primary-link rail: [Website] [Docs] [Repo] [Dashboard]      │
├──────────────────────────────────────────────────────────────┤
│ Stat strip: Participants · Tempo · Block · Surfaces ·       │
│             Endpoints · Completeness · Uptime 24h           │
├──────────────────────────────────────────────────────────────┤
│ Sticky tabs:  Overview · Surfaces · Endpoints · Schemas ·   │
│               Candidates · Gaps · Evidence · API            │
├──────────────────────────────────────────────────────────────┤
│ Two-column: main content (tab panel) + right rail           │
│ Right rail: Live health card · Provider card · Coverage     │
│             card (curation level, completeness bar, missing │
│             kinds chips) · Provenance/last reviewed         │
└──────────────────────────────────────────────────────────────┘
```

Details:
- Replace anchor `SectionNav` with real tabs that swap panels (URL search
  param `?tab=` so it's deep-linkable and shareable). Overview keeps a
  condensed view of every section.
- New `PrimaryLinksRail` component: pill buttons with brand icon, host,
  and external-link affordance. Hidden when a link is missing — never
  shows "—".
- New `CoverageCard`: completeness bar, curation chip, review state,
  reviewed-at, missing-kinds chips, gap notes.
- New `ProviderCard` in right rail: name, authority, link to
  `/providers/{slug}` for the primary surface's provider.
- `SurfacesList`: group by `kind`, show authority, auth_required,
  public_safe, probe enabled, copyable URL, evidence link.
- `EndpointsList`: keep table but add score, classification, monitoring
  status; collapse low-priority columns under "more" on narrow widths.
- `SchemasPanel`: surfaces with `kind=openapi` get a "View schema"
  link plus copyable `schema_url`; link to `/schemas` filtered by netuid.
- `CandidatesList`: explicit "Unverified — community lead" banner at top,
  group by confidence, show source_tier and review_notes.
- `GapsPanel` (new): renders `missing_kinds` and `gap_notes` with a
  CTA linking to `/gaps` and the GitHub contribution path.
- Empty states everywhere stop saying "—"; they show a one-line reason
  ("This subnet has no verified dashboard yet — see candidates.").

### 3. Rebuild `/providers/$slug` with the same profile pattern

- Header with name, authority, kind, homepage/docs link rail.
- Stat strip: endpoint count, monitored count, pool-eligible count,
  by-status (ok/warn/down) using `endpoint_summary`.
- Tabs: Overview · Endpoints · Subnets served (derived by grouping
  `endpoints[].netuid`).
- Right rail: notes, authority chip, links to filtered
  `/endpoints?provider={slug}` and `/surfaces?provider={slug}`.

### 4. Consistent "profile page" primitives

Extract three small shared components used by both routes (and reusable
for any future entity profile page):
- `src/components/metagraphed/profile-hero.tsx` — eyebrow, title, chips,
  link rail, stat strip.
- `src/components/metagraphed/profile-tabs.tsx` — URL-driven tabs.
- `src/components/metagraphed/coverage-card.tsx` — completeness bar +
  curation/review chips + missing-kinds.

## Out of scope

- No backend changes; this is pure frontend normalization + layout.
- No new routes; tabs use search params on existing routes.
- Other list pages (`/subnets`, `/surfaces`, `/endpoints`, `/providers`,
  `/schemas`, `/gaps`, `/about`, `/health`) keep their current layout —
  the user's complaint is specifically about *individual profile pages*.

## Files touched

- `src/lib/metagraphed/queries.ts` — add normalizers, rewire `subnetProfileQuery` and `providerQuery`.
- `src/lib/metagraphed/types.ts` — extend `SubnetProfile`, `Provider`.
- `src/routes/subnets.$netuid.tsx` — rewrite to new layout.
- `src/routes/providers.$slug.tsx` — rewrite to new layout.
- New: `src/components/metagraphed/profile-hero.tsx`,
  `profile-tabs.tsx`, `coverage-card.tsx`, `primary-links-rail.tsx`.
