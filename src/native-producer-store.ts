import type { ProducerStore } from "./producer-store.ts";
import type { PgUnsafe } from "./neon-write.ts";
import { recordOrNull } from "./read-store.ts";
import { pgStatementText, type PgSql } from "./pg-sql.ts";

export interface NativeProducerSelection {
  tables: readonly string[];
  store: Omit<ProducerStore, "close">;
}

export interface NativeProducerEnv {
  NATIVE_PRODUCER_STORE?: NativeProducerSelection;
  NATIVE_WRITE_RUNNERS?: Readonly<Record<string, PgUnsafe>>;
}

/** A selected native owner never falls through to a different database. */
export function selectedNativeProducerStore(
  env: unknown,
  tables: readonly string[],
): NativeProducerSelection["store"] | undefined {
  const bindings = recordOrNull(env);
  const selected = bindings?.NATIVE_PRODUCER_STORE;
  if (selected === undefined) {
    if (bindings?.NATIVE_WRITE_RUNNERS !== undefined)
      throw new TypeError("Selected native producer store is unavailable");
    return undefined;
  }
  const selection = recordOrNull(selected);
  const owned = selection?.tables;
  const store = recordOrNull(selection?.store);
  if (
    !Array.isArray(owned) ||
    !owned.every((table) => typeof table === "string") ||
    !store ||
    ["query", "first", "run", "transaction"].some(
      (method) => typeof store[method] !== "function",
    )
  )
    throw new TypeError("Selected native producer store is invalid");
  if (!tables.length || !tables.every((table) => owned.includes(table)))
    throw new Error("Native producer store does not own every requested table");
  return selection!.store as NativeProducerSelection["store"];
}

/** Presence selects native ownership for every enabled write lane. An omitted
 * lane is a configuration error, including when a legacy binding is available. */
export function selectedNativeWriteRunner(
  env: unknown,
  lane: string,
): PgUnsafe | undefined {
  const bindings = recordOrNull(env);
  const selected = bindings?.NATIVE_WRITE_RUNNERS;
  if (selected === undefined) {
    if (bindings?.NATIVE_PRODUCER_STORE !== undefined)
      throw new TypeError(`Selected native write lane is unavailable: ${lane}`);
    return undefined;
  }
  const runners = recordOrNull(selected);
  const runner =
    runners && Object.hasOwn(runners, lane)
      ? recordOrNull(runners[lane])
      : null;
  if (!runner || typeof runner.unsafe !== "function")
    throw new TypeError(`Selected native write lane is unavailable: ${lane}`);
  return (selected as Readonly<Record<string, PgUnsafe>>)[lane];
}

/** Tagged reads used by capture diffing share the same explicit table owner. */
export function selectedNativeProducerSql(
  env: unknown,
  tables: readonly string[],
): PgSql | undefined {
  const store = selectedNativeProducerStore(env, tables);
  if (!store) return undefined;
  return Object.assign(
    <Row>(strings: TemplateStringsArray, ...values: unknown[]) =>
      store.query<Row>(pgStatementText(strings), values),
    {
      unsafe: store.query.bind(store),
    },
  );
}
