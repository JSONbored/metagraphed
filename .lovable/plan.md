## Route-by-route UX/UI audit

### Critical bugs (fix first)

**1. Health page — broken JSX renders literal text**
`src/routes/health.tsx:339` wraps JSX in a template string:
```tsx
<span>{i.ended_at ? `ended $<TimeAgo at={i.ended_at} />` : "—"}</span>
```
Resolved incidents render the literal string `ended $<TimeAgo at={i.ended_at} />`. Replace with the same `<>ended <TimeAgo at={i.ended_at} /></>` pattern that `endpoints.tsx` already uses.

**2. Home stat strip permanently shows "—"**
`src/routes/index.tsx:111` wraps `useSuspenseQuery` calls in `try/catch`. Suspense throws a Promise during loading; the catch swallows it and the cells fall through to "—" forever (visible in screenshots). Convert `StatStrip` to non-suspense `useQuery` (it's stat data, partial loads are fine), or split each cell into its own `<Suspense>` + `<QueryErrorBoundary>` and read with `useSuspenseQuery` normally.

**3. Time formatting in seconds**
`health.tsx` (avg age, max age) and home `StatStrip` (avg freshness) print `${Math.round(n)}s` — "20363s" instead of "5h 39m". Replace with `formatRelative()` / a humanised duration formatter.

---

### Home (`/`)

- **Add BrandIcon column** to the "Active subnets" preview table for parity with `/subnets`.
- **Misleading footer copy**: "Showing first 12 of 12" when registry has 129. Rename section to "Recent subnets" or fetch 12 *with the total count* and show "12 of 129".
- **Pilot cards**: title + chip duplicate the eyebrow ("SN7" + "Allways" + "ADAPTER" + paragraph). Tighten — one chip on the right, two-line content max.
- **API URL block** uses `truncate={false}` and sits next to the headline; on narrow widths it wraps awkwardly. Cap width / move under heading on `<md`.

### Subnets list (`/subnets`)

- BrandIcons render fine after load; first-paint shows empty tiles. Render the **monogram as the skeleton itself** (not the pulse) so the cell is never visually empty.
- "Updated" column is all `—` — verify the field; if always null, drop the column or surface freshness on hover instead.
- Mobile cards already exist; confirm sticky filter row gets a backdrop on scroll (currently looks unstyled when content scrolls underneath).

### Subnets detail (`/subnets/:netuid`)

- "Endpoints at a glance" tiles for **Root RPC/WSS** and **SSE/Data** show `0 —` which reads as broken. When count is 0, show one line ("none tracked") instead of `0` + dash placeholder.
- "+1 more group — open the Surfaces tab" link is too muted. Promote to a small button-style row at the bottom of the Surfaces preview.
- "Known gaps" section repeats the same bullet points already shown in the "Coverage / Missing" sidebar. Dedupe or move bullets out of the sidebar.
- Hero shows blurry / late favicons for a beat. Same monogram-as-skeleton fix.

### Surfaces (`/surfaces`)

- Already strong: filters, infinite scroll, evidence panel.
- URL column truncates without ellipsis — add `text-overflow` and tooltip; add a small Copy button next to the external-link icon for quick paste.
- No empty-state when filters return nothing — currently shows raw `<EmptyState>` without a "Clear filters" CTA.

### Endpoints (`/endpoints`)

- **No filters or search** despite being the densest list page. Add `kind`, `provider`, `health` filters and a search input (mirror `/surfaces` controls).
- **No pagination/infinite scroll** — fetches everything; add the same pattern.
- URL column lacks `<ExternalLink>` decoration that surfaces uses. Add it + copy button.
- RPC pools table is all `—` — collapse empty columns automatically or replace with a "Pool metadata pending" empty state.
- "Proxy: future" cells need a tooltip explaining proxy routing is future-scoped (the page intro mentions it; tooltip on the cell ties the two together).
- `durationLabel` is duplicated with `health.tsx` → extract to `src/lib/metagraphed/format.ts`.

### Providers list (`/providers`)

- **No search, filter, or sort.** With ~50+ providers and growing, add: search box, kind filter (subnet-team / infrastructure-provider / data-provider / community), authority filter (official / provider-claimed / community), and a sort (name / surfaces / endpoints / subnets).
- Card icons render empty for ~300ms on first paint. Monogram-as-skeleton fix.
- Truncated provider name like "Actual Com…" cuts at three letters — bump max-width or wrap to two lines before truncating.

### Providers detail (`/providers/:slug`)

- Clean overall.
- "Subnets served" cards are fixed-width (3-col grid) and waste space when only 4 entries. Switch to flex-wrap with min-width so 5 fit on a row, 2 wrap nicely.
- Provider hero brand-icon same first-paint issue.

### Health (`/health`)

- **Incidents list is overwhelming** — 40+ near-identical "Degraded · sn-N-subnetradar-dashboard · This operation was aborted". Add:
  - Group by host pattern (parse the suffix after the netuid in `endpoint_id`); show one collapsible row per host with a count badge.
  - State filter (Down / Degraded / Resolved) + sort by severity.
  - Default-show top N, with "Show all" expand.
- **Source-health "Freshness" column** is just a coloured dot with no label or timestamp — surface the relative age next to the dot or wrap in a tooltip.
- "Last seen" column empty for most rows — if backend returns null universally, drop the column; otherwise show `—` with a tooltip.
- **AutoRefreshControl** is busy: select + Pause button + "Next sync · 30s" + tab-hidden chip + idle chip. Consolidate into a single rounded control: `[●] Auto · every 30s · syncing`, with the pause icon inline and one chip for tab-hidden state.

### Schemas, Gaps, About

- Out of scope for this round (no obvious issues from screenshots; user did not list them as focus). Flagging here so we can do a follow-up pass.

---

### Cross-cutting refactors

- **Extract shared utilities**: `durationLabel` (endpoints + health), `humaniseSeconds` (home + health), incident card component (endpoints + health).
- **Table padding consistency**: standardize on `px-4 py-2.5` across endpoints/health/source-health to match subnets/surfaces.
- **Sticky filter rows**: subnets/surfaces filter rows need a `bg-card/95 backdrop-blur` when scrolled so table content doesn't bleed through.
- **BrandIcon first-paint**: render the monogram tile as the loading state itself (current `animate-pulse` over an empty surface tile reads as broken when many cards load at once).

---

### Out of scope for this pass

- Schemas, Gaps, About route audits.
- Adding pagination/server-side filters that require backend changes — limited to what the client can do with the existing `/api/v1/*` endpoints.
- Visual redesign / palette changes.

---

### Suggested execution order
1. Critical bug fixes (1, 2, 3) — quick wins, visible immediately.
2. Endpoints filters + URL polish.
3. Providers list filters + search.
4. Health incidents grouping + AutoRefreshControl simplification.
5. Cross-cutting refactors + BrandIcon monogram-skeleton.
6. Home table tweaks and subnet detail polish.
