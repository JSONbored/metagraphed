# Deploying metagraphed-ui to Cloudflare (Workers Builds)

This frontend deploys as a **Cloudflare Worker** (TanStack Start SSR via Nitro's
`cloudflare-module` preset). It serves the `metagraph.sh` apex and consumes the
`metagraphed` backend API on the separate `api.metagraph.sh` subdomain.

**Lovable stays in control of the app code.** Nothing here touches
`vite.config.ts`, `src/`, or any Vite plugin — the Cloudflare build is enabled
entirely through build-time **environment variables**, so future Lovable visual
edits are unaffected.

## Cloudflare Workers Builds settings

Connect this GitHub repo to **Workers Builds** (Cloudflare dashboard → Workers →
Create → Connect to Git), then configure:

| Setting            | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| **Build command**  | `npm ci --legacy-peer-deps && npm run build`                          |
| **Deploy command** | `npx --yes wrangler@4.90.1 deploy`                                    |
| **Worker name**    | `metagraphed-ui` (or accept the auto name `jsonbored-metagraphed-ui`) |

### Build environment variables

| Var                                                   | Value                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOVABLE_SANDBOX`                                     | `1`                          | Force-enables Nitro's `cloudflare-module` build outside Lovable's own environment (the preset otherwise skips Nitro and emits a static-only client build).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `NITRO_PRESET`                                        | `cloudflare-module`          | Explicit Cloudflare Worker target (this is also the default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `VITE_METAGRAPH_API_BASE`                             | `https://api.metagraph.sh`   | Backend API base. Optional — this is also the in-code default (`src/lib/metagraphed/config.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `VITE_POSTHOG_PROJECT_TOKEN`                          | _(PostHog project token)_    | **Required for any PostHog capture to leave a no-op state** (web analytics #7760, error tracking #7759, session replay #7761 — `src/lib/analytics.ts`). Any `VITE_*` var is read via Vite's `import.meta.env` at **build** time, so it MUST be set here, under Workers Builds' own build-variable settings — **not** as a runtime secret/var on the deployed Worker itself (a separate Cloudflare settings panel that the build container never sees; setting it there silently leaves the client bundle with no token baked in, and every capture call stays a silent no-op with zero errors). |
| `VITE_POSTHOG_HOST`                                   | _(optional)_                 | Overrides the `/ingest` first-party proxy path. Leave unset in normal deploys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `VITE_POSTHOG_UI_HOST`                                | _(optional)_                 | Overrides the PostHog dashboard deep-link host (US cloud by default). Leave unset unless this project moves region.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VITE_SENTRY_DSN`                                     | _(optional)_                 | Overrides the in-code fallback Sentry DSN (`src/lib/error-reporting.ts`) — a DSN is safe to hardcode/embed, so this is only for pointing at a different project.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POSTHOG_API_KEY`                                     | _(PostHog personal API key)_ | Optional — enables source-map upload for PostHog error tracking (`vite.config.ts`'s `@posthog/rollup-plugin`). A real secret (read/write access), unlike the write-only token above. Must be paired with `POSTHOG_PROJECT_ID` below or upload stays disabled.                                                                                                                                                                                                                                                                                                                                   |
| `POSTHOG_PROJECT_ID`                                  | `220683`                     | This project's numeric PostHog ID. Paired with `POSTHOG_API_KEY` for source-map upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | _(optional)_                 | Enables Sentry source-map upload (`@sentry/vite-plugin` in `vite.config.ts`). `SENTRY_AUTH_TOKEN` is a real secret; sourcemap upload is optional (readable stack traces vs. raw minified line:col) — Sentry itself works without it.                                                                                                                                                                                                                                                                                                                                                            |

Notes:

- **Build-time vs. runtime, generally**: every `VITE_*` var above is compiled into
  the client bundle by Vite during the build step, so it only works when set as
  a Workers Builds _build_ variable — never as a variable/secret on the
  deployed Worker's own Settings page (that's a separate, runtime-only
  mechanism the build container has no visibility into). Getting this wrong
  produces no error anywhere — the affected feature just silently never
  activates, which is exactly what happened with `VITE_POSTHOG_PROJECT_TOKEN`
  once already. Non-`VITE_`-prefixed vars (`POSTHOG_API_KEY`,
  `SENTRY_AUTH_TOKEN`, etc.) are build-time-only in a different sense — they're
  read via `process.env` inside `vite.config.ts` itself (Node, not client
  code), so they must also be set as Workers Builds build variables, but are
  never bundled into client-visible JS the way a `VITE_*` var is.

- `npm ci --legacy-peer-deps` uses the committed `package-lock.json` instead of
  re-resolving the caret ranges in `package.json` during production builds. Keep
  the lockfile updated intentionally with reviewed dependency changes.
- The deploy command pins Wrangler to an explicit version (`4.90.1`) instead of
  allowing `npx` to download whichever `wrangler` version is latest at deploy
  time. Review and update this pinned version deliberately when upgrading
  Cloudflare tooling.
- The build emits `dist/server/` (the Worker, entry `index.mjs`) + `dist/client/`
  (static assets), and Nitro auto-generates `dist/server/wrangler.json` +
  `.wrangler/deploy/config.json`. `npx --yes wrangler@4.90.1 deploy` from the repo root
  auto-discovers that config via the redirect — no committed `wrangler.toml`
  needed. (Both are git-ignored build output.)
- Durable fallback if a future preset version changes the sandbox detection: set
  `nitro: true` inside the existing `defineConfig({ ... })` in `vite.config.ts`
  (the documented escape hatch) instead of `LOVABLE_SANDBOX=1`.
- **Workers Builds' container OOMs during Nitro's SSR bundling pass on a
  default Node heap** (`FATAL ERROR: ... JavaScript heap out of memory`,
  consistently around a ~2GB ceiling — confirmed via a local repro
  constraining Node to the same limit, and reproducible even after trimming
  the largest single contributor, fumadocs-openapi's shiki syntax-highlight
  bundle, down 93%). `apps/ui/package.json`'s own `build` script now sets
  `NODE_OPTIONS=--max-old-space-size=4096` for exactly this reason — Node's
  own heap-sizing heuristic is commonly more conservative than a container's
  real available memory, and this repo's `npm run build` needs the room. If
  the build still OOMs after this, the app's Nitro/SSR bundle has likely
  grown large enough to need either a genuinely bigger Workers Builds
  machine tier (if Cloudflare's dashboard exposes one) or further bundle
  trimming (large unscoped dependencies are the usual culprit — check for
  another shiki-style "whole package pulled in via a barrel import" case
  first).

## Routing

`metagraph.sh` is attached to this Worker as a Cloudflare **Custom Domain**
(Workers & Pages → `metagraphed-ui` → Domains), so the bare apex serves the UI
and Cloudflare manages the apex DNS record + TLS certificate automatically. The
Worker is also always reachable at `metagraphed-ui.<account>.workers.dev`, plus
per-branch preview URLs at `*-metagraphed-ui.<account>.workers.dev`.

The backend (`metagraphed`) is a **separate** Worker on the `api.metagraph.sh`
subdomain — the UI apex and the API are distinct hostnames, so there is no
path-based route splitting to configure on this Worker.
