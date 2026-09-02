// The singleton that holds Neon writes back so the compute can sleep (#10659).
//
// Read src/neon-write-buffer.ts's header first -- it carries the measurement
// this exists for and the reasoning behind the interval, the chunking and the
// ordering guarantee. This file is the storage and the alarm; that one is the
// arithmetic.
//
// ## A SINGLETON, reached by idFromName("global")
//
// Same convention as ChainFirehoseHub and AlerterHub, and here it is
// load-bearing rather than conventional: the entire benefit is that every
// lane's writes land in ONE burst. Two instances would mean two alarms drifting
// apart, waking the compute twice per window and halving the gap that made it
// sleep in the first place.
//
// ## The flush is the only thing that may claim a write landed
//
// A lane's `record()` reports `ok` when its statement did not throw. Against
// this buffer that means "durably enqueued", which is a weaker claim than "in
// Neon", so the flush records its OWN verdict per lane -- under `neon:<lane>`,
// the same key that path uses (#10851), or it clears nothing -- and a
// `neon:buffer-flush` verdict for the drain itself. A flush that fails leaves
// the backlog in place and says so; and because every buffered table is held to
// `2 * HOUR` by src/table-freshness-watchdog.ts, a flush that stays broken
// surfaces on the table's own freshness bound within two hours regardless of
// what any verdict here says. That watchdog is the backstop, and it is
// unchanged by buffering precisely because the interval is twelve times inside
// it.
//
// ## Why the backlog is never dropped on a failed flush
//
// These are capture rows -- a block header, a decoded event -- and nothing
// re-derives them cheaply once the chain has moved on. So a failed flush
// retries on the next alarm and the buffer grows, bounded by
// MAX_BUFFERED_STATEMENTS. At the ceiling the enqueue path starts REFUSING,
// which turns an invisible unbounded queue into a lane verdict a human can act
// on. Refusing is the safe direction: the producer's own retry still has the
// rows, and a refused write is a fact rather than a silent loss.

import {
  chunkKey,
  decodeStatement,
  encodeStatement,
  FLUSH_INTERVAL_MS,
  groupChunkKeys,
  joinPayload,
  MAX_BUFFERED_STATEMENTS,
  splitPayload,
  STATEMENT_PREFIX,
  type BufferedStatement,
} from "../src/neon-write-buffer.ts";
import { createPgSql, type HyperdriveLike } from "../src/pg-sql.ts";
import { laneHealthStore } from "../src/lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "../src/lane-health.ts";
import { neonLaneKey } from "../src/neon-write.ts";
import {
  recordExceptionEvent,
  type TelemetryEnv,
} from "../src/usage-telemetry.ts";

/** The lane the drain itself reports under. */
export const BUFFER_FLUSH_LANE = "neon:buffer-flush";

/**
 * The route label every capture from this file carries.
 *
 * ONE STRING, because PostHog groups an inbox by (route, error type) and a
 * second spelling would split one incident into two issues that each look half
 * as urgent. The lane verdict is the durable record; this is the notification
 * path -- see src/lane-health.ts's header for why the repo keeps both, and why
 * PostHog is deliberately NOT the record.
 */
export const BUFFER_ROUTE = "neon-write-buffer";

/** Where the monotonic sequence lives, outside the statement prefix. */
const SEQ_KEY = "seq";

/**
 * How many statements are waiting, maintained as a COUNTER.
 *
 * THE BUG THIS EXISTS TO KILL (#10755). enqueueStatement used to call
 * countPending(), which does a full storage.list() over every chunk in the
 * buffer and then sorts and groups the keys -- on EVERY enqueue. Cloudflare's
 * own logs show what that cost once a backlog existed:
 *
 *     POST /enqueue   outcome: exception
 *     cpuTimeMs: 2424   wallTimeMs: 2699
 *     -> Internal error in Durable Object storage caused object to be reset
 *
 * 2.4 SECONDS OF CPU TO APPEND ONE ROW. And it is a death spiral rather than a
 * slow path: each enqueue scans a bigger backlog, takes more CPU, and the
 * platform eventually resets the object mid-request -- at which point the
 * enqueue throws BEFORE reaching setAlarm, so nothing arms the flush, so the
 * backlog grows, so the next scan is worse.
 *
 * That one O(n) call is what produced all three failures this buffer was
 * disabled for: the storage "internal error", the enqueues that stopped
 * landing, and the alarm that never fired. A counter makes the enqueue O(1)
 * and the whole spiral unreachable.
 */
