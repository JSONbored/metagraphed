// Chain head poller — the firehose's ingest source after the box (#204).
//
// The retired box-side relay forwarded Postgres NOTIFY payloads produced by
// indexer-rs; with the box gone the DO polls the public archive endpoint
// itself. ONLY the `blocks` lane: extrinsics/chain_events/account_events need
// SCALE decoding against runtime metadata, which is the Containers indexer's
// job (#209) — a Worker faking those lanes from undecoded bytes would serve
// wrong data, and serving a quarter of the stream honestly beats serving four
// lanes wrongly.
//
// Pure functions here; the DO owns storage/broadcast (chain-firehose-hub.ts).
// Every RPC is plain HTTP JSON-RPC against CHAIN_HEAD_RPC_URL — the same
// public endpoint everything else already reads (live-verified for months).

import { z } from "zod";
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";
import { DEFAULT_SS58_PREFIX, encodeAccountId32 } from "./ss58.ts";

/**
 * The firehose `blocks` payload this module produces.
 *
 * A SCHEMA, with the type inferred from it (`z.infer`), so the shape is stated
 * once. A hand-written `interface` beside a validator is two things to keep in
 * step, and the one that drifts is always the validator.
 *
 * Scalar fields only, per the ingest validator's rules
 * (validateSingleChainFirehoseIngestPayload) -- nested JSON is rejected there,
 * so it must not be constructible here.
 */
export const HeadBlockSchema = z.object({
  table: z.literal("blocks"),
  block_number: z.int().min(0),
  block_hash: z.string(),
  parent_hash: z.string(),
  extrinsic_count: z.int().min(0),
  /**
   * The block's event count, or null when it could not be read.
   *
   * Nullable, never defaulted: a count we do not have is not a count of none.
   * See migrations/d1/0016_blocks_head_event_count.sql.
   */
  event_count: z.int().min(0).nullable(),
  /**
   * The SS58 address that produced this block, or null when it could not be
   * derived.
   *
   * Nullable, never defaulted: an author we do not have is not a placeholder
   * address. See migrations/d1/0017_blocks_head_author.sql.
   */
  author: z.string().nullable(),
  observed_at: z.int(),
});
export type HeadBlock = z.infer<typeof HeadBlockSchema>;

/**
 * What `chain_getBlock` must return for us to trust it.
 *
 * The RPC is untrusted external input reached over the network, and it was
 * previously read through a bare `as` cast -- which types the access without
 * checking a byte of it, so a malformed or truncated response produced a block
 * row with a silently wrong extrinsic count rather than an error. Deliberately
 * loose about fields we do not read; strict about the two we do.
 */
const BlockBodySchema = z.object({
  block: z.object({
    header: z.object({
      parentHash: z.string(),
      /**
       * The header's digest logs, where Aura records the slot this block was
       * produced in. Optional and loose on purpose, per this schema's rule: a
       * header without decodable logs must still yield a block row (with a
       * null author), not a refusal.
       */
      digest: z.object({ logs: z.array(z.unknown()) }).optional(),
    }),
    extrinsics: z.array(z.unknown()),
  }),
});

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as RpcResponse;
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export function hexToNumber(hex: unknown): number {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`not a hex quantity: ${String(hex)}`);
  }
  return Number.parseInt(hex, 16);
}

/** The chain's current head number, from one cheap header read. */
export async function fetchHeadNumber(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const header = (await rpc(url, "chain_getHeader", [], fetchImpl)) as {
    number?: unknown;
  };
  return hexToNumber(header?.number);
}

/**
 * Storage key for `System.Events`: twox128("System") ++ twox128("Events").
 *
 * DERIVED, not hardcoded. The pallet and item names are the only inputs a
 * human should ever have to read here; the hash is computed by the same
 * `storageMapPrefix` every other storage reader in this codebase uses
 * (src/twox-storage-key.ts), so this key cannot drift from the rest of the
 * repo and cannot be mistyped into something that silently reads the wrong
 * slot. tests/twox-storage-key.test.ts already proves that derivation against
 * the official xxHash vectors and a known-good chain key.
 *
 * Metadata-independent by construction: both halves hash literal names, so the
 * key is identical on every Substrate runtime and survives a runtime upgrade.
 * That is what makes reading it legal for this module, which must never
 * pretend to decode what only the indexer can.
 */
