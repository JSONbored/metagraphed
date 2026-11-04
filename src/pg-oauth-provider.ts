import type {
  OAuthHelpers,
  OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type {
  NativeOAuthContext,
  NativeOAuthModule,
} from "./native-oauth-provider.ts";
import { createPgKv, type PgKvRuntime } from "./pg-kv.ts";
import type { AppKv } from "./app-kv-types.ts";

const namespace = "oauth-provider";

class RollbackResponse {
  readonly response: Response;
  constructor(response: Response) {
    this.response = response;
  }
}

/** Match the pinned provider's endpoint rules, including its hostname/path
 * comparison for absolute endpoint URLs. The provider still owns dispatch. */
function matches(url: URL, endpoint: string): boolean {
  if (endpoint.startsWith("/")) return url.pathname === endpoint;
  const expected = new URL(endpoint);
  return (
    url.hostname === expected.hostname && url.pathname === expected.pathname
  );
}

/** Explicit native composition. Crypto, grant formats, expiry and protocol
 * responses remain owned by the pinned upstream provider. Every mutation uses
 * one namespace lock and one lease; bearer reads release their ordinary pooled
 * KV query before upstream delegates to the application handler. */
export function createPgOAuthProvider<Environment extends object>(
  runtime: PgKvRuntime,
  upstream: NativeOAuthModule,
  options: OAuthProviderOptions<Environment>,
) {
  if (
    options.clientIdMetadataDocumentEnabled ||
    options.enterpriseManagedAuthorization
  ) {
    throw new TypeError(
      "Native OAuth metadata fetching requires a qualified public-only fetch capability",
    );
  }
  const provider = new upstream.OAuthProvider(options);
  const kv = createPgKv(runtime, namespace);
  const environment = (env: Environment, store: AppKv) => ({
    ...env,
    OAUTH_KV: store,
  });
  const mutate = <T>(
    env: Environment,
    operation: (scoped: Environment, helpers: OAuthHelpers) => Promise<T>,
  ): Promise<T> =>
    runtime.transaction(
      async (tx) => {
        // BEGIN alone may inherit REPEATABLE READ from the connection defaults.
        // A waiter must observe the previous lock holder's committed grant.
        await tx.run("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await tx.query<{ pg_advisory_xact_lock: null }>(
          "SELECT pg_advisory_xact_lock(hashtextextended(?,0))",
          ["metagraphed:oauth-provider"],
        );
        const scoped = environment(
          env,
          createPgKv(
            { producer: tx, transaction: (callback) => callback(tx) },
            namespace,
          ),
        );
        const api = upstream.getOAuthApi(options, scoped);
        // Callbacks and nested helpers stay on this lease. Neither the scoped
        // environment nor its helpers are cached beyond the operation.
        Object.assign(scoped, { OAUTH_PROVIDER: api });
        return operation(scoped, api);
      },
      { isolation: "read committed" },
    );

  const helpers = (env: Environment): OAuthHelpers => {
    const read = () => upstream.getOAuthApi(options, environment(env, kv));
    return {
      parseAuthRequest: (request) => read().parseAuthRequest(request),
      lookupClient: (clientId) => read().lookupClient(clientId),
      listClients: (settings) => read().listClients(settings),
      listUserGrants: (userId, settings) =>
        read().listUserGrants(userId, settings),
      unwrapToken: <T>(token: string) => read().unwrapToken<T>(token),
      completeAuthorization: (settings) =>
        mutate(env, (_, api) => api.completeAuthorization(settings)),
      createClient: (settings) =>
        mutate(env, (_, api) => api.createClient(settings)),
      updateClient: (clientId, updates) =>
        mutate(env, (_, api) => api.updateClient(clientId, updates)),
      deleteClient: (clientId) =>
        mutate(env, (_, api) => api.deleteClient(clientId)),
      revokeGrant: (grantId, userId) =>
        mutate(env, (_, api) => api.revokeGrant(grantId, userId)),
      exchangeToken: (settings) =>
        mutate(env, (_, api) => api.exchangeToken(settings)),
      purgeExpiredData: (settings) =>
        mutate(env, (_, api) => api.purgeExpiredData(settings)),
    };
  };
  return {
    helpers,
    async fetch(
      request: Request,
      env: Environment,
      ctx: NativeOAuthContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      const writes =
        request.method !== "OPTIONS" &&
        (matches(url, options.tokenEndpoint) ||
          (options.clientRegistrationEndpoint !== undefined &&
            matches(url, options.clientRegistrationEndpoint)));
      if (writes) {
        try {
          return await mutate(env, async (scoped) => {
            const response = await provider.fetch(request, scoped, ctx);
            // 4xx responses may deliberately revoke a replayed code's grant.
            // Preserve those writes; server failures cannot partially commit.
            if (response.status >= 500) throw new RollbackResponse(response);
            return response;
          });
        } catch (error) {
          if (error instanceof RollbackResponse) return error.response;
          throw error;
        }
      }
      const scoped = Object.assign(environment(env, kv), {
        OAUTH_PROVIDER: helpers(env),
      });
      return provider.fetch(request, scoped, ctx);
    },
  };
}