const PENDING_KEY = "pending";

export interface FlushOutcome {
  /** Statements this drain took from storage. */
  drained: number;
  /** Statements it could not decode, and therefore discarded. */
  undecodable: number;
  ok: boolean;
  reason?: string;
  /**
   * Whether statements were left behind -- a truncated list, or a stop on
   * failure. THE CALLER MUST RE-ARM ON THIS. See the alarm handler.
   */
  remaining: boolean;
}

/**
 * How many statement chunks one drain may list.
 *
 * BOUNDED BECAUSE `storage.list()` IS BOUNDED, and #10722 is what assuming
 * otherwise cost. A drain that lists everything is not a thing the platform
 * offers: `list()` caps its result, so a backlog past the cap comes back
 * TRUNCATED and a flush that drains all of it still leaves rows behind.
 * Stating the bound here makes the leftover a value the caller can act on
 * (`remaining`) instead of an invisible remainder.
 *
 * Well under the platform cap so the truncation is OURS and predictable rather
 * than the platform's and silent.
 */
export const FLUSH_LIST_LIMIT = 500;

/**
 * How soon to come back when a drain left work behind.
 *
 * SECONDS, NOT THE FULL INTERVAL. A backlog is the one state where waiting ten
 * minutes is wrong: the rows are already late, and another full interval per
 * batch turns a 3,000-statement backlog into an hour of latency. Ten seconds
 * clears it at list-limit granularity while still being a wake the compute
 * would have taken anyway.
 */
export const FLUSH_BACKLOG_RETRY_MS = 10_000;

/**
 * Postgres SQLSTATEs that mean "retry this exact statement", and nothing else
 * (#11357).
 *
 * These two are the only classes the server itself declares retriable: it
 * chooses one transaction as the victim, aborts ONLY that one, and leaves the
 * connection healthy. Every other failure the drain can see -- a broken socket,
 * a constraint violation, a syntax error -- is either fatal to the connection
 * or fatal to the row, and retrying it is a wasted round trip.
 *
 *   40P01  deadlock_detected
 *   40001  serialization_failure
 *
 * The distinction matters because the drain's stop-on-first-failure rule is
 * built on "a failure here is nearly always the connection rather than the
 * row". That is true, except for these -- and treating a deadlock as a
 * connection fault turns ONE retriable row into a head-of-line block on the
 * whole buffer. Measured 2026-08-15: a 93-second deadlock stalled four
 * consecutive flushes, which drained 491, 1, 0 and 93 statements while
 * re-attempting the same poisoned statement first every time.
 */
const RETRIABLE_SQLSTATES = new Set(["40P01", "40001"]);

/**
 * How long ONE flush may spend retrying, in total.
 *
 * A BUDGET FOR THE WHOLE DRAIN, not per statement, and that is the whole
 * design. This runs inside a Durable Object alarm that drains up to
 * FLUSH_LIST_LIMIT statements; a per-statement allowance of even two short
 * retries is 500 x 2 x delay in the worst case, which spends the alarm on
 * waiting rather than writing. One shared budget makes the worst case the
 * budget itself.
 *
 * 1.5 SECONDS, sized against what a deadlock actually costs: Postgres aborts
 * the victim as soon as its detector runs (`deadlock_timeout`, 1s by default,
 * and the loser is already dead when the error arrives), so a retry usually
 * succeeds immediately. The budget is there for the case where it does not --
 * and when it runs out the drain stops exactly as it does today, which is a
 * behaviour this change never removes.
 */
export const FLUSH_RETRY_BUDGET_MS = 1_500;

/** Backoffs between retries of one statement, in order. Two attempts, because
 * a third inside one alarm is worth less than coming back on the next: the
 * first covers "the victim was already aborted", the second covers "the winner
 * had not committed yet". */
const RETRY_BACKOFF_MS = [50, 250];

/**
 * Whether an error is one Postgres told us to retry.
 *
 * Reads `code` off the error, which is where node-postgres puts the SQLSTATE.
 * A TYPE TEST rather than a cast: the drain catches `unknown`, and a thrown
 * string or a plain object must answer `false` here rather than crash the
 * handler that exists to keep the buffer draining.
 */
