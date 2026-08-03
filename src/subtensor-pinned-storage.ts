// Pinned SubtensorModule storage reads, shared by every Worker-side lane that
// has to look at the chain's per-netuid maps.
//
// Extracted from src/emission-drift-check.ts, which grew the whole idiom
// first: one `state_queryStorageAt` per storage ITEM covering every netuid at
// once (so a network-wide sweep is ~a dozen round trips, not ~1,300), every
// read pinned to a single block hash, and the netuid recovered from each
// returned key's own trailing u16 rather than from the response's ordering.
//
// PINNING IS THE POINT, not an optimisation. The values these maps carry move
// every block and some of them (theta, the gate bar) recompute on a 360-block
// boundary, so an unpinned sweep mixes states that never coexisted and
// publishes a capture artefact as if it were chain state. Both callers today
// -- the drift check and the live-economics refresh -- exist specifically to
// be checkable against the block they were read at, which an unpinned read
// makes impossible.
//
// Extracted rather than copied: a second hand-rolled copy of the key layout is
// how the two lanes would start disagreeing about which block they read, which
// is the exact failure the pinning exists to prevent.

/** twox128("SubtensorModule") -- the pallet half of every key here. */
const SUBTENSOR_PALLET_PREFIX = "658faa385070e074c85bf6b568cf0555";

/**
 * The netuid as a u16 little-endian hex suffix. These maps are Identity-hashed
 * on the map key, so the netuid is appended raw with no hasher prefix -- which
 * is also what makes netuidFromStorageKey below able to read it back.
 */
function netuidStorageSuffix(netuid: number): string {
  return (
    (netuid % 256).toString(16).padStart(2, "0") +
    Math.floor(netuid / 256)
      .toString(16)
      .padStart(2, "0")
  );
}

/** Inverse of netuidStorageSuffix, read off the tail of a returned key. */
function netuidFromStorageKey(key: string): number {
  const suffix = key.slice(-4);
  return (
    Number.parseInt(suffix.slice(0, 2), 16) +
    Number.parseInt(suffix.slice(2, 4), 16) * 256
  );
}

/** Full storage key for one Identity-hashed netuid map entry. */
function netuidStorageKey(itemHash: string, netuid: number): string {
  return `0x${SUBTENSOR_PALLET_PREFIX}${itemHash}${netuidStorageSuffix(netuid)}`;
}

export interface SubtensorPinnedStorageOptions {
  rpcUrl: string;
  /** Injected in tests; defaults to the runtime's own fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The block every read in one sweep is pinned to. */
export interface PinnedBlock {
  blockNumber: number;
  blockHash: string;
}

export interface SubtensorPinnedStorage {
  /** Chain tip, resolved to the hash every subsequent read pins to. */
  pinHead(): Promise<PinnedBlock>;
  /** One storage item across `netuids`, keyed by netuid. Absent keys are omitted. */
  readNetuidMap(
    itemHash: string,
    blockHash: string,
    netuids: number[],
  ): Promise<Map<number, string>>;
  /** One plain (non-map) storage item at the pinned block. */
  readValue(itemHash: string, blockHash: string): Promise<string | null>;
}

/**
 * Build a pinned-storage reader against one RPC endpoint.
 *
 * The request id counter is closure state, deliberately: a module-level
 * counter would be shared across every reader in the isolate (and would need
 * a module-state-registry reset), while an id that restarts per reader is
 * exactly as valid -- JSON-RPC ids only have to be unique within a connection.
 */
export function createSubtensorPinnedStorage(
  options: SubtensorPinnedStorageOptions,
): SubtensorPinnedStorage {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let rpcId = 0;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await doFetch(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: (rpcId += 1),
        method,
        params,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }

  return {
    async pinHead(): Promise<PinnedBlock> {
      const header = await call<{ number: string }>("chain_getHeader", []);
      const blockNumber = Number.parseInt(header.number, 16);
      const blockHash = await call<string>("chain_getBlockHash", [blockNumber]);
      return { blockNumber, blockHash };
    },
    async readNetuidMap(
      itemHash: string,
      blockHash: string,
      netuids: number[],
    ): Promise<Map<number, string>> {
      const keys = netuids.map((netuid) => netuidStorageKey(itemHash, netuid));
      const result = await call<{ changes: [string, string | null][] }[]>(
        "state_queryStorageAt",
        [keys, blockHash],
      );
      const out = new Map<number, string>();
      for (const [key, value] of result[0]?.changes ?? []) {
        if (value === null) continue;
        out.set(netuidFromStorageKey(key), value);
      }
      return out;
    },
    readValue(itemHash: string, blockHash: string): Promise<string | null> {
      return call<string | null>("state_getStorage", [
        `0x${SUBTENSOR_PALLET_PREFIX}${itemHash}`,
        blockHash,
      ]);
    },
  };
}
