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
// THE FALLBACK IS THE POINT. A missing shard, an unparseable body, an account
// the projection has not seen -- every one of them returns null, and the caller
// runs exactly the lakehouse query it runs today. So this can only make the
// route faster, never wrong, and shipping it before the producer has backfilled
// is safe by construction.

/** Objects the producer writes, one per shard. Contract with
 * metagraphed-infra's `services/indexer-rs/account_summary_r2.py`. */
export const ACCOUNT_SUMMARY_PROJECTION_PREFIX =
  "metagraph/projections/account-summary";

/**
 * How many shards the producer fans accounts across.
 *
 * SIZED FROM THE REAL PAYLOAD, because this number is what the route pays PER
 * REQUEST -- one whole shard is fetched to answer for one account. Measured:
 * 5,025,347 (account, event_kind, netuid) groups across ~1.2M accounts, 106 B
 * of JSON per group plus 53 B per account key, so ~601 MB in total:
 *
 *     shards    per shard   accounts/shard
 *        256      2294 KB             4688
 *       1024       573 KB             1172
 *       4096       143 KB              293
 *      16384        36 KB               73
 *
 * 16384 keeps a request at ~36 KB, against the 4,374 MB scan it replaces.
 *
 * MUST match `ACCOUNT_SUMMARY_SHARDS` on the writer. A mismatch does not error:
 * both sides compute a shard number happily and simply disagree about which
 * object holds an account, so every lookup misses and the route silently falls
 * back to the scan this exists to avoid. That is why the number is stated here
 * as a constant rather than read from the artifact -- a reader that trusted the
 * body's own `shard_count` could not detect the disagreement, because it would
 * have to fetch the right object first to learn it was fetching the wrong one.
 */
export const ACCOUNT_SUMMARY_SHARDS = 16384;

/** The payload shape this reader understands. A producer that changes a field's
 * MEANING bumps it, and this declines rather than misreading the new one. */
export const ACCOUNT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * FNV-1a over the address, mod `shards`.
 *
 * MIRRORED EXACTLY from the producer's `shard_of`. A prefix scheme would read
 * more simply, but every Bittensor ss58 starts '5' and the following characters
 * are far from uniform, so prefix buckets differ by orders of magnitude and one
 * object ends up holding most of the fleet.
 *
 * `Math.imul` and `>>> 0` are not decoration: javascript numbers are doubles, so
 * a plain `h * 0x01000193` loses the low bits past 2^53 and yields a different
 * hash from python's -- which is exactly the class of difference that agrees on
 * every ASCII test address and disagrees in production. tests pin three known
 * values against the producer's own.
 */
export function accountShard(
  account: string,
  shards: number = ACCOUNT_SUMMARY_SHARDS,
): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(account);
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** The R2 key holding this account's groups. */
export function accountSummaryShardKey(
  account: string,
  shards: number = ACCOUNT_SUMMARY_SHARDS,
): string {
  return `${ACCOUNT_SUMMARY_PROJECTION_PREFIX}/${accountShard(account, shards)}.json`;
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

/**
 * One account's aggregate groups, in the column aliases `foldSummaryGroups`
 * already reads -- so the projection feeds the SAME builder the lakehouse query
 * feeds, and nothing downstream learns which one answered.
 *
 * THE CAP STILL MEANS WHAT IT MEANT. The caller derives `scanned` from the
 * summed group counts and clamps it to ACCOUNT_EVENT_SUMMARY_SCAN_CAP, so an
 * account over the cap reports `event_scan_capped: true` and null `first_*`
 * whichever tier answered. The projection knows the true lifetime total and
 * publishing it would be a better number -- but a route whose meaning depends
 * on which tier served it is worse than either, so that is a contract change
 * and not this one.
 *
 * Returns null -- meaning "ask the lakehouse" -- for every condition that is
 * not an answer: no bucket bound, no object, a body this reader does not
 * understand, or an account the projection has not seen. None of those is an
 * error worth surfacing, because the caller's existing path handles all of
 * them by doing what it did before.
 */
export async function loadAccountSummaryProjection(
  env: Env | null | undefined,
  account: string,
  { shards = ACCOUNT_SUMMARY_SHARDS }: { shards?: number } = {},
): Promise<Record<string, unknown>[] | null> {
  // Same binding the thirteen sibling projections read from.
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !account) return null;
  let body: unknown;
  try {
    const object = await bucket.get(accountSummaryShardKey(account, shards));
    if (!object) return null;
    body = await object.json();
  } catch {
    // A shard that cannot be fetched or parsed is not a fault to report: the
    // caller reads the lakehouse and answers correctly, just slower.
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const payload = body as Record<string, unknown>;
  if (Number(payload["schema_version"]) !== ACCOUNT_SUMMARY_SCHEMA_VERSION) {
    return null;
  }
  // A shard written for a DIFFERENT fan-out is not this account's shard, even
  // though the object exists and parses -- it is the wrong bucket of the wrong
  // partitioning, so its absence of this account proves nothing.
  const declared = finite(payload["shard_count"]);
  if (declared !== null && declared !== shards) return null;

  const accounts = payload["accounts"];
  if (!accounts || typeof accounts !== "object") return null;
  const raw = (accounts as Record<string, unknown>)[account];
  if (!Array.isArray(raw)) return null;

  const groups: Record<string, unknown>[] = [];
  for (const entry of raw as ProjectedGroup[]) {
    if (!entry || typeof entry !== "object") continue;
    // Renamed to the column aliases `foldSummaryGroups` already reads, so the
    // projection feeds the SAME builder the lakehouse query feeds and nothing
    // downstream learns which one answered.
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
  return groups;
}
