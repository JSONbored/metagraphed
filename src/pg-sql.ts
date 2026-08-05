// The Postgres twin of workers/data-api.ts's `createD1Sql` (infra#336).
//
// WHY A SHIM AND NOT A REWRITE. The route handlers in data-api.ts are written
// against a tagged template -- `` sql`SELECT ... WHERE account = ${ss58}` `` --
// a shape inherited from the postgres.js era and kept when those routes were
// ported to D1 behind `createD1Sql`. Giving Postgres the SAME interface means a
// route moves between stores by changing which `sql` it is handed, and nothing
// else. The two `account_position_daily` reads are unchanged by this file's
// existence; they simply receive a different runner.
//
// THE ONE REAL DIFFERENCE IS THE PLACEHOLDER. D1 (SQLite) takes `?` positionally
// and `createD1Sql` builds its statement with `strings.join("?")`. Postgres takes
// `$1, $2, ...`, and the numbering is 1-based and must match the value order
// exactly -- an off-by-one here does not throw, it binds the wrong column, which
// is the failure mode the column-order tests in this repo keep guarding against.
//
// NATIVE `pg`, NOT `@neondatabase/serverless`. Hyperdrive already performs the
// connection pooling and routing the serverless driver exists to work around, so
// stacking them adds a hop for nothing -- Neon's own Workers guide says the same.
// `nodejs_compat` is already set on wrangler.data.jsonc, which is what makes the
// native driver usable here at all.
//
// A CONNECTION PER INVOCATION, closed in the background. Hyperdrive holds the
// real pool across Cloudflare's network; the `Client` here is a cheap handle to
// it, and `ctx.waitUntil(client.end())` returns it without making the response
// wait. Leaking it instead would exhaust the origin's connection limit under
// load -- the one way to turn a pooled setup back into an unpooled one.

import { Client } from "pg";

export type PgSqlRows = Record<string, unknown>[];

export interface PgSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<PgSqlRows>;
  /** For the rare statement whose TEXT is built dynamically. Mirrors
   * D1Sql.unsafe so a caller can move between stores unchanged. */
  unsafe(text: string, values?: unknown[]): Promise<PgSqlRows>;
}

/** The Hyperdrive binding's shape, structurally, so tests can hand a plain
 * object instead of standing up a real binding. */
export interface HyperdriveLike {
  connectionString: string;
}

/** Somewhere to park the connection teardown. `ExecutionContext` in a Worker;
 * anything with waitUntil in a test. */
export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * `$1, $2, ...` interleaved between the literal chunks.
 *
 * Exported because the numbering IS the contract: `createD1Sql` can get away
 * with `strings.join("?")` because SQLite's placeholders carry no index, and a
 * silent off-by-one here would bind values to the wrong columns rather than
 * failing. Asserting the built text directly is cheaper than discovering that
 * from a wrong answer in production.
 */
export function pgStatementText(strings: readonly string[]): string {
  return strings.reduce(
    (text, chunk, i) => text + (i > 0 ? `$${i}` : "") + chunk,
    "",
  );
}

/**
 * A tagged-template runner over Hyperdrive, interface-compatible with
 * `createD1Sql`.
 *
 * `clientFactory` is injectable so tests can exercise the statement text and
 * the connection lifecycle without a database.
 */
export function createPgSql(
  hyperdrive: HyperdriveLike,
  ctx: WaitUntilLike,
  clientFactory: (connectionString: string) => Client = (connectionString) =>
    new Client({ connectionString }),
): PgSql {
  const run = async (text: string, values: unknown[]): Promise<PgSqlRows> => {
    const client = clientFactory(hyperdrive.connectionString);
    await client.connect();
    try {
      const result = await client.query(text, values);
      return (result.rows ?? []) as PgSqlRows;
    } finally {
      // Returned to Hyperdrive's pool without the response waiting on it. NOT
      // awaited: a slow teardown must not become the caller's latency, and a
      // failed one must not mask a successful read.
      ctx.waitUntil(client.end().catch(() => undefined));
    }
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    run(pgStatementText(strings), values)) as PgSql;
  sql.unsafe = (text: string, values: unknown[] = []) => run(text, values);
  return sql;
}
