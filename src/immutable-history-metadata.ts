import { registerModuleStateReset } from "./module-state-registry.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_OBJECT_BYTES = 128 * 1024;
const MAX_PENDING = 16;
const contentKey =
  /^metagraph\/indexed-history\/v1\/(?:mainnet|testnet)\/[a-z_]+\/generations\/[a-f0-9]{64}\/(?:[^/]+\/)*([a-f0-9]{64})\.json$/;

function createState() {
  return {
    buckets: new WeakMap<object, number>(),
    nextBucket: 0,
    entries: new Map<string, ArrayBuffer>(),
    pending: 0,
    bytes: 0,
  };
}
let state = createState();
registerModuleStateReset("src/immutable-history-metadata.ts", () => {
  state = createState();
});

/** Cache only small, hash-verified directory objects. Mutable selections,
 * manifests and page payloads keep their ordinary conditional-read path. */
export function createImmutableHistoryMetadataReader(bucket: object) {
  // In-flight I/O belongs to one source/operation, never another request.
  const requests = new WeakMap<
    ReturnType<typeof createState>,
    Map<string, Promise<ArrayBuffer>>
  >();
  return async (
    key: string,
    etag: string,
    offset: number,
    length: number,
    read: () => Promise<ArrayBuffer>,
  ): Promise<ArrayBuffer> => {
    const digest =
      offset === 0 &&
      Number.isSafeInteger(length) &&
      length > 0 &&
      length <= MAX_OBJECT_BYTES &&
      key.length <= 1024 &&
      /^[a-f0-9]{32}$/.test(etag) &&
      contentKey.exec(key)?.[1];
    if (!digest) return read();

    // One global byte/entry limit, with strict binding identity isolation.
    // A reset replaces the state so an older pending read cannot repopulate it.
    const active = state;
    let owner = active.buckets.get(bucket);
    if (owner === undefined) {
      owner = active.nextBucket++;
      active.buckets.set(bucket, owner);
    }
    const id = JSON.stringify([owner, key, etag, length]);
    const prior = active.entries.get(id);
    if (prior) {
      active.entries.delete(id);
      active.entries.set(id, prior);
      return prior.slice(0);
    }
    let pendingReads = requests.get(active);
    if (!pendingReads) {
      pendingReads = new Map();
      requests.set(active, pendingReads);
    }
    const pending = pendingReads.get(id);
    if (pending) return (await pending).slice(0);
    if (active.pending >= MAX_PENDING) return read();
    active.pending++;

    const operation = (async () => {
      const bytes = (await read()).slice(0);
      const actual = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      // Admission cannot turn a legacy/non-content-addressed object into a
      // persistent value. Its existing reader still validates the fresh bytes.
      if (
        actual !== digest ||
        bytes.byteLength !== length ||
        active.entries.has(id)
      )
        return bytes;
      for (const [oldest, value] of active.entries) {
        if (
          active.entries.size < MAX_ENTRIES &&
          active.bytes + bytes.byteLength <= MAX_BYTES
        )
          break;
        active.entries.delete(oldest);
        active.bytes -= value.byteLength;
      }
      active.entries.set(id, bytes);
      active.bytes += bytes.byteLength;
      return bytes;
    })();
    pendingReads.set(id, operation);
    try {
      // Every consumer owns its buffer, including concurrent cache misses.
      return (await operation).slice(0);
    } finally {
      pendingReads.delete(id);
      active.pending--;
    }
  };
}
