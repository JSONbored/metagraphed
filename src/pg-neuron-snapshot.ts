import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import type { NeuronSnapshotStore } from "./neuron-snapshot-store.ts";
import { subnetNeuronRowsFromParts } from "./neuron-snapshot-read.ts";

interface NativeSnapshotPart {
  shard: string;
  payload: Uint8Array | null;
  uid: string | null;
  hotkey: string | null;
  coldkey: string | null;
}

/** One statement reads the same document/member snapshot. The existing subnet
 * endpoint parses document objects with last-key semantics; it does not use
 * the first-key SQL view projection. */
export function createPgNeuronSnapshotStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronSnapshotStore {
  return {
    async subnetRows(netuid, validatorsOnly) {
      const parts = await runtime.read.query<NativeSnapshotPart>(
        `SELECT shard::text AS shard,payload,NULL::text AS uid,NULL::text AS hotkey,NULL::text AS coldkey
         FROM app.neurons_documents WHERE netuid=$1 AND day=''
         UNION ALL
         SELECT shard::text,NULL::bytea,uid::text,hotkey,coldkey
         FROM app.neurons_members WHERE netuid=$1`,
        [netuid],
      );
      return subnetNeuronRowsFromParts(
        parts.map((part) => ({
          shard: Number(part.shard),
          payload: part.payload === null ? null : decoder.decode(part.payload),
          uid: part.uid === null ? null : Number(part.uid),
          hotkey: part.hotkey,
          coldkey: part.coldkey,
        })),
        validatorsOnly,
      );
    },
    async burnHotkey(netuid) {
      const owner = await runtime.read.first<{ owner_hotkey: string | null }>(
        "SELECT owner_hotkey FROM app.subnet_ownership WHERE netuid=$1 ORDER BY captured_at DESC LIMIT 1",
        [netuid],
      );
      if (!owner?.owner_hotkey) return null;
      const snapshot = await runtime.read.first<{
        miner_burned_fraction: number | null;
      }>(
        "SELECT miner_burned_fraction FROM app.subnet_snapshots WHERE netuid=$1 ORDER BY snapshot_date DESC LIMIT 1",
        [netuid],
      );
      const fraction = Number(snapshot?.miner_burned_fraction ?? 0);
      return Number.isFinite(fraction) && fraction > 0
        ? owner.owner_hotkey
        : null;
    },
  };
}
