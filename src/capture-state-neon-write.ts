// blocks_head and raw_capture_state, mirrored into Neon (#9787).
//
// Two tables, two different writers, one module: both are the head poller's
// idea of "how far have we got", and neither is derivable from anything else.
// blocks_head is the per-block register the firehose fills; raw_capture_state
// is the single-row-per-network contiguity watermark the backfill resumes from.
//
// WHY THE STATEMENTS ARE REUSED RATHER THAN REBUILT. createPgSql's `unsafe`
// already rewrites SQLite's `?` to `$n` (#9821 added that after six routes
// served empty because it only existed on one of three paths), and neither
// statement uses a construct Postgres lacks -- no json_each, no ifnull, no
// CAST-as-truncation. So the text carries over verbatim and the COALESCE
// semantics come with it, which matters more here than brevity:
//
//   event_count=COALESCE(excluded.event_count, blocks_head.event_count)
//   author=COALESCE(excluded.author, blocks_head.author)
//
// A re-poll that could not read the event count or derive the author must not
// erase one an earlier tick already stored. Rebuilding these as a generic
// upsert would silently drop that and replace a known value with NULL -- the
// same shape as #9634's last_ok, one table over.
import type { BlocksHead } from "../generated/db/types.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import { recordNeonWriteVerdict, type NeonWriteResult } from "./neon-write.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";

export const BLOCKS_HEAD_NEON_LANE = "blocks-head";
export const RAW_CAPTURE_STATE_NEON_LANE = "raw-capture-state";

export interface CaptureStateSql {
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
}

export interface CaptureStateMirrorDeps {
  sql?: CaptureStateSql | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/** Resolve the runner and lane bookkeeping shared by both mirrors. */
async function runner(
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  deps: CaptureStateMirrorDeps,
): Promise<{
  sql: CaptureStateSql | null;
  laneDb: LaneHealthDb | undefined;
  now: () => number;
  attempted: boolean;
  /** Whether `sql` enqueues rather than writes -- see record() below. */
  buffered: boolean;
}> {
  const now = deps.now ?? Date.now;
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  // The dual-write gate stood here until #10051: with D1 deleted this is the
  // SOLE write to the ONLY store, so it runs unconditionally -- a flag whose
  // no-arm means "do not persist" is not a cutover control any more, it is an
  // off switch nothing should be holding.
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  // #10659: buffered when the lane is flagged, direct otherwise. Defaults OFF
  // (empty lane list), so this changes nothing until a lane is named.
  const sql = deps.sql ?? neonWriteRunner(env, ctx, lane, hyperdrive);
  if (!sql) {
    // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op.
    //
    // No `buffered` argument, and it is not an oversight: this branch is only
    // reachable when there is NO runner at all, so nothing was buffered -- and
    // it is a failure either way, which records regardless.
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
    );
  }
  // Only a runner we BUILT can be buffered: an injected deps.sql is whatever
  // the caller handed us, and calling it buffered would suppress its verdict on
  // a write that went straight to a test double or a real connection.
  const buffered = !deps.sql && neonWriteBufferEnabled(env, lane);
  return { sql, laneDb, now, attempted: true, buffered };
}

async function record(
  laneDb: LaneHealthDb | undefined,
  lane: string,
  rows: number,
  now: () => number,
  run: () => Promise<unknown>,
  buffered = false,
): Promise<NeonWriteResult> {
  let result: NeonWriteResult;
  try {
    await run();
    result = { ok: true, rows, statements: 1 };
  } catch (error) {
    result = {
      ok: false,
      rows: 0,
      statements: 1,
      reason: String((error as Error)?.message ?? error),
    };
  }
  await recordNeonWriteVerdict(laneDb, lane, result, now(), buffered);
  return result;
}

/** One head row. Never throws: while D1 still serves, a mirror failure costs a
 * lane verdict and nothing the poller can see. */
export async function mirrorBlocksHeadToNeon(
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  row: BlocksHead,
  deps: CaptureStateMirrorDeps = {},
): Promise<{ attempted: boolean; result?: NeonWriteResult }> {
  const { sql, laneDb, now, attempted, buffered } = await runner(
    env,
    ctx,
    BLOCKS_HEAD_NEON_LANE,
    deps,
  );
  if (!attempted || !sql) return { attempted };
  const result = await record(
    laneDb,
    BLOCKS_HEAD_NEON_LANE,
    1,
    now,
    () =>
      sql.unsafe(
        `INSERT INTO blocks_head (block_number, block_hash, parent_hash, extrinsic_count, event_count, author, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_number) DO UPDATE SET
         block_hash=excluded.block_hash,
         parent_hash=excluded.parent_hash,
         extrinsic_count=excluded.extrinsic_count,
         event_count=COALESCE(excluded.event_count, blocks_head.event_count),
         author=COALESCE(excluded.author, blocks_head.author),
         observed_at=excluded.observed_at`,
        [
          row.block_number,
          row.block_hash,
          row.parent_hash,
          row.extrinsic_count,
          row.event_count,
          row.author,
          row.observed_at,
        ],
      ),
    buffered,
  );
  return { attempted: true, result };
}

/** The contiguity watermark, one row per network. */
export async function mirrorRawCaptureStateToNeon(
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  network: string,
  lastContiguousBlock: number,
  updatedAt: number,
  deps: CaptureStateMirrorDeps = {},
): Promise<{ attempted: boolean; result?: NeonWriteResult }> {
  const { sql, laneDb, now, attempted, buffered } = await runner(
    env,
    ctx,
    RAW_CAPTURE_STATE_NEON_LANE,
    deps,
  );
  if (!attempted || !sql) return { attempted };
  const result = await record(
    laneDb,
    RAW_CAPTURE_STATE_NEON_LANE,
    1,
    now,
    () =>
      sql.unsafe(
        `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(network) DO UPDATE SET
           last_contiguous_block = excluded.last_contiguous_block,
           updated_at = excluded.updated_at`,
        [network, lastContiguousBlock, updatedAt],
      ),
    buffered,
  );
  return { attempted: true, result };
}
