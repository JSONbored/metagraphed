import { selectedD1Store } from "./d1-store.ts";
import { ALPHA_QUANTITY_TABLES } from "./read-store-tables.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

type Row = Record<string, unknown>;
type Revision = { table_name: string; revision: number };
type CacheConfig = { D1_EXPORT_REVISIONS?: string; D1_STATE?: object };
type Entry = { key: string; until: number; rows: Promise<Row[]> };
let snapshots = new WeakMap<object, Entry>();
registerModuleStateReset("src/chain-holders-cache.ts", () => {
  snapshots = new WeakMap();
});

/** The canonical position producer advances its revision atomically. Recheck
 * on every hit and include the qualified capture identity; the caller also
 * rechecks selected runtime metadata/completion. Retired pool totals are not a
 * quantity owner. Read revisions before data so a race cannot relabel old rows. */
export async function readRevisionedChainHolders(
  env: unknown,
  capturedAt: number,
  read: () => Promise<Row[]>,
): Promise<Row[]> {
  const config = env as CacheConfig | undefined;
  const store =
    config?.D1_EXPORT_REVISIONS === "enabled"
      ? selectedD1Store(env, ALPHA_QUANTITY_TABLES)
      : null;
  if (!store) return read();
  const binding = config!.D1_STATE!; // selectedD1Store validates the binding.
  const revisions = await store
    .query<Revision>(
      "SELECT table_name,revision FROM archive_export_revisions " +
        "WHERE table_name='nominator_positions'",
    )
    .catch(() => []);
  if (
    revisions.length !== 1 ||
    revisions[0].table_name !== "nominator_positions" ||
    revisions.some(
      (row) => !Number.isSafeInteger(row.revision) || row.revision < 0,
    )
  ) {
    snapshots.delete(binding);
    return read();
  }
  const key = JSON.stringify([capturedAt, revisions]);
  const now = Date.now();
  const prior = snapshots.get(binding);
  if (prior && prior.key === key && prior.until > now)
    return (await prior.rows).map((row) => ({ ...row }));
  const entry = { key, until: now + 300_000, rows: read() };
  snapshots.set(binding, entry);
  const evict = () => {
    if (snapshots.get(binding) === entry) snapshots.delete(binding);
  };
  try {
    const rows = await entry.rows;
    if (rows.length > 1000 || JSON.stringify(rows).length > 512 * 1024) evict();
    // The ranking contains only scalar SQL columns; copy them for each caller.
    return rows.map((row) => ({ ...row }));
  } catch (error) {
    evict();
    throw error;
  }
}
