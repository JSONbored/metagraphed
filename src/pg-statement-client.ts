// A prepare/bind/all/run/batch client over Postgres, including a real
// batch() (#10104).
//
// ## Why this exists
//
// The producer lanes do not read their store through a tagged template -- they
// take an injected `db` and call an object API, the one D1 defined and they
// were written against:
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
export interface PgStatementClient {
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

export interface PgStatementDeps {
  clientFactory?: (connectionString: string) => PgStatementClient;
}

/**
 * A D1-shaped handle over one Postgres connection.
 *
 * The connection is opened lazily on first use and closed by `close()`, which
 * the caller MUST park on `ctx.waitUntil` -- a leaked connection per producer
 * tick is worse than the read it was opened for.
 */
export function createPgStatementClient(
  connectionString: string,
  deps: PgStatementDeps = {},
) {
  let client: PgStatementClient | null = null;
  const open = async (): Promise<PgStatementClient> => {
    if (client) return client;
    client =
      deps.clientFactory?.(connectionString) ??
      (new Client({ connectionString }) as unknown as PgStatementClient);
    await client.connect();
    return client;
  };

  const run = async (stmt: PendingStatement) => {
    const c = await open();
    return c.query(toPositionalPlaceholders(stmt.text), stmt.values);
  };

  /**
   * BIND RETURNS A NEW STATEMENT. It must, and this is not a style choice.
   *
   * D1's `bind()` is immutable -- it yields a fresh statement and leaves the
   * prepared one alone -- and the lanes are written against that contract. The
   * idiom this whole module exists to keep working is:
   *
   *     const insert = db.prepare(SQL);
   *     await db.batch(rows.map((r) => insert.bind(r.a, r.b)));
   *
   * An earlier version mutated one shared `stmt` and returned one shared
   * `bound` object, so every element of that array was THE SAME OBJECT holding
   * only the LAST row's values. `batch()` then ran the statement N times with
   * identical parameters, and an `ON CONFLICT ... DO UPDATE` collapsed the lot
   * into a single row.
   *
   * It failed silently and it failed in production: measured 2026-08-09,
   * `subnet-burn-history` had written exactly ONE row per 15-minute tick since
   * 2026-08-08T15:31 -- the instant the table went sole-store on Neon and this
   * shim took over from D1 -- while reporting `captured 129` on every pass.
   * 126 of 129 subnets stopped accruing history and every lane card stayed
   * green. Nothing about the shape of the call looks wrong at the call site,
   * which is exactly why the invariant belongs here.
   */
  function prepare(text: string) {
    const statement = (values: unknown[]) => {
      const stmt: PendingStatement = { text, values };
      return {
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
        /** A FRESH statement, never `this` -- see the note above. Chainable, so
         * a re-bind of an already-bound statement is also independent. */
        bind(...next: unknown[]) {
          return statement(next);
        },
      };
    };
    return statement([]);
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

/**
 * A boolean bound for the store that will receive it.
 *
 * Postgres columns declared `boolean` reject 1/0 with `operator does not
 * exist: boolean = integer`; SQLite has no boolean type and stores 1/0. So the
 * SAME row needs a different binding depending on which store it lands in, and
 * the choice cannot be made once at the schema level.
 *
 * NULL SURVIVES BOTH. `previous_enabled` uses it to mean "no prior
 * observation", which is not the same as false -- collapsing it would turn
 * every first sighting into a recorded transition from disabled.
 *
 * Exported and pure so the mapping can be tested directly: the alternative is
 * asserting it through a handler that cannot reach a real Postgres, where a
 * wrong binding fails at a connection it never opened.
 */
export function storeBoolean(
  neonOwns: boolean,
  value: boolean | null | undefined,
): boolean | number | null {
  if (value === null || value === undefined) return null;
  return neonOwns ? value : value ? 1 : 0;
}
