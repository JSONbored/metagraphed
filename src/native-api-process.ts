import type { PoolConfig } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "./pg-store-runtime.ts";
import type { PgPool, PooledPgOptions } from "./pg-pool.ts";
import { pgStatementText, type PgSql } from "./pg-sql.ts";
import type { AppKv } from "./app-kv.ts";
import { isNonOAuthMcpRequest } from "./github-oauth.ts";
import { errorResponse } from "../workers/http.ts";
import {
  createApiEntry,
  type ApiAuthorization,
  type ApiHandlers,
} from "../workers/api-composition.ts";

export interface NativeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  /** Request disconnects and the process drain deadline reach owned jobs here. */
  signal: AbortSignal;
}

export type NativeStore = Omit<PgStoreRuntime, "close">;
export interface NativeSourceDefinition {
  name: string;
  schema: string;
  owner: string;
  relations: readonly string[];
  access: "read" | "read-write";
}

/** Each declared source supplies the actual process-owned read/write handles. */
export interface NativeSource extends NativeSourceDefinition, NativeStore {}

function scopedSource(
  runtime: PgStoreRuntime,
  source: NativeSourceDefinition,
): NativeSource {
  const readOnly = source.access === "read";
  const searchPath = `pg_catalog, "${source.schema.replaceAll('"', '""')}", pg_temp`;
  const requireWrite = () => {
    if (readOnly) throw new Error(`Native source ${source.name} is read-only`);
  };
  const transaction: PgStoreRuntime["transaction"] = (callback, options) =>
    runtime.transaction(async (scope) => {
      if (readOnly) await scope.run("SET TRANSACTION READ ONLY");
      await scope.query(
        "SELECT pg_catalog.set_config('search_path', $1, true)",
        [searchPath],
      );
      return callback(
        readOnly
          ? {
              ...scope,
              run: async () => {
                throw new Error(`Native source ${source.name} is read-only`);
              },
            }
          : scope,
      );
    }, options);
  const query: NativeStore["read"]["query"] = (text, values) =>
    transaction((scope) => scope.query(text, values));
  const first: NativeStore["read"]["first"] = (text, values) =>
    transaction((scope) => scope.first(text, values));
  const sql: PgSql = Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query<Row>(pgStatementText(strings), values),
    { unsafe: query },
  );
  const scoped: NativeSource = {
    ...source,
    relations: Object.freeze([...source.relations]),
    sql,
    read: { query, first },
    producer: {
      query,
      first,
      run: async (text, values) => {
        requireWrite();
        return transaction((scope) => scope.run(text, values));
      },
      transaction: async (statements) => {
        requireWrite();
        return transaction(async (scope) => {
          const results = [];
          for (const statement of statements)
            results.push(await scope.run(statement.text, statement.values));
          return results;
        });
      },
    },
    transaction,
  };
  return Object.freeze(scoped);
}

export interface NativeApiComposition<Environment, Scheduled, Queue> {
  environment: Environment;
  application: ApiHandlers<
    Environment,
    NativeExecutionContext,
    Scheduled,
    Queue
  >;
  authorization: Pick<
    ApiAuthorization<Environment, NativeExecutionContext>,
    "provider"
  >;
  directory(
    request: Request,
    env: Environment,
    ctx: NativeExecutionContext,
  ): Promise<Response | null>;
}

export interface NativeApiOptions<Environment, Scheduled, Queue> {
  postgres: PooledPgOptions;
  maxRequests: number;
  maxJobs: number;
  drainTimeoutMillis: number;
  sources: readonly NativeSourceDefinition[];
  kv: { control: AppKv; oauthPending: AppKv };
  compose(providers: {
    sources: ReadonlyMap<string, NativeSource>;
    kv: NativeApiOptions<Environment, Scheduled, Queue>["kv"];
  }): Promise<NativeApiComposition<Environment, Scheduled, Queue>>;
  onBackgroundError(error: unknown): void;
}

export interface NativeApiProcess<Scheduled, Queue> {
  /** Readiness covers only the adapters and source relations declared at construction. */
  readonly state: "ready" | "closing" | "closed";
  fetch(request: Request): Promise<Response>;
  scheduled(event: Scheduled): Promise<void>;
  queue(batch: Queue): Promise<void>;
  close(): Promise<void>;
}

