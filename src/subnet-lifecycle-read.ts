// Reading `subnet_lifecycle` (#10263). The write half is src/subnet-lifecycle.ts.
//
// Two questions, two shapes. "What has this subnet done" is a HISTORY, keyed by
// netuid. "What changed on the network lately" is a FEED, and a feed carries
// the netuid on every row. Same table, same formatter, different envelopes --
// folding them into one would make `netuid` conditionally meaningful.
//
// ## Neon only, no cold tier
//
// The sibling history routes fall back to the lakehouse for deep pages. This
// one deliberately does not: the whole table is a handful of rows per subnet
// per lifetime (129 seed rows today), so there is no depth at which Neon stops
// being the right answer, and a second tier would be a second place for the
// event list to disagree with itself.
import type {
  ChainSubnetLifecycleArtifact,
  SubnetLifecycleArtifact,
  SubnetLifecycleEntry,
} from "../schemas-src/routes/subnet-lifecycle.ts";
import { readStore, type ReadStoreDb } from "./read-store.ts";

/** The columns every read here selects, in one place. */
const COLUMNS = "netuid, event, block_number, observed_at, predates_capture";

/**
 * The chain-wide feed's page bounds, declared here and imported by
 * `schemas-src/route-queries.ts` -- the same shape
 * `CHAIN_DEREGISTRATIONS_LIMIT_*` uses, so the published `maximum` and the
 * bound `parseLimitParam` enforces cannot drift apart.
 *
 * The ceiling is 1000 rather than the family's usual 100 because the whole
 * table is a few hundred rows: a client that wants the complete lifecycle of
 * the network should be able to ask for it in one request instead of paging a
 * feed that will never be large. `parseLimitParam` REJECTS above this; it does
 * not clamp.
 */
export const CHAIN_SUBNET_LIFECYCLE_LIMIT_DEFAULT = 50;
export const CHAIN_SUBNET_LIFECYCLE_LIMIT_MAX = 1000;

/**
 * The feed's default window.
 *
 * The window VALUES come from `HISTORY_WINDOWS` (src/neuron-history.ts) -- one
 * vocabulary, not a second map. Only the default differs, and deliberately: a
 * subnet registers or deregisters a handful of times in its life, so
 * `DEFAULT_HISTORY_WINDOW`'s 30d would answer "nothing happened" almost always.
 */
export const DEFAULT_SUBNET_LIFECYCLE_WINDOW = "all";

function formatEntry(
  row: Record<string, unknown>,
): SubnetLifecycleEntry | null {
  const netuid = Number(row.netuid);
  const event = String(row.event);
  if (!Number.isInteger(netuid)) return null;
  if (event !== "registered" && event !== "deregistered") return null;
  const block = Number(row.block_number);
  const observedAt = Number(row.observed_at);
  return {
    netuid,
    event,
    // NULL stays NULL. A lifecycle event with no block is a real answer --
    // it predates capture, or the detecting pass could not attribute one --
    // and coercing it to 0 would read as "block zero", which is a claim.
    block_number: Number.isFinite(block) && block > 0 ? block : null,
    observed_at: Number.isFinite(observedAt)
      ? new Date(observedAt).toISOString()
      : "",
    predates_capture: row.predates_capture === true,
  };
}

function formatEntries(rows: unknown[]): SubnetLifecycleEntry[] {
  return (rows as Record<string, unknown>[])
    .map(formatEntry)
    .filter((r): r is SubnetLifecycleEntry => r !== null);
}

/**
 * One subnet's transitions, newest first.
 *
 * Returns null when there is no store to read -- distinct from an empty list,
 * which means "this subnet has no recorded transitions". The caller turns the
 * first into a decline and the second into a 200 with `entries: []`, because
 * "we cannot answer" and "the answer is none" are different facts.
 */
export async function loadSubnetLifecycle(
  env: unknown,
  netuid: number,
  { limit, offset }: { limit: number; offset: number },
  injected?: ReadStoreDb | null,
): Promise<SubnetLifecycleEntry[] | null> {
  const db = readStore(env, ["subnet_lifecycle"], injected);
  if (!db) return null;
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM subnet_lifecycle WHERE netuid = ? ` +
        "ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(netuid, limit, offset)
    .all();
  return formatEntries(results ?? []);
}

/** The network-wide feed, newest first, optionally windowed by `since`. */
export async function loadChainSubnetLifecycle(
  env: unknown,
  {
    limit,
    offset,
    sinceMs,
  }: { limit: number; offset: number; sinceMs?: number | null },
  injected?: ReadStoreDb | null,
): Promise<SubnetLifecycleEntry[] | null> {
  const db = readStore(env, ["subnet_lifecycle"], injected);
  if (!db) return null;
  const windowed =
    Number.isFinite(sinceMs as number) && (sinceMs as number) > 0;
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM subnet_lifecycle ` +
        (windowed ? "WHERE observed_at >= ? " : "") +
        "ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(...(windowed ? [sinceMs, limit, offset] : [limit, offset]))
    .all();
  return formatEntries(results ?? []);
}

/** The per-subnet envelope. */
export function buildSubnetLifecycle(
  rows: SubnetLifecycleEntry[] | null | undefined,
  netuid: number,
  { limit, offset }: { limit?: number | null; offset?: number | null } = {},
): SubnetLifecycleArtifact {
  const entries = rows ?? [];
  return {
    schema_version: 1,
    netuid,
    entry_count: entries.length,
    limit: limit ?? null,
    offset: offset ?? null,
    // A cursor would have to encode (observed_at, id) to be stable against
    // concurrent appends. The table is small enough that limit/offset cannot
    // drift meaningfully within a page, so it stays null rather than shipping
    // a token that only looks resumable.
    next_cursor: null,
    entries,
  };
}

/** The network-wide envelope. */
export function buildChainSubnetLifecycle(
  rows: SubnetLifecycleEntry[] | null | undefined,
  { limit, offset }: { limit?: number | null; offset?: number | null } = {},
): ChainSubnetLifecycleArtifact {
  const entries = rows ?? [];
  return {
    schema_version: 1,
    entry_count: entries.length,
    subnet_count: new Set(entries.map((e) => e.netuid)).size,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: null,
    entries,
  };
}
