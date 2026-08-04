// Live Crowdloan-pallet state (#8696): every crowdloan the chain has ever
// opened, with its terms and how much it raised. Live-RPC + KV-cache route,
// same shape as subnet-lease.ts/subnet-burn.ts -- current chain state, not a
// historical event stream.
//
// WHY STORAGE AND NOT THE EXTRINSICS FEED. #8696 originally scoped this as
// "reuse the handleSudo shape", i.e. the extrinsics feed hardcoded to one
// call_module. The census that gated the issue ruled that out for the same
// reason it ruled it out for SafeMode and Scheduler: an extrinsics view
// answers "what was called", and the question here is "what exists". Two
// concrete failures of the feed approach --
//   1. `Crowdloan.Created` is DELIBERATELY excluded from the account_events
//      tier (src/account-events.ts: it declares a cap/end with no tao moved
//      yet, so there is no account amount to curate), so an events-backed
//      view cannot see a crowdloan being created at all.
//   2. `update_cap`/`update_end`/`update_min_contribution` mutate terms after
//      creation, so reconstructing current terms from the feed means replaying
//      every mutation in order and getting it right. The chain already stores
//      the answer.
//
// Storage items (pallets/crowdloan/src/lib.rs), read from live finney runtime
// metadata 2026-08-02 rather than guessed:
//   Crowdloans:      StorageMap<_, Twox64Concat, CrowdloanId(u32), CrowdloanInfo, OptionQuery>
//   NextCrowdloanId: StorageValue<_, u32, ValueQuery>
//
// CrowdloanInfo's #[derive(Encode, Decode)] field order IS its SCALE encoding
// order. Verified byte-exact against live entries 0/2/14 (all 139 bytes):
//   creator: AccountId32 (32) | deposit: u64 (8) | min_contribution: u64 (8)
//   end: u32 (4) | cap: u64 (8) | funds_account: AccountId32 (32)
//   raised: u64 (8) | target_address: Option<AccountId32> (1 [+32])
//   call: Option<Bounded<Call>> (1 [+N]) | finalized: bool (1)
//   contributors_count: u32 (4)
//
// `call` is the one variable-width field and it is an Option<Bounded<Call>>,
// which cannot be decoded without the full runtime type registry -- something
// a Worker does not carry. Every crowdloan on finney today has `call: None`
// (these fund a `target_address` instead), but a Some would push the two
// trailing fields to an offset this module cannot compute forwards. So
// `finalized` and `contributors_count` are read from the TAIL (the last 5
// bytes), which is position-independent, and the `call` Option contributes
// only a boolean `has_dispatch_call`. That keeps a Some-valued `call` a
// degraded-but-correct record rather than a decode failure.
//
// `Contributions` (a Twox64Concat+Identity StorageDoubleMap of per-contributor
// amounts) needs paginated key enumeration rather than a single get and is
// deliberately NOT included here -- exactly the call subnet-lease.ts made for
// SubnetLeaseShares (#6719). `contributors_count` on each record already gives
// the aggregate; the per-contributor breakdown is a future extension.

import { encodeAccountId32 } from "./ss58.ts";
import type { FieldSources } from "./field-provenance.ts";
import {
  bytesToHex,
  storageMapPrefix,
  twox64ConcatU32StorageKey,
} from "./twox-storage-key.ts";
import {
  type ChainNetworkId,
  networkKvKey,
  rpcUrlForNetwork,
} from "./chain-network.ts";

type Row = Record<string, unknown>;

export const CROWDLOANS_KV_TTL = 120; // seconds -- same freshness profile as subnet-lease.ts
export const CROWDLOANS_NEGATIVE_KV_TTL = 10; // seconds
export const CROWDLOANS_RPC_TIMEOUT_MS = 5000;

// A crowdloan id is a u32 on-chain. Anything outside that range can never
// name a record, so it is a client error rather than an empty result.
export const MAX_CROWDLOAN_ID = 0xffffffff;

