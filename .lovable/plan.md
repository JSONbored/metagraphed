# Plan

## 1. Pagination hardening for /subnets and /surfaces

**Validate next_cursor in the client**
- In `src/lib/metagraphed/queries.ts`, replace the loose `extractNextCursor` with a strict validator:
  - Accept only non-empty strings or finite numbers; reject `false`, `null`, objects, arrays, NaN.
  - Reject a cursor that equals the cursor we just sent (would cause an infinite loop).
  - On invalid shape, log a single dev-mode warning and treat as "no more pages".
- Surface a typed sentinel on the page object (e.g. `cursorInvalid: true`) when the API returned next_cursor but it failed validation, so the UI can show a friendly banner.

**Friendly errors during cursor fetches**
- In `src/components/metagraphed/list-shell.tsx` extend `LoadMore` to accept `error?: Error | null` and render an inline retry strip ("Couldn't load more — Retry") instead of the page-level error boundary, so already-loaded rows stay visible.
- `/subnets` and `/surfaces` route components pass `isFetchNextPageError`, `fetchNextPageError`, and a retry callback (`fetchNextPage`) down.

**Skeleton load-more UX**
- `LoadMore` renders 3 skeleton table rows (desktop) and 2 skeleton cards (mobile) while `isFetchingNextPage`, using the existing `Skeleton` primitive in `states.tsx`.
- Add a subtle "stale" tint (border-muted) on previously loaded rows while a background refetch is in flight (`isFetching && !isFetchingNextPage`), to make the refresh legible without flashing.

## 2. Page-size (limit) control + cursor reset

- Add `PageSizeSelect` to `src/components/metagraphed/table-controls.tsx` with options 10/25/50/100/200.
- Place it in the FilterBar slot on both routes alongside the existing filters.
- Changing `limit` calls `navigate({ search: prev => ({ ...prev, limit, cursor: "" }) })` — same cursor-reset rule used by sort/filter changes.

## 3. Shareable cursor / next_cursor state

- `tableSearchSchema` already has `cursor`. Add `cursorChain` (comma-joined opaque strings) so a shared URL can rehydrate the full sequence of pages the user had loaded.
- On `fetchNextPage`, append the resolved page's cursor to `cursorChain` in the URL.
- On route mount, if `cursorChain` is non-empty, seed `useSuspenseInfiniteQuery` via `initialData` / `initialPageParam` so all referenced pages reload in order; otherwise honor a single `cursor` for a "jump to this page" link.
- `ShareButton` already copies the full URL — just confirm `cursor` / `cursorChain` survive the share toast.

## 4. "Reset filters" control

- Replace the current `ResetLink` text with a clearer `ResetFiltersButton` (icon + label) in `table-controls.tsx`.
- Clears `q`, `sort`, `order`, `curation`, `health`, `kind`, `provider`, `cursor`, `cursorChain` but preserves `limit` (user's display preference).
- Hidden when no filters are active to keep the bar quiet.
- Hooked into both `/subnets` and `/surfaces` PageHeading right slot, replacing today's `<ResetLink/>`.

## 5. Color system overhaul — taostats-inspired, light + dark

**Tokens** (defined in `src/styles.css` per Tailwind v4 rules)
- Define `:root` (light) and `.dark` token sets, then map them inside `@theme inline` so every existing semantic class (`bg-paper`, `text-ink`, `border-border`, `bg-card`, `text-ink-muted`, `text-ink-strong`, `text-ink-subtle`, `bg-surface`, accents) keeps working without touching components.
- Palette direction (taostats reference: deep slate-navy backdrop, near-white ink, teal/cyan accent, traffic-light health preserved):

  Dark mode (default for `prefers-color-scheme: dark`)
  - `--paper`        oklch(0.16 0.02 250)   near-black slate
  - `--surface`      oklch(0.20 0.02 250)   panel
  - `--card`         oklch(0.22 0.02 250)   raised card
  - `--border`       oklch(0.30 0.02 250)
  - `--ink`          oklch(0.92 0.01 250)
  - `--ink-strong`   oklch(0.98 0.01 250)
  - `--ink-muted`    oklch(0.68 0.02 250)
  - `--ink-subtle`   oklch(0.45 0.02 250)
  - `--accent`       oklch(0.78 0.14 195)   teal/cyan (taostats-like)

  Light mode
  - `--paper`        oklch(0.985 0.003 250)
  - `--surface`      oklch(0.965 0.005 250)
  - `--card`         oklch(1.00 0 0)
  - `--border`       oklch(0.90 0.01 250)
  - `--ink`          oklch(0.25 0.02 250)
  - `--ink-strong`   oklch(0.12 0.02 250)
  - `--ink-muted`    oklch(0.50 0.02 250)
  - `--ink-subtle`   oklch(0.70 0.02 250)
  - `--accent`       oklch(0.55 0.13 200)

  Health (traffic-light, tuned per mode)
  - `--health-ok`      green oklch(~0.72 0.16 150 dark / 0.55 0.18 150 light)
  - `--health-warn`    amber oklch(~0.80 0.14 80  / 0.65 0.16 70)
  - `--health-down`    red   oklch(~0.70 0.20 25  / 0.55 0.22 25)
  - `--health-unknown` slate oklch(~0.55 0.02 250 / 0.60 0.02 250)

**Mode plumbing (follow-system + manual override)**
- Add `src/lib/theme.ts` with a `useTheme()` hook: reads `localStorage("mg-theme")` (`"light" | "dark" | "system"`), falls back to `"system"`, and toggles the `.dark` class on `documentElement` based on either the choice or `matchMedia("(prefers-color-scheme: dark)")`. Listens for system changes when in `system` mode.
- Add a `ThemeToggle` component (Sun / Moon / Monitor icons) to the AppShell header.
- Inject a tiny pre-hydration `<script>` in `src/routes/__root.tsx` `<head>` that sets the `.dark` class before first paint to prevent a flash.

**Component touch-ups for two-mode parity**
- Audit existing components that hardcode colors outside tokens (chips, freshness dots, health pulse animation in `styles.css`, evidence-panel, share-toast). Replace stray Tailwind color literals with semantic tokens.
- Verify Tailwind v4 `@theme inline` mappings exist for every token actually referenced (`bg-paper`, `bg-surface`, `bg-card`, `text-ink*`, `border-border`, `text-health-*`, `bg-health-*`).

## 6. Verification

- `bunx tsc --noEmit` after each file batch.
- Manual preview pass on /subnets and /surfaces:
  - Page-size change resets cursor.
  - Reset filters clears search + sort + chain.
  - Bad/missing next_cursor → graceful "end of list" with no infinite loader.
  - Toggle theme + reload → no FOUC, mode persists.

## Out of scope for this pass

- Server-side cursor signing/HMAC (backend concern).
- Per-row deep-link from a /surfaces row.
- Migrating other list routes (/endpoints, /providers, /gaps) to ListShell — already tracked separately.
