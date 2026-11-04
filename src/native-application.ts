import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolConfig } from "pg";
import api from "../workers/api.ts";
import data from "../workers/data-api.ts";
import registry from "../workers/registry-sync-api.ts";
import { handleDefaultExplorerDirectory } from "../workers/explorer-directory-entry.ts";
import type { AppScheduledEvent } from "../workers/runtime-context.ts";
import { buildOAuthProviderOptions } from "./github-oauth.ts";
import {
  createNativeApiProcess,
  type NativeApiKeyValues,
  type NativeApiOptions,
  type NativeExecutionContext,
  type NativeSource,
} from "./native-api-process.ts";
import { bufferNativeRequest } from "./native-request.ts";
import type { NativeOAuthModule } from "./native-oauth-provider.ts";
import { createPgOAuthProvider } from "./pg-oauth-provider.ts";
import { PG_QUEUE_NAMES } from "./pg-queue.ts";
import type { NativeCronOwner } from "./pg-cron.ts";
import type { PgPool } from "./pg-pool.ts";

interface Environments {
  api: Env;
  data: DataApiEnv;
  registry: RegistrySyncApiEnv;
}

export interface NativeInternalService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface NativeApplicationBindings {
  /** The source owner validates the complete selected capability manifest. */
  environments: { api: object; data: object; registry: object };
  assertEnvironment(
    environments: NativeApplicationBindings["environments"],
  ): void;
  /** Idempotent: stop external work; admitted requests must retain their adapters. */
  stop(): Promise<void>;
  /** Idempotent: drain adapters after requests finish, before pool closure. */
  close(): Promise<void>;
}

