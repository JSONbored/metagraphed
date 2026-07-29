// Deploy entry point for workers/api.ts -- composes the GitHub OAuth
// provider on top of the raw handler (metagraphed#7151). Kept SEPARATE from
// the actual handler (not composed inline in that file) purely so
// wrangler.jsonc's "main" can point at a thin composition layer while
// ~90 existing tests for this Worker keep importing api.ts's own
// handleRequest/handleScheduled/default export directly, unaffected by
// whatever this entry adds on top.
//
// metagraphed#7766: previously also wrapped everything with
// @sentry/cloudflare's withSentry() (Sentry fully removed here -- PostHog
// $exception capture already covers every route, and PostHog distributed
// tracing (src/tracing.ts, #7768) replaces the automatic HTTP
// instrumentation withSentry() provided). This file is now pure OAuth
// composition, no error-tracking wrap of its own.
//
// wrangler.jsonc's "main" points HERE instead of at the raw handler file,
// so only the actual deployed Worker -- running in the real workerd
// runtime, never a test -- ever executes the wrapped path. This file
// itself is excluded from coverage tracking (vitest.config.ts); it's a
// thin, mechanical composition with no logic of its own worth testing here
// (isNonOAuthMcpRequest/buildOAuthProviderOptions have their own coverage
// in tests/github-oauth.test.ts).
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import handler from "./api.ts";
import {
  buildOAuthProviderOptions,
  isNonOAuthMcpRequest,
} from "../src/github-oauth.ts";
// wrangler.jsonc's "main" points at THIS file, so wrangler looks for every
// Durable Object binding's class as a named export from here, not from
// api.ts -- confirmed by a real `wrangler deploy --dry-run` failure ("Your
// Worker depends on the following Durable Objects, which are not exported
// in your entrypoint file") before this re-export was added.
export {
  ChainFirehoseHub,
  McpSessionHub,
  AlerterHub,
  SubnetStatusHub,
} from "./api.ts";

// GitHub OAuth (metagraphed#7151): OAuthProvider owns top-level fetch
// dispatch (its own /oauth/token + /oauth/register endpoints, plus routing
// /mcp to apiHandler with ctx.props populated when a valid Bearer token is
// present). A BARE /mcp request with no Bearer token is routed to the real,
// unmodified `handler` directly, bypassing oauthProvider.fetch() entirely --
// isNonOAuthMcpRequest below, NOT anything inside OAuthProvider's own
// apiRoute/apiHandler machinery, is what keeps anonymous/IP-rate-limited
// access to /mcp working. This was a real production regression (silently
// 401ing every anonymous MCP client since #7151) until this explicit bypass
// was added: @cloudflare/workers-oauth-provider's apiRoute/apiHandler
// mechanism unconditionally requires a valid Bearer token and 401s BEFORE
// apiHandler is ever reached -- there is no library-level "authenticate if
// present, else fall through to defaultHandler" option (confirmed against
// node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js
// directly, not just its .d.ts); see src/github-oauth.ts's
// buildOAuthProviderOptions/isNonOAuthMcpRequest comments for the full
// story. Every other path -- /authorize, /oauth/token, /oauth/register,
// OAuthProvider's own discovery endpoints, and /mcp WITH a Bearer token --
// still needs the real oauthProvider.fetch() dispatch, so this bypass stays
// scoped to exactly the one route/no-token combination.
//
// OAuthProvider instances expose ONLY .fetch(), not .scheduled() -- this
// Worker has four live cron triggers (wrangler.jsonc "triggers.crons": the
// 15-min health probe, two hourly rollups, the daily embedding sync) that
// dispatch to handler.scheduled (handleScheduled in api.ts). Swapping the
// top-level export for a bare OAuthProvider instance would silently drop
// every one of those -- Cloudflare would just never find a .scheduled to
// call. This composed object keeps .scheduled pointed at the ORIGINAL,
// untouched handler so cron behavior is byte-for-byte unaffected by this
// change; only .fetch is rerouted through OAuthProvider.
const oauthProvider = new OAuthProvider(buildOAuthProviderOptions(handler));

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    isNonOAuthMcpRequest(request)
      ? handler.fetch(request, env, ctx)
      : oauthProvider.fetch(request, env, ctx),
  // Discards handleScheduled's (api.ts) return value --
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
