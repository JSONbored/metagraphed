import { registerModuleStateReset } from "./module-state-registry.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;

function createState() {
  return {
    owners: new WeakMap<object, number>(),
    nextOwner: 0,
    entries: new Map<string, Uint8Array>(),
    bytes: 0,
  };
}
let state = createState();
registerModuleStateReset("src/history-asset-metadata.ts", () => {
  state = createState();
});

/** Retain only completed, verified metadata bytes. Requests never share pending
 * I/O, mutable selectors or decoded objects, and each consumer owns its buffer. */
export function createHistoryAssetMetadataReader(store: object) {
  return async (
    hash: string,
    size: number,
    readVerified: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> => {
    const active = state;
    let owner = active.owners.get(store);
    if (owner === undefined) {
      owner = active.nextOwner++;
      active.owners.set(store, owner);
    }
    const id = JSON.stringify([owner, hash]);
    const prior = active.entries.get(id);
    if (prior) {
      if (prior.length !== size)
        throw new Error("Immutable history asset size conflict");
      active.entries.delete(id);
      active.entries.set(id, prior);
      return prior.slice();
    }

    const bytes = (await readVerified()).slice();
    if (bytes.length !== size)
      throw new Error("Immutable history asset size conflict");
    if (bytes.length > 512 * 1024 || active.entries.has(id)) return bytes;
    for (const [oldest, value] of active.entries) {
      if (
        active.entries.size < MAX_ENTRIES &&
        active.bytes + bytes.length <= MAX_BYTES
      )
        break;
      active.entries.delete(oldest);
      active.bytes -= value.length;
    }
    active.entries.set(id, bytes);
    active.bytes += bytes.length;
    return bytes.slice();
  };
}
