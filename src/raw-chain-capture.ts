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

import {
  chainRpc,
  chainRpcBatch,
  type ChainRpcBatchCall,
} from "./chain-rpc.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";

// DERIVED once in twox-storage-key.ts, beside the vectors that prove it.
// Re-exported here because this module's callers and tests have always
// addressed the key through it.
import { SYSTEM_EVENTS_STORAGE_KEY } from "./twox-storage-key.ts";
export { SYSTEM_EVENTS_STORAGE_KEY };

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

/**
 * The shared, VALIDATED client (#11194).
 *
 * This file used to carry its own copy of the envelope type and the call. Both
 * were byte-identical to raw-chain-capture.ts's, and both CAST the response
 * rather than parsing it -- see src/chain-rpc.ts for why that matters at a
 * boundary served by a public archive nobody here operates.
 */
async function rpc(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return chainRpc(url, method, params, { fetchImpl });
}

/**
 * The most JSON-RPC calls one batch request may carry.
 *
 * THE NODE'S OWN NUMBER, not a guess. Over the limit it refuses the whole
 * request -- not the excess -- with its own message, measured 2026-08-16
 * against archive.chain.opentensor.ai:
 *
 *     n=50  -> 200, array of 50 results
 *     n=51  -> {"error":{"code":-32010,"message":"The batch request was too
 *               large","data":"Exceeded max limit of 50"}}
 *
 * That refusal arrives as HTTP 200 carrying a single error OBJECT where an
 * array was asked for, which is why chainRpcBatch classifies a non-array
 * response as a failure rather than reading it as zero results.
 */
export const MAX_RPC_BATCH_CALLS = 50;

/** Calls one block costs inside a chunk's batch: its body, and its events. */
export const RPC_CALLS_PER_BLOCK = 2;

/**
 * HTTP requests one chunk costs, whatever its size: the hash list, then the
 * batch of bodies and events. The two cannot merge -- bodies and events are
 * addressed by hash, and the hashes are what the first request returns.
 */
export const REQUESTS_PER_CHUNK = 2;

/**
 * Most blocks one chunk may carry, from the two numbers above.
 *
 * DERIVED, so it cannot drift from the batch limit it exists to respect. At 25
 * blocks a chunk measured 0.81 MB and ~1.7 s against the live archive, which
 * is comfortable for a Worker; the binding constraint is the node's call cap,
 * not our memory.
 */
export const MAX_CAPTURE_CHUNK_BLOCKS = Math.floor(
  MAX_RPC_BATCH_CALLS / RPC_CALLS_PER_BLOCK,
);

/** What one chunk read produced: the contiguous PREFIX, and why it ended. */
export interface RawBlockChunk {
  /** Captured blocks in ascending height order, contiguous from heights[0]. */
  blocks: RawBlockCapture[];
  /**
   * The first height the chunk could not capture and why, or null when it
   * captured every height it was asked for.
   *
   * ONE FIELD, not a `stoppedAt?`/`reason?` pair: the two are only ever set
   * together, and a pair lets the type describe three states the code never
   * produces -- including a stop with no reason, which reaches an operator as a
   * decline that does not say why.
   */
  stopped: { at: number; reason: string } | null;
}

/**
 * Assemble one block from its parts, or say why it cannot be.
 *
 * Split out because the checks are the whole no-gap guarantee at the block
 * level -- a half-captured block that still advanced the watermark is exactly
 * the hole this module exists to prevent -- and they must not differ between
 * however many transports fetch the parts. Returns a message rather than
 * throwing so the chunk reader can keep the prefix before a bad block.
 *
 * `hash` is a validated string, not `unknown`: the chunk reader checks every
 * hash as it walks the list, because a null there BOUNDS the chunk (the chain
 * has not produced that block) rather than failing it. Re-checking here would
 * be a branch nothing can reach.
 */
