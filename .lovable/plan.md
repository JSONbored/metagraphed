# Registry UX polish — round 2

Round-2 polish across Endpoints, Providers, Subnet detail, Health, and the global navbar search. No backend/data-model changes — pure presentation, filtering, grouping, and shared-component refactors.

## 1. Endpoints route (`src/routes/endpoints.tsx`)

Right now this page is three plain tables with no controls and no shared incident card.

- **Add `IncidentCard` import** and replace the inline incident `<li>` with `<IncidentCard incident={i} />` so `/endpoints` matches `/health`.
- **Toolbar (sticky, `backdrop-blur`)** above "All endpoints":
  - search input (matches url/provider/region/netuid)
  - kind multi-select (rpc, wss, api, sse, docs, dashboard, …)
  - provider select (derived from rows)
  - health filter (ok/warn/down/unknown)
  - clear-all chip
- **URL-driven state** via existing `tableSearchSchema` (`q`, `kind`, `provider`, `health`, `sort`, `order`, `page`, `pageSize`). Use search params so views are shareable.
- **Sortable columns** (netuid, kind, provider, region, health, latency, probed) using `sortBy`. Click header to toggle.
- **Pagination**: client-side `paginate()` with a footer "Showing X of Y · page size 25/50/100".
- **Row decorations** matching `/surfaces`: copy-URL button + `<ExternalLink>` icon on the URL cell; truncate with title tooltip.
- **Incidents section**:
  - Reuse the `/health` host-grouping (`hostKeyFromEndpointId`) + state-filter chips (All/Down/Degraded/Resolved).
  - Show top 12, "Show all N" toggle.
  - Empty state: "No incidents in window".

## 2. Providers route (`src/routes/providers.index.tsx`)

- **Toolbar**: search (name/slug/notes/host), kind filter, authority filter (official / provider-claimed / community / unknown), sort (name | surfaces | endpoints | subnets).
- **Stickier header** + result count ("12 of 47 providers").
- **Empty/Stale/Error states**:
  - Empty (filter): "No providers match this filter" + clear chip.
  - Empty (data): keep existing.
  - Stale: reuse `<StaleBanner />` when `meta.generated_at` is stale.
  - Error: `QueryErrorBoundary` fallback already covers, but add a retry that calls `router.invalidate()`.
- **Smoother loading**: replace the single tall `<Skeleton h-64>` with a 6-card skeleton grid matching the real layout (no layout shift on first paint).
- **Card polish**: fix name truncation by allowing the name to wrap to 2 lines (`line-clamp-2`) instead of cutting mid-word; move the authority chip to a footer row on narrow widths so it stops squeezing the name.

## 3. Subnet detail (`src/routes/subnets.$netuid.tsx`)

- **Verified vs candidate labeling** — introduce a single `<CurationBadge level="verified|candidate|machine|pilot|native"/>` chip and apply consistently to every surface, endpoint, link, and gap row. Candidates always carry an "unverified — community" tone (amber/border) and never mix into verified counts.
- **Section anchors** (already have `section-anchor`): standardize headings as `Identity → Profile → Surfaces → Endpoints → Health → Gaps → Evidence → Providers → Candidates` with a sticky in-page TOC on `lg:` widths.
- **Endpoints-at-a-glance tiles**: replace `0 —` with `none tracked` (already planned earlier; finish across all four tiles).
- **Surfaces block**: group by kind (API / Schema / Docs / Dashboard / Repo / Data / SSE) inside collapsible sub-sections; show count next to each kind header.
- **Evidence panel**: tighten layout — left col = source, right col = `<TimeAgo />` + outbound link; collapse if >6 rows.
- **Gaps**: render as checklist with severity dot; link "Suggest on GitHub" per row.
- **Candidates section**: explicit amber banner: "Unverified leads — not part of the verified registry. Helps reviewers triage."

## 4. Health route (`src/routes/health.tsx`)

Most of the round-1 work landed. Remaining:

- **Severity sort toggle** for incident groups: "By severity" (default) | "By recency" | "By incident count".
- **Per-group action**: "Expand all / Collapse all" link above the list.
- **Refresh control polish**: add a "Refresh now" button (forces `queryClient.invalidateQueries({queryKey:["metagraphed"]})`) next to the countdown; keep countdown but render the seconds in a fixed-width slot so it doesn't jitter.
- **Source health table**: add inline `humaniseSeconds` for last-seen age in addition to `<TimeAgo />`.
- **Stale banner**: clarify copy ("snapshot is N min old — auto-refresh paused" when paused).

## 5. Navbar — upgraded global search (`src/components/metagraphed/app-shell.tsx`)

Current search is functional but minimal. Rebuild as a proper command-palette-style dropdown.

- **Trigger**: keyboard shortcut `⌘K` / `Ctrl+K` opens and focuses the input; `/` also focuses (when not in another field).
- **Wider input** with kbd hint chip on the right (`⌘K`).
- **Grouped results** in the popover: Subnets · Surfaces · Endpoints · Providers · Docs — each group with a small header and a "see all" link to the matching list route prefilled with `?q=`.
- **Keyboard navigation**: ↑/↓ moves selection (visual highlight), Enter activates, Esc closes, Tab cycles groups.
- **Recent searches**: persist last 5 to `localStorage` (`mg.search.recent`), show under "Recent" when input is empty and focused.
- **Suggested queries** when empty: a row of clickable chips ("bittensor", "taostats", "rpc", "openapi", "sn7").
- **Result rows**: show `BrandIcon` for providers/subnets where derivable, kind badge, title, and secondary line (host/netuid). Highlight matched substring.
- **Loading**: thin progress bar across the top of the popover while `isFetching`; no layout shift between states.
- **Empty result**: "No matches. Press Enter to browse /subnets filtered by '…'." — same as today, but add secondary actions: "Search providers", "Search endpoints".
- **Mobile**: open as full-screen sheet (uses existing `Sheet` UI primitive) so suggestions are usable on small screens.
- **A11y**: proper `role="combobox"` + `aria-activedescendant`, listbox/option roles, focus trap inside the mobile sheet.

## 6. Shared bits

- **New `src/components/metagraphed/curation-badge.tsx`** — single source of truth for verified/candidate styling.
- **`src/components/metagraphed/toolbar.tsx`** — extracted sticky filter row (`backdrop-blur bg-paper/85`) reused by Endpoints, Providers, Surfaces.
- **`src/components/metagraphed/kbd.tsx`** — small `<Kbd>⌘K</Kbd>` primitive for the search hint.
- **`src/lib/metagraphed/search-history.ts`** — recent-search persistence helper.

## Files

- New: `curation-badge.tsx`, `toolbar.tsx`, `kbd.tsx`, `search-history.ts`
- Edit: `endpoints.tsx`, `providers.index.tsx`, `subnets.$netuid.tsx`, `health.tsx`, `app-shell.tsx`

## Out of scope

- No new API routes or query changes.
- No registry data writes.
- No proxy/load-balancer surfaces (still future-scoped).
