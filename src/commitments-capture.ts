// Every hotkey's commitment on every subnet, captured from chain storage
// (runtime spec 497; MET-7365, ADR 0029 phase 2).
//
// A commitment is what a subnet's miners and validators publish on chain:
// model revisions, peer ids, endpoints, content hashes, timelocked payloads.
// The pallet (opentensor/subtensor pallets/commitments) keeps
//
//   CommitmentOf         (Identity NetUid, Twox64Concat AccountId)
//                          -> Registration { deposit: u64, block: u32,
//                               info: { fields: BoundedVec<Data> } }
//   RevealedCommitments  (Identity NetUid, Twox64Concat AccountId)
//                          -> Vec<(Vec<u8>, u64)>, each reveal and its block
//
// and `Data` has its own tagged encoding (pallets/commitments/src/types.rs):
// 0 none; 1..=129 raw bytes of length tag - 1; 130..=133 a BLAKE2-256,
// SHA-256, Keccak-256 or SHA3-256 hash; 134 a timelock ciphertext and its
// drand round; 135 the bonds-reset flag; 136 big raw bytes; 137 a timelock
// whose reveal failed.
//
// One finalized block is read whole, hourly (the maps held 29,461 and 17,695
// entries at block 9,604,440, 143 RPC calls), and the state table keeps
// validity ranges (migration 0061). A change is told by the chain's own
// bytes: each pair carries a digest of its SCALE values, and only the pairs
// whose digest moved are written.
//
// The public entrypoint limits a client by HTTP request, not by call. Read one
// call to a request, the first whole read (2026-11-28 19:01Z) listed its key
// pages and then drew HTTP 429 on its value calls, sent four at a time. At the
// counts above that is 145 requests: two for the head, 48 key pages and 95
// value calls. The value calls now go ten to a JSON-RPC batch, so the read
// takes 60. Measured the same day against the entrypoint, one such batch
// carried 5,000 values (1.9 MB) whole in 7.2 s.

import { chainRpc, chainRpcBatch } from "./chain-rpc.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  rpcUrlForNetwork,
} from "./chain-network.ts";
import { sha256Hex } from "./sha256-hex.ts";
import { bytesToHex, storageMapPrefix } from "./twox-storage-key.ts";
import {
  decode,
  enumerate,
  finalizedAt,
  netuidAt,
  RPC_TIMEOUT_MS,
  type Rpc,
  type RpcBatch,
  type Scale,
  storageAtBatched,
} from "./chain-storage-read.ts";

const prefix = (item: string) =>
  bytesToHex(storageMapPrefix("Commitments", item));
const KEY = Object.freeze({
  commitments: prefix("CommitmentOf"),
  reveals: prefix("RevealedCommitments"),
});
/** 100,000 keys a map, over three times finney's largest. */
const MAX_PAGES = 100;
/** Value calls to one HTTP request, and those requests in flight: ten calls
 * of 500 keys answered whole in 7.2 s when measured, so two requests at once
 * keep a read near a minute without a burst on the endpoint. */
const VALUE_CALLS_PER_REQUEST = 10;
const VALUE_REQUESTS_IN_FLIGHT = 2;
/** A batched request carries ten calls' values, past one call's timeout. */
const BATCH_TIMEOUT_MS = 60_000;
/** A Registration's field list, well past the runtime's MaxCommitFields. */
const MAX_FIELDS = 64;
const MAX_REVEALS = 1_024;
const HASH_KINDS = ["blake2_256", "sha256", "keccak256", "sha3_256"] as const;

/** The burn tick runs at minutes 1, 16, 31 and 46: the capture takes the
 * first of each hour. */
export function commitmentsCaptureDue(scheduledTimeMs: number): boolean {
  return new Date(scheduledTimeMs).getUTCMinutes() < 15;
}

export interface CommitmentField {
  kind:
    | "none"
    | "raw"
    | "big_raw"
    | (typeof HASH_KINDS)[number]
    | "timelock"
    | "timelock_failed"
    | "reset_bonds";
  /** The field's bytes, hex with 0x, when it has any. */
  hex?: string;
  /** The bytes as UTF-8, when they are printable text. */
  text?: string;
  /** A timelock's drand round. */
  reveal_round?: number;
}

export interface CommitmentReveal {
  block: number;
  hex: string;
  text?: string;
}

