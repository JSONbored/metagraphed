// Compose public directory reads, the full API and GitHub OAuth at deployment.
// Keep the module graph for the default directories independent of the general
// router: deferred ESM files alone do not help if the entry imports that router.
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
export default createApiEntry<
  Env,
  ExecutionContext,
  ScheduledController,
  MessageBatch<unknown>
>({
  directory: handleDefaultExplorerDirectory,
  loadApplication: async () => (await import("./api.ts")).default,
  loadAuthorization: loadOAuth,
});