export function isRetriableWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRIABLE_SQLSTATES.has(code);
}

/** The storage surface this hub uses, narrowed so a test can supply a fake. */
export interface BufferStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
  setAlarm(when: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

/** What the hub needs from its environment, so the flush can be driven alone. */
export interface BufferEnv extends TelemetryEnv {
  HYPERDRIVE?: HyperdriveLike;
  DATA_API?: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
}

/**
 * Append one statement, and make sure something will drain it.
 *
 * Exported and storage-injected so the ordering, the chunking and the ceiling
 * can be driven without a Worker runtime.
 */
export async function enqueueStatement(
  storage: BufferStorage,
  statement: BufferedStatement,
  now: number,
): Promise<{ accepted: boolean; seq?: number; reason?: string }> {
  // O(1). NEVER countPending() here -- see PENDING_KEY.
  const pending = (await storage.get<number>(PENDING_KEY)) ?? 0;
  if (pending >= MAX_BUFFERED_STATEMENTS) {
    // REFUSE rather than grow. See this file's header: an unbounded queue is
    // an outage nobody can see, and the producer's retry still holds the rows.
    return {
      accepted: false,
      reason: `buffer full at ${pending} statement(s)`,
    };
  }
  const seq = ((await storage.get<number>(SEQ_KEY)) ?? 0) + 1;
  const parts = splitPayload(encodeStatement(statement));
  const entries: Record<string, unknown> = {
    [SEQ_KEY]: seq,
    [PENDING_KEY]: pending + 1,
  };
  parts.forEach((part, index) => {
    entries[chunkKey(seq, index)] = part;
  });
  await storage.put(entries);
  // ARM WHEN THERE IS NO ALARM, OR WHEN THE ONE THERE IS HAS GONE STALE.
  //
  // `=== null` alone was not enough (#10763). An alarm whose time has passed
  // without the handler running is ORPHANED -- the object was reset mid-flight
  // often enough during #10755's CPU spiral to leave one behind -- and the old
  // guard read that as "an alarm is pending, nothing to do". Nothing then ever
  // fired it and nothing ever replaced it, so the buffer had no path to a first
  // drain even once every other fault was gone: enqueues succeeded, storage was
  // healthy, and no flush ran for thirteen minutes.
  //
  // Comparing against `now` rather than re-arming unconditionally keeps the
  // property the original guard was protecting: a live alarm is left alone, so
  // a steady stream of enqueues cannot push the flush further away with every
  // write.
  const existingAlarm = await storage.getAlarm();
  if (existingAlarm === null || existingAlarm <= now) {
    await storage.setAlarm(now + FLUSH_INTERVAL_MS);
  }
  return { accepted: true, seq };
}

/** How many distinct statements are waiting. */
export async function countPending(storage: BufferStorage): Promise<number> {
  const keys = await storage.list<unknown>({ prefix: STATEMENT_PREFIX });
  return groupChunkKeys([...keys.keys()]).length;
}

/**
 * Drain the buffer into Neon.
 *
 * ONE CONNECTION FOR THE WHOLE BACKLOG, which is the entire economy of this
 * change: sixty scattered writes become one wake.
 *
 * Statements replay in the order they were enqueued. Ordering is not strictly
 * required -- every statement carries its own out-of-order guard -- but
 * replaying a backlog in a different order than it was produced would make any
 * future failure far harder to reason about, and the ordering is free.
 */
export async function flushBuffer(
  storage: BufferStorage,
  env: BufferEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
  deps: {
    laneHealthDb?: LaneHealthDb | null;
    sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
    now?: () => number;
    captureException?: typeof recordExceptionEvent;
    /** The retry backoff, injectable so a test exercises the retry path
     * without spending its budget in real time. Defaults to a real wait. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<FlushOutcome> {
  const now = deps.now ?? Date.now;
  const laneDb = deps.laneHealthDb ?? laneHealthStore(env);
  const capture = deps.captureException ?? recordExceptionEvent;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stored = await storage.list<Uint8Array>({
    prefix: STATEMENT_PREFIX,
    limit: FLUSH_LIST_LIMIT,
  });
  const groups = groupChunkKeys([...stored.keys()]);
  // A full page back means there is almost certainly more behind it. Cheaper
  // and more honest than a second count: the caller only needs to know whether
  // to come back, not exactly how much is left.
  const truncated = stored.size >= FLUSH_LIST_LIMIT;
  if (groups.length === 0) {
    // RECORD IT. An empty drain returning silently is why "the alarm never
    // fired" and "the alarm fired and found nothing" were indistinguishable
    // for three incidents -- the absence of a verdict meant both. A cheap row
    // once per wake makes the next question answerable in one query.
    await recordLaneVerdict(laneDb, {
      lane: BUFFER_FLUSH_LANE,
      verdict: "ok",
      age_ms: null,
      detail: "nothing buffered",
      checked_at: now(),
    });
    return { drained: 0, undecodable: 0, ok: true, remaining: false };
  }

  const sql =
    deps.sql ??
    (env.HYPERDRIVE?.connectionString
      ? createPgSql(env.HYPERDRIVE, ctx)
      : null);
  if (!sql) {
    // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op -- the same
    // posture the lane runners take. The backlog stays put.
    await recordLaneVerdict(laneDb, {
      lane: BUFFER_FLUSH_LANE,
      verdict: "stale",
      age_ms: null,
      detail: `hyperdrive unbound with ${groups.length} statement(s) buffered`,
      checked_at: now(),
    });
    // The backlog is safe but growing, and nothing else will say so until a
    // freshness watchdog trips two hours later.
    await capture(env, {
      error: new Error(
        `neon write buffer cannot flush: hyperdrive unbound, ${groups.length} statement(s) held`,
      ),
      route: BUFFER_ROUTE,
      errorCode: "flush_hyperdrive_unbound",
    });
    return {
      drained: 0,
      undecodable: 0,
      ok: false,
      reason: "hyperdrive unbound",
      remaining: true,
    };
  }

  const drainedKeys: string[] = [];
  const perLane = new Map<string, { ok: number; failed: number }>();
  let undecodable = 0;
  let drained = 0;
  // Shared across every statement in this flush -- see FLUSH_RETRY_BUDGET_MS.
  let retrySpentMs = 0;
  let retriedStatements = 0;
  for (const group of groups) {
    const parts = group.keys.map((key) => stored.get(key) ?? new Uint8Array(0));
    const statement = decodeStatement(joinPayload(parts));
    if (!statement) {
      // Unreadable entries are discarded, never retried forever: one truncated
      // write must not wedge the whole backlog behind it.
      undecodable += 1;
      drainedKeys.push(...group.keys);
      // DISCARDING A STATEMENT IS DATA LOSS, and the only kind this design can
      // produce. It must page rather than show up as a number in a detail
      // string nobody reads.
      await capture(env, {
        error: new Error(
          `neon write buffer discarded an unreadable statement at seq ${group.seq}`,
        ),
        route: BUFFER_ROUTE,
        errorCode: "flush_undecodable_statement",
      });
      continue;
    }
    const tally = perLane.get(statement.lane) ?? { ok: 0, failed: 0 };
    try {
      // RETRIED IN PLACE, never skipped: order is the reason the drain stops on
      // a failure at all, and replaying a backlog out of order is the one thing
      // worse than replaying it late. Only the SQLSTATEs Postgres declares
      // retriable are retried, and only while the flush's shared budget lasts
      // -- everything else, including a budget that has run out, falls through
      // to the stop below exactly as before (#11357).
      for (let attempt = 0; ; attempt += 1) {
        try {
          await sql.unsafe(statement.text, statement.values);
          break;
        } catch (error) {
          const backoff = RETRY_BACKOFF_MS[attempt];
          if (
            backoff === undefined ||
            !isRetriableWriteError(error) ||
            retrySpentMs + backoff > FLUSH_RETRY_BUDGET_MS
          ) {
            throw error;
          }
          retrySpentMs += backoff;
          retriedStatements += 1;
          await sleep(backoff);
        }
      }
      tally.ok += 1;
      drained += 1;
      drainedKeys.push(...group.keys);
    } catch (error) {
      tally.failed += 1;
      perLane.set(statement.lane, tally);
      // STOP AT THE FIRST FAILURE and keep this statement and everything after
      // it. Skipping ahead would replay the backlog out of order on the next
      // alarm, and a failure here is nearly always the connection rather than
      // the row -- so the rest would fail too, one wasted round trip each.
      await storage.delete(drainedKeys);
      // Decrement, never scan -- same reason as the success path below.
      await storage.put({
        [PENDING_KEY]: Math.max(
          0,
          ((await storage.get<number>(PENDING_KEY)) ?? 0) -
            drained -
            undecodable,
        ),
      });
      await recordFlushVerdicts(laneDb, perLane, now());
      const reason = error instanceof Error ? error.message : String(error);
      await capture(env, {
        error,
        route: BUFFER_ROUTE,
        errorCode: "flush_failed",
      });
      await recordLaneVerdict(laneDb, {
        lane: BUFFER_FLUSH_LANE,
        verdict: "stale",
        age_ms: null,
        detail:
          `drained ${drained}, stopped on ${statement.lane}: ${reason}` +
          // Says whether the budget was spent before giving up, so "stopped on
          // a deadlock" is distinguishable from "stopped on a deadlock after
          // trying twice" -- different repairs.
          (retriedStatements > 0
            ? ` (after ${retriedStatements} retr${retriedStatements === 1 ? "y" : "ies"})`
            : ""),
        checked_at: now(),
      });
      // Stopped mid-backlog: everything from here on is still stored.
      return { drained, undecodable, ok: false, reason, remaining: true };
    }
    perLane.set(statement.lane, tally);
  }

  await storage.delete(drainedKeys);
  // O(1) ON BOTH PATHS (#10775). This reconciled with countPending() when the
  // drain was truncated -- which is the same full storage.list() that #10755
  // removed from the enqueue, just moved into the alarm. Measured in
  // production: the flush at 13:23:12 drained its 500 and then did NOT come
  // back for the remainder, because the scan on a large backlog outran the
  // handler.
  //
  // A clean drain still reconciles to the TRUE value, and that is where drift
  // gets corrected: an untruncated flush has emptied the buffer by definition,
  // so 0 is exact and costs nothing to write. A truncated one decrements, which
  // can drift slightly but is bounded and self-corrects on the next clean
  // drain -- and a counter that is slightly high only makes the ceiling
  // slightly conservative, which is the safe direction.
  await storage.put({
    [PENDING_KEY]: truncated
      ? Math.max(
          0,
          ((await storage.get<number>(PENDING_KEY)) ?? 0) -
            drained -
            undecodable,
        )
      : 0,
  });
  await recordFlushVerdicts(laneDb, perLane, now());
  await recordLaneVerdict(laneDb, {
    lane: BUFFER_FLUSH_LANE,
    verdict: "ok",
    age_ms: null,
    // A RETRY THAT SUCCEEDED IS STILL NEWS. Recovering silently would make the
    // deadlock frequency this change exists to survive invisible -- and that
    // number is what says whether the write pattern needs fixing rather than
    // retrying (#11357).
    detail: `drained ${drained} statement(s)${
      undecodable > 0 ? `, discarded ${undecodable} unreadable` : ""
    }${
      retriedStatements > 0
        ? `, retried ${retriedStatements} after a retriable conflict`
        : ""
    }`,
    checked_at: now(),
  });
  // Enqueue-time publication cannot see the completed pass in Neon. Ask again
  // after the ordered flush, when both the rows and their tally are committed.
  // The source route still declines partial passes and folds each stamp once.
  if (perLane.get("neurons")?.ok && env.DATA_API) {
    const dataApi = env.DATA_API;
    ctx.waitUntil(
      (async () => {
        const response = await dataApi.fetch(
          new Request(
            "https://data-api/api/v1/internal/neurons-snapshot-stamp",
          ),
        );
        if (!response.ok) {
          throw new Error(
            `explorer directory refresh returned HTTP ${response.status}`,
          );
        }
        await response.text();
      })().catch((error) =>
        capture(env, {
          error,
          route: BUFFER_ROUTE,
          errorCode: "directory_refresh_failed",
        }),
      ),
    );
  }
  return { drained, undecodable, ok: true, remaining: truncated };
}

/**
 * One verdict per lane per flush -- the honest one.
 *
 * This is the verdict that means "the rows are in Neon". The enqueue-time one
 * a lane records means only "durably buffered", which is why this exists
 * rather than trusting that.
 */
async function recordFlushVerdicts(
  laneDb: LaneHealthDb | undefined | null,
  perLane: Map<string, { ok: number; failed: number }>,
  at: number,
): Promise<void> {
  for (const [lane, tally] of perLane) {
    await recordLaneVerdict(laneDb, {
      // `neon:`-PREFIXED, matching recordNeonWriteVerdict (#10851). The tag on
      // a buffered statement is the bare lane name, and filing the verdict
      // under it put this in the wrong bucket twice over: it never cleared the
      // failure that path records, and it collided with the poller's own report
      // for the same lane. See neonLaneKey for the measurement.
      lane: neonLaneKey(lane),
      verdict: tally.failed > 0 ? "stale" : "ok",
      age_ms: null,
      detail:
        tally.failed > 0
          ? `${tally.ok} statement(s) flushed, ${tally.failed} failed`
          : `${tally.ok} statement(s) flushed`,
      checked_at: at,
    });
  }
}

/**
 * The Durable Object. A thin shell: storage and the alarm, nothing else.
 *
 * Every decision it makes lives in the exported functions above, so the
 * interesting behaviour is testable without a Worker runtime -- the same split
 * ChainFirehoseHub uses.
 */
export class NeonWriteBufferHub implements DurableObject {
  state: DurableObjectState;
  env: BufferEnv;

  constructor(state: DurableObjectState, env: BufferEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/enqueue" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "malformed body" }, { status: 400 });
    }
    const statement = decodeStatement(JSON.stringify(body));
    if (!statement) {
      return Response.json({ error: "malformed statement" }, { status: 400 });
    }
    const result = await enqueueStatement(
      this.state.storage,
      statement,
      Date.now(),
    );
    if (!result.accepted) {
      // THE BUFFER IS FULL. Producers are enqueueing faster than the flush
      // drains, which means the flush is failing or Neon is refusing -- and
      // from here on, capture rows are being turned away. The lane verdict
      // says so too, but this is the path that pages.
      await recordExceptionEvent(this.env, {
        error: new Error(
          `neon write buffer refused a statement: ${result.reason}`,
        ),
        route: BUFFER_ROUTE,
        errorCode: "buffer_full",
      });
    }
    // 503, not 500: the buffer being full is backpressure the producer should
    // retry against, not a bug in the request it just made.
    return result.accepted
      ? Response.json({ ok: true, seq: result.seq })
      : Response.json({ error: result.reason }, { status: 503 });
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage;
    let outcome: FlushOutcome;
    try {
      // `this.state` IS the WaitUntilLike the flush needs -- DurableObjectState
      // carries waitUntil, so wrapping it would add a branch with nothing on
      // the other side of it.
      outcome = await flushBuffer(storage, this.env, this.state);
    } catch (error) {
      // flushBuffer is written not to throw, so reaching here means something
      // outside its own error handling broke -- storage itself, most likely.
      // WITHOUT THIS THE ALARM DIES SILENTLY: an uncaught throw in alarm()
      // leaves no verdict, no capture, and no rescheduled alarm, so the buffer
      // stops draining and nothing says why until a freshness watchdog trips.
      await recordExceptionEvent(this.env, {
        error,
        route: BUFFER_ROUTE,
        errorCode: "flush_alarm_threw",
      });
      outcome = {
        drained: 0,
        undecodable: 0,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        // The drain never ran, so assume work is still there and come back.
        remaining: true,
      };
    }
    // RE-ARM WHENEVER ANYTHING IS LEFT, not only on failure (#10722).
    //
    // This previously read `if (!outcome.ok)`, on the reasoning that a
    // successful flush drained everything it listed and the next enqueue would
    // arm the next drain. Both halves were wrong. `storage.list()` is bounded,
    // so a backlog past the limit comes back TRUNCATED and a "successful" flush
    // leaves rows behind; and the next enqueue only arms an alarm if it
    // SUCCEEDS -- during a deploy the Durable Object is reset and enqueues fail
    // ("Durable Object reset because its code was updated"), so the one path
    // that could have recovered was failing at exactly the moment it was
    // needed. The buffer stalled for 47 minutes on 2026-08-11 with no alarm
    // pending and no way to arm one.
    //
    // A backlog comes back in SECONDS rather than the full interval: those rows
    // are already late, and another ten minutes per batch would turn a large
    // backlog into an hour of latency.
    if (!outcome.ok || outcome.remaining) {
      await storage.setAlarm(Date.now() + FLUSH_BACKLOG_RETRY_MS);
    }
  }
}
