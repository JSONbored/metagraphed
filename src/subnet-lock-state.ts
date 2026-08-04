// The subnet-ownership-contest ("conviction") leaderboard, read LIVE from
// chain storage.
//
// `/api/v1/subnets/{netuid}/conviction` was the last route in the API still
// answering `source: data-worker-unavailable`. Its whole capture lane died with
// Postgres: `handleSubnetLocksSync` is a 503 stub since #9193, its producer was
// the `fetch-subnet-locks.py` box timer, and no `subnet_locks` table exists in
// D1 or in the lakehouse.
//
// NO CAPTURE TIER IS REBUILT, AND THAT IS THE POINT. The obvious fix is a D1
// table + migration + write path + a producer cron. None of it is needed:
// `buildSubnetConviction` already rolls every row forward from its OWN
// `last_update` using the CURRENT UnlockRate/MaturityRate, so a row read
// straight from chain storage and a row read from a snapshot go through
// identical math. The snapshot only ever existed to avoid hitting the chain per
// request -- and the whole network's lock state is 190 entries (measured
// 2026-08-03: OwnerLock 119, DecayingOwnerLock 30, HotkeyLock 22,
// DecayingHotkeyLock 19), so per subnet this is a handful of reads. Same
// posture as /sudo/key and the upgrade radar: live chain state, read at request
// time.
//
// KV-CACHED PER SUBNET, and the reasoning that first said otherwise was wrong.
// The original argument was "the edge cache's short profile already bounds
// finney traffic". It does not: the edge keys on the URL, so 129 subnets are
// 129 independent cache entries, and a crawler or an audit sweep walking them
// issues ~6 RPC calls EACH against the public endpoint with nothing in front.
// Measured after shipping: a sweep across subnets made every netuid answer
// `data-worker-unavailable` -- including ones that had just answered -- while a
// direct RPC from elsewhere stayed healthy in 0.67s, i.e. finney was throttling
// this Worker, not failing. Twenty seconds later it recovered.
//
// So the cache is per-netuid and short (LOCK_STATE_KV_TTL). A board is a smooth
// decay curve, so a minute of staleness changes nothing a caller can perceive,
// and `queried_at_block` keeps reporting the block it was actually computed at
// rather than pretending to be current.
//
// Declines are cached too, for much longer than zero but much shorter than a
// success (LOCK_STATE_NEGATIVE_KV_TTL). Not caching them at all is what turns
// one throttled burst into a sustained one: every retry adds load to the
// endpoint that is already refusing.
//
// STORAGE LAYOUT, all verified against finney rather than inferred:
//
//   OwnerLock / DecayingOwnerLock   Map netuid -> LockState
//     key = prefix(32) ++ netuid as a BARE little-endian u16 (Identity hasher,
//     no hash at all -- netuid 1 is the suffix `0100`).
//
//   HotkeyLock / DecayingHotkeyLock DMap (netuid, hotkey) -> LockState
//     key = prefix(32) ++ netuid LE u16 ++ blake2_128(account) ++ account(32).
//     The second hasher is Blake2_128Concat (16-byte hash), NOT Twox64Concat --
//     the suffix is 50 bytes, and assuming an 8-byte hash silently misreads the
//     hotkey by 8 bytes. No key is ever CONSTRUCTED from an account here --
//     the map is enumerated by its netuid prefix and the hotkey recovered from
//     each key's trailing 32 bytes, so the hasher only has to be known, not
//     reimplemented.
//
//   LockState                       32 bytes:
//     [0..8)   locked_mass  LE u64 (rao)
//     [8..24)  conviction   LE u128, U64F64 raw bits
//     [24..32) last_update  LE u64 block
//
// The field order is not a guess that happens to fit: on a live sample the
// U64F64's INTEGER part equalled `locked_mass` exactly with a zero fraction,
// which only holds if both are being read from the right offsets.
import { encodeAccountId32 } from "./ss58.ts";
import { buildSubnetConviction } from "./subnet-conviction.ts";
import {
  storageMapPrefix,
  u16LeBytes,
  bytesToHex,
} from "./twox-storage-key.ts";
import { rpcUrlForNetwork } from "./chain-network.ts";