function assembleRawBlock(
  number: number,
  hash: string,
  signedRaw: unknown,
  eventsRaw: unknown,
  now: () => number,
): { block: RawBlockCapture } | { error: string } {
  const signed = signedRaw as {
    block?: { header?: { parentHash?: unknown }; extrinsics?: unknown };
  };
  const header = signed?.block?.header;
  const extrinsics = signed?.block?.extrinsics;
  if (!header || !Array.isArray(extrinsics)) {
    return { error: `malformed block at height ${number}` };
  }
  if (!extrinsics.every((x): x is string => typeof x === "string")) {
    return { error: `non-string extrinsic at height ${number}` };
  }
  // A pruned-state node answers null here. Recorded as null rather than "",
  // so a later decode can tell "no events" from "events unavailable".
  if (eventsRaw !== null && typeof eventsRaw !== "string") {
    return { error: `malformed events at height ${number}` };
  }
  const parentHash = header.parentHash;
  return {
    block: {
      block_number: number,
      block_hash: hash,
      parent_hash: typeof parentHash === "string" ? parentHash : "",
      header,
      extrinsics,
      events: eventsRaw,
      captured_at: now(),
    },
  };
}

/**
 * A run of blocks' raw bytes in TWO HTTP requests, however many blocks.
 *
 * WHY TWO, NOT THREE PER BLOCK. The public archive limits a client by HTTP
 * REQUESTS, not by JSON-RPC calls -- measured 2026-08-16 against
 * archive.chain.opentensor.ai by replaying this lane's own call pattern:
 *
 *     singles: 429 after 103 requests (103 calls)
 *     batches of 10: 1,400 calls in 140 requests, no limit, 103.7s
 *
 * Same allowance, 13.6x the data. The old shape spent three requests per block
 * and so could never exceed ~33 blocks/minute however it was paced; this one
 * spends two per CHUNK. Both requests use facilities the node already
 * advertises: `chain_getBlockHash` takes a LIST of heights and answers a list,
 * and the server accepts a JSON-RPC batch array.
 *
 * The two requests cannot merge into one: the bodies and the events blob are
 * addressed BY HASH, and the hashes are what the first request returns.
 *
 * THE PREFIX RULE IS UNCHANGED. A chunk stops at the first height it cannot
 * assemble and returns everything before it, so the caller's watermark still
 * only ever advances across blocks that are actually durable.
 */
