import { Pool, type PoolConfig } from "pg";
import { toPositionalPlaceholders } from "./pg-sql.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };

export interface PooledPgClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(discard?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

export interface PgPool {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PooledPgClient>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface PooledPgOptions {
  connectionString: string;
  maxConnections: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statementTimeoutMillis: number;
  /** The process owns reporting idle-connection errors without logging credentials. */
  onIdleError: (error: Error) => void;
}

export interface PooledPgRuntime {
  /** Shared across requests; individual requests cannot close the process pool. */
  store: Omit<ProducerStore, "close">;
  transaction: PgTransactionRunner;
  close(): Promise<void>;
}

export type PgTransaction = Pick<ProducerStore, "query" | "first" | "run">;
export interface PgTransactionOptions {
  isolation?: "read committed" | "repeatable read";
}
export type PgTransactionRunner = <T>(
  callback: (transaction: PgTransaction) => Promise<T>,
  options?: PgTransactionOptions,
) => Promise<T>;

/**
 * Process-owned PostgreSQL access for a long-running server. Existing Worker
 * adapters keep their Hyperdrive lifecycle; this runtime is explicitly selected
 * by its caller. Admission is capped at the connection count, with no unbounded
 * waiter queue. Callers decide how to reject or defer work when at capacity.
 */
export function createPooledPgRuntime(
  options: PooledPgOptions,
  poolFactory: (config: PoolConfig) => PgPool = (config) => new Pool(config),
): PooledPgRuntime {
  if (!options.connectionString.trim()) {
    throw new Error("PostgreSQL connection string is required");
  }
  for (const [name, value] of Object.entries({
    maxConnections: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis,
    statementTimeoutMillis: options.statementTimeoutMillis,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  const pool = poolFactory({
    connectionString: options.connectionString,
    max: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    idleTimeoutMillis: options.idleTimeoutMillis,
    statement_timeout: options.statementTimeoutMillis,
  });
  pool.on("error", options.onIdleError);

  const capacity = options.maxConnections;
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing)
      return Promise.reject(new Error("PostgreSQL runtime is closed"));
    if (active.size >= capacity) {
      return Promise.reject(new Error("PostgreSQL runtime is at capacity"));
    }
    const pending = (async () => operation())();
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    );
    return pending;
  };

  const query = (text: string, values: unknown[] = []) =>
    pool.query(toPositionalPlaceholders(text), values);
  const transaction = <T>(
    callback: (transaction: PgTransaction) => Promise<T>,
    transactionOptions: PgTransactionOptions = {},
  ): Promise<T> => {
    const isolation = transactionOptions.isolation ?? "read committed";
    if (isolation !== "read committed" && isolation !== "repeatable read") {
      return Promise.reject(
        new Error("Unsupported PostgreSQL transaction isolation"),
      );
    }
    return admit(async () => {
      const client = await pool.connect();
      let phase: "begin" | "statements" | "commit" = "begin";
      let discard = false;
      let connectionError: Error | undefined;
      let open = true;
      let operationFailure: { error: unknown } | undefined;
      const pending = new Set<Promise<unknown>>();
      const onError = (error: Error) => {
        connectionError ??= error;
        discard = true;
      };
      client.on("error", onError);
      const execute = async (text: string, values?: unknown[]) => {
        if (connectionError) throw connectionError;
        const result = await client.query(text, values);
        if (connectionError) throw connectionError;
        return result;
      };
      const issue = <T>(operation: () => Promise<T>): Promise<T> => {
        if (!open)
          return Promise.reject(
            new Error("PostgreSQL transaction scope is closed"),
          );
        const result = (async () => operation())();
        pending.add(result);
        void result.then(
          () => pending.delete(result),
          (error: unknown) => {
            operationFailure ??= { error };
            pending.delete(result);
          },
        );
        return result;
      };
      const scoped: PgTransaction = {
        query: <Row>(text: string, values: unknown[] = []) =>
          issue(
            async () =>
              ((await execute(toPositionalPlaceholders(text), values)).rows ??
                []) as Row[],
          ),
        first: <Row>(text: string, values: unknown[] = []) =>
          issue(
            async () =>
              ((await execute(toPositionalPlaceholders(text), values))
                .rows?.[0] ?? null) as Row | null,
          ),
        run: (text: string, values: unknown[] = []) =>
          issue(async () => ({
            changes:
              (await execute(toPositionalPlaceholders(text), values))
                .rowCount ?? 0,
          })),
      };
      try {
        await execute(
          isolation === "read committed"
            ? "BEGIN ISOLATION LEVEL READ COMMITTED"
            : "BEGIN ISOLATION LEVEL REPEATABLE READ",
        );
        phase = "statements";
        let result: { value: T } | undefined;
        let callbackFailure: { error: unknown } | undefined;
        try {
          result = { value: await callback(scoped) };
        } catch (error) {
          callbackFailure = { error };
        }
        open = false;
        // Scope admission ends with the callback. Every operation already
        // issued through it must settle before either transaction terminator.
        await Promise.allSettled([...pending]);
        if (callbackFailure) throw callbackFailure.error;
        if (operationFailure) throw operationFailure.error;
        phase = "commit";
        await execute("COMMIT");
        return result!.value;
      } catch (error) {
        if (phase === "statements" && !connectionError) {
          try {
            await execute("ROLLBACK");
          } catch {
            discard = true;
          }
        } else {
          // COMMIT may have reached the server. Preserve uncertainty and
          // discard the connection without retrying the write.
          discard = true;
        }
        throw error;
      } finally {
        open = false;
        try {
          client.release(discard);
        } finally {
          client.removeListener("error", onError);
        }
      }
    });
  };
  return {
    store: {
      query: <Row>(text: string, values: unknown[] = []) =>
        admit(async () => ((await query(text, values)).rows ?? []) as Row[]),
      first: <Row>(text: string, values: unknown[] = []) =>
        admit(
          async () =>
            ((await query(text, values)).rows?.[0] ?? null) as Row | null,
        ),
      run: (text: string, values: unknown[] = []) =>
        admit(async () => ({
          changes: (await query(text, values)).rowCount ?? 0,
        })),
      transaction: (statements: readonly ProducerStatement[]) =>
        transaction(async (scoped) => {
          const results = [];
          for (const statement of statements) {
            results.push(await scoped.run(statement.text, statement.values));
          }
          return results;
        }),
    },
    transaction,
    close() {
      closing ??= (async () => {
        await Promise.allSettled([...active]);
        await pool.end();
      })();
      return closing;
    },
  };
}
