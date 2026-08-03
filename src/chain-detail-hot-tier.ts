// Block drill-down for the range the lakehouse has not decoded yet (#9208).
//
// THE SHAPE OF THE PROBLEM. `blocks_head` carries block HEADERS to chain tip,
// so the block LIST is realtime; extrinsics and events exist only in the R2
// lakehouse, and only once the hourly batch decoder has run. Measured in
// production against head 8,762,608 (2026-08-03): block 8,759,000 answered 29
// extrinsics and 100 events, block 8,762,600 answered 0 and 0. A block explorer
// whose list is live and whose DETAIL is empty is the worst possible shape --
// it looks healthy until someone clicks.
//
// So there are now two tiers per block, exactly as there already are for
// headers, and this module is the hot one plus the routing between them:
//
//   block_number <= seam  ->  R2 lakehouse (verified history, full depth)
//   block_number >  seam  ->  D1 chain_detail_* (the live-follow lane's window)
//
// ONE SEAM, AND IT IS THE SAME SEAM. `resolveBlocksSeam` (src/blocks-cold-tier.ts,
// #9217) resolves the decoder's own published watermark, floored by the
// configured constant. This module calls it and does not introduce a second
// knob -- "how far is decoded" has exactly one derived answer, and a hot tier
// with its own idea of that answer would be a second source of truth that
// drifts silently in whichever direction nobody is watching.
//
// A GAP DECLINES. It never answers empty. Above the seam, an empty extrinsics
// array is indistinguishable from a block that genuinely had none, and that
// ambiguity IS the bug this whole issue exists to kill. So the hot tier's
// answer is authoritative ONLY for a block present in `chain_detail_blocks` --
// the coverage register the sync writes last. A block above the seam that the
// register does not carry is outside the window (not yet followed, or pruned
// past), and after giving the lakehouse its own chance to answer, the read
// DECLINES. `answerBlockDetail` returns `{kind:"gap"}` and the caller turns it
// into a 503 with a typed code, which a client can retry and a human can
// diagnose; an empty 200 is neither.
//
// THE LAKEHOUSE STILL GETS ASKED above the seam, before any decline. The
// published watermark is the MIN across four tables, so a run that committed
// chain.extrinsics and died before chain.chain_events leaves real rows above
// it -- src/extrinsics-cold-tier.ts's header makes exactly this argument for
// why it refuses to gate on the seam at all. Refusing rows we hold would be the
// same failure in a new place, so the order is: hot, then cold, then decline.

import { buildBlockExtrinsics, buildExtrinsic } from "./extrinsics.ts";
import { buildBlockEvents, formatAccountEvent } from "./account-events.ts";
import { decodeChainEventArgs } from "./chain-event-args.ts";
import { resolveBlocksSeam } from "./blocks-cold-tier.ts";
import { safeBlockNumber } from "./r2-sql.ts";
import { summarizeEvent } from "@jsonbored/chain-summaries";

type Row = Record<string, unknown>;

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all?(): Promise<{ results?: unknown[] } | null>;
  first?(): Promise<unknown>;
}
interface D1Like {
  prepare(sql: string): D1Statement;
}
interface HotTierBindings {
  METAGRAPH_HEALTH_DB?: D1Like;
}

