// Deploy entry point for workers/og-image-api.mjs -- wraps it with Sentry
// error tracking (metagraphed#6502, part of the rollout, #6485). Kept
// SEPARATE from the actual handler (not wrapped inline) for the same
// reason workers/data-api.sentry.mjs and workers/registry-sync-api.sentry.mjs
// are: @sentry/cloudflare's withSentry() requires real Cloudflare Workers
// runtime primitives (AsyncLocalStorage-based context propagation via
// workerd) that don't exist in the plain-Node vitest environment this
// repo's own tests run in -- confirmed empirically against the other two
// Workers using this exact pattern.
//
// wrangler.og.jsonc's "main" points HERE instead of at the raw handler
// file. This file itself is excluded from coverage tracking
// (vitest.config.mjs's "workers/*.sentry.mjs" glob) for the same
// runtime-mismatch reason; it's a thin, mechanical re-export with no logic
// of its own to test.
import * as Sentry from "@sentry/cloudflare";
import handler from "./og-image-api.mjs";

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || "production",
    // Cloudflare's own CF_VERSION_METADATA binding (added in
    // wrangler.og.jsonc) when present, falling back to an explicit
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
