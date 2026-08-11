// Write-behind buffering for the Neon write path (#10659).
//
// ## The problem this exists to solve
//
// Neon bills allocated compute, and a compute only suspends after
// `suspend_timeout_seconds` with no work. Measured 2026-08-11: the capture
// lanes wrote every 2.4s on average, with a MAXIMUM inter-write gap of 16.7s
// over six hours and not one gap over 60s. The timeout is 300s and Neon's floor
// is 60s, so neither was ever reachable -- the compute ran 24/7 at ~2.8%
// utilisation, which is a bill for availability rather than for work.
//
// The fix is not a cheaper query or a rarer cron. It is to stop writing
// continuously: hold statements somewhere durable and replay them in one burst,
// so the gaps between bursts exceed the suspend timeout.
//
// ## Why a Durable Object, and not a queue
//
// Cloudflare Queues cap `max_batch_timeout` at 60 SECONDS, so a queue consumer
// still writes once a minute and the compute still never suspends. A Durable
// Object alarm can fire on any interval and its storage is durable, which is
// the whole requirement. (A Workflow's `step.sleep` would also work and bills
// per step -- an awkward fit for a metronome.)
//
// ## Why ONE buffer and not one per lane
//
// A per-lane buffer would give each lane its own alarm, and eight alarms
// drifting apart would wake the compute eight times per window -- which is the
// state we are trying to leave. Concentrating every lane into one flush is the
// entire point, so the DO is a singleton and this module's keys are namespaced
// by sequence rather than by lane.
//
// ## What is safe to buffer, and how that was established
//
// Every statement in `src/*-neon-write.ts` is a write whose result is
// discarded: no `RETURNING` clause anywhere, and every `sql.unsafe(...)` is
// awaited bare. The one `SELECT` in those files is an `EXISTS (SELECT 1 ...)`
// inside an upsert's filter clause, which is part of the INSERT rather than a
// read. So a buffered runner never has to return rows, and `PgUnsafe` -- a
// one-method interface -- can be satisfied by something that enqueues.
//
// Replay safety comes free from the statements themselves: they are `ON
// CONFLICT` upserts carrying out-of-order guards (`table.captured_at <
// EXCLUDED.captured_at`), so re-running a flush that partially applied is a
// no-op on the rows that already landed rather than a corruption.
//
// ## This module is PURE
//
// Everything here is encoding, key ordering and size arithmetic -- no storage,
// no network, no clock. The Durable Object that owns the storage is
// workers/neon-write-buffer-hub.ts; keeping the arithmetic separate is what
// lets the ordering and chunking guarantees be asserted directly instead of
// inferred from a mock.

import { z } from "zod";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";

/**
 * One buffered statement, exactly as the lane would have executed it.
 *
 * A ZOD SCHEMA rather than a hand-written type guard, because this shape
 * crosses a trust boundary: the Durable Object parses it from a request body,
 * and the flush parses it back out of durable storage written by a possibly
 * older deploy. Both are places where "looks about right" is not good enough,
 * and a hand-rolled check drifts from the type it is supposed to enforce the
 * moment a field is added.
 *
 * `.strict()` on purpose -- an unknown key means the writer and the reader
 * disagree about the format, which is worth failing on rather than ignoring.
 */
export const BufferedStatementSchema = z
  .object({
    /** The lane that produced it, so the flush can attribute a verdict. */
    lane: z.string().min(1),
    text: z.string().min(1),
    // Deliberately NOT z.array(z.unknown()).nonempty(): a parameterless
    // DELETE is an ordinary statement here, and rejecting it would drop it.
    values: z.array(z.unknown()),
  })
  .strict();

export type BufferedStatement = z.infer<typeof BufferedStatementSchema>;

/**
 * Durable Object storage caps a single value at 128 KiB.
 *
 * Stated as the platform limit it is, separately from the chunk size below, so
 * the headroom is visible as a decision rather than baked into one number.
 */
export const DO_VALUE_LIMIT_BYTES = 128 * 1024;

/**
 * How many bytes one stored chunk may carry.
 *
 * 96 KiB against a 128 KiB ceiling. The headroom is not superstition: a bulk
 * neuron upsert is thousands of rows wide, so chunking is the NORMAL path here
 * rather than an edge case, and a chunk sized exactly to the limit would fail
 * the moment the value framing costs a byte more than expected. The same
 * reasoning, and the same ratio, as PG_PARAM_BUDGET in src/neon-write.ts.
 */
export const CHUNK_BYTES = 96 * 1024;

/**
 * Zero-pad width for the sequence number in a storage key.
 *
 * THIS IS THE ORDERING GUARANTEE, not cosmetics. `storage.list()` returns keys
 * in LEXICOGRAPHIC order, so an unpadded `stmt:10` sorts before `stmt:9` and
 * the flush replays statements out of the order they were written. Sixteen
 * digits holds Number.MAX_SAFE_INTEGER (16 digits) without ever widening, so
 * the padding cannot silently stop working at a round number.
 */
export const SEQ_WIDTH = 16;

/** The prefix every statement chunk lives under, so `list()` can scope to it. */
export const STATEMENT_PREFIX = "stmt:";

