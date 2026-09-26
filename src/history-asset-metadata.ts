import { registerModuleStateReset } from "./module-state-registry.ts";

const MAX_BYTES = 4 * 1024 * 1024;

function createState() {
  return {
    owners: new WeakMap<object, number>(),
    nextOwner: 0,
    entries: new Map<string, Uint8Array>(),
    bytes: 0,
  };
}
let metadataState = createState();
let payloadState = createState();
registerModuleStateReset("src/history-asset-metadata.ts", () => {
  metadataState = createState();
  payloadState = createState();
});

/** Retain only completed, verified immutable bytes. Requests never share pending
 * I/O, mutable selectors or decoded objects, and each consumer owns its buffer. */
function createReader(
  store: object,
  getState: () => ReturnType<typeof createState>,
  maxEntries: number,
  maxEntryBytes: number,
) {
  return async (
    hash: string,
    size: number,
    readVerified: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> => {
    const active = getState();
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
    if (bytes.length > maxEntryBytes || active.entries.has(id)) return bytes;
    for (const [oldest, value] of active.entries) {
      if (
        active.entries.size < maxEntries &&
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

export function createHistoryAssetMetadataReader(store: object) {
  return createReader(store, () => metadataState, 128, 512 * 1024);
}

/** Keep hot 128 KiB payload chunks in a separate 4 MiB budget so sequential
 * explorer, REST and MCP requests can reuse them without evicting metadata. */
export function createHistoryAssetPayloadReader(store: object) {
  return createReader(store, () => payloadState, 64, 128 * 1024);
}