/** The bytes as text, when they are UTF-8 a reader can print. */
function printable(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (text.includes("\uFFFD")) return undefined;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    )
      return undefined;
  }
  return text;
}

function withText(bytes: Uint8Array): { hex: string; text?: string } {
  const text = printable(bytes);
  return { hex: bytesToHex(bytes), ...(text === undefined ? {} : { text }) };
}

function dataField(s: Scale): CommitmentField {
  const tag = s.variant(138);
  if (tag === 0) return { kind: "none" };
  if (tag <= 129) return { kind: "raw", ...withText(s.fixed(tag - 1)) };
  if (tag <= 133)
    return { kind: HASH_KINDS[tag - 130], hex: bytesToHex(s.fixed(32)) };
  if (tag === 135) return { kind: "reset_bonds" };
  if (tag === 136) return { kind: "big_raw", ...withText(s.bytes()) };
  // 134 and 137: a timelock ciphertext and the drand round it unlocks at.
  const hex = bytesToHex(s.bytes());
  return {
    kind: tag === 134 ? "timelock" : "timelock_failed",
    hex,
    reveal_round: Number(s.uint(8)),
  };
}

export interface CommitmentRegistration {
  /** Rao, a u64 as decimal text. */
  deposit: string;
  block: number;
  fields: CommitmentField[];
}

/** Commitments.CommitmentOf's Registration. */
export function decodeRegistration(hex: string): CommitmentRegistration {
  return decode(hex, (s) => {
    const deposit = s.uint(8).toString();
    const block = Number(s.uint(4));
    const length = s.length(MAX_FIELDS);
    return {
      deposit,
      block,
      fields: Array.from({ length }, () => dataField(s)),
    };
  });
}

/** A reveal's text. The chain keeps a reveal as the SCALE bytes the
 * committed payload was -- a compact length and the payload (measured on
 * finney: 0x0101 then a 64-byte gist URL) -- so its text is the payload's,
 * and only a reveal that is no such vector is read as text whole. */
function revealText(bytes: Uint8Array): string | undefined {
  try {
    return printable(decode(bytesToHex(bytes), (s) => s.bytes()));
  } catch {
    return printable(bytes);
  }
}

/** Commitments.RevealedCommitments: each reveal and its block, in order. */
export function decodeReveals(hex: string): CommitmentReveal[] {
  return decode(hex, (s) => {
    const length = s.length(MAX_REVEALS);
    return Array.from({ length }, () => {
      const bytes = s.bytes();
      const text = revealText(bytes);
      return {
        hex: bytesToHex(bytes),
        ...(text === undefined ? {} : { text }),
        block: Number(s.uint(8)),
      };
    });
  });
}

/** The (netuid, hotkey) a commitment key names: the netuid after the prefix,
 * then the hotkey's Twox64 hash (8 bytes) and the 32-byte key itself. */
export function commitmentKey(
  key: string,
  itemPrefix: string,
): { netuid: number; hotkey: string } | null {
  if (!key.startsWith(itemPrefix)) return null;
  const rest = key.slice(itemPrefix.length);
  if (!/^[0-9a-f]{84}$/.test(rest)) return null;
  return { netuid: netuidAt(rest, 0), hotkey: "0x" + rest.slice(20) };
}

/** What tells one pair's chain state from another: SHA-256 over its two
 * SCALE values as the chain holds them, either absent. Hex, no 0x. */
export function commitmentDigest(
  commitment: string | null,
  reveals: string | null,
): Promise<string> {
  const part = (hex: string | null) => (hex === null ? "-" : hex.toLowerCase());
  return sha256Hex(`${part(commitment)}:${part(reveals)}`);
}

export interface CommitmentState {
  netuid: number;
  /** The 32-byte public key, hex with 0x. */
  hotkey: string;
  /** The current commitment, or null when only reveals remain. */
  commitment: CommitmentRegistration | null;
  reveals: CommitmentReveal[];
  /** commitmentDigest of the pair's values. */
  digest: string;
}

export interface CommitmentsSnapshot {
  block: number;
  /** Every (netuid, hotkey) whose state read whole, ascending. */
  commitments: CommitmentState[];
  /** Pairs the chain holds whose values did not read whole: their rows are
   * left as they are, neither changed nor closed as gone. */
  unknown: { netuid: number; hotkey: string }[];
  undecoded: number;
}

