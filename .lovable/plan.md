
# Plan: Density, Health Color Presets, and Per-Route UX Pass

## 1. Settings popover in the header

New `src/components/metagraphed/settings-popover.tsx`. Replace the standalone `ThemeToggle` slot in `app-shell.tsx` with a single gear button that opens a `Popover` containing three sections:

- **Theme** — Light / Dark / System (reuses existing `theme.ts`).
- **Density** — Comfortable (default) / Compact. Persists to `localStorage` under `mg:density` and toggles `data-density="compact"` on `<html>`.
- **Health colors** — three presets (see §3).

State lives in two tiny stores beside `theme.ts`:
- `src/lib/density.ts` (`getDensity`, `setDensity`, `subscribe`, SSR-safe).
- `src/lib/health-palette.ts` (`getPalette`, `setPalette`, presets array).

Both hydrate on `__root.tsx` mount via the same script-injection pattern as theme (no flash).

## 2. Density system

Add CSS in `src/styles.css`:

```css
:root { --mg-row-y: 0.75rem; --mg-cell-x: 1rem; --mg-kpi-pad: 1.25rem; --mg-kpi-num: 1.875rem; }
html[data-density="compact"] {
  --mg-row-y: 0.4rem; --mg-cell-x: 0.625rem; --mg-kpi-pad: 0.75rem; --mg-kpi-num: 1.375rem;
}
```

Then sweep:
- `list-shell.tsx` table rows/cells → use `py-[var(--mg-row-y)] px-[var(--mg-cell-x)]`.
- `health.tsx` KPI tiles → `p-[var(--mg-kpi-pad)]` and KPI number `text-[length:var(--mg-kpi-num)]`.
- Card variants in `chips.tsx`/`evidence-panel.tsx` get a compact spacing tweak.

No layout shift in comfortable mode (values match current).

## 3. Health color presets (presets only, AA verified)

`src/lib/health-palette.ts` ships three presets, each with light + dark OKLCH values for ok / warn / down / unknown:

1. **Traffic light** (current default, retuned for AA).
2. **Colorblind-safe** (deuteranopia/protanopia friendly — blue/orange/magenta/grey based on Okabe-Ito).
3. **Muted** (desaturated for dense dashboards).

Selected preset writes `--health-ok|warn|down|unknown` CSS vars on `<html>` overriding the defaults in `styles.css`. All preset values pre-checked ≥4.5:1 against both `--paper` and `--card` in light and dark. No live picker, so no runtime contrast UI needed; we ship a comment in the file with the measured ratios.

## 4. Per-route UX pass

Scoped to layout/composition; no data-model or query changes.

### `/` — taostats-style overview (`src/routes/index.tsx`)
- Top strip: 4 big KPI tiles using `AnimatedNumber` (Active subnets, Verified surfaces, Healthy endpoints %, Last sync). Replaces current text-heavy hero.
- Global search bar moved up, made primary (`max-w-2xl`, large input).
- Two-column below the fold: **Featured adapter-backed pilots** (Allways SN7, Gittensor SN74 cards with live metrics) + **Registry freshness/coverage** strip.
- Remove redundant "what is metagraphed" prose into a thin one-liner with a link to `/about`.

### `/subnets/:netuid` — cosmos-directory-style profile (`src/routes/subnets.$netuid.tsx`)
- Identity header: netuid badge + native name + symbol + curation chip + health dot, right-aligned share + open-in-API icons.
- **Quick-copy strip**: primary surface URLs (API base, docs, repo) as one-line `code` blocks with copy buttons. Cosmos-directory pattern.
- Tabbed body (`Tabs`): Overview · Surfaces · Endpoints · Health · Evidence · Candidates. Each tab loads its own slice; current single-scroll page becomes the Overview tab summary.
- Profile completeness moves into a slim progress bar in the header.

### `/surfaces` and `/endpoints`
- Tighten columns; inline copy button on URL cells.
- Group-by-provider toggle (segmented control next to search) — when on, renders provider as a sticky sub-header.
- Health column becomes a dot + last-checked relative time, no text label.
- Compact density (when enabled) lets ~2x rows fit on viewport.

### `/health` — status-page feel
- Per-source incidents become cards with start/duration/affected count instead of table rows.
- Add a 24h sparkline per probe source (pure SVG, no chart lib) using cached history endpoint `/api/v1/health/history/{date}`.
- KPI strip stays but reflows in compact mode.

## Out of scope
- No new API routes or backend changes.
- No custom health-color picker (presets only per chosen option).
- No changes to `/providers`, `/gaps`, `/schemas`, `/about` in this pass.
- No chart library; sparkline is hand-rolled SVG.

## Verification
- `bunx tsc --noEmit`.
- Visual pass across all touched routes in both light/dark and comfortable/compact.
- Verify health dots remain visible on every preset against `--paper` and `--card`.
- Confirm density toggle does not cause CLS in comfortable mode.