export const SUBNET_CONVICTION_RPC_TIMEOUT_MS = 5000;

/** Seconds a computed board stays cached. ~5 blocks: the decay is smooth, so
 * this is imperceptible, and it collapses a burst across one subnet to a single
 * pass of RPC calls. */
export const LOCK_STATE_KV_TTL = 60;
/** Seconds a DECLINE stays cached. Short enough that a blip clears quickly,
 * long enough that a throttled endpoint is not retried on every request. */
export const LOCK_STATE_NEGATIVE_KV_TTL = 10;
const LOCK_STATE_KV_PREFIX = "subnet-conviction:v1";

/**
 * `UnlockRate`'s on-chain default, applied when the StorageValue is absent.
 *
 * DECLARED, not inferred from the absence. A missing StorageValue means "the
 * runtime's declared default", and reading it as 0 would make `exp_decay`
 * treat every lock as instantaneously decayed -- a whole subnet's leaderboard
 * silently collapsing to zero. `MaturityRate` shares the same default but is
 * currently SET on mainnet (311,622 live vs this 934,866), which is exactly why
 * both are read rather than assumed equal.
 */
export const LOCK_RATE_DEFAULT = 934_866;

/** One decoded `LockState`, in the row shape `buildSubnetConviction` reads.
 * The index signature is what the builder's own `Row` alias expects. */
interface LockRow extends Record<string, unknown> {
  hotkey: string;
  is_owner: boolean;
  is_perpetual: boolean;
  locked_mass: number;
  /** u128 decimal STRING -- the builder parses it in BigInt space, so handing
   * it a Number would round away the fraction before it is ever used. */
  conviction_bits: string;
  last_update: number;
}

/** The four lock maps, and what each one's rows mean. */
const LOCK_MAPS = [
  { item: "OwnerLock", isOwner: true, isPerpetual: true },
  { item: "DecayingOwnerLock", isOwner: true, isPerpetual: false },
  { item: "HotkeyLock", isOwner: false, isPerpetual: true },
  { item: "DecayingHotkeyLock", isOwner: false, isPerpetual: false },
] as const;

/** A subnet having more locked hotkeys than it has neurons would be
 * extraordinary; this bounds a pathological subnet while staying a single
 * page in every realistic case (22 exist network-wide today). */
const MAX_HOTKEY_LOCK_KEYS = 512;

export interface ChainRpc {
  (method: string, params: unknown[]): Promise<unknown>;
}

/** Injectable for tests; the default hits finney and never throws. */
export const defaultChainRpc: ChainRpc = async (method, params) => {
  try {
    const resp = await fetch(rpcUrlForNetwork(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SUBNET_CONVICTION_RPC_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!resp.ok) return undefined;
    const body: { result?: unknown } = await resp.json();
    return body?.result;
  } catch {
    return undefined;
  }
};

function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex))
    return null;
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function readUIntLE(bytes: Uint8Array, offset: number, width: number): bigint {
  let value = 0n;
  for (let i = width - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]!);
  }
  return value;
}

/** `prefix ++ netuid` — the Identity-hashed single-key form all four
 * netuid-keyed lock items use. */
function netuidKey(item: string, netuid: number): string {
  const prefix = storageMapPrefix("SubtensorModule", item);
  const key = new Uint8Array(prefix.length + 2);
  key.set(prefix, 0);
  key.set(u16LeBytes(netuid), prefix.length);
  return bytesToHex(key);
}

/**
 * A 32-byte `LockState` hex blob -> its three fields, or null when the blob is
 * not that shape.
 *
 * A short or absent value is null rather than a zeroed row: a lock that cannot
 * be read is not a lock worth zero, and publishing one would understate the
 * subnet's total conviction with no way for a caller to notice.
 */