export const SYSTEM_EVENTS_STORAGE_KEY = bytesToHex(
  storageMapPrefix("System", "Events"),
);

/**
 * Storage key for `Aura.Authorities`: twox128("Aura") ++ twox128("Authorities").
 *
 * Derived for the same reasons as SYSTEM_EVENTS_STORAGE_KEY above, and legal
 * for this module on the same grounds: hashing two literal names needs no
 * runtime metadata, and the `Vec<[u8; 32]>` it returns is read by length and
 * offset rather than decoded against a type registry.
 */
export const AURA_AUTHORITIES_KEY = bytesToHex(
  storageMapPrefix("Aura", "Authorities"),
);

/**
 * The item count of a SCALE-encoded `Vec<T>`, read from its compact length
 * prefix WITHOUT decoding a single item.
 *
 * This is what lets the poller report an event count while honouring this
 * module's rule that it never fakes decoded data: the prefix is unambiguous
 * SCALE and metadata-independent, so the COUNT is knowable even though the
 * event CONTENTS are not. Verified against the live archive endpoint at blocks
 * 8,771,446 / 8,771,000 / 8,771,459 -> 320 / 268 / 256, matching
 * chain_detail_blocks and /chain-events exactly.
 *
 * Compact encoding (SCALE spec), by the low two bits of the first byte:
 *   00 single-byte  value = b0 >> 2                       (0..63)
 *   01 two-byte     value = u16le >> 2                    (0..2^14-1)
 *   10 four-byte    value = u32le >> 2                    (0..2^30-1)
 *   11 big-integer  (b0 >> 2) + 4 following LE bytes
 *
 * Returns null rather than throwing on anything malformed or truncated: the
 * caller treats an unreadable count as unknown, which is already a state the
 * schema and the UI handle.
 */
export function scaleCompactLength(hex: unknown): number | null {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(hex))
    return null;
  const bytes = hex.slice(2);
  const at = (i: number) => Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  if (bytes.length < 2) return null;
  const b0 = at(0);
  const mode = b0 & 0b11;
  if (mode === 0b00) return b0 >> 2;
  if (mode === 0b01) {
    if (bytes.length < 4) return null;
    return ((at(1) << 8) | b0) >>> 2;
  }
  if (mode === 0b10) {
    if (bytes.length < 8) return null;
    return (((at(3) << 24) | (at(2) << 16) | (at(1) << 8) | b0) >>> 0) >>> 2;
  }
  // 0b11: the next (b0 >> 2) + 4 bytes are a little-endian integer. An event
  // count needs nowhere near 2^30, so this branch exists for completeness --
  // and is capped at Number.MAX_SAFE_INTEGER rather than trusted blindly.
  const len = (b0 >> 2) + 4;
  if (bytes.length < (len + 1) * 2) return null;
  let n = 0;
  for (let i = len; i >= 1; i--) {
    n = n * 256 + at(i);
    if (!Number.isSafeInteger(n)) return null;
  }
  return n;
}

/**
 * How many events one block emitted, or null when that cannot be read.
 *
 * One `state_getStorage` against `System.Events` at this block's hash. The
 * whole blob comes back (11-17 KB in practice) to read the 1-4 byte prefix --
 * there is no JSON-RPC way to ask for a byte range, and `state_getStorageSize`
 * answers in bytes, not items. That cost is the reason the caller gates this
 * behind a kill switch.
 */
export async function fetchEventCountAt(
  url: string,
  blockHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const raw = await rpc(
      url,
      "state_getStorage",
      [SYSTEM_EVENTS_STORAGE_KEY, blockHash],
      fetchImpl,
    );
    // A block with no events at all stores nothing under the key. That is a
    // real, readable zero -- distinct from the null an unreadable RPC yields.
    if (raw === null || raw === undefined) return 0;
    return scaleCompactLength(raw);
  } catch {
    // Fail SOFT: the block row matters, its count does not. Losing the height
    // because a storage read failed would be the worse trade.
    return null;
  }
}

