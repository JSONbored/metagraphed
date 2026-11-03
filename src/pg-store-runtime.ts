import type { PoolConfig } from "pg";
import {
  createPooledPgRuntime,
  type PgPool,
  type PooledPgOptions,
  type PooledPgRuntime,
} from "./pg-pool.ts";
import { pgStatementText, type PgSql } from "./pg-sql.ts";
import type { ReadStoreDb } from "./read-store.ts";

export interface PgStoreRuntime {
  sql: PgSql;
  read: ReadStoreDb;
  producer: PooledPgRuntime["store"];
  /** Only the process owner closes the pool, after request/job admission stops. */
  close(): Promise<void>;
}

/**
 * Compose the existing SQL, reader and producer contracts over one process
 * pool. Every capability shares the same admission limit and shutdown drain;
 * handing one to a request never hands it the pool's lifecycle. Callers opt in
 * explicitly: this does not change Worker bindings or table ownership.
 */
export function createPgStoreRuntime(
  options: PooledPgOptions,
  poolFactory?: (config: PoolConfig) => PgPool,
): PgStoreRuntime {
  const runtime = createPooledPgRuntime(options, poolFactory);
  const sql: PgSql = Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      runtime.store.query<Row>(pgStatementText(strings), values),
    { unsafe: runtime.store.query },
  );
  return {
    sql,
    read: {
      query: runtime.store.query,
      first: runtime.store.first,
    },
    producer: runtime.store,
    close: () => runtime.close(),
  };
}
