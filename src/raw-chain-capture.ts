// Gap-free RAW chain capture — the durable half of the extrinsics/events lane.
//
// WHY RAW, AND WHY FIRST. src/head-poller.ts serves the `blocks` lane only,
// and says why: extrinsics/chain_events/account_events need SCALE decoding
// against runtime metadata, and "a Worker faking those lanes from undecoded
// bytes would serve wrong data". That reasoning is about SERVING. It does not
// apply to CAPTURE, and conflating the two is how a decommissioned box turns
// into a permanent hole: the chain only serves recent state cheaply, so bytes
// not captured near head become expensive-to-impossible to recover later.
//
// So this module captures the bytes VERBATIM -- block header, the extrinsics
// array exactly as the node returns it, and the System.Events storage blob at
// that block hash -- and lands them in R2 before anything is decoded. Decode
// is a pure function of those bytes plus runtime metadata, so it can be
// re-run, corrected, and re-run again. A missed block cannot.
//
// THE NO-GAP GUARANTEE, and why it holds:
//   - A single durable watermark, `last_contiguous_block`, means "every block
//     at or below this height is durably in R2". It is the ONLY thing that
//     advances, and it advances ONLY across a prefix that was actually
//     written this tick.
//   - Capture starts at watermark+1 every time. A tick that fails at height H
//     advances the watermark to H-1 at most, so the next tick retries H. There
//     is no cursor that can skip forward past a failure.
//   - Writes are idempotent: the R2 key is derived from the block range, so a
//     retried batch overwrites rather than duplicating.
//   - Therefore "are there gaps?" is answerable by a QUERY -- compare the
//     watermark against the chain head -- rather than by trusting a log.
//
// Cadence and bounds are the caller's (a Worker cron); this module is pure
// apart from the injected fetch and store, so the whole guarantee is testable
// without a chain or a bucket.

import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";

/** twox128("System") ++ twox128("Events") — the runtime storage key holding
 * the event list for a block. Stable across runtime upgrades (the KEY is a
 * hash of the pallet/item names; only the VALUE's encoding tracks metadata,
 * which is exactly why capturing the value verbatim is safe here). */
export const SYSTEM_EVENTS_STORAGE_KEY =
  "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

export interface RawBlockCapture {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  /** Full header as returned, so nothing is lost to our own field selection. */
  header: unknown;
  /** Extrinsics as the node returned them: SCALE hex, in block order. */
  extrinsics: string[];
  /** System.Events storage value at this block hash, SCALE hex, or null when
   * the node has pruned state for that height (recorded, never silently
   * treated as "no events"). */
  events: string | null;
  /** Wall-clock capture time, for provenance — never used for ordering. */
  captured_at: number;
}

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

/**
 * One block's raw bytes. Three reads: hash at height, the block (header +
 * extrinsics), and the events blob at that hash.
 *
 * Throws on anything unexpected rather than returning a partial capture — a
 * half-captured block that still advanced the watermark is precisely the gap
 * this module exists to prevent.
 */
