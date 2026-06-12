# Contributing to metagraphed-ui

Thanks for helping improve the [Metagraphed](https://github.com/JSONbored/metagraphed)
frontend. This guide gets you from clone to a green PR.

## Setup

[Bun](https://bun.sh) is the canonical toolchain.

```bash
bun install
bun run dev
```

The app fetches live data from `https://metagraph.sh` by default — no backend setup or
secrets are required to develop against real data. To point at a different backend, set
`VITE_METAGRAPH_API_BASE`.

## Before you open a PR

Run the three checks CI enforces — a PR is only mergeable when all pass:

```bash
bun run lint       # ESLint + Prettier (errors block; the repo is Prettier-clean)
bun run typecheck  # tsc --noEmit (the routes are fully typed — no `any` escape hatches)
bun run build      # production SSR build must succeed
```

If lint flags formatting, run `bun run format`. Prettier is the single source of truth
for style and is enforced through ESLint's `prettier/prettier` rule — don't hand-format.

## Code conventions

- **Typed routes.** TanStack Router params are typed. `/subnets/$netuid` takes a
  **number** netuid — pass `params={{ netuid: s.netuid }}`, not `String(...)`. Let `tsc`
  guide you; never cast around a type error.
- **Data fetching** goes through the query helpers in `src/lib/metagraphed/queries.ts`
  and `useSuspenseQuery` / error boundaries — don't fetch ad hoc in components.
- **Components** live in `src/components/metagraphed/`; route trees in `src/routes/`.
- Keep diffs focused. Don't reformat or refactor unrelated files in a feature PR.

## Lovable-managed surface

Parts of the build are managed by [Lovable](https://lovable.dev). **Do not edit**
`vite.config.ts`, the Vite plugin wiring, or the Nitro/Cloudflare preset config — the
Cloudflare build is driven entirely by build-time env vars (see [DEPLOY.md](./DEPLOY.md))
so Lovable's visual edits stay non-conflicting. App code under `src/` is fair game.

## Pull requests

1. Branch off `main`.
2. Make the change; keep it scoped to one concern.
3. Run the three checks above until green.
4. Open the PR with a clear description of what and why. CI must pass to merge.

## Where issues live

The roadmap and most issues are tracked in the
**[metagraphed](https://github.com/JSONbored/metagraphed/issues)** backend repo. Open
**UI-specific** issues (rendering, routing, accessibility, design) in this repo.
