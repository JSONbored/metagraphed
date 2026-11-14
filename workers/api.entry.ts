// Compose public directory reads, the full API and GitHub OAuth at deployment.
// Keep the module graph for the default directories independent of the general
// router: deferred ESM files alone do not help if the entry imports that router.
// The state-source seam below follows the same rule — its module (and the pg +
// node:sqlite graph behind it) loads only when a deployment sets
// METAGRAPH_STATE_SOURCE, so today's cold starts never pay for it.
import { handleDefaultExplorerDirectory } from "./explorer-directory-entry.ts";
import { createApiEntry, type ApiFetchHandler } from "./api-composition.ts";

// Durable Object names must remain exports on the deploy entry. Re-export the
// original classes directly so their identity and persisted state stay intact.
export { ChainFirehoseHub } from "./chain-firehose-hub.ts";
export { McpSessionHub } from "./mcp-session-hub.ts";
export { AlerterHub } from "./alerter-hub.ts";
export { SubnetStatusHub } from "./subnet-status-hub.ts";
export { NeonWriteBufferHub } from "./neon-write-buffer-hub.ts";

// Memoize the composition after its first use, without loading either the
// provider or the general router for the two default directory requests.
async function loadOAuth(handler: ApiFetchHandler<Env, ExecutionContext>) {
  const [
    { OAuthProvider },
    { buildOAuthProviderOptions, isNonOAuthMcpRequest },
  ] = await Promise.all([
    import("@cloudflare/workers-oauth-provider"),
    import("../src/github-oauth.ts"),
  ]);
  return {
    provider: new OAuthProvider(buildOAuthProviderOptions(handler)),
    isNonOAuthMcpRequest,
  };
}

// Hyperdrive-selected state (#13171, part of #13142): when a deployment sets
// the selector var, every invocation path resolves its env through the
// Hyperdrive assembly (which itself still requires the HYPERDRIVE binding and
// the exact "hyperdrive" value — anything else passes through unchanged). No
// deployed config sets the var today, so this import never runs and the env
// object reaches the application untouched and identical.
async function stateEnv(env: Env): Promise<Env> {
  if (env.METAGRAPH_STATE_SOURCE === undefined) return env;
  const { withHyperdriveStateBindings } =
    await import("../src/hyperdrive-state-bindings.ts");
  return withHyperdriveStateBindings(env);
}

const entry = createApiEntry<
  Env,
  ExecutionContext,
  ScheduledController,
  MessageBatch<unknown>
>({
  directory: handleDefaultExplorerDirectory,
  loadApplication: async () => (await import("./api.ts")).default,
  loadAuthorization: loadOAuth,
});

export default {
  async fetch(request, env, ctx) {
    return entry.fetch(request, await stateEnv(env), ctx);
  },
  async scheduled(event, env, ctx) {
    return entry.scheduled(event, await stateEnv(env), ctx);
  },
  async queue(batch, env, ctx) {
    return entry.queue(batch, await stateEnv(env), ctx);
  },
} satisfies typeof entry;
