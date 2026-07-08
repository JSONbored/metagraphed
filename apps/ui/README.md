<div align="center">

# apps/ui — metagraphed frontend

**The web frontend for [Metagraphed](https://github.com/JSONbored/metagraphed)** — the Bittensor subnet integration registry.

[![Live](https://img.shields.io/badge/live-metagraph.sh-2ea44f)](https://metagraph.sh)
[![Validate](https://github.com/JSONbored/metagraphed/actions/workflows/validate.yml/badge.svg)](https://github.com/JSONbored/metagraphed/actions/workflows/validate.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

[**metagraph.sh**](https://metagraph.sh) · [Backend](https://github.com/JSONbored/metagraphed) · [Deploy](./DEPLOY.md)

</div>

---

The web app at **[metagraph.sh](https://metagraph.sh)** — for every Bittensor subnet:
what it exposes (APIs, docs, schemas), whether it's healthy, and how to call it. It
holds **no** subnet data; it renders what the
[metagraphed](https://github.com/JSONbored/metagraphed) backend serves at
`api.metagraph.sh`. This directory (`apps/ui`) is an npm workspace within the
`metagraphed` monorepo, not a standalone repository.

## Stack

Vite · React 19 · [TanStack Start](https://tanstack.com/start) (SSR via Nitro's
`cloudflare-module` preset) · [TanStack Router/Query](https://tanstack.com) · Tailwind ·
Radix/shadcn. Deploys as a Cloudflare Worker — see [DEPLOY.md](./DEPLOY.md).

## Getting started

Node 22 and npm are the canonical toolchain. No secrets needed — it talks to the live
API.

```bash
npm install                       # from the repo root — wires the apps/ui workspace too
npm run dev --workspace=apps/ui   # dev server
```

Run the same checks CI's `ui` job gates on before you push:

```bash
npm run lint --workspace=apps/ui
npm run typecheck --workspace=apps/ui
npm run build --workspace=apps/ui
```

> The API base defaults to `https://api.metagraph.sh` (override with
> `VITE_METAGRAPH_API_BASE`).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Parts of the build are Lovable-managed —
don't edit `vite.config.ts`. All issues — backend, roadmap, and UI-specific — are
tracked in [JSONbored/metagraphed](https://github.com/JSONbored/metagraphed/issues).

## License

[AGPL-3.0](./LICENSE) — © 2026 JSONbored. (The metagraphed backend is also AGPL-3.0;
its embeddable client SDKs are Apache-2.0.)
