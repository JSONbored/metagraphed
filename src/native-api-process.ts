import type { PoolConfig } from "pg";
import { createPgStoreRuntime, type PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgPool, PooledPgOptions } from "./pg-pool.ts";
import { pgStatementText, type PgSql } from "./pg-sql.ts";
import type { AppKv } from "./app-kv.ts";
import { errorResponse } from "../workers/http.ts";
import {
  createApiEntry,
  type ApiAuthorization,
  type ApiHandlers,
} from "../workers/api-composition.ts";

export interface NativeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
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

function scopedSource(runtime: PgStoreRuntime, source: NativeSourceDefinition): NativeSource {
  const transaction: PgStoreRuntime["transaction"] = (callback, options) =>
    runtime.transaction(async (scope) => {
      const searchPath = `pg_catalog, "${source.schema.replaceAll('"', '""')}"`;
      await scope.query("SELECT pg_catalog.set_config('search_path', $1, true)", [searchPath]);
      return callback(scope);
    }, options);
  const query: NativeStore["read"]["query"] = (text, values) =>
    transaction((scope) => scope.query(text, values));
  const first: NativeStore["read"]["first"] = (text, values) =>
    transaction((scope) => scope.first(text, values));
  const sql: PgSql = Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) => query<Row>(pgStatementText(strings), values),
    { unsafe: query },
  );
  const scoped: NativeSource = {
    ...source,
    relations: Object.freeze([...source.relations]),
    sql,
    read: { query, first },
    producer: {
      query, first,
      run: (text, values) => transaction((scope) => scope.run(text, values)),
      transaction: (statements) => transaction(async (scope) => {
        const results = [];
        for (const statement of statements) results.push(await scope.run(statement.text, statement.values));
        return results;
      }),
    },
    transaction,
  };
  return Object.freeze(scoped);
}

export interface NativeApiComposition<Environment, Scheduled, Queue> {
  environment: Environment;
  application: ApiHandlers<Environment, NativeExecutionContext, Scheduled, Queue>;
  authorization: ApiAuthorization<Environment, NativeExecutionContext>;
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

async function verifySources(store: NativeStore, sources: readonly NativeSourceDefinition[]) {
  if (sources.length === 0) throw new Error("Native source ownership is required");
  const names = new Set<string>();
  const ownedRelations = new Set<string>();
  for (const source of sources) {
    if (!source.name || names.has(source.name) || !source.schema || !source.owner || source.relations.length === 0 || !["read", "read-write"].includes(source.access)) {
      throw new Error("Native sources require unique names, schema, owner and relations");
    }
    names.add(source.name);
    for (const relation of source.relations) {
      const identity = `${source.schema}.${relation}`;
      if (!relation || ownedRelations.has(identity)) throw new Error("Native relation ownership overlaps");
      ownedRelations.add(identity);
    }
    const rows = await store.read.query<{
      relation: string;
      owner: string;
      readable: boolean;
      insertable: boolean;
      updatable: boolean;
      deletable: boolean;
    }>(
      `SELECT c.relname AS relation, pg_get_userbyid(c.relowner) AS owner,
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
      if (!row || row.owner !== source.owner || !row.readable || (source.access === "read-write" && !(row.insertable && row.updatable && row.deletable))) {
        throw new Error(`Native source ${source.name} is not ready for ${relation}`);
      }
    }
  }
}

/** Explicit preparation factory; no default environment, listener or activation. */
export async function createNativeApiProcess<Environment, Scheduled, Queue>(
  options: NativeApiOptions<Environment, Scheduled, Queue>,
  poolFactory?: (config: PoolConfig) => PgPool,
): Promise<NativeApiProcess<Scheduled, Queue>> {
  for (const value of [options.maxRequests, options.maxJobs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Native admission limits must be positive safe integers");
  }
  requireKv(options.kv?.control, "control KV");
  requireKv(options.kv?.oauthPending, "OAuth pending KV");
  requireFunction(options.compose, "Native application composition");
  requireFunction(options.onBackgroundError, "Background error reporter");
  const runtime = createPgStoreRuntime(options.postgres, poolFactory);
  const store: NativeStore = { sql: runtime.sql, read: runtime.read, producer: runtime.producer, transaction: runtime.transaction };
  let composition: NativeApiComposition<Environment, Scheduled, Queue>;
  try {
    await verifySources(store, options.sources);
    const sources = new Map(options.sources.map((source) => [source.name, scopedSource(runtime, source)]));
    composition = await options.compose({ sources, kv: options.kv });
    for (const method of ["fetch", "scheduled", "queue"] as const) {
      requireFunction(composition?.application?.[method], `Native application.${method}`);
    }
    requireFunction(composition?.authorization?.provider?.fetch, "Native OAuth provider.fetch");
    requireFunction(composition?.authorization?.isNonOAuthMcpRequest, "Native OAuth request selector");
    requireFunction(composition?.directory, "Native directory handler");
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const entry = createApiEntry({
    loadApplication: async () => composition.application,
    loadAuthorization: async () => composition.authorization,
    directory: composition.directory,
  });
  const active = new Set<Promise<void>>();
  let requests = 0;
  let jobs = 0;
  let state: NativeApiProcess<Scheduled, Queue>["state"] = "ready";
  let closing: Promise<void> | undefined;

  function invocation() {
    const background = new Set<Promise<unknown>>();
    let settle!: () => void;
    let finished = false;
    let finishing: Promise<void> | undefined;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    active.add(done);
    const context: NativeExecutionContext = {
      waitUntil(promise) {
        if (finished) throw new Error("Native invocation has finished");
        const observed = Promise.resolve(promise).catch((error) => {
          try { options.onBackgroundError(error); } catch { /* Reporting cannot retain an invocation. */ }
        });
        background.add(observed);
        void observed.then(() => background.delete(observed));
      },
    };
    return {
      context,
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

  async function runJob(operation: (ctx: NativeExecutionContext) => Promise<void>) {
    if (state !== "ready" || jobs >= options.maxJobs) throw new Error("Native job admission is unavailable");
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
    get state() { return state; },
    async fetch(request) {
      if (state !== "ready" || requests >= options.maxRequests) {
        return errorResponse("service_unavailable", "Request admission is unavailable.", 503);
      }
      requests += 1;
      const task = invocation();
      let finishing: Promise<void> | undefined;
      const finish = () => {
        finishing ??= task.finish().then(() => { requests -= 1; });
        return finishing;
      };
      try {
        const response = await entry.fetch(request, composition.environment, task.context);
        if (!response.body) {
          void finish();
          return response;
        }
        const reader = response.body.getReader();
        let complete = false;
        const finishBody = async () => {
          if (complete) return;
          complete = true;
          reader.releaseLock();
          await finish();
        };
        const body = new ReadableStream<Uint8Array>({
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
            try { await reader.cancel(reason); } finally { await finishBody(); }
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        await finish();
        throw error;
      }
    },
    scheduled: (event) => runJob((ctx) => entry.scheduled(event, composition.environment, ctx)),
    queue: (batch) => runJob((ctx) => entry.queue(batch, composition.environment, ctx)),
    close() {
      closing ??= (async () => {
        state = "closing";
        await Promise.allSettled([...active]);
        try { await runtime.close(); } finally { state = "closed"; }
      })();
      return closing;
    },
  };
}