function requireFunction(value: unknown, name: string): void {
  if (typeof value !== "function") throw new Error(`${name} is required`);
}

function requireKv(value: AppKv, name: string): void {
  for (const method of ["get", "put", "delete", "list", "consume"] as const) {
    requireFunction(value?.[method], `${name}.${method}`);
  }
}

async function verifySources(
  store: NativeStore,
  sources: readonly NativeSourceDefinition[],
) {
  if (sources.length === 0)
    throw new Error("Native source ownership is required");
  const names = new Set<string>();
  const ownedRelations = new Set<string>();
  for (const source of sources) {
    if (
      !source.name ||
      names.has(source.name) ||
      !source.schema ||
      !source.owner ||
      source.relations.length === 0 ||
      !["read", "read-write"].includes(source.access)
    ) {
      throw new Error(
        "Native sources require unique names, schema, owner and relations",
      );
    }
    names.add(source.name);
    for (const relation of source.relations) {
      const identity = `${source.schema}.${relation}`;
      if (!relation || ownedRelations.has(identity))
        throw new Error("Native relation ownership overlaps");
      ownedRelations.add(identity);
    }
    const rows = await store.read.query<{
      relation: string;
      owner: string;
      schema_usable: boolean;
      readable: boolean;
      insertable: boolean;
      updatable: boolean;
      deletable: boolean;
    }>(
      `SELECT c.relname AS relation, pg_get_userbyid(c.relowner) AS owner,
        has_schema_privilege(current_user, n.oid, 'USAGE') AS schema_usable,
        has_table_privilege(current_user, c.oid, 'SELECT') AS readable,
        has_table_privilege(current_user, c.oid, 'INSERT') AS insertable,
        has_table_privilege(current_user, c.oid, 'UPDATE') AS updatable,
        has_table_privilege(current_user, c.oid, 'DELETE') AS deletable
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
         AND c.relkind IN ('r','p','v','m')`,
      [source.schema, source.relations],
    );
    const available = new Map(rows.map((row) => [row.relation, row]));
    for (const relation of source.relations) {
      const row = available.get(relation);
      if (
        !row ||
        row.owner !== source.owner ||
        !row.schema_usable ||
        !row.readable ||
        (source.access === "read-write" &&
          !(row.insertable && row.updatable && row.deletable))
      ) {
        throw new Error(
          `Native source ${source.name} is not ready for ${relation}`,
        );
      }
    }
  }
}