export async function fetchRawBlockChunk(
  url: string,
  heights: number[],
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<RawBlockChunk> {
  if (heights.length === 0) return { blocks: [], stopped: null };

  // Request 1: every hash in one call.
  const hashesRaw = await rpc(url, "chain_getBlockHash", [heights], fetchImpl);
  // `ListOrValue` answers a list for a list, which is what we always send. A
  // node that answers a bare value to a list request has not understood the
  // request, and reading it as one hash for many heights would assign every
  // block the same bytes -- wrong data, not missing data.
  if (!Array.isArray(hashesRaw)) {
    return {
      blocks: [],
      stopped: {
        at: heights[0]!,
        reason: `chain_getBlockHash: expected a list of ${heights.length} hashes`,
      },
    };
  }
  // Only the leading heights that actually have a hash are worth asking about;
  // a null is the chain simply not having produced that block yet, and it
  // bounds the chunk rather than failing it.
  const usable: { height: number; hash: string }[] = [];
  let stopped: { at: number; reason: string } | null = null;
  for (const [index, height] of heights.entries()) {
    const hash = hashesRaw[index];
    if (typeof hash !== "string" || !hash.startsWith("0x")) {
      stopped = { at: height, reason: `no hash at height ${height}` };
      break;
    }
    usable.push({ height, hash });
  }
  if (usable.length === 0) return { blocks: [], stopped };

  // Request 2: every body and every events blob, in one batch. Grouped by
  // method rather than interleaved only for readability -- correlation is by
  // id, computed below from the same ordering, never from position.
  const calls: ChainRpcBatchCall[] = [
    ...usable.map(({ hash }) => ({
      method: "chain_getBlock",
      params: [hash] as unknown[],
    })),
    ...usable.map(({ hash }) => ({
      method: "state_getStorage",
      params: [SYSTEM_EVENTS_STORAGE_KEY, hash] as unknown[],
    })),
  ];
  const results = await chainRpcBatch(url, calls, { fetchImpl });

  const blocks: RawBlockCapture[] = [];
  for (const [index, { height, hash }] of usable.entries()) {
    // TOTAL by construction: chainRpcBatch returns exactly one result per call,
    // in the caller's order, and both indices are inside the array it was
    // handed -- an unanswered call comes back as `{ok: false}`, not as a hole.
    // A presence check here would be a branch nothing can reach.
    const body = results[index]!;
    const events = results[index + usable.length]!;
    if (!body.ok) {
      stopped = { at: height, reason: body.error };
      break;
    }
    if (!events.ok) {
      stopped = { at: height, reason: events.error };
      break;
    }
    const assembled = assembleRawBlock(
      height,
      hash,
      body.result,
      events.result,
      now,
    );
    if ("error" in assembled) {
      stopped = { at: height, reason: assembled.error };
      break;
    }
    blocks.push(assembled.block);
  }
  return { blocks, stopped };
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
  /**
   * The archive endpoints this tick may read from, in preference order.
   *
   * A LIST, NOT A URL, for RELIABILITY -- not for rate. What the list buys is
   * that a host which is down, or which cannot serve historical state at all,
   * stops being a single point of failure for the whole lane. It is
   * deliberately NOT a throughput multiplier; see `chunkGapMs` below for the
   * measurement that says why it does not need to be.
   *
   * THE NO-GAP GUARANTEE IS UNCHANGED, and the rotation is why it needed care:
   * a height that fails on one endpoint is retried on the OTHERS before the
   * tick gives up, and the tick still stops at the first height NO endpoint
   * could serve. So a single flaky host degrades throughput instead of pinning
   * the watermark, and nothing is ever skipped.
   *
   * Must be non-empty; a caller with one endpoint passes a one-element list,
   * which behaves exactly as the single-URL form did.
   */
  rpcUrls: readonly string[];
  store: RawCaptureStore;
  watermark: WatermarkStore;
  genesisFloor: number;
  maxPerTick: number;
  /** Which chain these bytes came from. Decides the R2 key prefix only —
   * everything else here is chain-agnostic, because capture never decodes. */
  network?: ChainNetworkId;
  /**
   * Minimum time between the STARTS of two chunk reads, so a tick's requests
   * are spread across it rather than fired as fast as the network allows.
   *
   * The endpoint's limit is per MINUTE, so an unpaced tick is bounded by one
   * minute's allowance however long the tick runs -- which is what pinned the
   * testnet cap at 32 blocks (#9430). Pacing makes the tick's own span the
   * budget instead. Zero (the default) keeps the previous behaviour exactly.
   *
   * MEASURED FROM THE START OF THE PREVIOUS CHUNK, not slept flat after it.
   * A fixed post-work sleep makes the real cycle `gap + latency`, so the tick
   * overruns its interval by however long the reads took -- tolerable when a
   * read was one small call, not when a chunk is ~1.4 s of transfer. Pacing on
   * the cycle keeps the request RATE at exactly the budget whatever the
   * latency, and a chunk slower than the gap simply paces itself.
   */
  minGapMs?: number;
  /**
   * Blocks per chunk: one batched read AND one durable write.
   *
   * The read and the flush are the same boundary on purpose. A chunk costs two
   * requests regardless of its size, so reading in chunks and then writing on
   * some other rhythm would only add ways for an invocation to die holding
   * unwritten bytes.
   *
   * Bounded by the node's own stated batch limit -- see MAX_RPC_BATCH_CALLS.
   */
  flushEvery?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injectable so a test asserts the PACING without waiting for it. A real
   * timer is not dependable under the shared-registry pass (#9123). */
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<CaptureResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const minGapMs = deps.minGapMs ?? 0;
  // CLAMPED to what the node will actually answer, whatever the caller asks.
  // A chunk is one batch, and a batch over the node's limit is refused whole
  // (see MAX_RPC_BATCH_CALLS) -- so an over-large `flushEvery` would not read
  // more per request, it would read NOTHING and stall the lane at its
  // watermark. `Infinity`, the previous "write once at the end" default,
  // lands on the cap by the same clamp.
  const flushEvery = Math.min(
    Math.max(1, Math.trunc(deps.flushEvery ?? MAX_CAPTURE_CHUNK_BLOCKS)),
    MAX_CAPTURE_CHUNK_BLOCKS,
  );
  const sleepFn =
    deps.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoints = deps.rpcUrls;
  if (endpoints.length === 0) {
    throw new Error("captureTick: rpcUrls is empty; nothing to read from");
  }
  // THE GAP IS NOT DIVIDED BY THE ENDPOINT COUNT, and briefly was -- but the
  // reason given for removing it was wrong, so here is what was measured.
  //
  // #9378 concluded the limit was per CLIENT: after exhausting it on one host,
  // a DIFFERENT host refused too. Re-measured 2026-08-16 against the endpoints
  // this lane actually reads, that does not hold. Exhausting
  // archive.chain.opentensor.ai (429 after 79 requests) and then immediately
  // draining lite.chain.opentensor.ai got a FULL fresh allowance -- 100
  // requests before its own 429. The buckets are per BACKEND NODE.
  //
  // What made the old measurement look client-wide is that the names are not
  // the nodes. `entrypoint-finney.opentensor.ai` is a CNAME to
  // `lite.chain.opentensor.ai`, both resolving to 65.109.251.221, while
  // archive answers from 65.109.254.0 -- so draining "another host" drained
  // the same machine, and it returned 0 requests. Two of the three mainnet
  // names in the registry are one node.
  //
  // THE DIVISOR STAYS OUT ANYWAY, on a better reason than a wrong ceiling:
  // there is nothing left to buy. A chunk is two requests whatever its size,
  // so one node's ~100 requests/minute already funds hundreds of blocks per
  // minute against a chain producing five. Multiplying an allowance the lane
  // cannot spend would only add a rotation that has to be right about which
  // names share a machine -- a fact DNS is free to change under us. The
  // rotation stays what it is: FAILOVER and archive coverage, not rate.
  const chunkGapMs = minGapMs;
  const stored = await deps.watermark.read();
  // An unset watermark starts just below the floor, so the first tick captures
  // the floor block itself rather than skipping it.
  const lastContiguous =
    typeof stored === "number" && Number.isInteger(stored)
      ? stored
      : deps.genesisFloor - 1;

  // The head comes from whichever endpoint answers FIRST, not from a fixed one:
  // a tick must not be lost because the preferred host is down when every other
  // host could have served the whole run.
  let headRaw: { number?: unknown } | null = null;
  let headError: unknown = null;
  for (const url of endpoints) {
    try {
      headRaw = (await rpc(url, "chain_getHeader", [], fetchImpl)) as {
        number?: unknown;
      };
      break;
    } catch (error) {
      headError = error;
    }
  }
  if (headRaw === null) {
    const detail = String((headError as Error)?.message ?? headError);
    // One endpoint's failure IS the lane's failure, and its message is already
    // the whole story -- rewrapping it would only bury the cause a caller
    // greps for. The "no endpoint answered" framing is a claim about a SET, so
    // it is only made when there was one.
    throw new Error(
      endpoints.length > 1
        ? `chain_getHeader: no endpoint answered (${detail})`
        : detail,
    );
  }
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

  // FLUSHED IN CHUNKS, NOT AT THE END. Holding a whole tick in memory and
  // writing once meant a tick could only be as long as we were willing to lose
  // -- an invocation killed by a redeploy discarded everything it had read. So
  // a paced tick, which is the only way to use a per-MINUTE budget across a
  // five-minute interval, was unaffordable (#9430).
  //
  // The no-gap guarantee is unchanged, and rests on the same ordering it always
  // did: bytes durable FIRST, watermark only after. The watermark therefore
  // never claims a height whose object is missing, so a retry re-reads exactly
  // the range that did not land -- from the same `lastContiguous`, producing
  // the same chunk boundaries and the same key, overwriting byte-for-byte
  // rather than appending a duplicate.
  const flush = async (batch: RawBlockCapture[]) => {
    const first = batch[0]!.block_number;
    const last = batch[batch.length - 1]!.block_number;
    await deps.store.put(
      rawBatchKey(first, last, deps.network),
      batch.map((b) => JSON.stringify(b)).join("\n") + "\n",
    );
    // Only now -- the bytes are durable, so the watermark may claim them.
    await deps.watermark.write(last);
    return last;
  };

  let captured = 0;
  let watermark = lastContiguous;
  let stoppedAt: number | undefined;
  let reason: string | undefined;
  let chunkIndex = 0;
  // When the previous chunk's read STARTED, so the gap paces the cycle rather
  // than being added on top of it (see `minGapMs`).
  let previousChunkStartedAt: number | null = null;
  for (let offset = 0; offset < heights.length; offset += flushEvery) {
    const chunkHeights = heights.slice(offset, offset + flushEvery);
    // BEFORE the read, and never before the first: the gap belongs between two
    // chunks' bursts, so pacing never delays a tick that captures one chunk.
    if (previousChunkStartedAt !== null && chunkGapMs > 0) {
      const remaining = chunkGapMs - (now() - previousChunkStartedAt);
      if (remaining > 0) await sleepFn(remaining);
    }
    previousChunkStartedAt = now();

    let chunk: RawBlockChunk | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < endpoints.length; attempt += 1) {
      const url = endpoints[(chunkIndex + attempt) % endpoints.length]!;
      try {
        const got = await fetchRawBlockChunk(url, chunkHeights, fetchImpl, now);
        chunk = got;
        if (got.blocks.length > 0) break;
        // Captured NOTHING: this host cannot serve the very next height, which
        // is the case rotation exists for. A PARTIAL chunk is not retried --
        // its prefix is already good, and the height it stopped at leads the
        // next tick's first chunk, where a zero-length read rotates then.
        //
        // `stopped` is non-null here by construction: `chunkHeights` is a
        // non-empty slice, and the only way to come back with no blocks from a
        // non-empty ask is to have stopped somewhere and said why.
        lastError = new Error(got.stopped!.reason);
      } catch (error) {
        // NOT a gap yet: another endpoint may hold these heights. Only a chunk
        // NO endpoint can start stops the tick.
        lastError = error;
      }
    }
    chunkIndex += 1;

    if (chunk === null || chunk.blocks.length === 0) {
      // Stop at the FIRST failure and keep what earlier chunks wrote.
      // Continuing past it would create exactly the hole this module exists to
      // prevent.
      stoppedAt = chunkHeights[0];
      reason = String((lastError as Error)?.message ?? lastError);
      break;
    }

    // Durable FIRST, watermark after -- the ordering the guarantee rests on.
    watermark = await flush(chunk.blocks);
    captured += chunk.blocks.length;

    // A short chunk means the run ended inside it. Its prefix is written; the
    // height it stopped at is where the next tick resumes.
    if (chunk.stopped !== null) {
      stoppedAt = chunk.stopped.at;
      reason = chunk.stopped.reason;
      break;
    }
  }

  if (captured === 0) {
    return {
      captured: 0,
      watermark: lastContiguous,
      behind: head - lastContiguous,
      stoppedAt,
      reason,
    };
  }

  return {
    captured,
    watermark,
    behind: head - watermark,
    stoppedAt,
    reason,
  };
}
