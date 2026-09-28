import type { ProducerStore } from "./producer-store.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

type Row = Record<string, unknown>;
type Entry = { revision: number; until: number; rows: Promise<Row[]> };
let snapshots = new WeakMap<object, Entry>();
registerModuleStateReset("src/neuron-economics-cache.ts", () => {
  snapshots = new WeakMap();
});

/** The neuron writer advances this revision in the SAME transaction as its
 * document/membership changes. Check it on every request, even a cache hit.
 * The key is read BEFORE the data: a racing write can make an entry obsolete,
 * but cannot label older data with a newer revision. One bounded entry per
 * binding also coalesces simultaneous reads of the same revision.
 *
 * Only normalized economics rows enter here: all column values are scalar
 * SQLite values, so a row copy isolates callers from the retained snapshot. */
export async function readRevisionedNeuronEconomics(
  store: Pick<ProducerStore, "first">,
  binding: object,
  read: () => Promise<Row[]>,
): Promise<Row[]> {
  const stamp = await store
    .first<{ revision: number }>(
      "SELECT revision FROM archive_export_revisions WHERE table_name='neurons'",
    )
    .catch(() => null);
  if (!stamp || !Number.isSafeInteger(stamp.revision) || stamp.revision < 0) {
    snapshots.delete(binding);
    return read();
  }
  const now = Date.now();
  const prior = snapshots.get(binding);
  if (prior && prior.revision === stamp.revision && prior.until > now)
    return (await prior.rows).map((row) => ({ ...row }));

  const entry: Entry = {
    revision: stamp.revision,
    until: now + 30_000,
    rows: read(),
  };
  snapshots.set(binding, entry);
  const evict = () => {
    if (snapshots.get(binding) === entry) snapshots.delete(binding);
  };
  try {
    const rows = await entry.rows;
    // Bound retained objects as well as their scalar contents. Larger answers
    // still work; they simply bypass reuse instead of growing isolate memory.
    if (rows.length > 50_000 || JSON.stringify(rows).length > 8 * 1024 * 1024)
      evict();
    return rows.map((row) => ({ ...row }));
  } catch (error) {
    evict();
    throw error;
  }
}