/**
 * The storage key for one chunk of one statement.
 *
 * Both the sequence and the part are padded, for the same reason: a statement
 * that chunks into eleven parts must not replay part 10 before part 2.
 */
export function chunkKey(seq: number, part: number): string {
  return `${STATEMENT_PREFIX}${String(seq).padStart(SEQ_WIDTH, "0")}:${String(
    part,
  ).padStart(4, "0")}`;
}

/** The sequence number a chunk key belongs to, or null if it is not one. */
export function seqFromChunkKey(key: string): number | null {
  if (!key.startsWith(STATEMENT_PREFIX)) return null;
  const seq = Number(key.slice(STATEMENT_PREFIX.length).split(":")[0]);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * Split an encoded statement into storable chunks.
 *
 * BYTES, NOT CHARACTERS, and the difference is a real bug rather than
 * pedantry: an SS58 address or a subnet name can carry multi-byte UTF-8, and a
 * string sliced by code unit can cut a surrogate pair in half -- producing two
 * chunks that are each individually invalid and a rejoin that is silently
 * corrupt. Encoding to bytes first and rejoining before decoding makes a chunk
 * boundary land wherever it likes with no effect on the result.
 */
export function splitPayload(
  payload: string,
  chunkBytes: number = CHUNK_BYTES,
): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length === 0) return [new Uint8Array(0)];
  const size = Math.max(1, chunkBytes);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.slice(offset, offset + size));
  }
  return parts;
}

/** Rejoin chunks into the encoded statement they came from. */
export function joinPayload(parts: readonly Uint8Array[]): string {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}

/** Encode a statement for storage. */
export function encodeStatement(statement: BufferedStatement): string {
  return JSON.stringify({
    lane: statement.lane,
    text: statement.text,
    values: statement.values,
  });
}

/**
 * Decode a stored statement, or null if it is not one.
 *
 * NULL RATHER THAN THROWING, because the caller is a flush loop draining
 * durable storage: one unparseable entry (a truncated write, a format from a
 * previous deploy) must cost that entry and not the whole backlog behind it.
 * The flush discards what it cannot read and records that it did.
 */
export function decodeStatement(payload: string): BufferedStatement | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = BufferedStatementSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Group chunk keys back into statements, in replay order.
 *
 * Takes the keys `list()` returned and returns one entry per sequence, each
 * carrying its parts in order. Written as a pure function over a key list
 * because "did the ordering survive" is the property most worth asserting and
 * the hardest to see through a storage mock.
 */
export function groupChunkKeys(
  keys: readonly string[],
): { seq: number; keys: string[] }[] {
  const bySeq = new Map<number, string[]>();
  for (const key of keys) {
    const seq = seqFromChunkKey(key);
    if (seq === null) continue;
    const existing = bySeq.get(seq);
    if (existing) existing.push(key);
    else bySeq.set(seq, [key]);
  }
  return [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, group]) => ({ seq, keys: [...group].sort() }));
}

/**
 * How long the buffer may hold statements before a flush.
 *
 * TEN MINUTES, chosen against the bound that already exists rather than picked
 * for feel: every table this buffers is held to `2 * HOUR` by
 * src/table-freshness-watchdog.ts, so a ten-minute flush is twelve ticks inside
 * a contract nothing has to renegotiate. It is also comfortably past the 300s
 * suspend timeout, which is the point -- at five minutes the compute would
 * never quite sleep.
 */
export const FLUSH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How many statements may pile up before a flush is forced early.
 *
 * A BOUND, NOT A TUNING KNOB. Without it a stalled flush grows the buffer
 * until the DO's storage becomes the outage. Forcing a flush at the ceiling
 * turns "the buffer is filling faster than we drain it" into backpressure the
 * next writer can see, rather than an unbounded queue nobody is watching.
 */
export const MAX_BUFFERED_STATEMENTS = 5_000;

/** Whether a pending count has reached the point of flushing early. */
export function shouldFlushEarly(
  pending: number,
  ceiling: number = MAX_BUFFERED_STATEMENTS,
): boolean {
  return pending >= ceiling;
}

/**
 * The lanes routed through the buffer, read from the environment.
 *
 * A COMMA LIST DEFAULTING TO EMPTY, deliberately, and the same shape as
 * `NEON_DUAL_WRITE_LANES` in src/neon-write.ts. That file's header states the
 * reason and it applies unchanged here: this changes nothing until a lane is
 * named, so the deploy that introduces buffering cannot itself be the deploy
 * that buffers everything.
 */
export function neonWriteBufferLanes(
  env: Record<string, unknown> | null | undefined,
): Set<string> {
  const raw = env?.NEON_WRITE_BUFFER_LANES;
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((lane) => lane.trim())
      .filter((lane) => lane.length > 0),
  );
}

