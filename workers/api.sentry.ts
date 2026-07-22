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
// workers-og at all -- see src/og-image.ts's own header. That freed
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
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import handler from "./api.mjs";
import {
  buildOAuthProviderOptions,
  isAnonymousMcpRequest,
} from "../src/github-oauth.ts";
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

// GitHub OAuth (metagraphed#7151): OAuthProvider owns top-level fetch
// dispatch (its own /oauth/token + /oauth/register endpoints, plus routing
// /mcp to apiHandler with ctx.props populated when a valid Bearer token is
// present). A BARE /mcp request with no Bearer token is routed to the real,
// unmodified `handler` directly, bypassing oauthProvider.fetch() entirely --
// isAnonymousMcpRequest below, NOT anything inside OAuthProvider's own
// apiRoute/apiHandler machinery, is what keeps anonymous/IP-rate-limited
// access to /mcp working. This was a real production regression (silently
// 401ing every anonymous MCP client since #7151) until this explicit bypass
// was added: @cloudflare/workers-oauth-provider's apiRoute/apiHandler
// mechanism unconditionally requires a valid Bearer token and 401s BEFORE
// apiHandler is ever reached -- there is no library-level "authenticate if
// present, else fall through to defaultHandler" option (confirmed against
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
// directly, not just its .d.ts); see src/github-oauth.ts's
// buildOAuthProviderOptions/isAnonymousMcpRequest comments for the full
// story. Every other path -- /authorize, /oauth/token, /oauth/register,
// OAuthProvider's own discovery endpoints, and /mcp WITH a Bearer token --
// still needs the real oauthProvider.fetch() dispatch, so this bypass stays
// scoped to exactly the one route/no-token combination.
//
// OAuthProvider instances expose ONLY .fetch(), not .scheduled() -- this
// Worker has four live cron triggers (wrangler.jsonc "triggers.crons": the
// 15-min health probe, two hourly rollups, the daily embedding sync) that
// dispatch to handler.scheduled (handleScheduled in api.mjs). Swapping the
// top-level export for a bare OAuthProvider instance would silently drop
// every one of those -- Cloudflare would just never find a .scheduled to
// call. This composed object keeps .scheduled pointed at the ORIGINAL,
// untouched handler so cron behavior is byte-for-byte unaffected by this
// change; only .fetch is rerouted through OAuthProvider.
const oauthProvider = new OAuthProvider(buildOAuthProviderOptions(handler));
const handlerWithOAuth = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    isAnonymousMcpRequest(request)
      ? handler.fetch(request, env, ctx)
      : oauthProvider.fetch(request, env, ctx),
  // Discards handleScheduled's (api.mjs, not yet converted) return value --
  // it returns diagnostic objects for its own test suite's benefit; the real
  // Workers runtime ignores scheduled()'s return value, and ExportedHandler's
  // type expects `void | Promise<void>`.
  scheduled: async (
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> => {
    await handler.scheduled(controller, env, ctx);
  },
};

export default withSentry<Env>(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || "production",
    // Cloudflare's own CF_VERSION_METADATA binding (added in
    // wrangler.jsonc) when present, falling back to an explicit
    // SENTRY_RELEASE var/secret -- matches @sentry/cloudflare's own
    // documented auto-detection convention. Both undefined is a valid,
    // accepted value (Sentry just omits release tagging), not an error.
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    // Performance tracing at a conservative 5% sample (metagraphed#6768) --
    // was 0 ("error tracking only") across this whole rollout, which left
    // zero visibility into real request volume/latency for anything outside
    // /mcp (the only route with its own hand-rolled span). 5% is a starting
    // point chosen without knowing this org's actual Sentry plan/quota
    // headroom (not visible from the tools available when this was picked);
    // revisit once real trace volume is observable -- worth moving to a
    // tracesSampler with per-route weights (e.g. sampling the leaderboard/
    // chain-events routes higher) once there's real traffic data to
    // calibrate that against, rather than guessing now.
    tracesSampleRate: 0.05,
  }),
  handlerWithOAuth,
);
