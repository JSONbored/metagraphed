# Deploying metagraph-finder to Cloudflare (Workers Builds)

This frontend deploys as a **Cloudflare Worker** (TanStack Start SSR via Nitro's
`cloudflare-module` preset) alongside the `metagraphed` backend, so the UI and
API share the `metagraph.sh` origin (same-origin, no CORS).

**Lovable stays in control of the app code.** Nothing here touches
`vite.config.ts`, `src/`, or any Vite plugin — the Cloudflare build is enabled
entirely through build-time **environment variables**, so future Lovable visual
edits are unaffected.

## Cloudflare Workers Builds settings

Connect this GitHub repo to **Workers Builds** (Cloudflare dashboard → Workers →
Create → Connect to Git), then configure:

| Setting | Value |
| --- | --- |
| **Build command** | `npm install --legacy-peer-deps && npm run build` |
| **Deploy command** | `npx wrangler deploy` |
| **Worker name** | `metagraph-finder` (or accept the auto name `jsonbored-metagraph-finder`) |

### Build environment variables

| Var | Value | Why |
| --- | --- | --- |
| `LOVABLE_SANDBOX` | `1` | Force-enables Nitro's `cloudflare-module` build outside Lovable's own environment (the preset otherwise skips Nitro and emits a static-only client build). |
| `NITRO_PRESET` | `cloudflare-module` | Explicit Cloudflare Worker target (this is also the default). |
| `VITE_METAGRAPH_API_BASE` | `https://metagraph.sh` | Backend API base (also the in-code default). |

Notes:
- `npm install --legacy-peer-deps` is used instead of `bun install` because
  `bun.lock` pins some public packages (e.g. `@tanstack/zod-adapter`) to
  Lovable's **private npm mirror**, which 403s outside Lovable's network. All
  those packages exist on the **public** npm registry, so npm resolves them
  fine. (Durable alternative if you prefer bun: add a `bunfig.toml` with
  `registry = "https://registry.npmjs.org"`.)
- The build emits `dist/server/` (the Worker, entry `index.mjs`) + `dist/client/`
  (static assets), and Nitro auto-generates `dist/server/wrangler.json` +
  `.wrangler/deploy/config.json`. `npx wrangler deploy` from the repo root
  auto-discovers that config via the redirect — no committed `wrangler.toml`
  needed. (Both are git-ignored build output.)
- Durable fallback if a future preset version changes the sandbox detection: set
  `nitro: true` inside the existing `defineConfig({ ... })` in `vite.config.ts`
  (the documented escape hatch) instead of `LOVABLE_SANDBOX=1`.

## Routing (apex cutover)

Initially the Worker is reachable at `metagraph-finder.<account>.workers.dev`
(verify all pages load live data from `https://metagraph.sh`). To serve the UI
at the bare apex:

1. Backend (`metagraphed`) switches `wrangler.jsonc` from `custom_domain: true`
   to zone routes (`metagraph.sh/api/*`, `/rpc/*`, `/metagraph/*`, `/health`).
2. This Worker takes the catch-all route **`metagraph.sh/*`** (Worker → Triggers
   → Routes, or `routes` in the deploy). Cloudflare matches more-specific routes
   first, so `/api/*` etc. hit the backend and everything else renders the UI.
3. Ensure `metagraph.sh` has a **proxied** DNS record and remove the backend's
   old custom domain. Do the swap in one short window so the apex is never
   orphaned.