/**
 * Lanes that must NEVER be buffered, whatever the flag says.
 *
 * `blocks-head` is the block explorer's live read path, not merely a write.
 * src/blocks-cold-tier.ts routes `block_number > seam` to
 * `blocks_head b LEFT JOIN chain_detail_blocks c`, which is exactly the window
 * "between a block being seen and being decoded" -- so deferring that write
 * defers the explorer's head by the whole flush interval. A block explorer
 * showing a ten-minute-old tip is broken in the way users notice first.
 *
 * A SET RATHER THAN A COMMENT, because the tempting move when the compute
 * still will not suspend is to add the one remaining high-frequency lane to
 * the flag and see what happens. This makes that a no-op instead of a
 * regression discovered by a user.
 *
 * THE HONEST CONSEQUENCE: with `blocks-head` writing every ~12s the compute
 * cannot reach the 300s suspend timeout, so buffering the other lanes buys a
 * lower CU while ACTIVE (fewer statements per hour, so autoscaling sits nearer
 * the 0.25 floor) rather than a sleeping compute. Suspension and a live
 * explorer are mutually exclusive while the head is served from Neon; making
 * them compatible means moving the above-seam read off Neon entirely, which is
 * a different change and a much larger one -- the LEFT JOIN above cannot span
 * two stores without returning a wrong answer with a valid shape.
 */
export const NEVER_BUFFER_LANES: ReadonlySet<string> = new Set(["blocks-head"]);

/** Whether one lane's writes go through the buffer. */
export function neonWriteBufferEnabled(
  env: Record<string, unknown> | null | undefined,
  lane: string,
): boolean {
  if (NEVER_BUFFER_LANES.has(lane)) return false;
  return neonWriteBufferLanes(env).has(lane);
}

/** The DO namespace binding this hub is reached through. */
export interface NeonWriteBufferNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * Statements whose result the caller needs, which therefore cannot be deferred.
 *
 * Word-bounded and case-insensitive so `returning` in a column or string
 * literal does not trip it. This is deliberately a coarse check: the cost of a
 * false positive is a lane that stays on the direct path (slower, correct), and
 * the cost of a false negative is a wrong answer.
 */
const RESULT_CONSUMING = /\bRETURNING\b/i;

/**
 * A `PgUnsafe` that enqueues instead of executing.
 *
 * Drop-in for `createPgSql` on the write lanes: `PgUnsafe` is a one-method
 * interface, no statement in those lanes carries a `RETURNING`, and every
 * caller awaits the result bare -- so returning an empty row set is
 * indistinguishable from what a real write returns today.
 *
 * IT THROWS WHEN THE BUFFER REFUSES, deliberately. The lane's own `record()`
 * turns a throw into a `stale` verdict, which is exactly the signal a full
 * buffer should produce; swallowing it would make backpressure invisible.
 */
export function createBufferedPgSql(
  namespace: NeonWriteBufferNamespace,
  lane: string,
): { unsafe(text: string, values?: unknown[]): Promise<unknown> } {
  return {
    async unsafe(text: string, values: unknown[] = []): Promise<unknown> {
      // A DEFERRED WRITE CANNOT RETURN ROWS, so a statement that asks for them
      // must fail here rather than receive `[]`. This is the one way buffering
      // could produce a confidently wrong answer instead of a slow one:
      // `RETURNING id` + `rows.length > 0` is how a caller learns whether its
      // row was new, and an empty result would read as "already present" for a
      // row that has not been written yet. Refusing makes the buffer's contract
      // -- fire-and-forget writes only -- enforced rather than documented.
      if (RESULT_CONSUMING.test(text)) {
        throw new Error(
          `neon write buffer cannot defer a statement that RETURNs rows (lane ${lane})`,
        );
      }
      const stub = namespace.get(namespace.idFromName("global"));
      const response = await stub.fetch(
        new Request("https://neon-write-buffer/enqueue", {
          method: "POST",
          body: JSON.stringify({ lane, text, values }),
          headers: { "content-type": "application/json" },
        }),
      );
      if (!response.ok) {
        throw new Error(
          `neon write buffer refused the statement (${response.status})`,
        );
      }
      return [];
    },
  };
}

/**
 * The runner a write lane should use: buffered when flagged, direct otherwise.
 *
 * ONE PLACE, because there were six. Every `src/*-neon-write.ts` runner built
 * its own connection with the identical line, and adding the buffer branch to
 * each would have made six copies of a decision that has exactly one right
 * answer. A lane that forgets the branch keeps writing directly, which costs
 * nothing visible and silently denies the whole change its saving -- the sort
 * of omission that is invisible until someone measures the compute again.
 *
 * ORDER MATTERS. The buffer is consulted first, but only when the binding is
 * actually present: a flag naming a lane on a Worker with no NEON_WRITE_BUFFER
 * binding is a half-applied config, and falling through to the direct write
 * keeps the rows landing. Refusing there would drop capture data over a missing
 * binding, which is the wrong direction to fail.
 */
export function neonWriteRunner(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  hyperdrive: HyperdriveLike | undefined,
): { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null {
  const buffer = env?.NEON_WRITE_BUFFER as NeonWriteBufferNamespace | undefined;
  if (buffer && neonWriteBufferEnabled(env, lane)) {
    return createBufferedPgSql(buffer, lane);
  }
  return hyperdrive?.connectionString && ctx
    ? createPgSql(hyperdrive, ctx)
    : null;
}
