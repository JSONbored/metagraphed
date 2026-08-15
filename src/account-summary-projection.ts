// The account summary card's aggregate leg, served from a SHARDED PROJECTION
// artifact instead of scanning the lakehouse per request (#11131).
//
// WHAT THIS REPLACES. `/api/v1/accounts/{ss58}` asks its aggregate leg for
// per-(event_kind, netuid) totals over one account's whole history, which is
// `(hotkey = X OR coldkey = X)` against 455M rows in 51 files. An account value
// is scattered across every file, so statistics cannot prune it and the engine
// opens all of them: measured against production 2026-08-14, 4,374 MB and ~14s
// PER REQUEST, and it is the read that aborts at the 15s r2-sql ceiling.
//
// #11141 bounded every FEED on that table -- a page went 1,068.9 MB -> 3.0 MB --
// but a lifetime aggregate has no window that answers it. Proving an account has
// fewer than N events means reading its whole history, so the scan has to
// happen; the only question is once per request or once per day. This is once
// per day, in the infra container that already runs the sibling rollups
// (metagraphed-infra#557).
//
// WHY SHARDED R2 AND NOT ANOTHER LAKEHOUSE TABLE. Because `account` would be a
// scattered key there too -- a rollup keyed on it opens most of its own files
// for a point lookup exactly as the source does, which shrinks the table ~5x and
// cures nothing. #11133 measured that bucketing on a scattered key trades bytes
// for R2 requests at a bad rate. This route is a POINT LOOKUP by a
// high-cardinality key, and ~1.2M accounts over 256 objects is one GET.
//
// WHY NOT `chain.account_events_daily`, which already exists. Its rule is
// `hotkey IS NOT NULL AND netuid IS NOT NULL`, deliberately, so Transfer and
// Deposit (coldkey, no netuid) and WeightsSet (no hotkey) are absent. For
// 5EYCAe5jLQhn6ofDSvqF... it holds no row on any day against 1,343,321
// both-side events on 2026-07-10 alone. Reading it here would have published a
// 284x undercount.
//
// THE PUBLISH IS ATOMIC, which is why this reads a POINTER first. 16,384 PUTs
// are not a transaction: a producer run that dies partway would otherwise leave
// half the fleet on today's aggregates and half on yesterday's -- and no
// freshness bound can catch that, because the stale half is not old, it is one
// day old. The producer writes each generation to a directory nothing reads and
// flips `current.json` only once every shard has landed, so a failed run leaves
// the previous generation whole. Stale-but-COHERENT is detectable; half-updated
// is not.
//
// The pointer also DECLARES the fan-out, which retires a constant that lived in
// two repositories with nothing able to enforce the pair -- no CI can diff a
// python function against a typescript one. The producer owns the number now
// and this reads it.
//
// THE FALLBACK IS THE POINT. A missing shard, an unparseable body, an account
// the projection has not seen -- every one of them returns null, and the caller
// runs exactly the lakehouse query it runs today. So this can only make the
// route faster, never wrong, and shipping it before the producer has backfilled
// is safe by construction.

import { ACCOUNT_EVENT_SUMMARY_SCAN_CAP } from "./account-events.ts";
import { AccountSummaryPointerSchema } from "../schemas-src/artifacts/account-summary-projection.ts";

/** Objects the producer writes, one per shard. Contract with
 * metagraphed-infra's `services/indexer-rs/account_summary_r2.py`. */
export const ACCOUNT_SUMMARY_PROJECTION_PREFIX =
  "metagraph/projections/account-summary";

/** Names the generation currently readable, and the fan-out it was built with. */
export const ACCOUNT_SUMMARY_POINTER_KEY = `${ACCOUNT_SUMMARY_PROJECTION_PREFIX}/current.json`;

/** The payload shape this reader understands. A producer that changes a field's
 * MEANING bumps it, and this declines rather than misreading the new one. */
export const ACCOUNT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * How old a published generation may be before this stops trusting it.
 *
 * Three days against a producer whose own floor is 20 hours: it clears a missed
 * run, an overrunning one and a container redeploy, while still catching a dead
 * lane in days rather than never. Past it the route returns to the lakehouse
 * read it used before the projection existed -- slower, correct, and
 * self-healing the moment the producer recovers.
 */
export const ACCOUNT_SUMMARY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * FNV-1a over the address, mod the fan-out the POINTER declares.
 *
 * `Math.imul` and `>>> 0` are not decoration: javascript numbers are doubles, so
 * a plain `h * 0x01000193` loses the low bits past 2^53 and yields a different
 * hash from the producer's python. Tests pin three known values against it.
 */
