// Deploy entry point for workers/data-api.mjs -- wraps it with Sentry error
// tracking (metagraphed#6479, part of #6485). Kept SEPARATE from the actual
// handler (not wrapped inline in that file) because @sentry/cloudflare's
// withSentry() requires real Cloudflare Workers runtime primitives
// (AsyncLocalStorage-based context propagation via workerd) that don't
// exist in the plain-Node vitest environment this repo's own tests already
// run in -- confirmed empirically against workers/registry-sync-api.mjs
// (the same pattern): wrapping a Worker's export inline crashed every one
// of its existing tests with "Cannot read properties of undefined (reading
// 'bind')" inside @sentry/cloudflare's flush-lock registry.
// tests/data-api.test.mjs continues importing and exercising the real
// handler directly (this file's own import below, unwrapped), completely
// unaffected.
//
// wrangler.data.jsonc's "main" points HERE instead of at the raw handler
// file, so only the actual deployed Worker -- running in the real workerd
// runtime, never a test -- ever executes the wrapped path. This file
// itself is excluded from coverage tracking (vitest.config.mjs) for the
// same runtime-mismatch reason; it's a thin, mechanical re-export with no
// logic of its own to test.
//
// withSentry() MUTATES `handler` in place and returns the same reference
// (confirmed by reading @sentry/cloudflare's own source) -- this only
// matters if something else also imports data-api.mjs's raw export in the
// same module graph as this file, which nothing does today (tests import
// the raw file only; only wrangler's build ever loads this wrapper).
import * as Sentry from "@sentry/cloudflare";
import handler from "./data-api.mjs";

export default Sentry.withSentry<Env>(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || "production",
    // Cloudflare's own CF_VERSION_METADATA binding (added in
    // wrangler.data.jsonc) when present, falling back to an explicit
    // SENTRY_RELEASE var/secret -- matches @sentry/cloudflare's own
    // documented auto-detection convention. Both undefined is a valid,
    // accepted value (Sentry just omits release tagging), not an error.
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    // Performance tracing at a conservative 5% sample -- see
    // workers/api.sentry.mjs's own comment (metagraphed#6768) for the full
    // rationale; this Worker is the one that actually runs the leaderboard/
    // chain-events Postgres queries this issue's traffic-volume question was
    // about.
    tracesSampleRate: 0.05,
  }),
  handler,
);