export interface NativeInternalLimits {
  maxConcurrent: number;
  maxBufferBytes: number;
  maxCalls: number;
  maxDepth: number;
  timeoutMillis: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

type Scheduled = AppScheduledEvent & { owner: NativeCronOwner };
type ProcessOptions = NativeApiOptions<
  Environments,
  Scheduled,
  MessageBatch<unknown>
>;

export interface NativeApplicationOptions extends Omit<
  ProcessOptions,
  "compose"
> {
  internal: NativeInternalLimits;
  oauth: { module: NativeOAuthModule; source: string };
  compose(providers: {
    sources: ReadonlyMap<string, NativeSource>;
    kv: NativeApiKeyValues;
    services: { data: NativeInternalService; registry: NativeInternalService };
  }): Promise<NativeApplicationBindings>;
}

interface Invocation {
  owner: NativeCronOwner;
  context?: NativeExecutionContext;
  calls: { count: number };
  depth: number;
}

const forbidden = [
  "D1_STATE",
  "D1_RETAINED_BLOCKS",
  "HYPERDRIVE",
  "NEON_WRITE_BUFFER",
  "MCP_SESSION_HUB",
  "SUBNET_STATUS_HUB",
  "CHAIN_FIREHOSE_HUB",
  "ALERTER_HUB",
  "AI",
  "VECTORIZE",
  "RPC_USAGE_ANALYTICS",
  "ANALYTICS_ENGINE_SQL_TOKEN",
  "METAGRAPH_AI_GATEWAY",
  "METAGRAPH_ARCHIVE",
] as const;

function checkEnvironments(
  bindings: NativeApplicationBindings,
  services: { data: NativeInternalService; registry: NativeInternalService },
): Environments {
  const environments = {
    api: { ...bindings.environments.api },
    data: { ...bindings.environments.data },
    registry: { ...bindings.environments.registry },
  };
  for (const [owner, environment] of Object.entries(environments)) {
    for (const name of Object.keys(environment)) {
      if (
        (forbidden.includes(name as (typeof forbidden)[number]) ||
          /^(NATIVE_|ACCOUNT_)?HISTORY_ASSETS(?:_|$)/.test(name)) &&
        Reflect.get(environment, name) !== undefined
      )
        throw new TypeError(`Native ${owner} environment retains ${name}`);
    }
    if (Reflect.get(environment, "D1_STATE_TABLES"))
      throw new TypeError(`Native ${owner} environment selects D1 tables`);
  }
  if (
    Reflect.get(environments.api, "DATA_API") !== services.data ||
    Reflect.get(environments.api, "REGISTRY_SYNC_API") !== services.registry
  )
    throw new TypeError(
      "Native internal services differ from the process-owned bindings",
    );
  for (const environment of Object.values(environments))
    Object.freeze(environment);
  bindings.assertEnvironment(environments);
  // Worker deployment types require platform bindings even when the selected
  // native capability owns the path. The explicit manifest validator above
  // owns that boundary; no stand-in D1, DO or Hyperdrive objects are supplied.
  return Object.freeze(environments) as Environments;
}

async function responseBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
) {
  if (signal.aborted) {
    await response.body?.cancel(signal.reason).catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reads = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason?: unknown) =>
    (cancellation ??= reader.cancel(reason).catch(() => {}));
  const onAbort = () => {
    void cancel(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (++reads > 65536)
        throw new RangeError("Native internal response exceeds chunk limit");
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new RangeError("Native internal response exceeds byte limit");
      if (next.value.byteLength) chunks.push(next.value.slice());
      if (reads % 128 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** One opt-in process and pool for the actual application handlers. No listener,
 * scheduler registration, timer loop, data migration or activation is performed. */
export async function createNativeApplication(
  options: NativeApplicationOptions,
  poolFactory?: (config: PoolConfig) => PgPool,
) {
  const limits = { ...options.internal };
  const compose = options.compose;
  const oauthSourceName = options.oauth.source;
  const oauthModule: NativeOAuthModule = Object.freeze({
    publicFetchProtection: options.oauth.module.publicFetchProtection,
    OAuthProvider: options.oauth.module.OAuthProvider,
    getOAuthApi: options.oauth.module.getOAuthApi,
  });
  const processOptions = {
    ...options,
    postgres: { ...options.postgres },
    sources: options.sources.map((source) =>
      Object.freeze({
        ...source,
        relations: Object.freeze([...source.relations]),
      }),
    ),
    kv:
      typeof options.kv === "function"
        ? options.kv
        : Object.freeze({ ...options.kv }),
  };
  for (const [name, maximum] of Object.entries({
    maxConcurrent: 100,
    maxBufferBytes: 64 * 1024 * 1024,
    maxCalls: 10000,
    maxDepth: 16,
    timeoutMillis: 30000,
    maxRequestBytes: 32 * 1024 * 1024,
    maxResponseBytes: 32 * 1024 * 1024,
  })) {
    const value = limits[name as keyof NativeInternalLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new RangeError(`Invalid native internal ${name}`);
  }
  if (
    3 *
      (limits.maxRequestBytes + limits.maxResponseBytes) *
      limits.maxConcurrent >
    limits.maxBufferBytes
  )
    throw new RangeError("Native internal buffer budget is too small");
  let activeInternal = 0;
  const scope = new AsyncLocalStorage<Invocation>();
  let environments: Environments;
  const inContext = <T>(
    context: NativeExecutionContext,
    operation: () => T,
  ): T => {
    const current = scope.getStore();
    // All public ports enter invoke before the process calls this composition.
    return scope.run({ ...current!, context }, operation);
  };
  const service = (owner: "data" | "registry"): NativeInternalService => ({
    fetch(input, init) {
      const parent = scope.getStore();
      if (!parent?.context?.active || parent.context.signal.aborted)
        return Promise.reject(
          new Error("Native internal call has no active invocation"),
        );
      if (
        parent.depth >= limits.maxDepth ||
        parent.calls.count >= limits.maxCalls ||
        activeInternal >= limits.maxConcurrent
      )
        return Promise.reject(
          new Error("Native internal call admission is unavailable"),
        );
      parent.calls.count += 1;
      const context = parent.context;
      let original: Request;
      try {
        original = new Request(input, init);
      } catch (error) {
        return Promise.reject(error);
      }
      activeInternal += 1;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        original.signal,
        context.signal,
        controller.signal,
      ]);
      const timer = setTimeout(
        () =>
          controller.abort(new Error("Native internal call deadline exceeded")),
        limits.timeoutMillis,
      );
      let onAbort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const operation = (async () => {
        const request = await bufferNativeRequest(
          original,
          signal,
          limits.maxRequestBytes,
        );
        const response = await scope.run(
          { ...parent, owner, depth: parent.depth + 1 },
          () =>
            owner === "data"
              ? data.fetch(request, environments.data, context)
              : registry.fetch(request, environments.registry),
        );
        return responseBytes(response, signal, limits.maxResponseBytes);
      })().finally(() => {
        activeInternal -= 1;
      });
      // Track even an unawaited call; its caller still owns error semantics.
      context.waitUntil(
        operation.then(
          () => undefined,
          () => undefined,
        ),
      );
      return Promise.race([operation, aborted]).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
    },
  });
  const services = Object.freeze({
    data: Object.freeze(service("data")),
    registry: Object.freeze(service("registry")),
  });
  const process = await createNativeApiProcess<
    Environments,
    Scheduled,
    MessageBatch<unknown>
  >(
    {
      ...processOptions,
      async compose(providers) {
        const bindings = await compose({ ...providers, services });
        const stop = bindings.stop.bind(bindings);
        const close = bindings.close.bind(bindings);
        providers.onStartupCleanup(async () => {
          await stop();
          await close();
        });
        environments = checkEnvironments(bindings, services);
        const oauthSource = providers.sources.get(oauthSourceName);
        if (!oauthSource || oauthSource.access !== "read-write")
          throw new Error("Native OAuth source is unavailable");
        const application = {
          fetch: (
            request: Request,
            env: Environments,
            context: NativeExecutionContext,
          ) =>
            inContext(context, () => {
              const owner = scope.getStore()!.owner;
              return owner === "data"
                ? data.fetch(request, env.data, context)
                : owner === "registry"
                  ? registry.fetch(request, env.registry)
                  : api.fetch(request, env.api, context);
            }),
          scheduled: (
            event: Scheduled,
            env: Environments,
            context: NativeExecutionContext,
          ) =>
            inContext(context, () => {
              if (event.owner === "api")
                return api.scheduled(event, env.api, context);
              if (event.owner === "data")
                return data.scheduled(event, env.data, context);
              if (event.owner === "registry")
                return registry.scheduled(event, env.registry, context);
              throw new TypeError("Unknown native schedule owner");
            }),
          queue: (
            batch: MessageBatch<unknown>,
            env: Environments,
            context: NativeExecutionContext,
          ) =>
            inContext(context, () => {
              if (
                !PG_QUEUE_NAMES.includes(
                  batch.queue as (typeof PG_QUEUE_NAMES)[number],
                )
              )
                throw new TypeError("Unknown native queue");
              return batch.queue === "sync-batches" ||
                batch.queue === "sync-batches-dlq"
                ? data.queue(batch, env.data, context)
                : api.queue(batch, env.api, context);
            }),
        };
        const oauth = createPgOAuthProvider(
          oauthSource,
          oauthModule,
          buildOAuthProviderOptions({
            fetch: (request, env, context) => api.fetch(request, env, context),
          }),
        );
        return {
          environment: environments,
          application,
          authorization: {
            provider: {
              fetch: (request, env, context) =>
                inContext(context, () =>
                  scope.getStore()!.owner === "api"
                    ? oauth.fetch(request, env.api, context)
                    : application.fetch(request, env, context),
                ),
            },
          },
          directory: (request, env, context) =>
            inContext(context, () =>
              scope.getStore()!.owner === "api"
                ? handleDefaultExplorerDirectory(request, env.api, context)
                : Promise.resolve(null),
            ),
          stop,
          close,
        };
      },
    },
    poolFactory,
  );
  const invoke = <T>(owner: NativeCronOwner, operation: () => T): T =>
    scope.run({ owner, calls: { count: 0 }, depth: 0 }, operation);
  const owner = (name: NativeCronOwner) => ({
    fetch: (request: Request) => invoke(name, () => process.fetch(request)),
    scheduled: (event: AppScheduledEvent, signal?: AbortSignal) =>
      invoke(name, () => process.scheduled({ ...event, owner: name }, signal)),
    queue: (batch: MessageBatch<unknown>, signal?: AbortSignal) =>
      invoke(name, () => process.queue(batch, signal)),
  });
  return {
    get state() {
      return process.state;
    },
    fetch: (request: Request) => invoke("api", () => process.fetch(request)),
    scheduled: (event: Scheduled, signal?: AbortSignal) =>
      invoke(event.owner, () => process.scheduled(event, signal)),
    owners: {
      api: owner("api"),
      data: owner("data"),
      registry: owner("registry"),
    },
    close: process.close,
  };
}
