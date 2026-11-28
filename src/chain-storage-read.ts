// Reading runtime storage at one finalized block: the SCALE reader, the
// bounded storage and key reads, and the key helpers every storage capture
// shares (src/chain-gamma-capture.ts, src/subnet-emission-capture.ts).
//
// Every read is bounds-checked and every value must be consumed whole, so a
// runtime that moved a shape is read as unknown, never as a wrong number.

import { encodeAccountId32 } from "./ss58.ts";
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";

/** One JSON-RPC call: the method and its params, answering the result. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/** One JSON-RPC batch, sent as ONE HTTP request: each call's result, aligned
 * to `calls`, or a throw when the request or any call in it failed. */
export type RpcBatch = (
  calls: readonly { method: string; params: unknown[] }[],
) => Promise<unknown[]>;

/** The time one RPC call may take before the capture gives up on it. */
export const RPC_TIMEOUT_MS = 15_000;
const KEYS_PER_PAGE = 1_000;
/** An enumerated map larger than this is read as incomplete, never truncated
 * silently: 20,000 keys is far past mainnet's hundreds per map. */
const MAX_PAGES = 20;
const VALUES_PER_CALL = 500;

export function hexBytes(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex))
    throw new TypeError("storage value is not hex");
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return bytes;
}

/** A SCALE reader over one storage value: every read is bounds-checked, and a
 * value with bytes left over is refused, so a runtime that moved a shape is
 * read as unknown rather than as a wrong number. */
export class Scale {
  private offset = 0;
  // A plain field, not a parameter property: the native build and its tests
  // run this module through Node's strip-only TypeScript, which has none.
  private readonly buffer: Uint8Array;
  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }
  private take(n: number): Uint8Array {
    if (this.offset + n > this.buffer.length)
      throw new RangeError("SCALE value is truncated");
    const out = this.buffer.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  /** `n` raw bytes: a fixed-size array, or a length the value itself states. */
  fixed(n: number): Uint8Array {
    return this.take(n);
  }
  bool(): boolean {
    const [byte] = this.take(1);
    if (byte > 1) throw new RangeError("SCALE bool is out of range");
    return byte === 1;
  }
  uint(width: number): bigint {
    const bytes = this.take(width);
    let value = 0n;
    for (let i = width - 1; i >= 0; i -= 1)
      value = (value << 8n) | BigInt(bytes[i]);
    return value;
  }
  compact(): bigint {
    const [first] = this.take(1);
    switch (first & 3) {
      case 0:
        return BigInt(first >> 2);
      case 1:
        return (BigInt(first) | (this.uint(1) << 8n)) >> 2n;
      case 2:
        return (BigInt(first) | (this.uint(3) << 8n)) >> 2n;
      default:
        return this.uint((first >> 2) + 4);
    }
  }
  bytes(): Uint8Array {
    const length = this.compact();
    if (length > 65_536n) throw new RangeError("SCALE bytes are too long");
    return this.take(Number(length));
  }
  /** A sequence's length, refused above the runtime's own bound for it. */
  length(max: number): number {
    const length = this.compact();
    if (length > BigInt(max))
      throw new RangeError("SCALE sequence is longer than its bound");
    return Number(length);
  }
  /** An enum's variant index, refused past the variants the runtime has. */
  variant(count: number): number {
    const [index] = this.take(1);
    if (index >= count) throw new RangeError("SCALE enum is out of range");
    return index;
  }
  account(): string {
    // Thirty-two bytes always encode: encodeAccountId32 refuses only a key of
    // another length, which take(32) cannot return.
    return encodeAccountId32(this.take(32))!;
  }
  option<T>(read: () => T): T | null {
    const [tag] = this.take(1);
    if (tag === 0) return null;
    if (tag === 1) return read();
    throw new RangeError("SCALE option tag is out of range");
  }
  done(): void {
    if (this.offset !== this.buffer.length)
      throw new RangeError("SCALE value has trailing bytes");
  }
}

/** Read one whole storage value: a value with bytes left over is refused. */
export function decode<T>(hex: string, read: (scale: Scale) => T): T {
  const scale = new Scale(hexBytes(hex));
  const value = read(scale);
  scale.done();
  return value;
}

/** The finalized head's hash and number: every value of one capture is read
 * at this one block, so they all describe the same chain state. */
export async function finalizedAt(
  rpc: Rpc,
): Promise<{ at: string; block: number }> {
  const at = await rpc("chain_getFinalizedHead", []);
  if (typeof at !== "string") throw new Error("no finalized head");
  const header = (await rpc("chain_getHeader", [at])) as {
    number?: unknown;
  } | null;
  const block =
    typeof header?.number === "string" ? parseInt(header.number, 16) : NaN;
  if (!Number.isSafeInteger(block) || block < 0)
    throw new Error("finalized header has no number");
  return { at, block };
}

/** `items` split into runs of at most `size`. */
function runsOf<T>(items: readonly T[], size: number): (readonly T[])[] {
  const runs: (readonly T[])[] = [];
  for (let i = 0; i < items.length; i += size)
    runs.push(items.slice(i, i + size));
  return runs;
}

/** One `state_queryStorageAt` answer's changes, into `values`. */
function absorbChanges(values: Map<string, string>, result: unknown): void {
  const changes = Array.isArray(result)
    ? (result[0] as { changes?: unknown } | undefined)?.changes
    : null;
  if (!Array.isArray(changes))
    throw new Error("state_queryStorageAt answered no changes");
  for (const change of changes) {
    if (
      Array.isArray(change) &&
      typeof change[0] === "string" &&
      typeof change[1] === "string"
    )
      values.set(change[0].toLowerCase(), change[1]);
  }
}

