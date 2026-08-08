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
// ## Why the shape is D1's
//
// Every call site already speaks `prepare(text).bind(...).all()`. Returning
// that shape means the swap is the binding expression and nothing else -- no
// query rewriting, no signature changes, no behaviour to re-verify at ~60 sites
// across the tier readers. `?` placeholders are rewritten to `$n` on the way
// through, which is the only dialect difference these queries have: they are
// plain SELECTs with no SQLite-specific functions.
//
// ## All-or-nothing, deliberately
//
// A reader is handed EVERY table its statements name. Neon has to own all of
// them or the D1 binding is returned unchanged. A reader split across stores
// would run a JOIN against a store missing one side, and that failure is an
// empty result set rather than an error -- a schema-stable wrong answer, which
// is the failure mode this whole migration keeps having to design against.
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

/** D1's read surface, as the tier readers actually use it. */
export interface ReadStoreDb {
  prepare(text: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results: unknown[] }>;
      first(): Promise<unknown>;
    };
    all(): Promise<{ results: unknown[] }>;
    first(): Promise<unknown>;
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
  const ops = (text: string, values: unknown[]) => ({
    all: async () => ({ results: await run(text, values) }),
    first: async () => (await run(text, values))[0] ?? null,
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
 * The store to read `tables` from: Neon once it solely owns every one of them
 * and Hyperdrive is bound, the D1 binding until then.
 *
 * `injected` wins outright so a test can hand in its own fake, and `undefined`
 * comes back when neither store is available -- which every caller already
 * handles, because an unbound D1 has always been possible.
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
  const d1 = bag?.METAGRAPH_HEALTH_DB as ReadStoreDb | undefined;
  const hyperdrive = bag?.HYPERDRIVE as HyperdriveLike | undefined;
  if (!hyperdrive?.connectionString) return d1;
  // Empty `tables` must never read as "Neon owns them all" -- that would send a
  // caller who forgot to declare its tables to Postgres unconditionally.
  if (tables.length === 0) return d1;
  if (!tables.every((table) => neonOwnsTable(bag, table))) return d1;
  return pgReadStore(hyperdrive.connectionString, deps);
}
