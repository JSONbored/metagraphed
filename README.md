<div align="center">

# metagraphed-ui

**The web frontend for [Metagraphed](https://github.com/JSONbored/metagraphed)** — the Bittensor subnet integration registry.

[![Live](https://img.shields.io/badge/live-metagraph.sh-2ea44f)](https://metagraph.sh)
[![CI](https://github.com/JSONbored/metagraphed-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/JSONbored/metagraphed-ui/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

[**metagraph.sh**](https://metagraph.sh) · [Backend](https://github.com/JSONbored/metagraphed) · [Deploy](./DEPLOY.md)

</div>

---

The web app at **[metagraph.sh](https://metagraph.sh)** — for every Bittensor subnet:
what it exposes (APIs, docs, schemas), whether it's healthy, and how to call it. It
holds **no** subnet data; it renders what the
[metagraphed](https://github.com/JSONbored/metagraphed) backend serves at
`api.metagraph.sh`.

## Stack

Vite · React 19 · [TanStack Start](https://tanstack.com/start) (SSR via Nitro's
`cloudflare-module` preset) · [TanStack Router/Query](https://tanstack.com) · Tailwind ·
Radix/shadcn. Deploys as a Cloudflare Worker — see [DEPLOY.md](./DEPLOY.md).

## Getting started

[Bun](https://bun.sh) is the canonical toolchain. No secrets needed — it talks to the
live API.

```bash
bun install
bun run dev        # dev server
```

Run the same checks CI gates on before you push:

```bash
bun run lint       # ESLint + Prettier
bun run typecheck  # tsc --noEmit
bun run build      # production SSR build
```

> The API base defaults to `https://api.metagraph.sh` (override with
> `VITE_METAGRAPH_API_BASE`). CI installs via `npm ci --legacy-peer-deps` to match the
> Cloudflare deploy path — `bun.lock` pins a few packages to a private mirror that 403s
> in CI, so both lockfiles are kept in sync.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Parts of the build are Lovable-managed —
don't edit `vite.config.ts`. Backend and roadmap issues live in the
[metagraphed](https://github.com/JSONbored/metagraphed/issues) repo; open UI-specific
issues here.

## License

[AGPL-3.0](./LICENSE) — © 2026 JSONbored. (The metagraphed backend is also AGPL-3.0;
its embeddable client SDKs are Apache-2.0.)