/** `read` over every unit, at most `concurrency` at once. The first failure
 * fails the whole read, and the other readers start no more units. */
async function readEach<T>(
  units: readonly T[],
  concurrency: number,
  read: (unit: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const reader = async () => {
    while (next < units.length) {
      const unit = units[next];
      next += 1;
      try {
        await read(unit);
      } catch (error) {
        next = units.length;
        throw error;
      }
    }
  };
  const readers = Math.max(1, Math.min(concurrency, units.length));
  await Promise.all(Array.from({ length: readers }, reader));
}

/** The values of `keys` at `at`, keyed in lower case. A key the block does not
 * hold is absent from the map: its runtime default, never a value. At most
 * `concurrency` calls are in flight: one unless a large read states more. */
export async function storageAt(
  rpc: Rpc,
  keys: readonly string[],
  at: string,
  concurrency = 1,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  await readEach(runsOf(keys, VALUES_PER_CALL), concurrency, async (chunk) =>
    absorbChanges(values, await rpc("state_queryStorageAt", [chunk, at])),
  );
  return values;
}

/**
 * The values of `keys` at `at`, as `storageAt` reads them, with `perRequest`
 * of its calls sent as one JSON-RPC batch and at most `concurrency` such
 * requests in flight.
 *
 * For a read large enough to meet an endpoint's limit: the public entrypoints
 * limit a client by HTTP request, not by call (src/raw-chain-capture.ts
 * measured it), so a batch of ten spends a tenth of the allowance. Every call
 * of a batch must answer: one failed call fails the read whole.
 */
export async function storageAtBatched(
  batch: RpcBatch,
  keys: readonly string[],
  at: string,
  { perRequest, concurrency = 1 }: { perRequest: number; concurrency?: number },
): Promise<Map<string, string>> {
  if (!Number.isSafeInteger(perRequest) || perRequest < 1)
    throw new RangeError(
      "a batched storage read needs at least one call per request",
    );
  const values = new Map<string, string>();
  const requests = runsOf(runsOf(keys, VALUES_PER_CALL), perRequest);
  await readEach(requests, concurrency, async (chunks) => {
    const results = await batch(
      chunks.map((chunk) => ({
        method: "state_queryStorageAt",
        params: [chunk, at],
      })),
    );
    if (results.length !== chunks.length)
      throw new Error("state_queryStorageAt batch answered the wrong count");
    for (const result of results) absorbChanges(values, result);
  });
  return values;
}

/** Every key of one map at `at`, or null when it is larger than the bound
 * (`maxPages` pages of 1,000; a map known to be large states its own). */
export async function enumerate(
  rpc: Rpc,
  itemPrefix: string,
  at: string,
  maxPages = MAX_PAGES,
): Promise<string[] | null> {
  const keys: string[] = [];
  let start = itemPrefix;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await rpc("state_getKeysPaged", [
      itemPrefix,
      KEYS_PER_PAGE,
      start,
      at,
    ]);
    if (!Array.isArray(result) || !result.every((k) => typeof k === "string"))
      throw new Error("state_getKeysPaged answered no keys");
    keys.push(...(result as string[]).map((k) => k.toLowerCase()));
    if (result.length < KEYS_PER_PAGE) return keys;
    start = result[result.length - 1] as string;
  }
  return null;
}

/** A value decoded, or null when absent; a value that does not decode is
 * counted in `miss` and read as unknown. */
export function decoded<T>(
  value: string | undefined,
  read: (hex: string) => T,
  miss: { undecoded: number },
): T | null {
  if (value === undefined) return null;
  try {
    return read(value);
  } catch {
    miss.undecoded += 1;
    return null;
  }
}

/** netuid as the 2-byte little-endian Identity key suffix. */
export function netuidSuffix(netuid: number): string {
  return (
    (netuid & 0xff).toString(16).padStart(2, "0") +
    (netuid >> 8).toString(16).padStart(2, "0")
  );
}

/** The netuid whose 2-byte little-endian hex starts at `at` in `hex`. */
export function netuidAt(hex: string, at: number): number {
  return (
    parseInt(hex.slice(at, at + 2), 16) +
    parseInt(hex.slice(at + 2, at + 4), 16) * 256
  );
}

const SUBNET_STATE = bytesToHex(
  storageMapPrefix("SubtensorModule", "SubnetState"),
);

/** Every subnet the chain holds at `at`, ascending: the netuids SubnetState
 * lists (an OptionQuery, so absence is no subnet). Throws when the listing is
 * past its bound or holds a key that names no netuid, because a partial or
 * unreadable listing cannot say which subnets are gone. */
export async function subnetNetuids(rpc: Rpc, at: string): Promise<number[]> {
  const keys = await enumerate(rpc, SUBNET_STATE, at);
  if (keys === null)
    throw new Error("SubnetState is larger than its read bound");
  return keys
    .map((key) => {
      const suffix = key.slice(SUBNET_STATE.length);
      if (!/^[0-9a-f]{4}$/.test(suffix))
        throw new Error("SubnetState holds a key that names no netuid");
      return netuidAt(suffix, 0);
    })
    .sort((a, b) => a - b);
}