export function accountShard(account: string, shards: number): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(account)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** The R2 key holding this account's groups, within a generation. */
export function accountSummaryShardKey(
  account: string,
  shards: number,
  generation: string,
): string {
  return `${ACCOUNT_SUMMARY_PROJECTION_PREFIX}/${generation}/${accountShard(account, shards)}.json`;
}

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/** One (event_kind, netuid) group, in the producer's field names. */
interface ProjectedGroup {
  kind: unknown;
  netuid: unknown;
  count: unknown;
  fb: unknown;
  lb: unknown;
  fo: unknown;
  lo: unknown;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readJson(
  bucket: ArtifactBucket,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const body = await object.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    // Unfetchable or unparseable is not a fault to report: the caller reads the
    // lakehouse and answers correctly, just slower.
    return null;
  }
}

/**
 * One account's aggregate groups, in the column aliases `foldSummaryGroups`
 * already reads -- so the projection feeds the SAME builder the lakehouse query
 * feeds, and nothing downstream learns which one answered.
 *
 * Returns null -- meaning "ask the lakehouse" -- for every condition that is not
 * an answer: no binding, no pointer, a schema this does not understand, a
 * generation too old to trust, a shard that will not parse, or an account the
 * projection has not seen.
 *
 * THE CAP KEEPS ITS MEANING. The caller derives `scanned` from the summed group
 * counts and clamps it, so an account over the cap reports `event_scan_capped`
 * and null `first_*` whichever tier answered. The projection knows the true
 * lifetime total and publishing it would be a better number -- but a route
 * whose meaning depends on its tier is worse than either.
 */
export async function loadAccountSummaryProjection(
  env: Env | null | undefined,
  account: string,
  {
    now = Date.now,
    maxAgeMs = ACCOUNT_SUMMARY_MAX_AGE_MS,
  }: { now?: () => number; maxAgeMs?: number } = {},
): Promise<Record<string, unknown>[] | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !account) return null;

  // PARSED, not indexed. The producer is in another repository, so the only
  // thing that can hold the two ends together is a written-down shape --
  // `AccountSummaryPointerSchema` is that, and the rules it encodes (a STRING
  // `generated_at`, a POSITIVE INTEGER `shard_count`) are the two the previous
  // hand-rolled checks existed to enforce. See the schema's header for why each
  // one is load-bearing.
  const parsedPointer = AccountSummaryPointerSchema.safeParse(
    await readJson(bucket, ACCOUNT_SUMMARY_POINTER_KEY),
  );
  if (!parsedPointer.success) return null;
  const pointer = parsedPointer.data;
  if (pointer.schema_version !== ACCOUNT_SUMMARY_SCHEMA_VERSION) return null;
  const shards = pointer.shard_count;
  const generation = pointer.generation;
  const generated = Date.parse(pointer.generated_at);
  if (!Number.isFinite(generated)) return null;
  if (maxAgeMs > 0 && now() - generated > maxAgeMs) return null;

  const payload = await readJson(
    bucket,
    accountSummaryShardKey(account, shards, generation),
  );
  if (!payload) return null;
  const accounts = payload["accounts"];
  if (!accounts || typeof accounts !== "object") return null;
  const raw = (accounts as Record<string, unknown>)[account];
  if (!Array.isArray(raw)) return null;

  const groups: Record<string, unknown>[] = [];
  for (const entry of raw as ProjectedGroup[]) {
    if (!entry || typeof entry !== "object") continue;
    groups.push({
      kind: entry.kind ?? null,
      netuid: entry.netuid ?? null,
      count: finite(entry.count) ?? 0,
      fb: entry.fb ?? null,
      lb: entry.lb ?? null,
      fo: entry.fo ?? null,
      lo: entry.lo ?? null,
    });
  }
  // An account present with no usable groups is not an answer -- the caller
  // reads the lakehouse rather than publishing an empty card from a shard.
  if (!groups.length) return null;

  // AN ACCOUNT OVER THE CAP IS NOT THIS TIER'S TO ANSWER.
  //
  // The projection aggregates an account's WHOLE history. The live path
  // aggregates the newest ACCOUNT_EVENT_SUMMARY_SCAN_CAP events. Below the cap
  // those are the same set, so the answers are identical -- above it they are
  // not, and the difference is invisible in `event_count` (both clamp to CAP)
  // while `event_kinds` and `subnet_count` silently widen to lifetime.
  //
  // Measured on 5Fv5t8frGG3MKt...: the live path reports 4 kinds across 2
  // subnets, the projection 10 across 3. Same route, different answer depending
  // on which tier served it, which is worse than either answer alone.
  //
  // So this declines above the cap and the lakehouse answers, exactly as it did
  // before the projection existed. That is a small minority of accounts -- the
  // cap is 5,000 lifetime events -- and it costs them nothing they were not
  // already paying.
  const scanned = groups.reduce((n, g) => n + Number(g.count), 0);
  if (scanned > ACCOUNT_EVENT_SUMMARY_SCAN_CAP) return null;
  return groups;
}
