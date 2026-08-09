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

import { Client, types } from "pg";

/** Postgres OID for `int8` / BIGINT. */
const INT8_OID = 20;

/**
 * BIGINT comes back as a JS number, not a string.
 *
 * WHY THIS IS NOT A PREFERENCE. node-postgres returns `int8` as a STRING by
 * default, because int8 spans a wider range than a JS number can hold exactly.
 * D1 returns the same columns as numbers. So without this, moving a route
 * between the two stores changes the TYPE of every epoch-ms and counter field
 * in its response -- `created_at: 1785176950652` becomes
 * `created_at: "1785176950652"` -- with no error anywhere, and a consumer
 * doing arithmetic or a `>` comparison silently gets a different answer.
 *
 * Confirmed against production 2026-08-07, which is what makes this a fix and
 * not a precaution: `SELECT registered_at_block FROM neurons` over this driver
 * returns `"1404439"`, while the live `/subnets/1/metagraph` -- a route
 * already served from Neon -- returns `8692121`. The two agree only because
 * that handler happens to coerce. Every handler that does not is one field
 * away from the divergence.
 *
 * THE RANGE CHECK IS THE POINT. Silently rounding a value past 2^53 would be a
 * worse bug than the one this fixes, so anything outside the exactly-
 * representable range stays a string -- a caller that sees a string knows it
 * got something a number could not hold. Nothing in this schema is close:
 * every int8 column here is epoch-milliseconds (~1.79e12) or a row counter,
 * against a safe ceiling of ~9.01e15, so the guard is a backstop rather than a
 * live path.
 *
 * Set on the module rather than per-connection because both callers of this
 * file build their Client here, and a parser that applied to only some
 * connections would reintroduce exactly the inconsistency it removes.
 */
types.setTypeParser(INT8_OID, (value: string) => {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
});

/**
 * Rows a statement returns.
 *
 * GENERIC OVER THE ROW, defaulting to the untyped shape every existing caller
 * already has (#10261). `generated/db/types.ts` now has one interface per Neon
 * table, so a caller that knows what it selected can say so --
 * `sql<Pick<Neurons, "netuid" | "hotkey">>\`SELECT netuid, hotkey ...\`` -- and
 * get a compile error when a column is renamed or retyped, instead of the
 * hand-written coercion that stands between Postgres and the first typed value
 * everywhere else.
 *
 * The default keeps this a widening: not one of the ~150 existing call sites
 * changes meaning, and a site opts in by naming its row.
 */
export type PgSqlRows<Row = Record<string, unknown>> = Row[];

export interface PgSql {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<PgSqlRows<Row>>;
  /** For the rare statement whose TEXT is built dynamically. Mirrors
   * D1Sql.unsafe so a caller can move between stores unchanged. */
  unsafe<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgSqlRows<Row>>;
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
  // `?` -> `$n`, exactly as createPgQuestionMarkRunner does it, and for the same reason
  // -- this is the escape hatch route handlers reach for when the statement is
  // assembled from a column-list constant, and they write SQLite's `?` because
  // D1 is what they were written against.
  //
  // WITHOUT THIS, SIX ROUTES SERVED EMPTY (#9821). Postgres does not recognise
  // `?` as a placeholder, so `WHERE netuid = ? AND snapshot_date >= ?` never
  // matched and /subnets/{n}/performance/history went 28 rows -> 0, along with
  // /subnets/{n}/validators, /subnets/{n}/performance, /subnets/{n}/neurons/
  // {uid}, that route's /history, and /validators/{hotkey}/history.
  //
  // The conversion existed and was wired into createPgQuestionMarkRunner ONLY, so the
  // tagged-template path and the injected-runner path were both safe and the
  // third path -- this one -- was not. A statement that already uses `$n` and
  // no `?` passes through unchanged, so applying it here is not a behaviour
  // change for any caller that was already correct.
  sql.unsafe = (<Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) =>
    run(toPositionalPlaceholders(text), values) as Promise<
      PgSqlRows<Row>
    >) as PgSql["unsafe"];
  return sql;
}

/**
 * A `D1Runner`-shaped adapter over Postgres.
 *
 * `D1Runner` is `(sql, params) => Promise<Row[]>`, and four analytics modules
 * (`movers`, `turnover`, `chain-turnover`, `concentration`) already take one as
 * a parameter rather than reaching for a binding. That injection is what makes
 * moving them a matter of handing over a different runner instead of editing
 * their queries -- the same property `createPgSql` gives the tagged-template
 * routes.
 *
 * THE TRANSLATION IS THE WHOLE RISK. Those modules write SQLite's positional
 * `?`, and Postgres needs `$1, $2, ...` numbered in the same order. Getting it
 * wrong does not throw: it binds a value to the wrong column and returns a
 * confident wrong answer. So `toPositionalPlaceholders` is exported and
 * asserted directly rather than trusted through a query that happens to pass.
 */
export function toPositionalPlaceholders(sql: string): string {
  let n = 0;
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    // A `?` inside a string literal is data, not a placeholder. SQLite escapes
    // a quote by doubling it, and since the doubled pair reads as close-then-
    // open the state ends up correct either way.
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch === "?" ? `$${(n += 1)}` : ch;
  }
  return out;
}

/** Build a D1Runner backed by Hyperdrive. Callers pass this where they would
 * otherwise pass the D1-backed runner; the modules themselves are untouched. */
export function createPgQuestionMarkRunner(
  hyperdrive: HyperdriveLike,
  ctx: WaitUntilLike,
  clientFactory?: (connectionString: string) => Client,
): (sql: string, params: unknown[]) => Promise<PgSqlRows> {
  const sql = createPgSql(hyperdrive, ctx, clientFactory);
  return (text: string, params: unknown[] = []) =>
    sql.unsafe(toPositionalPlaceholders(text), params);
}