/** Explicit preparation factory; no default environment, listener or activation. */
export async function createNativeApiProcess<Environment, Scheduled, Queue>(
  options: NativeApiOptions<Environment, Scheduled, Queue>,
  poolFactory?: (config: PoolConfig) => PgPool,
): Promise<NativeApiProcess<Scheduled, Queue>> {
  const { maxRequests, maxJobs, drainTimeoutMillis } = options;
  for (const value of [maxRequests, maxJobs, drainTimeoutMillis]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Native admission limits must be positive safe integers");
  }
  requireKv(options.kv?.control, "control KV");
  requireKv(options.kv?.oauthPending, "OAuth pending KV");
  requireFunction(options.compose, "Native application composition");
  requireFunction(options.onBackgroundError, "Background error reporter");
  const runtime = createPgStoreRuntime(options.postgres, poolFactory);
  const store: NativeStore = {
    sql: runtime.sql,
    read: runtime.read,
    producer: runtime.producer,
    transaction: runtime.transaction,
  };
  let composition: NativeApiComposition<Environment, Scheduled, Queue>;
  try {
    await verifySources(store, options.sources);
    const sources = new Map(
      options.sources.map((source) => [
        source.name,
        scopedSource(runtime, source),
      ]),
    );
    composition = await options.compose({ sources, kv: options.kv });
    for (const method of ["fetch", "scheduled", "queue"] as const) {
      requireFunction(
        composition?.application?.[method],
        `Native application.${method}`,
      );
    }
    requireFunction(
      composition?.authorization?.provider?.fetch,
      "Native OAuth provider.fetch",
    );
    requireFunction(composition?.directory, "Native directory handler");
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const entry = createApiEntry({
    loadApplication: async () => composition.application,
    loadAuthorization: async () => ({
      ...composition.authorization,
      isNonOAuthMcpRequest,
    }),
    directory: composition.directory,
  });
  const active = new Map<Promise<void>, (reason: Error) => Promise<void>>();
  let requests = 0;
  let jobs = 0;
  let state: NativeApiProcess<Scheduled, Queue>["state"] = "ready";
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;

  function reportError(error: unknown) {
    try {
      options.onBackgroundError(error);
    } catch {
      /* Error reporters do not own completion. */
    }
  }

  function invocation() {
    const background = new Set<Promise<unknown>>();
    let settle!: () => void;
    let finished = false;
    let finishing: Promise<void> | undefined;
    const controller = new AbortController();
    let cancelBody: ((reason: Error) => Promise<void>) | undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const cancel = async (reason: Error) => {
      controller.abort(reason);
      await cancelBody?.(reason);
    };
    active.set(done, cancel);
    const context: NativeExecutionContext = {
      signal: controller.signal,
      waitUntil(promise) {
        if (finished) throw new Error("Native invocation has finished");
        const observed = Promise.resolve(promise).catch(reportError);
        background.add(observed);
        void observed.then(() => background.delete(observed));
      },
    };
    return {
      context,
      cancel,
      setBodyCancel(callback: (reason: Error) => Promise<void>) {
        cancelBody = callback;
        if (controller.signal.aborted)
          void callback(controller.signal.reason).catch(reportError);
      },
      finish() {
        finishing ??= (async () => {
          while (background.size) await Promise.allSettled([...background]);
          finished = true;
          active.delete(done);
          settle();
        })();
        return finishing;
      },
    };
  }

  async function runJob(
    operation: (ctx: NativeExecutionContext) => Promise<void>,
  ) {
    if (state !== "ready" || jobs >= maxJobs)
      throw new Error("Native job admission is unavailable");
    jobs += 1;
    const task = invocation();
    try {
      await operation(task.context);
    } finally {
      await task.finish();
      jobs -= 1;
    }
  }

  return {
    get state() {
      return state;
    },
    async fetch(request) {
      if (state !== "ready" || requests >= maxRequests) {
        return errorResponse(
          "service_unavailable",
          "Request admission is unavailable.",
          503,
        );
      }
      requests += 1;
      const task = invocation();
      const onAbort = () => {
        void task.cancel(request.signal.reason).catch(reportError);
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      let finishing: Promise<void> | undefined;
      const finish = () => {
        finishing ??= task.finish().then(() => {
          request.signal.removeEventListener("abort", onAbort);
          requests -= 1;
        });
        return finishing;
      };
      try {
        const response = await entry.fetch(
          new Request(request, {
            signal: AbortSignal.any([request.signal, task.context.signal]),
          }),
          composition.environment,
          task.context,
        );
        if (!response.body) {
          void finish();
          return response;
        }
        const reader = response.body.getReader();
        let output!: ReadableStreamDefaultController<Uint8Array>;
        let complete = false;
        const finishBody = async () => {
          if (complete) return;
          complete = true;
          reader.releaseLock();
          await finish();
        };
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
          },
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                controller.close();
                await finishBody();
              } else controller.enqueue(result.value);
            } catch (error) {
              controller.error(error);
              await finishBody();
            }
          },
          async cancel(reason) {
            // A disconnected response aborts its invocation's background work.
            try {
              await task.cancel(reason);
            } finally {
              await finishBody();
            }
          },
        });
        task.setBodyCancel(async (reason) => {
          if (complete) return;
          output.error(reason);
          try {
            await reader.cancel(reason);
          } finally {
            await finishBody();
          }
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        await finish();
        throw error;
      }
    },
    scheduled: (event) =>
      runJob(async (ctx) => {
        await entry.scheduled(event, composition.environment, ctx);
      }),
    queue: (batch) =>
      runJob(async (ctx) => {
        await entry.queue(batch, composition.environment, ctx);
      }),
    close() {
      if (closing) return closing;
      draining ??= (async () => {
        state = "closing";
        await Promise.allSettled([...active.keys()]);
        await runtime.close();
        state = "closed";
      })();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            "Native process drain deadline exceeded; unfinished work is still closing",
          );
          for (const cancel of active.values())
            void cancel(error).catch(reportError);
          reject(error);
        }, drainTimeoutMillis);
      });
      const attempt = Promise.race([draining, deadline]).finally(() =>
        clearTimeout(timer),
      );
      closing = attempt;
      void attempt.catch(() => {
        closing = undefined;
      });
      return attempt;
    },
  };
}