// How many bytes the SCALE compact integer at the front of `hex` occupies.
// scaleCompactLength reads the VALUE; a payload that follows the prefix also
// needs to know where it ends. Mirrors that function's mode table exactly.
export function scaleCompactPrefixBytes(hex: string): number | null {
  if (hex.length < 2) return null;
  const b0 = Number.parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(b0)) return null;
  const mode = b0 & 0b11;
  if (mode === 0b00) return 1;
  if (mode === 0b01) return 2;
  if (mode === 0b10) return 4;
  return (b0 >> 2) + 5;
}

/** Aura's digest engine id, ASCII "aura" — the four bytes after the log tag. */
const AURA_ENGINE_ID = "61757261";
/** `DigestItem::PreRuntime` — SCALE variant index 6. */
const PRE_RUNTIME_TAG = "06";

/**
 * The Aura slot this block was produced in, from the header's own PreRuntime
 * digest log, or null when the header carries no readable Aura log.
 *
 * Costs no RPC: `chain_getBlock` already returned this header. Layout is
 * `0x06` (PreRuntime) ++ 4-byte engine id ++ a compact-length-prefixed payload
 * whose first 8 bytes are the slot as a little-endian u64.
 *
 * Returns a bigint, not a number: a slot is a u64, and the modulo that selects
 * the authority has to be exact. Reducing it through a double would start
 * mis-attributing blocks once the slot passes 2^53 rather than failing loudly.
 */
export function auraSlotFromDigest(logs: unknown): bigint | null {
  if (!Array.isArray(logs)) return null;
  for (const log of logs) {
    if (typeof log !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(log)) continue;
    const body = log.slice(2);
    if (body.slice(0, 2) !== PRE_RUNTIME_TAG) continue;
    if (body.slice(2, 10).toLowerCase() !== AURA_ENGINE_ID) continue;
    const payload = body.slice(10);
    const prefix = scaleCompactPrefixBytes(payload);
    if (prefix === null) return null;
    const slotHex = payload.slice(prefix * 2, prefix * 2 + 16);
    if (slotHex.length !== 16) return null;
    // Little-endian u64: walk the byte pairs back to front.
    let be = "";
    for (let i = 0; i < 8; i += 1) be = slotHex.slice(i * 2, i * 2 + 2) + be;
    if (!/^[0-9a-fA-F]{16}$/.test(be)) return null;
    return BigInt(`0x${be}`);
  }
  return null;
}

/**
 * The producer of a block, given the SCALE-encoded `Aura.Authorities` value
 * and that block's slot: `authorities[slot % authorities.length]`, SS58.
 *
 * The stored value is a `Vec<AuthorityId>` — a compact length followed by that
 * many 32-byte sr25519 public keys. Null on anything malformed rather than a
 * guess, because a wrong author is worse than an absent one.
 */
export function authorFromAuthorities(
  authoritiesHex: unknown,
  slot: bigint | null,
): string | null {
  if (slot === null) return null;
  if (
    typeof authoritiesHex !== "string" ||
    !/^0x([0-9a-fA-F]{2})*$/.test(authoritiesHex)
  ) {
    return null;
  }
  const body = authoritiesHex.slice(2);
  const count = scaleCompactLength(authoritiesHex);
  const prefix = scaleCompactPrefixBytes(body);
  if (count === null || prefix === null || count <= 0) return null;
  // Refuse a truncated set: picking from a short read would silently attribute
  // the block to whichever key happened to survive.
  if (body.length < (prefix + count * 32) * 2) return null;
  const index = Number(slot % BigInt(count));
  const start = (prefix + index * 32) * 2;
  const key = body.slice(start, start + 64);
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 1) {
    bytes.push(Number.parseInt(key.slice(i * 2, i * 2 + 2), 16));
  }
  return encodeAccountId32(bytes, DEFAULT_SS58_PREFIX);
}

