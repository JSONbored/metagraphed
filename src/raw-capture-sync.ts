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
import {
  CHAIN_RPC_URLS,
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "./chain-network.ts";

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
 * Testnet's floor, and why it is not genesis.
 *
 * Testnet has no lakehouse behind it, so unlike mainnet there is no prior
 * export to meet — the floor is a free choice, and "genesis" is the wrong one.
 * Capturing testnet from block 1 is 7.7M blocks; at this lane's budget that is
 * months of ticks spent on a chain that is periodically WIPED, to serve history
 * whose only consumer (a subnet developer checking their own recent activity)
 * cares about the last few days.
 *
 * 7,700,000 was the height ~8,200 blocks (~27h) below the testnet head when
 * this lane was written (head 7,708,225 on 2026-08-04). Starting one day back
 * gives the lane a short, bounded backfill that drains in a few hours and then
 * tracks the tip, rather than a backlog that never closes.
 *
 * Blocks below this are not captured, and that is a recorded decision rather
 * than a gap: `/api/v1/testnet/blocks` reports its own floor, so a caller can
 * tell "before we started" from "we lost it".
 */
export const TESTNET_RAW_CAPTURE_GENESIS_FLOOR = 7_700_000;

/**
 * Blocks per tick, per network. Each block costs three RPC calls.
 *
 * Both networks run in ONE invocation, so these are bounded together against
 * the platform's 1000-subrequest ceiling, not individually: 150*3 + 100*3 + two
 * head fetches = 752, leaving headroom for the R2 puts and D1 writes. Mainnet
 * keeps its original 150 — it is the lane with a real backlog to drain and an
 * existing cadence that is known to out-run the chain.
 */
const MAX_BLOCKS_PER_TICK = 150;
const TESTNET_MAX_BLOCKS_PER_TICK = 100;

/**
 * The capture lanes, as data.
 *
 * One row per network, so adding a third is a row rather than a branch — and
 * so the tick loop below cannot accidentally treat one network's floor or
 * endpoint as another's. Mainnet's values are byte-identical to what this lane
 * used before it grew a second network.
 */
export interface RawCaptureLane {
  network: ChainNetworkId;
  /** Env var carrying an endpoint override, if any. Mainnet's is the existing
   * CHAIN_HEAD_RPC_URL, kept so no deployed value changes meaning. */
  rpcUrlEnv: keyof RawCaptureEnv;
  defaultRpcUrl: string;
  genesisFloor: number;
  maxPerTick: number;
}

export const RAW_CAPTURE_LANES: readonly RawCaptureLane[] = [
  {
    network: "mainnet",
    rpcUrlEnv: "CHAIN_HEAD_RPC_URL",
    defaultRpcUrl: DEFAULT_RPC_URL,
    genesisFloor: RAW_CAPTURE_GENESIS_FLOOR,
    maxPerTick: MAX_BLOCKS_PER_TICK,
  },
  {
    network: "testnet",
    rpcUrlEnv: "TESTNET_CHAIN_HEAD_RPC_URL",
    // Verified 2026-08-04 to be a full archive: state readable at block 1,
    // unpruned, 186 RPC methods (#8700). Capture only needs recent blocks, but
    // an archive endpoint means a widened floor stays possible later.
    defaultRpcUrl: CHAIN_RPC_URLS.testnet,
    genesisFloor: TESTNET_RAW_CAPTURE_GENESIS_FLOOR,
    maxPerTick: TESTNET_MAX_BLOCKS_PER_TICK,
  },
];

interface RawCaptureEnv {
  METAGRAPH_ARCHIVE?: { put(key: string, value: string): Promise<unknown> };
  METAGRAPH_HEALTH_DB?: D1LikeDb;
  RAW_CAPTURE_ENABLED?: string;
  CHAIN_HEAD_RPC_URL?: string;
  TESTNET_CHAIN_HEAD_RPC_URL?: string;
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
export function d1Watermark(
  db: D1LikeDb,
  now: () => number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): WatermarkStore {
  return {
    async read() {
      const row = await db
        .prepare(
          `SELECT last_contiguous_block FROM raw_capture_state WHERE network = ?`,
        )
        .bind(network)
        .first?.();
      const value = row?.last_contiguous_block;
      return typeof value === "number" ? value : null;
    },
    async write(value: number) {
      return db
        .prepare(
          `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(network) DO UPDATE SET
             last_contiguous_block = excluded.last_contiguous_block,
             updated_at = excluded.updated_at`,
        )
        .bind(network, value, now())
        .run?.();
    },
  };
}

export interface RawCaptureSyncResult extends Partial<CaptureResult> {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  /** Per-network detail. Absent when the whole lane short-circuited (disabled
   * or a missing binding), present once any network actually ran. */
  lanes?: RawCaptureLaneResult[];
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

  // Each lane is captured independently and IN ORDER, mainnet first.
  //
  // Isolation is the whole point of the loop shape. Testnet is a best-effort
  // secondary lane against a chain that gets wiped; a testnet RPC outage must
  // not stop mainnet capture, and — because the mainnet lane runs first and its
  // watermark is already durable by then — it cannot. The reverse is also true:
  // a mainnet failure still lets testnet run, so one broken endpoint degrades
  // one lane rather than the cron.
  const lanes: RawCaptureLaneResult[] = [];
  for (const lane of RAW_CAPTURE_LANES) {
    lanes.push(
      await runLane(lane, {
        env,
        store,
        now,
        capture,
        fetchImpl: deps.fetchImpl,
      }),
    );
  }

  const mainnet = lanes.find((lane) => lane.network === "mainnet");
  // The top-level result keeps mainnet's shape verbatim: this function's return
  // value is consumed by the cron branch and by tests written before testnet
  // existed, and mainnet is still the lane whose health the lane-level alarms
  // are keyed to. Per-network detail rides alongside in `lanes`.
  return {
    ok: lanes.some((lane) => lane.ok),
    ...(mainnet?.result ?? {}),
    ...(mainnet?.ok === false && mainnet.reason
      ? { reason: mainnet.reason }
      : {}),
    lanes,
  };
}

export interface RawCaptureLaneResult extends Partial<CaptureResult> {
  network: ChainNetworkId;
  ok: boolean;
  reason?: string;
  /** The raw CaptureResult, kept whole so the caller can spread mainnet's
   * fields into the legacy top-level shape without re-deriving them. */
  result?: CaptureResult;
}

/** One network's tick. Never throws — a lane's failure is that lane's result. */
async function runLane(
  lane: RawCaptureLane,
  ctx: {
    env: RawCaptureEnv;
    store: RawCaptureStore;
    now: () => number;
    capture: typeof recordExceptionEvent;
    fetchImpl?: typeof fetch;
  },
): Promise<RawCaptureLaneResult> {
  const { env, store, now, capture } = ctx;
  try {
    const result = await captureTick({
      rpcUrl: (env[lane.rpcUrlEnv] as string | undefined) || lane.defaultRpcUrl,
      store,
      watermark: d1Watermark(env.METAGRAPH_HEALTH_DB!, now, lane.network),
      genesisFloor: lane.genesisFloor,
      maxPerTick: lane.maxPerTick,
      network: lane.network,
      fetchImpl: ctx.fetchImpl,
      now,
    });
    if (result.stoppedAt !== undefined) {
      // Stopping short is EXPECTED and safe (the next tick retries the same
      // height), so this is a warning rather than an exception -- but it is
      // recorded, because a lane that stops at the same height every tick is
      // stuck, not merely behind.
      // captureTick sets stoppedAt and reason together, so no fallback here.
      console.warn(
        `[raw-capture-sync] ${lane.network} stopped at ${result.stoppedAt}: ${result.reason} (watermark ${result.watermark}, behind ${result.behind})`,
      );
    }
    return { network: lane.network, ok: true, ...result, result };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error(`[raw-capture-sync] ${lane.network}`, message);
    await capture(env as never, {
      error,
      route: `raw-capture-sync:${lane.network}`,
    });
    return { network: lane.network, ok: false, reason: message };
  }
}