export async function fetchRawBlock(
  url: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<RawBlockCapture> {
  const hash = (await rpc(
    url,
    "chain_getBlockHash",
    [number],
    fetchImpl,
  )) as string;
  if (typeof hash !== "string" || !hash.startsWith("0x")) {
    throw new Error(`no hash at height ${number}`);
  }
  const signed = (await rpc(url, "chain_getBlock", [hash], fetchImpl)) as {
    block?: { header?: { parentHash?: unknown }; extrinsics?: unknown };
  };
  const header = signed?.block?.header;
  const extrinsics = signed?.block?.extrinsics;
  if (!header || !Array.isArray(extrinsics)) {
    throw new Error(`malformed block at height ${number}`);
  }
  if (!extrinsics.every((x): x is string => typeof x === "string")) {
    throw new Error(`non-string extrinsic at height ${number}`);
  }
  // A pruned-state node answers null here. Recorded as null rather than "",
  // so a later decode can tell "no events" from "events unavailable".
  const events = (await rpc(
    url,
    "state_getStorage",
    [SYSTEM_EVENTS_STORAGE_KEY, hash],
    fetchImpl,
  )) as unknown;
  if (events !== null && typeof events !== "string") {
    throw new Error(`malformed events at height ${number}`);
  }
  const parentHash = header.parentHash;
  return {
    block_number: number,
    block_hash: hash,
    parent_hash: typeof parentHash === "string" ? parentHash : "",
    header,
    extrinsics,
    events,
    captured_at: now(),
  };
}

/**
 * The heights this tick should capture: the contiguous run starting at
 * `lastContiguous + 1`, bounded by the head and by `maxPerTick`.
 *
 * Deliberately never skips ahead to the head. Falling behind is recoverable
 * (the next tick continues); skipping is not.
 */
export function nextCaptureHeights(
  lastContiguous: number,
  head: number,
  maxPerTick: number,
): number[] {
  if (!Number.isInteger(head) || head < 0) return [];
  if (!Number.isInteger(maxPerTick) || maxPerTick <= 0) return [];
  const start = lastContiguous + 1;
  if (start > head) return [];
  const end = Math.min(head, lastContiguous + maxPerTick);
  const out: number[] = [];
  for (let n = start; n <= end; n += 1) out.push(n);
  return out;
}

/**
 * Zero-padded so lexicographic key order matches numeric block order — R2
 * listings and any later compaction then walk the chain in order for free.
 *
 * Mainnet keeps the bare `chain/raw/blocks/` prefix UNCHANGED. That is not
 * cosmetic: the decode lane (metagraphed-infra's decode-r2 container) lists
 * exactly that prefix, and every object already captured lives under it.
 * Testnet gets its own prefix instead, because the key encodes only a block
 * RANGE — testnet block 7,700,000 and mainnet block 7,700,000 would otherwise
 * write the same object, and the second one to land would silently overwrite
 * the first with bytes from a different chain.
 */
export function rawBatchKey(
  first: number,
  last: number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  const pad = (n: number) => String(n).padStart(12, "0");
  const scope = network === DEFAULT_CHAIN_NETWORK ? "" : `${network}/`;
  return `chain/raw/${scope}blocks/${pad(first)}-${pad(last)}.ndjson`;
}

/** The minimal slice of the R2 binding this module uses — structural so tests
 * can pass a plain object. */
export interface RawCaptureStore {
  put(key: string, value: string): Promise<unknown>;
}

/** Where the watermark lives. Structural for the same reason. */
export interface WatermarkStore {
  read(): Promise<number | null>;
  write(value: number): Promise<unknown>;
}

export interface CaptureResult {
  /** Blocks durably written this tick. */
  captured: number;
  /** Watermark after the tick — never past a failure. */
  watermark: number;
  /** How far behind the head the watermark is once the tick settles. */
  behind: number;
  /** Present when the tick stopped early; the run is retried next tick.
   * `stoppedAt` and `reason` are always set together — a stop without a
   * recorded cause would be indistinguishable from a clean finish. */
  stoppedAt?: number;
  reason?: string;
}

/**
 * Capture one tick's worth of blocks and advance the watermark across exactly
 * the prefix that was written.
 *
 * The batch is fetched fully, then written as ONE object, then the watermark
 * moves. Any failure short-circuits before the write, so the watermark can
 * never claim a block that is not in R2. A partial run is normal and safe —
 * the next tick resumes from the same place.
 */
export async function captureTick(deps: {
  rpcUrl: string;
  store: RawCaptureStore;
  watermark: WatermarkStore;
  genesisFloor: number;
  maxPerTick: number;
  /** Which chain these bytes came from. Decides the R2 key prefix only —
   * everything else here is chain-agnostic, because capture never decodes. */
  network?: ChainNetworkId;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CaptureResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const stored = await deps.watermark.read();
  // An unset watermark starts just below the floor, so the first tick captures
  // the floor block itself rather than skipping it.
  const lastContiguous =
    typeof stored === "number" && Number.isInteger(stored)
      ? stored
      : deps.genesisFloor - 1;

  const headRaw = (await rpc(
    deps.rpcUrl,
    "chain_getHeader",
    [],
    fetchImpl,
  )) as { number?: unknown };
  const headHex = headRaw?.number;
  if (typeof headHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(headHex)) {
    throw new Error("chain_getHeader: unusable head number");
  }
  const head = Number.parseInt(headHex, 16);

  const heights = nextCaptureHeights(lastContiguous, head, deps.maxPerTick);
  if (heights.length === 0) {
    return {
      captured: 0,
      watermark: lastContiguous,
      behind: head - lastContiguous,
    };
  }

  const blocks: RawBlockCapture[] = [];
  let stoppedAt: number | undefined;
  let reason: string | undefined;
  for (const height of heights) {
    try {
      blocks.push(await fetchRawBlock(deps.rpcUrl, height, fetchImpl, now));
    } catch (error) {
      // Stop at the FIRST failure and keep the prefix. Continuing past it
      // would create exactly the hole this module exists to prevent.
      stoppedAt = height;
      reason = String((error as Error)?.message ?? error);
      break;
    }
  }

  if (blocks.length === 0) {
    return {
      captured: 0,
      watermark: lastContiguous,
      behind: head - lastContiguous,
      stoppedAt,
      reason,
    };
  }

  const first = blocks[0]!.block_number;
  const last = blocks[blocks.length - 1]!.block_number;
  // One object per contiguous batch, keyed by its range: a retry of the same
  // range overwrites byte-for-byte rather than appending a duplicate.
  await deps.store.put(
    rawBatchKey(first, last, deps.network),
    blocks.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );
  // Only now — the bytes are durable, so the watermark may claim them.
  await deps.watermark.write(last);

  return {
    captured: blocks.length,
    watermark: last,
    behind: head - last,
    stoppedAt,
    reason,
  };
}
