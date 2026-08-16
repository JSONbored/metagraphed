// How far the lakehouse tier has observed at all, as a wall-clock instant.
//
// WHAT IT ANSWERS. `/api/v1/accounts/{ss58}/events` returning `event_count: 0`
// is the CORRECT answer for a valid ss58 with no activity -- "absent is null,
// never zero" is a settled contract rule and these routes stay on it. But it is
// also what the reader returns when the tier's coverage has not reached the
// account yet, and until this the two were the same bytes. Measured 2026-08-16:
// an account registered at 13:53 read as an empty account for a full day,
// because the lakehouse's coverage ended at 02:30 that morning and no field
// said so.
//
// WHY NOT `max(observed_at)` ON THE TABLE. That is the literal answer and the
// wrong query: `chain.account_events` is the unpartitioned table whose
// unprunable scans this whole area exists to avoid, and a coverage marker that
// costs a full scan per request would be more expensive than the reads it
// annotates.
//
// SO IT IS DERIVED FROM THE DECODE WATERMARK, which is the same number the
// serving path already routes on. `decodedThrough` is defined as the highest
// block for which ALL FOUR decoded tables hold rows (src/decode-watermark.ts),
// so it IS `chain.account_events`' ceiling -- in blocks. `blocks_head` maps a
// block to the instant it was observed, so one indexed point lookup converts
// the unit the tier knows into the unit the field publishes.
//
// WHY A TIMESTAMP AND NOT THE BLOCK. The field name and semantics are already
// published on /subnets/{netuid}/ownership-history as an ISO instant, and one
// field name carrying two units across routes is worse than a conversion.
//
// NULL IS A REAL ANSWER, and it is PUBLISHED rather than omitted. No watermark,
// no `blocks_head` row for it, no store binding: every one yields null, and the
// caller stamps that null. A consumer trusts a horizon it is given, so an
// invented one is worse than none -- the same reason `recentFloorMs` refuses a
// pointer with no `through` -- and dropping the key instead would make "this
// tier publishes no horizon" indistinguishable from "it could not be read this
// tick", which is the same conflation this field exists to end.

import { registerModuleStateReset } from "./module-state-registry.ts";
import { resolveDecodeWatermark } from "./decode-watermark.ts";
import { readStore } from "./read-store.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";

/**
 * How long a resolved horizon is reused.
 *
 * The same TTL the decode watermark itself uses, and deliberately not a
 * different one: this value is a pure function of that watermark, so a shorter
 * TTL would re-read `blocks_head` for a watermark that cannot have moved, and a
 * longer one would keep publishing a horizon after the watermark it was derived
 * from had already advanced.
 */
export const OBSERVED_THROUGH_TTL_MS = 5 * 60 * 1000;

/** Resolved value plus its expiry, keyed by network for the same reason the
 * decode watermark's memo is: a horizon is a chain-specific instant, and
 * handing one network's to another would publish a coverage claim about a chain
 * that was never read. The PROMISE is memoized so a cold isolate issues one
 * lookup rather than racing several. */
const memo = new Map<
  ChainNetworkId,
  { expiresAt: number; value: Promise<string | null> }
>();

registerModuleStateReset("src/lakehouse-observed-through.ts", () => {
  memo.clear();
});

/** Drop the memo so the next resolve re-reads. Exported for tests. */
export function resetObservedThroughCache(): void {
  memo.clear();
}

export interface ObservedThroughDeps {
  now?: () => number;
  /** Bypass the memo, for a caller that has just seen the watermark move. */
  fresh?: boolean;
}

async function readObservedThrough(
  env: unknown,
  network: ChainNetworkId,
): Promise<string | null> {
  const watermark = await resolveDecodeWatermark(env, {}, network).catch(
    () => null,
  );
  const through = watermark?.decodedThrough;
  if (
    typeof through !== "number" ||
    !Number.isFinite(through) ||
    through <= 0
  ) {
    return null;
  }
  const db = readStore(env, ["blocks_head"]);
  if (!db?.first) return null;
  try {
    // Equality, not `<=` with an ORDER BY: the watermark names a block the
    // decoder finished, so the row either exists or the head register has not
    // caught up -- and answering with some OLDER block's timestamp would
    // publish a horizon earlier than the one actually served.
    const row = (await db.first(
      "SELECT observed_at FROM blocks_head WHERE block_number = $1",
      [through],
    )) as { observed_at?: unknown } | null;
    const at = Number(row?.observed_at);
    if (!Number.isFinite(at) || at <= 0) return null;
    const iso = new Date(at).toISOString();
    return iso;
  } catch {
    return null;
  }
}

/**
 * The lakehouse tier's coverage ceiling as an ISO instant, or null.
 *
 * Null is cached exactly like a hit, for the reason `resolveDecodeWatermark`
 * gives for doing the same: a deployment with no watermark (self-hosters, CI,
 * the window before the decoder first publishes) must not pay a miss on every
 * cold read.
 */
export async function resolveObservedThrough(
  env: unknown,
  deps: ObservedThroughDeps = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<string | null> {
  if (deps.fresh) return readObservedThrough(env, network);
  const now = (deps.now ?? Date.now)();
  const cached = memo.get(network);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = readObservedThrough(env, network);
  memo.set(network, { expiresAt: now + OBSERVED_THROUGH_TTL_MS, value });
  return value;
}