// Guard on the fan-out. NextCrowdloanId is 15 on finney today and grows by one
// per crowdloan ever created, so this ceiling is ~3 orders of magnitude above
// live -- it exists so a corrupt/absurd NextCrowdloanId read can never turn
// one request into an unbounded batch of storage keys.
export const MAX_CROWDLOANS_FANOUT = 512;

export function isCrowdloanId(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CROWDLOAN_ID
  );
}

interface StorageFetchResult {
  ok: boolean;
  raw: unknown;
}

// One raw state_getStorage read. `ok` is false only on a genuine RPC failure
// (non-2xx / timeout / network error); `raw` is the JSON-RPC result on
// success, which is itself `null` for a genuinely-absent key.
async function fetchStorageRaw(
  storageKey: string,
  timeoutMs: number,
  network?: ChainNetworkId,
): Promise<StorageFetchResult> {
  return rpcCall("state_getStorage", [storageKey], timeoutMs, network);
}

// Batched multi-key read: ONE round trip for every crowdloan record, instead
// of one per id. state_queryStorageAt returns [{ block, changes: [[key,
// value|null], ...] }]; measured ~650ms for 15 keys against finney, versus 15
// sequential reads that would blow through CROWDLOANS_RPC_TIMEOUT_MS.
async function fetchStorageBatch(
  storageKeys: string[],
  timeoutMs: number,
  network?: ChainNetworkId,
): Promise<Map<string, string> | null> {
  const result = await rpcCall(
    "state_queryStorageAt",
    [storageKeys],
    timeoutMs,
    network,
  );
  if (!result.ok || !Array.isArray(result.raw)) return null;
  const first = (result.raw as Row[])[0];
  const changes = first?.changes;
  if (!Array.isArray(changes)) return null;
  const byKey = new Map<string, string>();
  for (const change of changes) {
    if (!Array.isArray(change) || change.length < 2) continue;
    const [key, value] = change as [unknown, unknown];
    if (typeof key === "string" && typeof value === "string") {
      byKey.set(key.toLowerCase(), value);
    }
  }
  return byKey;
}

