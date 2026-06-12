# metagraphed-ui

The web frontend for **[Metagraphed](https://github.com/JSONbored/metagraphed)** — the
Bittensor subnet integration registry. It answers, for every subnet: _what does it
expose (APIs, docs, schemas), is it healthy, and how do I call it?_

Live at **[metagraph.sh](https://metagraph.sh)** as a Cloudflare Worker,
consuming the metagraphed backend API on the `api.metagraph.sh` subdomain.

## Stack

- **[Vite](https://vite.dev)** + **React 19** + **[TanStack Start](https://tanstack.com/start)** (SSR via Nitro's `cloudflare-module` preset)
- **[TanStack Router](https://tanstack.com/router)** (file-based, typed routes/params) + **[TanStack Query](https://tanstack.com/query)** (data fetching, suspense)
- **[Tailwind CSS](https://tailwindcss.com)** + **[Radix UI](https://www.radix-ui.com)** / shadcn primitives
- Deploys as a **Cloudflare Worker** — see [DEPLOY.md](./DEPLOY.md)

All data comes from the Metagraphed API (`https://api.metagraph.sh`, overridable
via `VITE_METAGRAPH_API_BASE`). This repo holds **no** subnet data — it renders
what the backend serves.

## Local development

[Bun](https://bun.sh) is the canonical local toolchain (`bun.lock` + `bunfig.toml`).

```bash
bun install
bun run dev        # Vite dev server
```

### Checks (the same gates CI runs)

```bash
bun run lint       # ESLint + Prettier
bun run typecheck  # tsc --noEmit
bun run build      # production SSR build
```

`bun run format` rewrites files to the Prettier style; `bun run format:check` verifies
without writing.

> CI installs with `npm ci --legacy-peer-deps` (the public `package-lock.json`) to match
> the Cloudflare Workers Builds deploy path. `bun.lock` pins a few packages to a private
> mirror that 403s in CI, so CI deliberately uses npm. Both lockfiles are kept in sync.

## Deployment

Deploys to Cloudflare Workers Builds on push. The Worker is named `metagraphed-ui`
and serves the `metagraph.sh` apex as a Cloudflare Custom Domain. Full setup,
environment variables, and the build/deploy commands are in [DEPLOY.md](./DEPLOY.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and the roadmap live in the
**[metagraphed](https://github.com/JSONbored/metagraphed/issues)** backend repo; open
UI-specific issues here.
