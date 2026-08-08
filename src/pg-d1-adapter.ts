// A D1-shaped surface backed by Postgres, including batch() (#10104).
//
// ## Why this exists
//
// The producer lanes still on D1 do not read their store through a tagged
// template -- they take an injected `db` and call D1's own object API:
//
//     db.prepare(sql).bind(...v).all()      the reads
//     db.prepare(sql).bind(...v).run()      single writes
//     db.batch([stmt, stmt, ...])           the atomic multi-statement write
//
// createPgSql cannot stand in for that. It exposes a tagged template plus
// `unsafe`, and -- more importantly -- it opens a NEW CLIENT PER STATEMENT, so
// there is no connection for a batch's statements to share and therefore no
// transaction to make them atomic. Rewriting each lane to a different shape
// would be one bespoke port per lane, each an opportunity to lose the
// all-or-nothing property that batch() is doing the work of.
//
// So the shape moves instead of the callers: same object API, one pooled
// client, and `batch()` really is a transaction.
//
// ## batch() IS the transaction, and that is load-bearing
//
// D1's `batch()` is documented as all-or-nothing, and several lanes lean on it
// for exactly that -- src/subnet-burn-history.ts writes its rows and its prune
// in one batch, and a partial application there leaves the table pruned but
// not refilled. BEGIN/COMMIT around the statements preserves the property
// rather than approximating it; a rejected statement ROLLBACKs the whole set
// and the error propagates, which is what the callers already expect.
//
// ## Placeholders
//
// The lanes were written for SQLite and bind with `?`. toPositionalPlaceholders
// rewrites those to `$n` -- the same conversion createPgSql has applied since
// #9821, reused rather than reimplemented so the two paths cannot disagree
// about a statement's parameter order.
import { Client } from "pg";
import { toPositionalPlaceholders } from "./pg-sql.ts";

/** The minimal pg client this needs, so a test can hand it a fake. */
export interface PgD1Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
}

/** One statement, captured rather than executed -- `batch()` needs the text
 * and values to still be pending when it opens its transaction. */
interface PendingStatement {
  text: string;
  values: unknown[];
}

export interface PgD1Deps {
  clientFactory?: (connectionString: string) => PgD1Client;
}

/**
 * A D1-shaped handle over one Postgres connection.
 *
 * The connection is opened lazily on first use and closed by `close()`, which
 * the caller MUST park on `ctx.waitUntil` -- a leaked connection per producer
 * tick is worse than the read it was opened for.
 */
export function createPgD1(connectionString: string, deps: PgD1Deps = {}) {
  let client: PgD1Client | null = null;
  const open = async (): Promise<PgD1Client> => {
    if (client) return client;
    client =
      deps.clientFactory?.(connectionString) ??
      (new Client({ connectionString }) as unknown as PgD1Client);
    await client.connect();
    return client;
  };

  const run = async (stmt: PendingStatement) => {
    const c = await open();
    return c.query(toPositionalPlaceholders(stmt.text), stmt.values);
  };

  function prepare(text: string) {
    const stmt: PendingStatement = { text, values: [] };
    const bound = {
      // `results` mirrors D1's envelope so a caller reading either shape works.
      async all() {
        const res = await run(stmt);
        return { results: (res.rows ?? []) as unknown[] };
      },
      async run() {
        const res = await run(stmt);
        return { meta: { changes: res.rowCount ?? 0 } };
      },
      async first() {
        const res = await run(stmt);
        return ((res.rows ?? [])[0] ?? null) as unknown;
      },
      /** Read by batch() -- the pending statement, not a promise. */
      __stmt: stmt,
    };
    return {
      bind(...values: unknown[]) {
        stmt.values = values;
        return bound;
      },
      ...bound,
    };
  }

  return {
    prepare,
    /**
     * All-or-nothing, the property D1's batch() carries.
     *
     * Statements arrive already bound; nothing has executed yet, which is what
     * lets them share one transaction rather than each having run on its own.
     */
    async batch(statements: unknown[]) {
      const pending = statements.map((s) => {
        const stmt = (s as { __stmt?: PendingStatement }).__stmt;
        if (!stmt) throw new Error("pg-d1: batch received a foreign statement");
        return stmt;
      });
      const c = await open();
      await c.query("BEGIN");
      try {
        const out: unknown[] = [];
        for (const stmt of pending) {
          const res = await c.query(
            toPositionalPlaceholders(stmt.text),
            stmt.values,
          );
          out.push({ results: res.rows ?? [] });
        }
        await c.query("COMMIT");
        return out;
      } catch (error) {
        // Best-effort: a ROLLBACK that itself fails must not replace the error
        // that caused it, or the log names the symptom and loses the cause.
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    },
    async close() {
      if (!client) return;
      const c = client;
      client = null;
      await c.end().catch(() => undefined);
    },
  };
}
