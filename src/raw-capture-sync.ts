// Worker-side wiring for the raw chain capture lane (src/raw-chain-capture.ts).
//
// The pure capture logic and its no-gap guarantee live in that module; this
// one binds it to the runtime: the R2 bucket the bytes land in, the D1 row the
// watermark lives in, the kill switch, and the loud-failure posture every
// other cron in this codebase follows.
//
// WHY THIS LANE EXISTS. The self-hosted indexer produced extrinsics and events
// by SCALE-decoding each block; with that box decommissioned nothing captured
// them, so every block past the quiesce height had no extrinsic/event bytes
// anywhere. Waiting for a decoder to exist before capturing would have made
// the hole permanent -- the chain serves recent state cheaply and old state
// expensively -- so capture runs now and decode follows.
//
// LOUD, NEVER SILENT. Missing config no-ops with a console.error plus one
// $exception rather than skipping quietly; a lane that is silently doing
// nothing is indistinguishable from a healthy one, which is precisely the
// failure this migration has been cleaning up all day.
import {
  captureTick,
  type CaptureResult,
  type RawCaptureStore,
  type WatermarkStore,
} from "./raw-chain-capture.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

/** Kill switch, matching CHAIN_HEAD_POLL_ENABLED's convention on the head
 * poller: absent or anything but "true" means this lane does not run. */
export const RAW_CAPTURE_ENABLED_ENV = "RAW_CAPTURE_ENABLED";

/** Public archive endpoint, same default the head poller already uses. */
const DEFAULT_RPC_URL = "https://archive.chain.opentensor.ai";

/**
 * First block this lane is responsible for: the height after the box's final
 * frozen export. Everything at or below it is already in the lakehouse from
 * the exodus, so starting here neither re-captures settled history nor leaves
 * a hole between the two.
 */
export const RAW_CAPTURE_GENESIS_FLOOR = 8756635;

/**
 * Blocks per tick. Each block costs three RPC calls, so this bounds a tick at
 * ~450 subrequests -- comfortably inside a Worker invocation's budget while
 * still out-running the chain (~5 blocks/minute) by a wide margin, so a
 * backlog drains instead of merely holding steady.
 */
const MAX_BLOCKS_PER_TICK = 150;

interface RawCaptureEnv {
  METAGRAPH_ARCHIVE?: { put(key: string, value: string): Promise<unknown> };
  METAGRAPH_HEALTH_DB?: D1LikeDb;
  RAW_CAPTURE_ENABLED?: string;
  CHAIN_HEAD_RPC_URL?: string;
}

interface D1LikeDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first?(): Promise<Record<string, unknown> | null>;
      run?(): Promise<unknown>;
      all?(): Promise<unknown>;
    };
  };
}

/** The watermark row, read/written through D1. Absent row => null, which the
 * capture treats as "start at the floor". */
export function d1Watermark(db: D1LikeDb, now: () => number): WatermarkStore {
  return {
    async read() {
      const row = await db
        .prepare(
          `SELECT last_contiguous_block FROM raw_capture_state WHERE id = 1`,
        )
        .bind()
        .first?.();
      const value = row?.last_contiguous_block;
      return typeof value === "number" ? value : null;
    },
    async write(value: number) {
      return db
        .prepare(
          `INSERT INTO raw_capture_state (id, last_contiguous_block, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_contiguous_block = excluded.last_contiguous_block,
             updated_at = excluded.updated_at`,
        )
        .bind(value, now())
        .run?.();
    },
  };
}

export interface RawCaptureSyncResult extends Partial<CaptureResult> {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * One scheduled tick. Returns a result object rather than throwing, so a bad
 * tick degrades the LANE without failing the Worker's whole scheduled run —
 * the same contract every other cron branch here honours.
 */
export async function runRawCaptureSync(
  env: RawCaptureEnv | null | undefined,
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    recordException?: typeof recordExceptionEvent;
  } = {},
): Promise<RawCaptureSyncResult> {
  const now = deps.now ?? Date.now;
  const capture = deps.recordException ?? recordExceptionEvent;
  const loud = async (reason: string, message: string) => {
    console.error(`[raw-capture-sync] ${message}`);
    await capture(env as never, {
      error: new Error(message),
      route: "raw-capture-sync",
    });
    return { ok: false, skipped: true, reason };
  };

  if (env?.[RAW_CAPTURE_ENABLED_ENV] !== "true") {
    // Disabled is a deliberate state, not a fault: no capture, no noise.
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!env?.METAGRAPH_ARCHIVE?.put) {
    return loud(
      "store_unavailable",
      "METAGRAPH_ARCHIVE is not bound; refusing to run. Captured bytes have nowhere durable to land, and a tick that cannot store is a gap.",
    );
  }
  if (!env?.METAGRAPH_HEALTH_DB?.prepare) {
    return loud(
      "watermark_unavailable",
      "METAGRAPH_HEALTH_DB is not bound; refusing to run. Without a durable watermark the next tick cannot know where to resume, which is exactly how a gap forms.",
    );
  }

  const store: RawCaptureStore = {
    put: (key, value) => env.METAGRAPH_ARCHIVE!.put(key, value),
  };

  try {
    const result = await captureTick({
      rpcUrl: env.CHAIN_HEAD_RPC_URL || DEFAULT_RPC_URL,
      store,
      watermark: d1Watermark(env.METAGRAPH_HEALTH_DB, now),
      genesisFloor: RAW_CAPTURE_GENESIS_FLOOR,
      maxPerTick: MAX_BLOCKS_PER_TICK,
      fetchImpl: deps.fetchImpl,
      now,
    });
    if (result.stoppedAt !== undefined) {
      // Stopping short is EXPECTED and safe (the next tick retries the same
      // height), so this is a warning rather than an exception -- but it is
      // recorded, because a lane that stops at the same height every tick is
      // stuck, not merely behind.
      // captureTick sets stoppedAt and reason together, so no fallback here.
      console.warn(
        `[raw-capture-sync] stopped at ${result.stoppedAt}: ${result.reason} (watermark ${result.watermark}, behind ${result.behind})`,
      );
    }
    return { ok: true, ...result };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error("[raw-capture-sync]", message);
    await capture(env as never, { error, route: "raw-capture-sync" });
    return { ok: false, reason: message };
  }
}
