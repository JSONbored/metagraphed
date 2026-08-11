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
// Neon", so the flush records its OWN verdict per lane and a
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

/** The lane the drain itself reports under. */
export const BUFFER_FLUSH_LANE = "neon:buffer-flush";

/** Where the monotonic sequence lives, outside the statement prefix. */
const SEQ_KEY = "seq";

export interface FlushOutcome {
  /** Statements this drain took from storage. */
  drained: number;
  /** Statements it could not decode, and therefore discarded. */
  undecodable: number;
  ok: boolean;
  reason?: string;
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
export interface BufferEnv {
  HYPERDRIVE?: HyperdriveLike;
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
  const pending = await countPending(storage);
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
  const entries: Record<string, unknown> = { [SEQ_KEY]: seq };
  parts.forEach((part, index) => {
    entries[chunkKey(seq, index)] = part;
  });
  await storage.put(entries);
  // Set the alarm only when none is pending: re-arming on every enqueue would
  // push the flush further out on every write, which at these cadences means
  // never.
  if ((await storage.getAlarm()) === null) {
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
  } = {},
): Promise<FlushOutcome> {
  const now = deps.now ?? Date.now;
  const laneDb = deps.laneHealthDb ?? laneHealthStore(env);
  const stored = await storage.list<Uint8Array>({ prefix: STATEMENT_PREFIX });
  const groups = groupChunkKeys([...stored.keys()]);
  if (groups.length === 0) return { drained: 0, undecodable: 0, ok: true };

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
    return {
      drained: 0,
      undecodable: 0,
      ok: false,
      reason: "hyperdrive unbound",
    };
  }

  const drainedKeys: string[] = [];
  const perLane = new Map<string, { ok: number; failed: number }>();
  let undecodable = 0;
  let drained = 0;
  for (const group of groups) {
    const parts = group.keys.map((key) => stored.get(key) ?? new Uint8Array(0));
    const statement = decodeStatement(joinPayload(parts));
    if (!statement) {
      // Unreadable entries are discarded, never retried forever: one truncated
      // write must not wedge the whole backlog behind it.
      undecodable += 1;
      drainedKeys.push(...group.keys);
      continue;
    }
    const tally = perLane.get(statement.lane) ?? { ok: 0, failed: 0 };
    try {
      await sql.unsafe(statement.text, statement.values);
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
      await recordFlushVerdicts(laneDb, perLane, now());
      const reason = error instanceof Error ? error.message : String(error);
      await recordLaneVerdict(laneDb, {
        lane: BUFFER_FLUSH_LANE,
        verdict: "stale",
        age_ms: null,
        detail: `drained ${drained}, stopped on ${statement.lane}: ${reason}`,
        checked_at: now(),
      });
      return { drained, undecodable, ok: false, reason };
    }
    perLane.set(statement.lane, tally);
  }

  await storage.delete(drainedKeys);
  await recordFlushVerdicts(laneDb, perLane, now());
  await recordLaneVerdict(laneDb, {
    lane: BUFFER_FLUSH_LANE,
    verdict: "ok",
    age_ms: null,
    detail: `drained ${drained} statement(s)${
      undecodable > 0 ? `, discarded ${undecodable} unreadable` : ""
    }`,
    checked_at: now(),
  });
  return { drained, undecodable, ok: true };
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
      lane,
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
      this.state.storage as unknown as BufferStorage,
      statement,
      Date.now(),
    );
    // 503, not 500: the buffer being full is backpressure the producer should
    // retry against, not a bug in the request it just made.
    return result.accepted
      ? Response.json({ ok: true, seq: result.seq })
      : Response.json({ error: result.reason }, { status: 503 });
  }

  async alarm(): Promise<void> {
    const storage = this.state.storage as unknown as BufferStorage;
    // `this.state` IS the WaitUntilLike the flush needs -- DurableObjectState
    // carries waitUntil, so wrapping it would add a branch with nothing on the
    // other side of it.
    const outcome = await flushBuffer(storage, this.env, this.state);
    // A FAILED flush is the only reason to re-arm. A successful one drained
    // everything it listed, and the alarm has already fired and cleared -- so
    // the next enqueue arms the next drain, which is exactly what
    // enqueueStatement does when it finds no alarm pending. Re-arming after a
    // clean drain would schedule a wake with nothing to do, which is the cost
    // this whole file exists to avoid.
    if (!outcome.ok) {
      await storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
    }
  }
}
