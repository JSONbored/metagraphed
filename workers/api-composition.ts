export interface ApiFetchHandler<Environment, Context> {
  fetch(
    request: Request,
    env: Environment,
    ctx: Context,
  ): Promise<Response> | Response;
}

export interface ApiHandlers<
  Environment,
  Context,
  Scheduled,
  Queue,
> extends ApiFetchHandler<Environment, Context> {
  scheduled(event: Scheduled, env: Environment, ctx: Context): Promise<unknown>;
  queue(batch: Queue, env: Environment, ctx: Context): Promise<unknown>;
}

export interface ApiAuthorization<Environment, Context> {
  provider: ApiFetchHandler<Environment, Context>;
  isNonOAuthMcpRequest(request: Request): boolean;
}

/** Shared dispatch; each runtime must supply its own authorization provider. */
export function createApiEntry<
  Environment,
  Context,
  Scheduled,
  Queue,
>(options: {
  loadApplication(): Promise<
    ApiHandlers<Environment, Context, Scheduled, Queue>
  >;
  loadAuthorization(
    handler: ApiFetchHandler<Environment, Context>,
  ): Promise<ApiAuthorization<Environment, Context>>;
  directory(
    request: Request,
    env: Environment,
    ctx: Context,
  ): Promise<Response | null>;
}): ApiHandlers<Environment, Context, Scheduled, Queue> {
  const handler: ApiFetchHandler<Environment, Context> = {
    fetch: async (request, env, ctx) =>
      (await options.loadApplication()).fetch(request, env, ctx),
  };
  let authorization:
    Promise<ApiAuthorization<Environment, Context>> | undefined;
  return {
    async fetch(request, env, ctx) {
      const directory = await options.directory(request, env, ctx);
      if (directory) return directory;
      const { provider, isNonOAuthMcpRequest } = await (authorization ??=
        options.loadAuthorization(handler));
      return isNonOAuthMcpRequest(request)
        ? handler.fetch(request, env, ctx)
        : provider.fetch(request, env, ctx);
    },
    async scheduled(event, env, ctx) {
      return (await options.loadApplication()).scheduled(event, env, ctx);
    },
    async queue(batch, env, ctx) {
      await (await options.loadApplication()).queue(batch, env, ctx);
    },
  };
}
