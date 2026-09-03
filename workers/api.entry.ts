// Compose public directory reads, the full API and GitHub OAuth at deployment.
// Keep the module graph for the default directories independent of the general
// router: deferred ESM files alone do not help if the entry imports that router.
import { handleDefaultExplorerDirectory } from "./explorer-directory-entry.ts";

// Durable Object names must remain exports on the deploy entry. Re-export the
// original classes directly so their identity and persisted state stay intact.
export { ChainFirehoseHub } from "./chain-firehose-hub.ts";
export { McpSessionHub } from "./mcp-session-hub.ts";
export { AlerterHub } from "./alerter-hub.ts";
export { SubnetStatusHub } from "./subnet-status-hub.ts";
export { NeonWriteBufferHub } from "./neon-write-buffer-hub.ts";

const handler = {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) =>
    (await import("./api.ts")).default.fetch(request, env, ctx),
};

// Memoize the composition after its first use, without loading either the
// provider or the general router for the two default directory requests.
async function loadOAuth() {
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
let oauth: ReturnType<typeof loadOAuth> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const directory = await handleDefaultExplorerDirectory(request, env, ctx);
    if (directory) return directory;
    const { provider, isNonOAuthMcpRequest } = await (oauth ??= loadOAuth());
    // Bare MCP retains its anonymous path. Bearer tokens and all OAuth
    // discovery/token/registration routes remain owned by the provider.
    return isNonOAuthMcpRequest(request)
      ? handler.fetch(request, env, ctx)
      : provider.fetch(request, env, ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await (await import("./api.ts")).default.scheduled(controller, env, ctx);
  },
  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await (await import("./api.ts")).default.queue(batch, env, ctx);
  },
};