/**
 * This block's author, or null when it cannot be derived.
 *
 * One extra `state_getStorage`, and fail-SOFT for the same reason
 * fetchEventCountAt is: the block row matters, its author does not. The
 * authority set is read at this block's hash rather than at head, so a set
 * rotation between the poll and the read cannot mis-attribute the block.
 */
async function fetchAuthorAt(
  url: string,
  hash: string,
  logs: unknown,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const slot = auraSlotFromDigest(logs);
  if (slot === null) return null;
  try {
    const raw = await rpc(
      url,
      "state_getStorage",
      [AURA_AUTHORITIES_KEY, hash],
      fetchImpl,
    );
    return authorFromAuthorities(raw, slot);
  } catch {
    return null;
  }
}

/**
 * One finalized-ish block at an exact height, as a firehose `blocks` payload.
 * Three reads: hash at height, header, body (for the extrinsic count the UI's
 * block rail renders). Scalar fields only, per the ingest validator's rules.
 */
export async function fetchBlockAt(
  url: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  /**
   * Whether to spend one extra `state_getStorage` on this block's event count.
   * Off by default so every existing caller (and every test) keeps its exact
   * request count; the head poller opts in via CHAIN_HEAD_EVENT_COUNT_ENABLED.
   */
  withEventCount = false,
  /**
   * Whether to spend one extra `state_getStorage` on this block's author.
   * Off by default for the same reason as withEventCount: every existing
   * caller keeps its exact request count. The head poller opts in via
   * CHAIN_HEAD_AUTHOR_ENABLED.
   */
  withAuthor = false,
): Promise<HeadBlock> {
  const hash = (await rpc(
    url,
    "chain_getBlockHash",
    [number],
    fetchImpl,
  )) as string;
  if (typeof hash !== "string" || !hash.startsWith("0x")) {
    throw new Error(`no hash at height ${number}`);
  }
  const parsed = BlockBodySchema.safeParse(
    await rpc(url, "chain_getBlock", [hash], fetchImpl),
  );
  if (!parsed.success) {
    // Refuse rather than emit a block with an invented extrinsic count. The
    // caller's alarm re-arms, so a malformed response costs one tick, not the
    // lane -- and the height is retried on the next.
    throw new Error(`chain_getBlock: malformed response at height ${number}`);
  }
  const { header, extrinsics } = parsed.data.block;
  return {
    table: "blocks",
    block_number: number,
    block_hash: hash,
    parent_hash: header.parentHash,
    extrinsic_count: extrinsics.length,
    // Awaited, not raced with the reads above: fetchEventCountAt needs the hash
    // those produced. It never throws (see its own catch), so a storage-read
    // failure degrades the count to null and leaves the block intact.
    event_count: withEventCount
      ? await fetchEventCountAt(url, hash, fetchImpl)
      : null,
    // Same posture as event_count: awaited (it needs the hash above), never
    // throws, and degrades to null rather than costing the height.
    author: withAuthor
      ? await fetchAuthorAt(url, hash, header.digest?.logs, fetchImpl)
      : null,
    observed_at: now(),
  };
}

/**
 * Which heights to emit this tick. Bounded on purpose: after an outage the
 * poller catches up at most `maxCatchUp` blocks per tick rather than hammering
 * the endpoint with an unbounded burst — deeper history is the backfill's job,
 * not the live poller's. `lastSeen = null` (first ever tick) starts AT the
 * head, not behind it: the poller's contract is "live from now", and the gap
 * behind it belongs to the reconciling backfill.
 */
export function heightsToEmit(
  lastSeen: number | null,
  head: number,
  maxCatchUp = 25,
): number[] {
  if (!Number.isInteger(head) || head < 0) return [];
  if (lastSeen === null || lastSeen >= head) {
    return lastSeen === null ? [head] : [];
  }
  const start = Math.max(lastSeen + 1, head - maxCatchUp + 1);
  const out: number[] = [];
  for (let n = start; n <= head; n += 1) out.push(n);
  return out;
}
