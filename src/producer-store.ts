// The producer lanes' store client, with OUR contract (#10309).
//
// ## What this replaced, and why the shape changed
//
// Its predecessor (`pg-statement-client.ts`) presented D1's
// `prepare/bind/all/run/batch` object API over Postgres so the producer lanes
// -- written against D1 -- did not have to be ported. Correct as migration
// scaffolding; D1 is deleted, and an adapter faithfully reproducing an
// interface whose owner no longer exists has no reference implementation to
// check against. #10304 is what that costs: `bind()` mutated a shared
// statement where D1's returned a fresh one, and `subnet_burn_history` wrote
// 1 row per tick instead of 129 for 34 hours while reporting success.
//
// The replacement makes that WHOLE CLASS structurally impossible: there are no
// statement objects to share. A statement is plain `{ text, values }` data,
// built fresh by the caller at the call site --
//
//     await store.transaction(
//       rows.map((r) => ({ text: INSERT_SQL, values: [r.a, r.b] })),
//     );
//
// -- so there is nothing to mutate, nothing to rebind, and nothing whose
// aliasing semantics have to be remembered from a deleted database's docs.
//
// ## The invariants, stated as ours
//
// - ONE lazily opened connection per store instance, closed by `close()`,
//   which the owner MUST park on `ctx.waitUntil` -- a leaked connection per
//   producer tick is worse than the read it was opened for. Hyperdrive holds
//   the real pool; the client here is a cheap handle to it.
// - `?` placeholders are rewritten to `$n` on the way through
//   (toPositionalPlaceholders, shared with pg-sql.ts so the two paths cannot
//   disagree about parameter order). The lanes were written with `?` and keep
//   it.
// - `transaction()` is ALL-OR-NOTHING: BEGIN, each statement in order, COMMIT;
//   any rejection ROLLBACKs the whole set and rethrows the ORIGINAL error (a
//   ROLLBACK that itself fails must not replace the error that caused it, or
//   the log names the symptom and loses the cause).
// - Writes report `changes` (pg's rowCount). A write path that cannot count
//   its own effect cannot be watched -- the number #10304 proved a batching
//   lane must see, kept per statement in `transaction()`'s result.
import { Client } from "pg";
import { toPositionalPlaceholders } from "./pg-sql.ts";

/** The minimal pg client this needs, so a test can hand it a fake. */
export interface ProducerStoreClient {
  /**
   * `unknown`, not `void`: `pg`'s own `connect()` resolves to the client, and
   * every caller here awaits it for the side effect and ignores the value. A
   * `void` return is not a superset of `Promise<Client>` inside a generic, so
   * declaring one made the real driver incompatible and forced
   * `new Client(...) as unknown as <Contract>` at the factory (#11339).
   */
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
}

/** One statement, as plain data. Built at the call site; nothing executes
 * until the store runs it, which is what lets `transaction()` share one
 * BEGIN/COMMIT across the set. */
export interface ProducerStatement {
  text: string;
  values?: unknown[];
}

export interface ProducerStoreDeps {
  clientFactory?: (connectionString: string) => ProducerStoreClient;
}

export interface ProducerStore {
  /** Rows a SELECT returns. */
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<Row[]>;
  /** The first row, or null -- for the single-row lookups. */
  first<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<Row | null>;
  /** A single write; `changes` is how many rows it actually touched. */
  run(text: string, values?: unknown[]): Promise<{ changes: number }>;
  /** All-or-nothing, one result per statement in order. */
  transaction(
    statements: readonly ProducerStatement[],
  ): Promise<{ changes: number }[]>;
  close(): Promise<void>;
}

export function createProducerStore(
  connectionString: string,
  deps: ProducerStoreDeps = {},
): ProducerStore {
  let client: ProducerStoreClient | null = null;
  const open = async (): Promise<ProducerStoreClient> => {
    if (client) return client;
    client =
      deps.clientFactory?.(connectionString) ??
      new Client({ connectionString });
    await client.connect();
    return client;
  };

  const exec = async (text: string, values: unknown[] = []) => {
    const c = await open();
    return c.query(toPositionalPlaceholders(text), values);
  };

  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      const res = await exec(text, values);
      return (res.rows ?? []) as Row[];
    },
    async first<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      const res = await exec(text, values);
      return ((res.rows ?? [])[0] ?? null) as Row | null;
    },
    async run(text: string, values: unknown[] = []) {
      const res = await exec(text, values);
      return { changes: res.rowCount ?? 0 };
    },
    async transaction(statements: readonly ProducerStatement[]) {
      const c = await open();
      await c.query("BEGIN");
      try {
        const out: { changes: number }[] = [];
        for (const stmt of statements) {
          const res = await c.query(
            toPositionalPlaceholders(stmt.text),
            stmt.values ?? [],
          );
          out.push({ changes: res.rowCount ?? 0 });
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
