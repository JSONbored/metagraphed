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

| Var                       | Value                      | Why                                                                                                                                                        |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOVABLE_SANDBOX`         | `1`                        | Force-enables Nitro's `cloudflare-module` build outside Lovable's own environment (the preset otherwise skips Nitro and emits a static-only client build). |
| `NITRO_PRESET`            | `cloudflare-module`        | Explicit Cloudflare Worker target (this is also the default).                                                                                              |
| `VITE_METAGRAPH_API_BASE` | `https://api.metagraph.sh` | Backend API base. Optional — this is also the in-code default (`src/lib/metagraphed/config.ts`).                                                           |

Notes:

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

## Routing

`metagraph.sh` is attached to this Worker as a Cloudflare **Custom Domain**
(Workers & Pages → `metagraphed-ui` → Domains), so the bare apex serves the UI
and Cloudflare manages the apex DNS record + TLS certificate automatically. The
Worker is also always reachable at `metagraphed-ui.<account>.workers.dev`, plus
per-branch preview URLs at `*-metagraphed-ui.<account>.workers.dev`.

The backend (`metagraphed`) is a **separate** Worker on the `api.metagraph.sh`
subdomain — the UI apex and the API are distinct hostnames, so there is no
path-based route splitting to configure on this Worker.