export function decodeLockState(
  raw: unknown,
): { lockedMass: bigint; convictionBits: bigint; lastUpdate: number } | null {
  const bytes = hexToBytes(raw);
  if (bytes === null || bytes.length !== 32) return null;
  return {
    lockedMass: readUIntLE(bytes, 0, 8),
    convictionBits: readUIntLE(bytes, 8, 16),
    lastUpdate: Number(readUIntLE(bytes, 24, 8)),
  };
}

/** The trailing AccountId32 of a `(netuid, hotkey)` lock key, as SS58. */
function hotkeyFromLockKey(key: unknown): string | null {
  const bytes = hexToBytes(key);
  if (bytes === null || bytes.length < 32) return null;
  return encodeAccountId32(bytes.slice(bytes.length - 32));
}

/** A StorageValue<u64> rate, or its declared default when unset. */
function rateOrDefault(raw: unknown): number | null {
  if (raw == null) return LOCK_RATE_DEFAULT;
  const bytes = hexToBytes(raw);
  if (bytes === null || bytes.length !== 8) return null;
  return Number(readUIntLE(bytes, 0, 8));
}

/**
 * One subnet's conviction leaderboard, read live from chain storage and rolled
 * forward -- or null when the chain cannot be read.
 *
 * Declining rather than returning an empty leaderboard is the point: a subnet
 * with no locks and an unreachable RPC are opposite answers, and this route's
 * existing degraded payload already says "we could not look". A subnet that
 * genuinely holds no locks still publishes a MEASURED empty board, with real
 * rates attached.
 */
export async function loadSubnetConvictionChainTier(
  netuid: number,
  {
    rpc = defaultChainRpc,
    kv,
  }: {
    rpc?: ChainRpc;
    /** METAGRAPH_CONTROL, when the caller has an env to take it from. */
    kv?: KvLike | null;
  } = {},
): Promise<ReturnType<typeof buildSubnetConviction> | null> {
  // Not cached: this fires before any RPC call, so there is no load to
  // suppress, and caching per bogus netuid would just fill KV with junk keys.
  if (!Number.isSafeInteger(netuid) || netuid < 0 || netuid > 65_535) {
    return null;
  }

  const cacheKey = `${LOCK_STATE_KV_PREFIX}:${netuid}`;
  if (kv?.get) {
    try {
      const cached = (await kv.get(cacheKey, { type: "json" })) as {
        board: ReturnType<typeof buildSubnetConviction> | null;
      } | null;
      // A cached DECLINE is stored as an explicit null board, so it is
      // distinguishable from a cache miss and actually suppresses the retry.
      if (cached) return cached.board;
    } catch {
      // A KV read failure is non-fatal -- fall through to the live read.
    }
  }

  const [header, unlockRaw, maturityRaw, ownerHotkeyRaw] = await Promise.all([
    rpc("chain_getHeader", []),
    rpc("state_getStorage", [
      bytesToHex(storageMapPrefix("SubtensorModule", "UnlockRate")),
    ]),
    rpc("state_getStorage", [
      bytesToHex(storageMapPrefix("SubtensorModule", "MaturityRate")),
    ]),
    rpc("state_getStorage", [netuidKey("SubnetOwnerHotkey", netuid)]),
  ]);

  // `now` is the head block: the roll-forward's whole input is
  // (now - last_update), so a missing head makes every row's decay unknowable.
  const headNumber = (header as { number?: unknown } | undefined)?.number;
  const now =
    typeof headNumber === "string"
      ? Number.parseInt(headNumber, 16)
      : Number.NaN;
  if (!Number.isSafeInteger(now) || now <= 0)
    return await remember(kv, cacheKey, null);

  const unlockRate = rateOrDefault(unlockRaw);
  const maturityRate = rateOrDefault(maturityRaw);
  if (unlockRate === null || maturityRate === null)
    return await remember(kv, cacheKey, null);

  const ownerHotkey =
    ownerHotkeyRaw == null ? null : hotkeyFromLockKey(ownerHotkeyRaw);

  const rows: LockRow[] = [];
  for (const map of LOCK_MAPS) {
    const collected = map.isOwner
      ? await readOwnerLock(rpc, map.item, netuid, ownerHotkey)
      : await readHotkeyLocks(rpc, map.item, netuid);
    if (collected === null) return await remember(kv, cacheKey, null);
    for (const row of collected) {
      rows.push({
        ...row,
        is_owner: map.isOwner,
        is_perpetual: map.isPerpetual,
      });
    }
  }

  return await remember(
    kv,
    cacheKey,
    buildSubnetConviction(rows, netuid, { now, unlockRate, maturityRate }),
  );
}