const byPair = (
  a: CommitmentsSnapshot["unknown"][number],
  b: CommitmentsSnapshot["unknown"][number],
) =>
  // No two pairs of one snapshot are equal: a map keys each pair once.
  a.netuid - b.netuid || (a.hotkey < b.hotkey ? -1 : 1);

/** The network's endpoint: single calls, and JSON-RPC batches whose every
 * call must answer. */
function chainTransport(network: ChainNetworkId): {
  rpc: Rpc;
  batch: RpcBatch;
} {
  const url = rpcUrlForNetwork(network);
  return {
    rpc: (method, params) =>
      chainRpc(url, method, params, { timeoutMs: RPC_TIMEOUT_MS }),
    batch: async (calls) => {
      const results = await chainRpcBatch(url, [...calls], {
        timeoutMs: BATCH_TIMEOUT_MS,
      });
      return results.map((result, index) => {
        if (!result.ok)
          throw new Error(`${calls[index]?.method}: ${result.error}`);
        return result.result;
      });
    },
  };
}

/** One finalized block's commitments and reveals for every subnet. Throws on
 * an RPC failure or a map past its bound: a partial listing cannot say which
 * commitments are gone. The head and the key pages are single calls; the
 * values go in batches. */
export async function loadCommitmentsSnapshot(
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
  { rpc, batch }: { rpc: Rpc; batch: RpcBatch } = chainTransport(network),
): Promise<CommitmentsSnapshot> {
  const { at, block } = await finalizedAt(rpc);
  const commitmentKeys = await enumerate(rpc, KEY.commitments, at, MAX_PAGES);
  const revealKeys = await enumerate(rpc, KEY.reveals, at, MAX_PAGES);
  if (commitmentKeys === null || revealKeys === null)
    throw new Error("Commitments are larger than their read bound");
  const values = await storageAtBatched(
    batch,
    [...commitmentKeys, ...revealKeys],
    at,
    {
      perRequest: VALUE_CALLS_PER_REQUEST,
      concurrency: VALUE_REQUESTS_IN_FLIGHT,
    },
  );
  type Held = CommitmentsSnapshot["unknown"][number] & {
    commitment: string | null;
    reveals: string | null;
  };
  const held = new Map<string, Held>();
  const unknown = new Map<string, CommitmentsSnapshot["unknown"][number]>();
  const list = (
    keys: string[],
    itemPrefix: string,
    part: "commitment" | "reveals",
  ) => {
    for (const key of keys) {
      const id = commitmentKey(key, itemPrefix);
      // A key that names no (netuid, hotkey) cannot be told apart from a
      // commitment that is gone: the whole snapshot refuses rather than guess.
      if (!id) throw new Error("A commitment key names no subnet and hotkey");
      const name = `${id.netuid}:${id.hotkey}`;
      const raw = values.get(key);
      // Gone between the listing and the read: unknown at this block.
      if (raw === undefined) unknown.set(name, id);
      const pair = held.get(name) ?? { ...id, commitment: null, reveals: null };
      pair[part] = raw ?? null;
      held.set(name, pair);
    }
  };
  list(commitmentKeys, KEY.commitments, "commitment");
  list(revealKeys, KEY.reveals, "reveals");

  let undecoded = 0;
  const commitments: CommitmentState[] = [];
  for (const [name, pair] of held) {
    if (unknown.has(name)) continue;
    let commitment: CommitmentRegistration | null;
    let reveals: CommitmentReveal[];
    try {
      commitment =
        pair.commitment === null ? null : decodeRegistration(pair.commitment);
      reveals = pair.reveals === null ? [] : decodeReveals(pair.reveals);
    } catch {
      // A pair with one part unreadable is unknown whole: half a state is
      // not one.
      undecoded += 1;
      unknown.set(name, { netuid: pair.netuid, hotkey: pair.hotkey });
      continue;
    }
    commitments.push({
      netuid: pair.netuid,
      hotkey: pair.hotkey,
      commitment,
      reveals,
      digest: await commitmentDigest(pair.commitment, pair.reveals),
    });
  }
  return {
    block,
    commitments: commitments.sort(byPair),
    unknown: [...unknown.values()].sort(byPair),
    undecoded,
  };
}

