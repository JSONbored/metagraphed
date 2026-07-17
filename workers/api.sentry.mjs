// Deploy entry point for workers/api.mjs -- wraps it with Sentry error
// tracking (metagraphed#6479/#6502, part of #6485). Kept SEPARATE from the
// actual handler (not wrapped inline in that file) because
// @sentry/cloudflare's withSentry() requires real Cloudflare Workers
// runtime primitives (AsyncLocalStorage-based context propagation via
// workerd) that don't exist in the plain-Node vitest environment this
// repo's own ~90 existing tests for this Worker already run in -- confirmed
// empirically against workers/registry-sync-api.mjs (the same pattern):
// wrapping a Worker's export inline crashed every one of its existing
// tests with "Cannot read properties of undefined (reading 'bind')" inside
// @sentry/cloudflare's flush-lock registry. Those ~90 tests continue
// importing and exercising the real handler directly (this file's own
// import below, unwrapped), completely unaffected.
//
// wrangler.jsonc's "main" points HERE instead of at the raw handler file,
// so only the actual deployed Worker -- running in the real workerd
// runtime, never a test -- ever executes the wrapped path. This file
// itself is excluded from coverage tracking (vitest.config.mjs) for the
// same runtime-mismatch reason; it's a thin, mechanical re-export with no
// logic of its own to test.
//
// This wrapper originally didn't fit: adding @sentry/cloudflare pushed
// this Worker's own bundle 30.9 KiB over Cloudflare's 1024 KiB hard deploy
// ceiling (#6502). The ~545 KiB gzipped cost was workers-og (satori +
// resvg-wasm), imported for the live OG-card render at GET /og.png. Fixed
// by moving that render out of the request path entirely: it now runs at
// publish time in Node (scripts/refresh-og-image.mjs) and the result is
// stored in R2 like every other artifact, so api.mjs never imports
// workers-og at all -- see src/og-image.mjs's own header. That freed
// comfortable headroom for Sentry here without a second Worker.
//
// withSentry() instruments BOTH the fetch AND scheduled handlers on the
// object it's given (confirmed by reading @sentry/cloudflare's own
// withSentry.js source -- it calls instrumentExportedHandlerFetch and
// instrumentExportedHandlerScheduled unconditionally, not just fetch), so
// api.mjs's cron-triggered handleScheduled path is covered too, not just
// the public HTTP surface. It MUTATES `handler` in place and returns the
// same reference -- this only matters if something else also imports
// api.mjs's raw export in the same module graph as this file, which
// nothing does today (tests import the raw file only; only wrangler's
// build ever loads this wrapper).
import { withSentry } from "@sentry/cloudflare";
import handler from "./api.mjs";
// wrangler.jsonc's "main" now points at THIS file, so wrangler looks for
// every Durable Object binding's class as a named export from here, not
// from api.mjs -- confirmed by a real `wrangler deploy --dry-run` failure
// ("Your Worker depends on the following Durable Objects, which are not
// exported in your entrypoint file") before this re-export was added.
export {
  ChainFirehoseHub,
  McpSessionHub,
  AlerterHub,
  SubnetStatusHub,
} from "./api.mjs";

export default withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || "production",
    // Cloudflare's own CF_VERSION_METADATA binding (added in
    // wrangler.jsonc) when present, falling back to an explicit
    // SENTRY_RELEASE var/secret -- matches @sentry/cloudflare's own
    // documented auto-detection convention. Both undefined is a valid,
    // accepted value (Sentry just omits release tagging), not an error.
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    // Error tracking only, matching every other component in this rollout
    // -- no performance tracing.
    tracesSampleRate: 0,
  }),
  handler,
);