async function rpcCall(
  method: string,
  params: unknown[],
  timeoutMs: number,
  network?: ChainNetworkId,
): Promise<StorageFetchResult> {
  try {
    const rpcResp = await fetch(rpcUrlForNetwork(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!rpcResp.ok) return { ok: false, raw: undefined };
    const rpcBody = (await rpcResp.json()) as Row;
    return { ok: true, raw: rpcBody?.result };
  } catch {
    return { ok: false, raw: undefined };
  }
}

// "0x"-prefixed even-length hex -> raw bytes. null on anything else.
function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    return null;
  }
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readU64LEBigInt(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

// BigInt rao (u64 @ 1e9 precision) -> TAO display units, split in BigInt space
// first to avoid float precision loss (mirrors subnet-lease.ts's identical
// conversion).
function rawToDisplay(raw: bigint): number {
  return Number(raw / 1_000_000_000n) + Number(raw % 1_000_000_000n) / 1e9;
}

// Fixed-width prefix through `raised`, before the first Option field.
const CROWDLOAN_FIXED_PREFIX_BYTES = 32 + 8 + 8 + 4 + 8 + 32 + 8; // 100
// finalized (1) + contributors_count (4), read from the tail.
const CROWDLOAN_TRAILER_BYTES = 5;

/**
 * Decode one SCALE-encoded `CrowdloanInfo` (see this module's header for the
 * field-order source and why the trailer is read backwards).
 *
 * Returns null on any malformed/too-short input rather than throwing -- a
 * live-RPC route must stay schema-stable against an unexpected chain-side
 * shape.
 */
export function decodeCrowdloan(hex: unknown): Row | null {
  const bytes = hexToBytes(hex);
  // Smallest legal record: fixed prefix + target None (1) + call None (1) +
  // trailer. Anything shorter cannot carry the fields below.
  if (
    !bytes ||
    bytes.length < CROWDLOAN_FIXED_PREFIX_BYTES + 2 + CROWDLOAN_TRAILER_BYTES
  ) {
    return null;
  }

  let offset = 0;
  const creator = encodeAccountId32(bytes.slice(offset, offset + 32));
  offset += 32;
  const depositRao = readU64LEBigInt(bytes, offset);
  offset += 8;
  const minContributionRao = readU64LEBigInt(bytes, offset);
  offset += 8;
  const end = readU32LE(bytes, offset);
  offset += 4;
  const capRao = readU64LEBigInt(bytes, offset);
  offset += 8;
  const fundsAccount = encodeAccountId32(bytes.slice(offset, offset + 32));
  offset += 32;
  const raisedRao = readU64LEBigInt(bytes, offset);
  offset += 8;

  // Option<AccountId32>: 1-byte tag, 32 bytes if Some.
  const targetTag = bytes[offset];
  offset += 1;
  let targetAddress: string | null = null;
  if (targetTag === 1) {
    if (bytes.length < offset + 32 + 1 + CROWDLOAN_TRAILER_BYTES) return null;
    targetAddress = encodeAccountId32(bytes.slice(offset, offset + 32));
    offset += 32;
  } else if (targetTag !== 0) {
    return null; // malformed Option tag
  }

  // Option<Bounded<Call>>: only its presence is decodable here (header).
  const callTag = bytes[offset];
  if (callTag !== 0 && callTag !== 1) return null;
  const hasDispatchCall = callTag === 1;

  // Position-independent trailer -- see the header for why this is not read
  // forwards from `offset`.
  const finalizedByte = bytes[bytes.length - CROWDLOAN_TRAILER_BYTES];
  if (finalizedByte !== 0 && finalizedByte !== 1) return null;
  const contributorsCount = readU32LE(bytes, bytes.length - 4);

  const capTao = rawToDisplay(capRao);
  const raisedTao = rawToDisplay(raisedRao);

  return {
    creator,
    deposit_tao: rawToDisplay(depositRao),
    min_contribution_tao: rawToDisplay(minContributionRao),
    end,
    cap_tao: capTao,
    funds_account: fundsAccount,
    raised_tao: raisedTao,
    target_address: targetAddress,
    has_dispatch_call: hasDispatchCall,
    finalized: finalizedByte === 1,
    contributors_count: contributorsCount,
    // Derived, not stored: the share of the cap actually raised. Guarded
    // because a cap of 0 is representable on-chain and would divide by zero.
    percent_raised: capRao === 0n ? null : (raisedTao / capTao) * 100,
  };
}

/**
 * Where each published value came from (#9108).
 *
 * Every crowdloan field is a measured read of `Crowdloan.Crowdloans`.
 * `crowdloan_count` is ours -- it reports how many ids `NextCrowdloanId`
 * covered, which is a fact about the enumeration rather than a stored value.
 */
export const CROWDLOANS_FIELD_SOURCES = {
  crowdloan_count: { kind: "reconstructed", storage: null },
  next_crowdloan_id: {
    kind: "measured",
    storage: "Crowdloan.NextCrowdloanId",
  },
  crowdloans: { kind: "measured", storage: "Crowdloan.Crowdloans" },
} as const satisfies FieldSources;

/**
 * `exists` is ours, not the chain's: it reports whether the map lookup
 * resolved at all, which is a fact about the lookup rather than a stored
 * value — the same relationship `leased` has to SubnetLeases.
 */
export const CROWDLOAN_FIELD_SOURCES = {
  crowdloan_id: { kind: "reconstructed", storage: null },
  exists: { kind: "reconstructed", storage: null },
  crowdloan: { kind: "measured", storage: "Crowdloan.Crowdloans" },
} as const satisfies FieldSources;

function nextCrowdloanIdKey(): string {
  return bytesToHex(storageMapPrefix("Crowdloan", "NextCrowdloanId"));
}

function crowdloanKey(id: number): string {
  return twox64ConcatU32StorageKey("Crowdloan", "Crowdloans", id);
}

// NextCrowdloanId is a ValueQuery u32: an absent key is 0 (no crowdloan has
// ever been created), NOT an error.
function decodeNextCrowdloanId(result: StorageFetchResult): number | null {
  if (!result.ok) return null;
  if (result.raw === null) return 0;
  const bytes = hexToBytes(result.raw);
  if (!bytes || bytes.length !== 4) return null;
  return readU32LE(bytes, 0);
}

async function loadCrowdloansSnapshot(
  env: Env,
  network?: ChainNetworkId,
): Promise<Row> {
  // Each chain runs its own crowdloans, numbered from its own NextCrowdloanId.
  const cacheKey = networkKvKey("crowdloans:index", network);
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as Row;
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  const timeout = CROWDLOANS_RPC_TIMEOUT_MS;

  const nextId = decodeNextCrowdloanId(
    await fetchStorageRaw(nextCrowdloanIdKey(), timeout, network),
  );

  const crowdloans: Row[] = [];
  let rpcOk = false;

  if (nextId === 0) {
    // Confirmed "no crowdloan has ever existed" — a real, cacheable answer.
    rpcOk = true;
  } else if (nextId !== null) {
    const ids = [...Array(Math.min(nextId, MAX_CROWDLOANS_FANOUT)).keys()];
    const keys = ids.map(crowdloanKey);
    const byKey = await fetchStorageBatch(keys, timeout, network);
    if (byKey) {
      for (const id of ids) {
        const decoded = decodeCrowdloan(byKey.get(keys[id].toLowerCase()));
        // An absent id is normal: `dissolve` removes the record while
        // NextCrowdloanId keeps counting. Skip rather than emit a null hole.
        if (decoded) crowdloans.push({ crowdloan_id: id, ...decoded });
      }
      rpcOk = true;
    }
  }

  const payload: Row = {
    schema_version: 1,
    crowdloan_count: crowdloans.length,
    next_crowdloan_id: nextId,
    crowdloans,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? CROWDLOANS_KV_TTL : CROWDLOANS_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}

async function loadCrowdloanSnapshot(
  env: Env,
  id: number,
  network?: ChainNetworkId,
): Promise<Row> {
  if (!isCrowdloanId(id)) {
    throw new RangeError(
      "crowdloan_id must be an integer in the u32 range 0..4294967295",
    );
  }

  const cacheKey = networkKvKey(`crowdloan:${id}`, network);
  const kv = env?.METAGRAPH_CONTROL;

  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return cached as Row;
    } catch {
      // KV read failure is non-fatal.
    }
  }

  const queriedAt = new Date().toISOString();
  const result = await fetchStorageRaw(
    crowdloanKey(id),
    CROWDLOANS_RPC_TIMEOUT_MS,
    network,
  );

  // `exists: null` (not false) on RPC failure — distinct from a confirmed
  // absent id (`exists: false`), matching subnet-lease.ts's leased:null
  // convention. A caller must be able to tell "no such crowdloan" from
  // "we could not find out".
  let exists: boolean | null = null;
  let crowdloan: Row | null = null;
  let rpcOk = false;

  if (result.ok) {
    if (result.raw === null) {
      exists = false;
      rpcOk = true;
    } else {
      const decoded = decodeCrowdloan(result.raw);
      if (decoded) {
        exists = true;
        crowdloan = { crowdloan_id: id, ...decoded };
        rpcOk = true;
      }
    }
  }

  const payload: Row = {
    schema_version: 1,
    crowdloan_id: id,
    exists,
    crowdloan,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: rpcOk ? CROWDLOANS_KV_TTL : CROWDLOANS_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return payload;
}

/**
 * The served records: the bodies above plus their provenance maps.
 *
 * Attached outside the loaders so provenance never enters the KV blob, and so
 * every consumer inherits it from one point (#9108) — same split as
 * subnet-lease.ts.
 */
export async function loadCrowdloans(
  env: Env,
  network?: ChainNetworkId,
): Promise<Row> {
  return {
    ...(await loadCrowdloansSnapshot(env, network)),
    field_sources: CROWDLOANS_FIELD_SOURCES,
  };
}

export async function loadCrowdloan(
  env: Env,
  id: number,
  network?: ChainNetworkId,
): Promise<Row> {
  return {
    ...(await loadCrowdloanSnapshot(env, id, network)),
    field_sources: CROWDLOAN_FIELD_SOURCES,
  };
}