/** The minimal KV surface this module needs -- structural, so tests can hand a
 * plain object. */
export interface KvLike {
  get?: (key: string, opts?: { type: "json" }) => Promise<unknown>;
  put?: (
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ) => Promise<unknown>;
}

/** Cache `board` (including a null decline) and hand it straight back. */
async function remember<T>(
  kv: KvLike | null | undefined,
  cacheKey: string,
  board: T,
): Promise<T> {
  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify({ board }), {
        expirationTtl:
          board === null ? LOCK_STATE_NEGATIVE_KV_TTL : LOCK_STATE_KV_TTL,
      });
    } catch {
      // A KV write failure is non-fatal.
    }
  }
  return board;
}

/** A decoded lock before its map's `is_owner`/`is_perpetual` are attached.
 * Spelled out rather than `Omit<LockRow, …>`, because Omit drops LockRow's
 * index signature and the spread then stops being provably complete. */
interface PartialLockRow {
  hotkey: string;
  locked_mass: number;
  conviction_bits: string;
  last_update: number;
}

/** The subnet-owner aggregate: one key, and the identity comes from
 * `SubnetOwnerHotkey` rather than from the key itself. */
async function readOwnerLock(
  rpc: ChainRpc,
  item: string,
  netuid: number,
  ownerHotkey: string | null,
): Promise<PartialLockRow[] | null> {
  const raw = await rpc("state_getStorage", [netuidKey(item, netuid)]);
  if (raw == null) return [];
  const state = decodeLockState(raw);
  if (state === null) return null;
  // A lock with no resolvable owner cannot be attributed. Declining beats
  // publishing an unattributed row on a leaderboard keyed by hotkey.
  if (ownerHotkey === null) return null;
  return [
    {
      hotkey: ownerHotkey,
      locked_mass: Number(state.lockedMass),
      conviction_bits: state.convictionBits.toString(),
      last_update: state.lastUpdate,
    },
  ];
}

/** The per-hotkey aggregates: enumerate the netuid prefix, then read each. */
async function readHotkeyLocks(
  rpc: ChainRpc,
  item: string,
  netuid: number,
): Promise<PartialLockRow[] | null> {
  const keys = await rpc("state_getKeysPaged", [
    netuidKey(item, netuid),
    MAX_HOTKEY_LOCK_KEYS,
  ]);
  // An RPC miss and an empty prefix are different answers: undefined means the
  // call failed, [] means this subnet has no locks of this kind.
  if (keys === undefined) return null;
  if (!Array.isArray(keys)) return null;

  const values = await Promise.all(
    keys.map((key) => rpc("state_getStorage", [key])),
  );
  const rows: PartialLockRow[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const hotkey = hotkeyFromLockKey(keys[i]);
    const state = decodeLockState(values[i]);
    // The key was enumerated from this very prefix, so a value that will not
    // decode is a real inconsistency, not an absence -- decline rather than
    // drop a row and understate the board.
    if (hotkey === null || state === null) return null;
    rows.push({
      hotkey,
      locked_mass: Number(state.lockedMass),
      conviction_bits: state.convictionBits.toString(),
      last_update: state.lastUpdate,
    });
  }
  return rows;
}
