import { createProducerStore } from "./producer-store.ts";
import type { ProducerStatement } from "./producer-store.ts";
import { commitSyncDelivery } from "./sync-delivery-receipt.ts";
import type { PassTallyInput } from "./pass-completeness.ts";

/** Existing writer builders produce native PG statements. Collect them without
 * I/O, then commit the complete business unit on one pinned connection. Never
 * use the per-statement Hyperdrive/buffer runner for identified deliveries. */
export async function writeIdentifiedPostgres<T>(
  connectionString: string | undefined,
  lane: string,
  rows: Record<string, unknown>[],
  pass: PassTallyInput,
  build: (
    sql: { unsafe(text: string, values?: unknown[]): Promise<unknown> },
    legacy: PassTallyInput,
  ) => Promise<T>,
): Promise<T> {
  if (!connectionString)
    throw new Error("Identified delivery needs an atomic PostgreSQL store");
  const statements: ProducerStatement[] = [];
  const outcome = await build(
    {
      async unsafe(text, values) {
        statements.push({ text, values });
        return [];
      },
    },
    { ...pass, delivery: undefined },
  );
  const failures = (value: unknown): boolean =>
    !!value &&
    typeof value === "object" &&
    ((Object.hasOwn(value, "ok") && (value as { ok: unknown }).ok === false) ||
      Object.values(value).some(failures));
  if (failures(outcome))
    throw new Error("Identified business statement preparation failed");
  const store = createProducerStore(connectionString);
  try {
    await commitSyncDelivery(store, lane, rows, pass, statements);
  } finally {
    await store.close();
  }
  return outcome;
}