/** A current row as the store holds it: hotkey and digest hex, no 0x. */
export interface CommitmentCurrentRow {
  netuid: number;
  hotkey: string;
  digest: string;
}

/** A row to open, as the writer sends it. */
export interface CommitmentOpen {
  netuid: number;
  /** Hex, no 0x. */
  hotkey: string;
  committed_block: number | null;
  deposit: string | null;
  fields: CommitmentField[] | null;
  reveals: CommitmentReveal[];
  /** Hex, no 0x. */
  digest: string;
}

export interface CommitmentChanges {
  close: { netuid: number; hotkey: string }[];
  open: CommitmentOpen[];
}

/** What one capture changes, against the store's current rows. Pure. A pair
 * the snapshot holds with another digest closes and reopens; a current row
 * the snapshot neither holds nor names unknown closes as gone. */
export function commitmentChanges(
  snapshot: CommitmentsSnapshot,
  current: readonly CommitmentCurrentRow[],
): CommitmentChanges {
  const bare = (hotkey: string) => hotkey.replace(/^0x/, "").toLowerCase();
  const name = (netuid: number, hotkey: string) => `${netuid}:${bare(hotkey)}`;
  const digests = new Map(
    current.map((row) => [name(row.netuid, row.hotkey), row.digest]),
  );
  const seen = new Set(
    [...snapshot.commitments, ...snapshot.unknown].map((pair) =>
      name(pair.netuid, pair.hotkey),
    ),
  );
  const changes: CommitmentChanges = { close: [], open: [] };
  for (const state of snapshot.commitments) {
    const key = name(state.netuid, state.hotkey);
    const digest = digests.get(key);
    if (digest === state.digest) continue;
    if (digest !== undefined)
      changes.close.push({ netuid: state.netuid, hotkey: bare(state.hotkey) });
    changes.open.push({
      netuid: state.netuid,
      hotkey: bare(state.hotkey),
      committed_block: state.commitment?.block ?? null,
      deposit: state.commitment?.deposit ?? null,
      fields: state.commitment?.fields ?? null,
      reveals: state.reveals,
      digest: state.digest,
    });
  }
  for (const row of current) {
    if (!seen.has(name(row.netuid, row.hotkey)))
      changes.close.push({ netuid: row.netuid, hotkey: bare(row.hotkey) });
  }
  return changes;
}

export interface CommitmentsWriteOutcome {
  /** False when the store already holds an observation at or past this block. */
  written: boolean;
  opened: number;
  closed: number;
}

/** The writer the capture needs (src/pg-commitments.ts implements it). */
export interface CommitmentsWriter {
  write(
    snapshot: CommitmentsSnapshot,
    observedAtMs: number,
  ): Promise<CommitmentsWriteOutcome>;
}

/** Persist one capture. Never throws: returns what happened for the lane's
 * verdict. */
export async function captureCommitments(
  _env: unknown,
  {
    store,
    now = Date.now,
    network,
    load = loadCommitmentsSnapshot,
  }: {
    store?: CommitmentsWriter | null;
    now?: () => number;
    network?: ChainNetworkId;
    load?: typeof loadCommitmentsSnapshot;
  } = {},
): Promise<{
  ok: boolean;
  commitments: number;
  changed: number;
  undecoded: number;
  reason?: string;
}> {
  const none = { commitments: 0, changed: 0, undecoded: 0 };
  if (typeof store?.write !== "function")
    return { ok: false, ...none, reason: "no_store_binding" };
  let snapshot: CommitmentsSnapshot;
  try {
    snapshot = await load(network);
  } catch (error) {
    return {
      ok: false,
      ...none,
      reason: `chain_read_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  let outcome: CommitmentsWriteOutcome;
  try {
    outcome = await store.write(snapshot, now());
  } catch (error) {
    return {
      ok: false,
      ...none,
      undecoded: snapshot.undecoded,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
  const reason = !outcome.written
    ? "not_newer"
    : snapshot.undecoded > 0
      ? `undecoded: ${snapshot.undecoded}`
      : undefined;
  return {
    ok: outcome.written && snapshot.undecoded === 0,
    commitments: snapshot.commitments.length,
    changed: outcome.opened + outcome.closed,
    undecoded: snapshot.undecoded,
    ...(reason === undefined ? {} : { reason }),
  };
}
