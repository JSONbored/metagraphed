// Native D1 implementation of the owned read/producer contracts (#12151).
//
// Transactions use ONE D1 batch. Splitting a batch to fit a request budget would
// commit a prefix of a capture while reporting a failure, so oversized work
// must be chunked by its producer at an explicit receipt boundary instead.
// SQL stays SQLite SQL: this adapter never attempts to translate PostgreSQL's
// casts, arrays, JSON operators, or interactive transactions with regexes.
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

export type D1StoreBinding = Pick<D1Database, "prepare" | "batch">;

function d1TableOwners(env: unknown): Set<string> {
  const value =
    env && typeof env === "object"
      ? (env as { D1_STATE_TABLES?: unknown }).D1_STATE_TABLES
      : undefined;
  return new Set(
    typeof value === "string"
      ? value.split(",").map((name) => name.trim())
      : [],
  );
}

/** Census queries may span owners; JOINs still must select a single owner. */
export function partitionStoreTables(
  env: unknown,
  tables: readonly string[],
): string[][] {
  const owners = d1TableOwners(env);
  return [
    tables.filter((table) => owners.has(table)),
    tables.filter((table) => !owners.has(table)),
  ].filter((partition) => partition.length > 0);
}

/** D1 does not accept booleans, objects, undefined, or bigint bindings. */
function bindValue(value: unknown): string | number | null | ArrayBuffer {
  if (value === null) return null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || value instanceof ArrayBuffer) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Strings preserve wide integers; silently rounding them changes chain data.
  // Callers storing structured JSON must serialize it explicitly, as for pg.
  if (typeof value === "bigint") return value.toString();
  throw new TypeError(
    "Unsupported D1 bind value; serialize structured data explicitly",
  );
}

export function createD1Store(db: D1StoreBinding): ProducerStore {
  const prepare = ({ text, values = [] }: ProducerStatement) => {
    if (values.length > 100)
      throw new RangeError("D1 statement exceeds 100 bindings");
    const statement = db.prepare(text);
    return values.length ? statement.bind(...values.map(bindValue)) : statement;
  };
  const query = async <Row = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row[]> => {
    const result = await prepare({ text, values }).all<Row>();
    return result.results;
  };
  return {
    query,
    async first<Row = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      return (await query<Row>(text, values))[0] ?? null;
    },
    async run(text: string, values: unknown[] = []) {
      const result = await prepare({ text, values }).run();
      return { changes: result.meta.changes };
    },
    async transaction(statements: readonly ProducerStatement[]) {
      if (statements.length === 0) return [];
      // Prepare every statement before submitting anything. Invalid bindings
      // must not allow earlier statements in the same transaction to execute.
      const result = await db.batch(statements.map(prepare));
      return result.map((item) => ({ changes: item.meta.changes }));
    },
    async close() {
      // A Worker binding has no per-invocation TCP connection to release.
    },
  };
}

/**
 * All tables named by a reader must have the same owner. The list is explicit
 * during migration so binding a destination for validation never moves reads
 * onto an unpopulated database. Mixed-store JOINs fail rather than silently
 * consulting the stale source copy. An absent selected binding is also an
 * error: configuration drift must not resurrect Neon as a hidden fallback.
 */
export function selectedD1Store(
  env: unknown,
  tables: readonly string[],
): ProducerStore | null {
  if (!env || typeof env !== "object" || tables.length === 0) return null;
  const bag = env as { D1_STATE_TABLES?: unknown; D1_STATE?: D1StoreBinding };
  if (typeof bag.D1_STATE_TABLES !== "string") return null;
  const owners = d1TableOwners(env);
  const selected = tables.filter((name) => owners.has(name));
  if (selected.length === 0) return null;
  if (selected.length !== tables.length)
    throw new Error("Reader spans D1 and Neon tables");
  if (
    !bag.D1_STATE ||
    typeof bag.D1_STATE.prepare !== "function" ||
    typeof bag.D1_STATE.batch !== "function"
  )
    throw new Error("Selected D1 store is unbound");
  return createD1Store(bag.D1_STATE);
}
