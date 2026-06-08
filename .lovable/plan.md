# Charcoal & Ember redesign + taostats-style microinteractions

## 1. Color system overhaul (`src/styles.css`)

Replace the current slate/cyan tokens with a Charcoal & Ember palette, tuned to accent intensity 3 (moderate — present but not neon). Light + dark both first-class, follow-system default already wired via `src/lib/theme.ts` (no logic changes needed there).

**Dark mode (the primary, taostats-like surface)**
- `--paper`        near-black charcoal — `oklch(0.16 0.004 40)`
- `--surface`      panel               — `oklch(0.20 0.004 40)`
- `--card`         raised card         — `oklch(0.235 0.005 40)`
- `--border`       hairline            — `color-mix(in oklab, var(--ink-strong) 12%, transparent)`
- `--ink-strong`   `oklch(0.985 0.003 40)`
- `--ink`          `oklch(0.90 0.004 40)`
- `--ink-muted`    `oklch(0.66 0.006 40)`
- `--ink-subtle`   `oklch(0.45 0.006 40)`
- `--accent`       muted ember         — `oklch(0.68 0.13 38)` (intensity 3: warm orange, not neon)
- `--accent-foreground` `oklch(0.14 0.01 40)`
- `--ring`         `color-mix(in oklab, var(--accent) 45%, transparent)`

**Light mode**
- `--paper`        warm off-white — `oklch(0.985 0.004 60)`
- `--surface`      `oklch(0.965 0.005 60)`
- `--card`         `oklch(1 0 0)`
- `--ink-strong`   `oklch(0.16 0.008 40)`
- `--ink`          `oklch(0.28 0.008 40)`
- `--ink-muted`    `oklch(0.50 0.008 40)`
- `--ink-subtle`   `oklch(0.70 0.006 40)`
- `--accent`       `oklch(0.58 0.16 38)` (ember holds up on light)

**Health (traffic-light preserved per user)** — re-tuned slightly warmer to live next to ember without clashing:
- ok: `oklch(0.72 0.16 150)` dark / `oklch(0.55 0.18 150)` light
- warn: `oklch(0.80 0.14 75)` dark / `oklch(0.65 0.16 65)` light
- down: `oklch(0.70 0.20 28)` dark / `oklch(0.55 0.22 28)` light
- unknown: neutral charcoal

**Curation tokens** re-mapped onto the charcoal/ember family so chips no longer read as cyan/slate.

## 2. Taostats-style microinteractions

Two reusable primitives, both motion-safe (`prefers-reduced-motion` falls back to instant swap).

**a. `<AnimatedNumber />`** — `src/components/metagraphed/animated-number.tsx`
- Tween between previous and next numeric value over ~600ms with `requestAnimationFrame` and ease-out.
- Formats via existing `format.ts` helpers (compact, percent, latency ms).
- Brief flash of `--accent` on increase, `--health-down` on decrease (subtle, 250ms fade), opt-in via `flashOnChange`.
- Used in: `/health` summary tiles, `/subnets` row latency/participant counts, `/` overview KPIs, freshness countdowns.

**b. `<LiveDot />` + smooth refresh** — replace abrupt list refreshes with crossfade.
- Wrap the auto-refreshing tables/cards in a `data-refreshing` container; existing rows fade to 70% then back instead of unmount/remount flash.
- The countdown timer on `/health` already exists — swap its raw text for `<AnimatedNumber />` so the seconds tick smoothly.

**c. Hairline interactions**
- Row hover: 120ms `background-color` to `color-mix(var(--ink-strong) 4%, transparent)` — taostats-style quiet hover.
- Sort header active state: tiny ember underline (1px) instead of color swap.
- Chips: 100ms scale 0.98→1 on first render via existing `animate-fade-in`.

## 3. Component audit pass

Walk the components that currently lean cyan/slate and confirm they read correctly under ember:
- `chips.tsx` — health dot, curation chips, freshness chip
- `app-shell.tsx` — sidebar active state uses `--accent` (now ember, looks right)
- `theme-toggle.tsx` — already token-driven, no change
- `list-shell.tsx` — skeleton tint, stale tint, retry strip
- `evidence-panel.tsx`, `share-button.tsx`, `freshness.tsx` — verify no hardcoded colors

No structural changes to routes, queries, pagination, or URL state — this pass is purely visual + microinteraction.

## 4. Verification

- `bunx tsc --noEmit`
- Preview pass: toggle light/dark/system, confirm contrast on `/`, `/subnets`, `/subnets/:netuid`, `/health`, `/surfaces`, `/endpoints`.
- Trigger `/health` auto-refresh, confirm countdown ticks smoothly and KPI tiles tween rather than snap.
- Reduced-motion: enable OS setting, confirm animations no-op and numbers swap instantly.

## Out of scope

- Replacing TanStack Query's refetch lifecycle (the crossfade is a visual wrapper, not a data-fetch rewrite).
- Sparkline/chart animations (would need a chart lib pass — separate ticket).
- Sidebar/route hierarchy changes — already shipped in earlier passes.