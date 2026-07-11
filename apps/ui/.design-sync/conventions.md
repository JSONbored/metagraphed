## Wrapping and setup

Most components need no wrapper. The one exception: `Tooltip`, `SparkLegend`, and
`StatWithSpark` render a Radix `Tooltip`/`TooltipTrigger`/`TooltipContent` chain
internally — wrap anything that uses them in `<TooltipProvider>` (also exported
here), or they throw. One provider covers the whole tree:

```tsx
<TooltipProvider>
  <YourApp />
</TooltipProvider>
```

No router, query client, or other app context is required — every component here
takes plain props and renders standalone.

## Styling idiom — Tailwind v4 utility classes + semantic tokens

This is a Tailwind design system ("Bone & Ink") — style with utility classes, not
inline styles or a CSS-in-JS prop API. The classes below resolve through named
CSS custom properties (not raw Tailwind palette colors like `bg-emerald-500`) —
always reach for the semantic name:

| Purpose                   | Classes                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page/canvas background    | `bg-paper`                                                                                                                                                                                                                                                             |
| Card/panel surface        | `bg-surface`, `bg-card`                                                                                                                                                                                                                                                |
| Body text                 | `text-ink` (default), `text-ink-strong` (headings/emphasis), `text-ink-muted` (secondary), `text-ink-subtle`/`text-ink-subtle-text` (faint, AA-safe variant for small text)                                                                                            |
| Brand accent              | `text-accent`/`bg-accent` (graphics/borders), `text-accent-text` (AA-safe for small accent text), `bg-primary-soft` (tinted accent surface)                                                                                                                            |
| Borders                   | `border-border`                                                                                                                                                                                                                                                        |
| Status color              | `bg-health-ok` / `bg-health-warn` / `bg-health-down` / `bg-health-unknown` (dots, chips); `text-health-warn-text` for AA-safe small warn text                                                                                                                          |
| Provenance/curation chips | `text-curation-seeded`, `-verified`, `-pilot`, `-machine` (used as `text-curation-<tier>` + matching `border-curation-<tier>/40`) — other curation tiers (native, candidate, adapter) render as plain `text-ink-strong`/`text-ink-muted`, not a curation-colored class |
| Radius                    | `rounded` (border-radius token — `sm`/`md`/`lg`/`xl` variants also themed)                                                                                                                                                                                             |

Categorical chart series (`--chart-1` … `--chart-6`) are **not** consumed as
Tailwind classes anywhere in this system — every real usage passes them as
inline CSS variable values, e.g. `color="var(--chart-1)"` or
`style={{ background: "var(--chart-3)" }}`. Follow that pattern for chart/series
color, don't invent a `bg-chart-*` class.

Typography: `font-display` (Space Grotesk — headings, use explicitly),
`font-mono` (JetBrains Mono — code, addresses, numeric labels, timestamps, use
explicitly). DM Sans is the body default (no `font-sans` class needed — it's
already what text renders in). Sizes run small and dense throughout this system
— real components lean on `text-[9px]`–`text-sm` with `uppercase tracking-wide`
for labels far more than default Tailwind text sizes; match that density rather
than defaulting to `text-base`.

## Where the truth lives

- **Tokens**: `_ds_bundle.css`, reached via `styles.css`'s `@import` chain — every
  `--paper`/`--ink*`/`--health-*`/`--chart-*` custom property is defined there.
  Read it before inventing a new color.
- **Per-component API + usage**: each component's `<Name>.prompt.md` (composition
  examples come from this repo's real previews, not invented).
- **Fonts**: `fonts/fonts.css` — Space Grotesk, DM Sans, JetBrains Mono, self-hosted
  as real woff2 at exactly the weights this app uses (400/500/600 — verified by
  grepping every `font-weight` utility class in `apps/ui/src`; `font-bold`/700
  never appears anywhere in the app, so it isn't shipped).

## Example composition

A stat tile with a trend line, in this system's real idiom:

```tsx
<TooltipProvider>
  <StatWithSpark
    label="Emission share"
    value="4.2"
    unit="%"
    hint="of total network emission"
    tone="ok"
    viz={<Sparkline values={[3.8, 3.9, 4.0, 4.1, 4.2]} width={100} height={18} />}
  />
</TooltipProvider>
```

`tone` drives color across this system's stat/status components consistently:
`"ok"` → `text-health-ok`, `"warn"` → `text-health-warn`, `"down"` →
`text-health-down`, `"default"` → `text-ink-strong`.
