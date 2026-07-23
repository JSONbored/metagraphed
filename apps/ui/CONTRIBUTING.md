# Contributing to apps/ui

Thanks for helping improve the [Metagraphed](https://github.com/JSONbored/metagraphed)
frontend. `apps/ui` is an npm workspace inside the `metagraphed` monorepo — this guide
gets you from clone to a green PR.

## Setup

**Fastest path:** open the repo root in a [devcontainer](../../.devcontainer/devcontainer.json)-aware tool (VS Code, GitHub Codespaces, the `devcontainer` CLI) — Node 22 and Playwright's Chromium come preinstalled, which covers the screenshot workflow below with no manual `npx playwright install`. Otherwise, Node 22 and npm are the canonical toolchain (`.nvmrc` at the repo root pins it).

```bash
npm install                       # root install wires the apps/ui workspace too
npm run dev --workspace=apps/ui
```

The app fetches live data from `https://api.metagraph.sh` by default — no backend setup
or secrets are required to develop against real data. To point at a different backend,
set `VITE_METAGRAPH_API_BASE`.

## Before you open a PR

Run the same checks CI's `ui` job enforces, in this order — a PR is only mergeable when
all pass:

```bash
npm run lint --workspace=apps/ui && npm run format:check --workspace=apps/ui
npm run typecheck --workspace=apps/ui  # auto-builds packages/client first (pretypecheck) -- no separate step needed
npm test --workspace=apps/ui
npm run test:e2e --workspace=apps/ui   # needs a Chromium browser: npx playwright install --with-deps chromium (once)
npm run build --workspace=apps/ui
```

If lint flags formatting, run `npm run format --workspace=apps/ui`. Prettier is the
single source of truth for style and is enforced through ESLint's `prettier/prettier`
rule — don't hand-format.

The responsive-overflow E2E check (`tests/e2e/responsive-overflow.spec.ts`) replays
recorded API traffic (`tests/e2e/har/*.har`) instead of hitting live production data, so
it stays deterministic regardless of live chain state. If your PR adds a new API call on
one of the checked routes (`/`, `/subnets/1`, `/endpoints`, `/status`, `/settings`,
`/explorer`), re-record the fixtures against a running dev server:
`npm run test:e2e:record-har --workspace=apps/ui`. A stale HAR still passes (unmatched
requests fall back to live data) but re-recording keeps the check fully offline-capable
and avoids masking a real layout change behind stale fixture data.

CI also gzip-measures the initial client JS for a cold `/` visit against a bundle-size
budget — keep new dependencies/imports lean.

## Code conventions

- **Typed routes.** TanStack Router params are typed. `/subnets/$netuid` takes a
  **number** netuid — pass `params={{ netuid: s.netuid }}`, not `String(...)`. Let `tsc`
  guide you; never cast around a type error.
- **Data fetching** goes through the query helpers in `src/lib/metagraphed/queries.ts`
  and `useSuspenseQuery` / error boundaries — don't fetch ad hoc in components.
- **Components** live in `src/components/metagraphed/`; route trees in `src/routes/`.
- Reuse existing design tokens (`src/styles.css`, `packages/ui-kit/src/styles.css`) and
  shared components instead of inventing new one-off styles. The "Bone & Ink" rules,
  mechanically flagged (as warnings — see `eslint.config.js`) by `no-restricted-syntax`:
  - Semantic tokens only — `bg-paper`, `text-ink-strong`, `bg-health-ok`, `text-accent-text`,
    `border-border`, etc. Never a raw Tailwind palette color (`bg-emerald-500`,
    `text-gray-600`) and never a hex/rgb literal in code. Author new colors in OKLCH in
    `packages/ui-kit/src/styles.css`.
  - Type weights capped at 500/600 — `font-bold`, `font-extrabold`, `font-black` are banned.
  - Sticky offsets use `var(--mg-sticky-offset)`, never a hardcoded `top-14` / `top-[3.5rem]`.
  - Spacing/type scale: prefer the `--mg-space-*` / `--mg-type-*` tokens (see
    `src/styles.css`) over arbitrary values like `text-[13px]` or `p-[7px]`.
  - Card/panel shells: use `<Panel>` from `src/components/metagraphed/primitives` rather
    than hand-rolling `rounded border bg-card`.
  - External links: use `<ExternalLink>` from `@jsonbored/ui-kit`, not a raw
    `<a target="_blank">` — it sets `rel=noreferrer` and filters unsafe/private URLs.
  - See `docs/ssr-safety.md` for the hydration-safety rules (also partly ESLint-enforced).
- Keep diffs focused. Don't reformat or refactor unrelated files in a feature PR.

## Lovable-managed surface

Parts of the build are managed by [Lovable](https://lovable.dev). **Do not edit**
`vite.config.ts`, the Vite plugin wiring, or the Nitro/Cloudflare preset config — the
Cloudflare build is driven entirely by build-time env vars (see [DEPLOY.md](./DEPLOY.md))
so Lovable's visual edits stay non-conflicting. App code under `src/` is fair game.

## Screenshot contract (required for any visual change)

**Non-negotiable for any PR that changes rendered output — PRs without it are
auto-closed, no exceptions.** See the root
[`.claude/skills/metagraphed/SKILL.md`](../../.claude/skills/metagraphed/SKILL.md)'s
"Path C — Frontend PR" section (Phase C2) for the exact capture steps: fixed viewport
sizes (mobile 375×812, tablet 768×1024, desktop 1280×800), both themes, before/after,
hosted on a branch and linked in a table in the PR body — never a full-page capture,
never images committed to your feature branch.

A PR confined to non-visual code (`src/lib/**`, `src/hooks/**`, test files) with no
rendered-output change skips this — it isn't rendering anything different.

## Linked issue

Every PR must reference an open issue (`Closes #<n>` / `Refs #<n>`) in the PR body, and
that issue must still be open at submission time — a missing or already-closed link is
an automatic close before content is even reviewed. Pick a `gittensor:bug` /
`gittensor:feature` issue scoped to `apps/ui/`.

## Pull requests

1. Branch off `main`.
2. Make the change; keep it scoped to one concern (aim for ≤10 files / ≤1000 LOC).
3. Run the checks above until green.
4. Fill the screenshot table if the change is visual, and link the issue you're closing.
5. Open the PR with a clear description of what and why. CI must pass to merge.

## Where issues live

All issues — backend, roadmap, and UI-specific — are tracked in
**[JSONbored/metagraphed](https://github.com/JSONbored/metagraphed/issues)**. There is
no separate frontend repo anymore; `apps/ui` is a workspace within this monorepo.

## License

By contributing you agree your work is released under this repository's
[AGPL-3.0 License](./LICENSE).