function db(env: unknown): D1Like | null {
  const binding = (env as HotTierBindings | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  return binding?.prepare ? binding : null;
}

/** Rows for one bound query, or null when D1 is unbound or the query fails. A
 * hot-tier failure must never fail the request: the caller falls through to the
 * lakehouse, and past that to a decline, both of which are honest answers. */
async function query(
  env: unknown,
  sql: string,
  params: unknown[],
): Promise<Row[] | null> {
  const binding = db(env);
  if (!binding) return null;
  try {
    const res = await binding
      .prepare(sql)
      .bind(...params)
      .all?.();
    const rows = res?.results;
    return Array.isArray(rows) ? (rows as Row[]) : [];
  } catch {
    return null;
  }
}

/**
 * A non-negative block-shaped integer, or null.
 *
 * This is `safeBlockNumber` itself, re-exported rather than reimplemented. A
 * second parser here would be a second place for a ref to mean something
 * different: a loose `Number(value)` accepts "0xabc" as block 2,748, which
 * would route a short hash to a height the caller never asked for. The R2-SQL
 * module owns the rule because it had to get it right first; this tier binds
 * parameters instead of interpolating them, but the PARSING question is
 * identical and must have one answer.
 */
export { safeBlockNumber as hotBlockNumber };

const BLOCK_HASH = /^0x[0-9a-f]{64}$/i;

/** The columns the extrinsic formatter reads, in the cold tier's order so both
 * tiers hand `formatExtrinsic` the identical shape. */
const EXTRINSIC_COLUMNS =
  "block_number, extrinsic_index, extrinsic_hash, signer, call_module, " +
  "call_function, success, fee_tao, tip_tao, call_args, observed_at";
/** Ditto for account events. */
const ACCOUNT_EVENT_COLUMNS =
  "block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, " +
  "netuid, uid, amount_tao, alpha_amount, observed_at";
/** Ditto for chain events. Exported because the LAKEHOUSE leg of the same
 * route selects it too (src/events-cold-tier.ts): one column list, so the two
 * tiers cannot hand `formatChainEvent` different shapes. */
export const CHAIN_EVENT_COLUMNS =
  "block_number, event_index, pallet, method, args, phase, extrinsic_index, " +
  "observed_at";
/** The cold tier embeds at most this many events in an extrinsic-detail
 * payload; the hot tier embeds the same number so the payload does not change
 * shape across the seam. */
const MAX_EMBEDDED_EVENTS = 50;

export interface ChainDetailCoverage {
  /** Oldest block still resident after the prune. */
  floor: number;
  /** Newest block the lane has written. */
  head: number;
  /** `observed_at` of that newest block, epoch ms. */
  headObservedAt: number | null;
}

/**
 * The window the hot tier currently holds, or null when it holds nothing (a
 * deployment with no lane, CI, the window before the first POST).
 */
export async function chainDetailCoverage(
  env: unknown,
): Promise<ChainDetailCoverage | null> {
  const rows = await query(
    env,
    "SELECT MIN(block_number) AS floor, MAX(block_number) AS head, " +
      "MAX(observed_at) AS observed FROM chain_detail_blocks",
    [],
  );
  const row = rows?.[0];
  const floor = safeBlockNumber(row?.floor);
  const head = safeBlockNumber(row?.head);
  if (floor === null || head === null) return null;
  return { floor, head, headObservedAt: safeBlockNumber(row?.observed) };
}

/** The highest block the lane has synced, for the producer's resume call. */
export async function chainDetailHead(env: unknown): Promise<number | null> {
  return (await chainDetailCoverage(env))?.head ?? null;
}

/**
 * The height a `ref` names IF the hot tier covers it: the number itself for a
 * numeric ref, or the height a block hash resolves to.
 *
 * A hash the register does not carry resolves to null, and the caller falls
 * through to the lakehouse's own hash resolution -- there is no "unknown hash"
 * answer here, because the hot tier only ever knows about a few thousand
 * blocks and absence proves nothing about the other 8.7 million.
 */
async function resolveHotRef(
  env: unknown,
  ref: string,
): Promise<{ height: number; covered: boolean } | null> {
  const asNumber = safeBlockNumber(ref);
  if (asNumber !== null) {
    const rows = await query(
      env,
      "SELECT block_number FROM chain_detail_blocks WHERE block_number = ? LIMIT 1",
      [asNumber],
    );
    return { height: asNumber, covered: Boolean(rows?.length) };
  }
  if (!BLOCK_HASH.test(String(ref).trim())) return null;
  const rows = await query(
    env,
    "SELECT block_number FROM chain_detail_blocks WHERE block_hash = ? LIMIT 1",
    [String(ref).trim().toLowerCase()],
  );
  const height = safeBlockNumber(rows?.[0]?.block_number);
  return height === null ? null : { height, covered: true };
}

/** Every extrinsic in one covered block, in read order. */
export async function loadBlockExtrinsicsHotTier(
  env: unknown,
  ref: string,
  height: number,
  page: { limit: number; offset?: number | null },
): Promise<ReturnType<typeof buildBlockExtrinsics> | null> {
  const limit = safeBlockNumber(page.limit);
  const offset = safeBlockNumber(page.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  const rows = await query(
    env,
    `SELECT ${EXTRINSIC_COLUMNS} FROM chain_detail_extrinsics ` +
      "WHERE block_number = ? ORDER BY extrinsic_index ASC LIMIT ? OFFSET ?",
    [height, limit, offset],
  );
  if (rows === null) return null;
  return buildBlockExtrinsics(rows, ref, height, { limit, offset });
}

/** Every account event in one covered block, in read order. */
export async function loadBlockEventsHotTier(
  env: unknown,
  ref: string,
  height: number,
  page: { limit: number; offset?: number | null },
): Promise<ReturnType<typeof buildBlockEvents> | null> {
  const limit = safeBlockNumber(page.limit);
  const offset = safeBlockNumber(page.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  const rows = await query(
    env,
    `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM chain_detail_account_events ` +
      "WHERE block_number = ? ORDER BY event_index ASC LIMIT ? OFFSET ?",
    [height, limit, offset],
  );
  if (rows === null) return null;
  return buildBlockEvents(rows, ref, height, { limit, offset });
}

export interface ChainEventApi {
  block_number: number | null;
  event_index: number | null;
  pallet: unknown;
  method: unknown;
  args: unknown;
  phase: unknown;
  extrinsic_index: number | null;
  observed_at: number | null;
  summary: string | null;
}

/**
 * One `chain_detail_chain_events` row -> the API event shape.
 *
 * This is the SAME sequence the deleted Postgres tier's `coerceEvent` ran
 * (decode the args, then summarize from the decoded form, never the raw one),
 * with one addition the tiers do not share: Postgres handed back JSONB already
 * parsed into an object, while D1 and the Iceberg lakehouse both hand back the
 * column as TEXT, so the JSON.parse happens here. Malformed text degrades to
 * null args rather than failing the block -- one undecodable event must not
 * empty a block's feed.
 *
 * AN ALREADY-PARSED `args` PASSES STRAIGHT THROUGH, which is what makes this
 * formatter safe to share with the cold tier (#9260). Both live stores hand
 * back a string today, but `String(anObject)` is "[object Object]" -- it would
 * fail to parse and null out the args of EVERY event in the block rather than
 * failing visibly. The type check costs nothing and removes the trap.
 */
export function formatChainEvent(
  row: Row | null | undefined,
): ChainEventApi | null {
  if (!row || typeof row !== "object") return null;
  let parsed: unknown = null;
  if (typeof row.args === "string") {
    try {
      parsed = JSON.parse(row.args);
    } catch {
      parsed = null;
    }
  } else if (row.args != null) {
    parsed = row.args;
  }
  const pallet = (row.pallet as string | null | undefined) ?? null;
  const method = (row.method as string | null | undefined) ?? null;
  const args = decodeChainEventArgs(parsed, { pallet, method });
  return {
    block_number: safeBlockNumber(row.block_number),
    event_index: safeBlockNumber(row.event_index),
    pallet,
    method,
    args,
    phase: row.phase ?? null,
    extrinsic_index: safeBlockNumber(row.extrinsic_index),
    observed_at: safeBlockNumber(row.observed_at),
    // From the DECODED args above, never the raw value: summarizeEvent's
    // templates read the account-decoded, positional-hinted shape.
    summary: summarizeEvent(pallet, method, args) ?? null,
  };
}

/** Every chain event in one covered block, in read order. The payload shape is
 * the one `/api/v1/blocks/{n}/chain-events` has always published. */
export async function loadBlockChainEventsHotTier(
  env: unknown,
  height: number,
): Promise<{
  block_number: number;
  count: number;
  events: ChainEventApi[];
} | null> {
  const rows = await query(
    env,
    `SELECT ${CHAIN_EVENT_COLUMNS} FROM chain_detail_chain_events ` +
      "WHERE block_number = ? ORDER BY event_index ASC",
    [height],
  );
  if (rows === null) return null;
  const events = rows
    .map(formatChainEvent)
    .filter((event): event is ChainEventApi => Boolean(event));
  return { block_number: height, count: events.length, events };
}

/**
 * One extrinsic by `<block>-<index>` or by hash, with the account_events it
 * emitted embedded exactly as the cold tier embeds them.
 *
 * Returns null when the hot tier cannot answer AT ALL (unbound D1, unusable
 * ref, or a row it does not hold) -- deliberately NOT the cold tier's
 * "confirmed absent" payload, because the hot tier's absence is never a
 * confirmation: it holds a few thousand blocks out of 8.7 million.
 */
export async function loadExtrinsicHotTier(
  env: unknown,
  ref: string,
): Promise<ReturnType<typeof buildExtrinsic> | null> {
  const composite = /^(\d+)-(\d+)$/.exec(String(ref).trim());
  let rows: Row[] | null;
  if (composite) {
    const block = safeBlockNumber(composite[1]);
    const index = safeBlockNumber(composite[2]);
    if (block === null || index === null) return null;
    rows = await query(
      env,
      `SELECT ${EXTRINSIC_COLUMNS} FROM chain_detail_extrinsics ` +
        "WHERE block_number = ? AND extrinsic_index = ? LIMIT 1",
      [block, index],
    );
  } else {
    const hash = String(ref).trim();
    if (!BLOCK_HASH.test(hash)) return null;
    rows = await query(
      env,
      `SELECT ${EXTRINSIC_COLUMNS} FROM chain_detail_extrinsics ` +
        "WHERE lower(extrinsic_hash) = ? LIMIT 1",
      [hash.toLowerCase()],
    );
  }
  const row = rows?.[0];
  if (!row) return null;

  const block = safeBlockNumber(row.block_number);
  const index = safeBlockNumber(row.extrinsic_index);
  let events: unknown[] = [];
  if (block !== null && index !== null) {
    const found = await query(
      env,
      `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM chain_detail_account_events ` +
        "WHERE block_number = ? AND extrinsic_index = ? " +
        "ORDER BY event_index ASC LIMIT ?",
      [block, index, MAX_EMBEDDED_EVENTS],
    );
    // Events failing is not a reason to withhold the extrinsic -- the cold
    // tier makes the same call for the same reason.
    events = (found ?? []).map(formatAccountEvent).filter(Boolean);
  }
  return buildExtrinsic(row, ref, events);
}

/**
 * "Did the lakehouse actually find anything?" -- one named predicate per
 * payload shape, rather than the same one-liner rewritten at each call site.
 *
 * These decide whether an above-seam cold answer beats a DECLINE, so getting
 * one wrong is not a cosmetic bug: reading `count` on a payload whose field is
 * `extrinsic_count` yields `undefined === 0` -> false -> "not empty", and a
 * genuinely empty answer would be served as if it were measured. The three
 * shapes really are three different field names (`extrinsic_count`,
 * `event_count`, `count`), which is exactly why they belong in one place with
 * their own tests instead of being retyped in five.
 */
export function isEmptyExtrinsicPayload(payload: {
  extrinsic_count: number;
}): boolean {
  return payload.extrinsic_count === 0;
}

export function isEmptyEventPayload(payload: { event_count: number }): boolean {
  return payload.event_count === 0;
}

export function isEmptyChainEventPayload(payload: { count: number }): boolean {
  return payload.count === 0;
}

export type ChainDetailAnswer<T> =
  | { kind: "answer"; data: T; tier: "hot" | "cold" }
  | {
      kind: "gap";
      block: number;
      seam: number;
      coverage: ChainDetailCoverage | null;
    }
  | { kind: "miss" };

/**
 * Route one block-scoped read across the seam, and decline rather than invent
 * an empty answer in the gap between the two tiers.
 *
 * `hot` is called only for a block the coverage register carries, so its
 * answer -- including an EMPTY one -- is a measurement. `cold` is the caller's
 * existing lakehouse loader, unchanged, and it keeps ownership of everything at
 * or below the seam plus its own hash resolution. `isEmpty` is how this
 * function tells "the lakehouse looked and found nothing" from "the lakehouse
 * answered", because the cold loaders return a schema-stable payload for both.
 */
export async function answerBlockDetail<T>(
  env: unknown,
  ref: string,
  ops: {
    hot: (height: number) => Promise<T | null>;
    cold: () => Promise<T | null>;
    isEmpty: (data: T) => boolean;
  },
): Promise<ChainDetailAnswer<T>> {
  const seam = await resolveBlocksSeam(env);
  const numeric = safeBlockNumber(ref);

  // At or below the seam the lakehouse is authoritative and complete, so the
  // hot tier is not consulted at all -- one source per block, the property
  // src/blocks-cold-tier.ts's seam was introduced to preserve.
  if (numeric !== null && numeric <= seam) {
    const cold = await ops.cold();
    return cold
      ? { kind: "answer", data: cold, tier: "cold" }
      : { kind: "miss" };
  }

  const resolved = await resolveHotRef(env, ref);
  // A hash the hot tier does not carry, or a ref that is neither a height nor a
  // hash: nothing here can route it, so the cold tier answers exactly as it
  // does today, including its schema-stable "unknown ref" payload.
  if (!resolved) {
    const cold = await ops.cold();
    return cold
      ? { kind: "answer", data: cold, tier: "cold" }
      : { kind: "miss" };
  }
  if (resolved.height <= seam) {
    const cold = await ops.cold();
    return cold
      ? { kind: "answer", data: cold, tier: "cold" }
      : { kind: "miss" };
  }

  if (resolved.covered) {
    const hot = await ops.hot(resolved.height);
    if (hot) return { kind: "answer", data: hot, tier: "hot" };
  }

  // Above the seam and not covered. The lakehouse can still hold it (the
  // watermark is a MIN across four tables), so ask before declining.
  const cold = await ops.cold();
  if (cold && !ops.isEmpty(cold))
    return { kind: "answer", data: cold, tier: "cold" };
  return {
    kind: "gap",
    block: resolved.height,
    seam,
    coverage: await chainDetailCoverage(env),
  };
}

/**
 * The extrinsic-detail route's version of the same routing.
 *
 * TWO REF FORMS, TWO DIFFERENT ANSWERS TO "NOT FOUND", and the difference is
 * the whole reason this is not just `answerBlockDetail`:
 *
 * `<block>-<index>` names a position, so the seam applies exactly as it does to
 * a block read and an unanswerable position DECLINES.
 *
 * A hash names a thing, and a hash absent from the hot tier proves nothing --
 * the hot tier holds a few thousand blocks out of 8.7 million, so "not here" is
 * the expected answer for almost every valid hash. Declining on that would turn
 * every historical extrinsic lookup into a 503. So the hash form asks hot
 * first, cold second, and keeps the existing schema-stable `extrinsic: null` on
 * a miss, which for a hash is the honest shape it always was.
 */
export async function answerExtrinsicDetail(
  env: unknown,
  ref: string,
  cold: () => Promise<ReturnType<typeof buildExtrinsic> | null>,
): Promise<ChainDetailAnswer<ReturnType<typeof buildExtrinsic>>> {
  const composite = /^(\d+)-(\d+)$/.exec(String(ref).trim());
  if (!composite) {
    const hot = await loadExtrinsicHotTier(env, ref);
    if (hot) return { kind: "answer", data: hot, tier: "hot" };
    const found = await cold();
    return found
      ? { kind: "answer", data: found, tier: "cold" }
      : { kind: "miss" };
  }
  return answerBlockDetail(env, composite[1]!, {
    hot: () => loadExtrinsicHotTier(env, ref),
    cold,
    isEmpty: (data) => !data.extrinsic,
  });
}

/** The one message every declining route emits, so a client sees a single
 * diagnosable shape rather than four hand-written variants. */
export function chainDetailGapMessage(gap: {
  block: number;
  seam: number;
  coverage: ChainDetailCoverage | null;
}): string {
  const window = gap.coverage
    ? `${gap.coverage.floor}-${gap.coverage.head}`
    : "empty";
  return (
    `Block ${gap.block} falls between the decoded lakehouse (through ${gap.seam}) ` +
    `and the live-follow window (${window}), so its detail cannot be read right ` +
    `now. This is a gap in coverage, not a block without extrinsics or events.`
  );
}
