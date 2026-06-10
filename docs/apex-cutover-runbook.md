# Apex cutover runbook — UI at `metagraph.sh`, backend path-routed

This is the coordinated cutover from the single-Worker apex (backend on
`custom_domain: true`) to **two Workers on the same apex**: the `metagraph-finder`
frontend Worker serves the UI at `metagraph.sh/*`, and this backend Worker serves
only `/api/*`, `/rpc/*`, `/metagraph/*`, `/health` via zone routes. Same-origin →
no CORS. (Decision: `docs/beta-roadmap.md` → "Frontend Architecture".)

**Why a runbook:** switching the backend off `custom_domain` before the frontend
catch-all exists orphans the apex (every non-API path 404s). Do the swap in one
short window.

## Pre-req (must be true before starting)

1. The frontend Worker (`metagraph-finder`) is **deployed and verified** on a
   non-apex hostname (`*.workers.dev` or `app.metagraph.sh`), loading live data
   from `https://metagraph.sh`. See `metagraph-finder/DEPLOY.md`.
2. `metagraph.sh` has a **proxied** (orange-cloud) DNS record in the zone so
   Workers zone-routes can attach. (With `custom_domain` Cloudflare managed this;
   zone routes need a proxied A/AAAA/CNAME record on the apex.)

## Cutover (one window)

1. **Backend → zone routes.** Merge the `wrangler.jsonc` change in this PR
   (`custom_domain: true` → the four zone routes). Cloudflare Workers Builds
   redeploys the backend on push to `main`. At this moment the apex root has no
   Worker for non-API paths — proceed immediately to step 2–3.
2. **Remove the old custom domain.** In the Cloudflare dashboard → Workers &
   Pages → `metagraphed` → Settings → Domains & Routes, **remove the
   `metagraph.sh` custom domain** (a `wrangler deploy` route change does not
   auto-remove an existing custom domain). Confirm the four zone routes are
   present.
3. **Frontend → apex catch-all.** Add the route **`metagraph.sh/*`** to the
   `metagraph-finder` Worker (Workers → metagraph-finder → Triggers → Routes, or
   its deploy config). Lowest precedence — it catches everything the backend
   routes don't.

## Verify

```sh
curl -sI  https://metagraph.sh/                              # 200 text/html (UI)
curl -s   https://metagraph.sh/api/v1/subnets | head -c 80   # JSON envelope (backend)
curl -sI  https://metagraph.sh/metagraph/health/badges/7.svg # image/svg+xml (backend)
curl -sI  https://metagraph.sh/subnets/7                      # 200 text/html (UI SSR)
```
Then `npm run smoke:live` (backend) and click through the UI pages.

## Rollback

Revert this PR (restore `custom_domain: true`) and redeploy the backend; remove
the frontend `metagraph.sh/*` route. The apex returns to backend-only.

## Notes

- Webhooks (`/api/v1/webhooks/*`) and SSE (`/api/v1/events`) fall under
  `/api/*`, so they're covered by the backend zone routes.
- Optional later optimization: a Service Binding (frontend → backend) for SSR
  fetches avoids the public edge hop; needs a frontend-code change, so deferred.
