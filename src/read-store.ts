// Which store a READ should go to, for callers that have no ExecutionContext.
//
// ## Why this exists when createPgSql already does
//
// createPgSql hands its connection back through `ctx.waitUntil(client.end())`,
// so every caller needs an ExecutionContext. That is fine on a route handler
// and impossible on the tier readers: chain-detail-hot-tier, blocks-cold-tier,
// nominator-positions-hot-tier and the rest are `(env, ...)` functions called
// from resolvers, MCP handlers and other loaders, several layers below anything
// holding a ctx. Threading one through all of them, and through every caller of
// every one of them, is a far larger and riskier change than the reads deserve.
//
// So this takes lane-health-store's approach instead, for the same reason and
// with the same trade: each operation opens, runs and closes its own
// connection, awaiting the teardown rather than deferring it. Hyperdrive pools,
// so `connect()` is against the pool rather than a fresh TCP handshake -- which
// is what makes per-operation connections affordable here and would not be
// against a bare Postgres.
//
// ## Why the shape is `prepare().bind().all()`
//
// Every call site already spoke that shape when D1 held these tables. Keeping
// it meant the swap was the binding expression and nothing else -- no query
// rewriting, no signature changes, no behaviour to re-verify at ~60 sites
// across the tier readers. `?` placeholders are rewritten to `$n` on the way
// through, which was the only dialect difference these queries had: they are
// plain SELECTs with no SQLite-specific functions.
//
// ## All-or-nothing, deliberately
//
// A reader is handed EVERY table its statements name, and Neon has to be
// declared the owner of all of them or nothing is returned. A reader split
// across stores would run a JOIN against a store missing one side, and that
// failure is an empty result set rather than an error -- a schema-stable wrong
// answer, which is the failure mode this whole migration keeps having to
// design against.
import { Client } from "pg";
import { neonOwnsTable } from "./neon-write.ts";
import { toPositionalPlaceholders, type HyperdriveLike } from "./pg-sql.ts";

/** The minimal pg client this needs, so a test can hand it a fake. */
export interface ReadStoreClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows?: unknown[]; rowCount?: number } | undefined>;
}

/** A row with no claimed shape.
 *
 * The DEFAULT for `all`/`first`, rather than `unknown`, because that is what
 * D1's own typing gave these call sites: several read a named column straight
 * off an untyped `first()`, and `unknown` would break them for no benefit --
 * neither store validates the shape, so the default is about what the caller is
 * allowed to write, not about safety. */
type Row = Record<string, unknown>;

/** D1's read surface, as the callers actually use it.
 *
 * `all` and `first` are generic for the same reason D1's are: the ~45 call
 * sites this replaced write `all<SubnetRow>()` and read named columns off the
 * result. A non-generic `unknown[]` would compile only after adding a cast at
 * every one of them, which is churn that hides exactly the mistakes a cast-free
 * swap makes visible. */
export interface ReadStoreDb {
  prepare(text: string): {
    bind(...values: unknown[]): {
      all<T = Row>(): Promise<{ results: T[] }>;
      first<T = Row>(): Promise<T | null>;
    };
    all<T = Row>(): Promise<{ results: T[] }>;
    first<T = Row>(): Promise<T | null>;
  };
}

export interface ReadStoreDeps {
  clientFactory?: (connectionString: string) => ReadStoreClient;
}

/** A D1-shaped read handle over Postgres, one connection per operation. */
export function pgReadStore(
  connectionString: string,
  deps: ReadStoreDeps = {},
): ReadStoreDb {
  const run = async (text: string, values: unknown[]) => {
    const client =
      deps.clientFactory?.(connectionString) ??
      (new Client({ connectionString }) as unknown as ReadStoreClient);
    await client.connect();
    try {
      const result = await client.query(toPositionalPlaceholders(text), values);
      return (result?.rows ?? []) as unknown[];
    } finally {
      // Awaited, unlike createPgSql's waitUntil -- see this module's header.
      await client.end().catch(() => undefined);
    }
  };
  // The generic parameter is the CALLER's claim about the row shape, exactly as
  // it is on D1: Postgres hands back whatever the query selected, and neither
  // store validates it. Cast here rather than at 45 call sites.
  const ops = (text: string, values: unknown[]) => ({
    async all<T = unknown>() {
      return { results: (await run(text, values)) as T[] };
    },
    async first<T = unknown>() {
      return ((await run(text, values))[0] ?? null) as T | null;
    },
  });
  return {
    prepare(text: string) {
      return {
        bind: (...values: unknown[]) => ops(text, values),
        ...ops(text, []),
      };
    },
  };
}

/**
 * The store to read `tables` from: Neon, once it is declared to solely own
 * every one of them and Hyperdrive is bound.
 *
 * `injected` wins outright so a test can hand in its own fake, and `undefined`
 * comes back when no store is available -- which every caller already handles,
 * because an unbound store has always been possible.
 */
export function readStore(
  // Deliberately loose: callers hand in an `Env`, a bag, or `unknown`, and a
  // narrower type would push a cast to every one of them.
  env: unknown,
  tables: readonly string[],
  injected?: ReadStoreDb | null,
  deps: ReadStoreDeps = {},
): ReadStoreDb | undefined {
  if (injected) return injected;
  const bag = env as Record<string, unknown> | null | undefined;
  const hyperdrive = bag?.HYPERDRIVE as HyperdriveLike | undefined;
  if (!hyperdrive?.connectionString) return undefined;
  // Empty `tables` must never read as "Neon owns them all" -- that would send a
  // caller who forgot to declare its tables to Postgres unconditionally.
  if (tables.length === 0) return undefined;
  if (!tables.every((table) => neonOwnsTable(bag, table))) return undefined;
  return pgReadStore(hyperdrive.connectionString, deps);
}
