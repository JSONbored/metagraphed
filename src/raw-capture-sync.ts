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
import { RAW_CAPTURE_CRON } from "../workers/config.ts";
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
 * export to meet — the floor is a free choice. 7,700,000 was the height ~8,200
 * blocks (~27h) below the testnet head when this lane was written (head
 * 7,708,225 on 2026-08-04).
 *
 * THE ORIGINAL REASON GIVEN HERE WAS WRONG, and is corrected rather than
 * quietly deleted because it is the kind of claim that gets planned against.
 * It said the floor was shallow because testnet "is periodically WIPED" and so
 * its history has no consumer. The chain is NOT wiped. Measured 2026-08-04
 * from `Timestamp.Now` at block 1 and at head: testnet block 1 is 2023-08-03
 * and the height has climbed monotonically ever since — 3.00 years continuous,
 * against mainnet's 3.38. What churns is SUBNET state (netuids deregistered
 * and recycled), not the ledger underneath.
 *
 * The real constraint is throughput, not staleness. The public endpoint serves
 * ~100 requests per client per minute (#9378), which at 3 calls per block caps
 * this lane near 33 blocks/minute — so genesis..7,700,000 is roughly 162 DAYS
 * of continuous capture from one client. That is why the floor is shallow, and
 * it is a cost problem with real options (a bulk snapshot from the Foundation,
 * a raised limit, a dedicated backfill lane) rather than a "nobody wants it"
 * problem. Three years of continuous testnet history is genuinely useful — it
 * covers the full testnet life of every subnet that later graduated to
 * mainnet.
 *
 * DRAIN TIME, measured rather than hoped (#9378): the endpoint's rate limit
 * caps a tick at 32 blocks while the chain produces ~25 in the same 5 minutes,
 * so the backlog closes at ~7 blocks/tick — about **four days**, not the "few
 * hours" this comment originally claimed. It does converge, and the lane tracks
 * the tip once it has. The floor is deliberately NOT raised to shorten that:
 * the watermark is already past it, so moving it up would leave the blocks in
 * between permanently uncaptured, which is the one outcome this lane exists to
 * prevent.
 *
 * Blocks below this are not captured, and that is a recorded decision rather
 * than a gap: `/api/v1/testnet/blocks` reports its own floor, so a caller can
 * tell "before we started" from "we lost it".
 */
export const TESTNET_RAW_CAPTURE_GENESIS_FLOOR = 7_700_000;

/**
 * The per-lane tick budget, DERIVED from the endpoint's own limit.
 *
 * THE PLATFORM CEILING is 1000 subrequests per invocation, and every lane runs
 * in ONE invocation, so the budgets are bounded together rather than
 * individually.
 *
 * THE ENDPOINT CEILING is ~100 requests per client per minute, measured by
 * replaying this lane's exact call pattern (#9378):
 *
 *     FAILED after 33 blocks (100 calls) in 23.0s: HTTP 429
 *
 * It is per CLIENT, not per host -- probing test.chain.opentensor.ai straight
 * afterwards stopped after 4 blocks, because the first probe had already spent
 * the budget. So there is no sibling endpoint to spread across.
 *
 * THESE USED TO BE TWO HAND-WRITTEN NUMBERS (150 mainnet, 32 testnet), and
 * #9430 is what that cost. 32 was pinned just under the measured 429; 150 was
 * chosen when mainnet was the only lane. Together they sustained 109 calls/min
 * against a 100/min ceiling the moment a second lane existed -- over budget in
 * the worst case with nothing to say so -- while testnet saturated its own cap
 * every tick and sat ~92 hours from closing a gap the interval could close in
 * ~16.
 *
 * The limit is PER MINUTE, so that is what the budget reads. An unpaced tick is
 * bounded by one minute's allowance however long it runs; a paced one is
 * bounded by its own span. Both numbers below fall out of the same three
 * measured inputs -- the ceiling, the calls per block, and the cron interval --
 * so a cadence change or a third network moves them together instead of leaving
 * one behind.
 */
/**
 * Requests the public RPC serves one client per minute, measured (#9378).
 *
 * Exported so the budget above is checked against it by a test rather than by a
 * comment — a raised `maxPerTick` that silently re-crosses this limit is the
 * exact regression #9378 was.
 */
export const RPC_REQUESTS_PER_MINUTE_LIMIT = 100;

/** RPC calls one captured block costs: hash, block body, events blob. */
export const RPC_CALLS_PER_BLOCK = 3;

const RPC_BUDGET_UTILISATION = 0.8;

/**
 * Fraction of the interval a tick may spend reading.
 *
 * Not all of it: cron jitter and a redeploy landing mid-tick both want slack,
 * and a tick still running when the next fires would double the rate. Chunked
 * flushing (see captureTick) is what makes even this much affordable -- a
 * killed invocation now loses one chunk rather than everything it read.
 */
const TICK_SPEND_FRACTION = 0.8;

/** Blocks per durable write. One R2 PUT each, so this trades a few writes for
 * how much a killed invocation discards -- 25 blocks is ~2 minutes of chain. */
const FLUSH_EVERY_BLOCKS = 25;

/** The paced budget for ONE lane, given how many share the client allowance. */
export function pacedLaneBudget(
  laneCount: number,
  cronMinutes: number,
  limitPerMinute: number = RPC_REQUESTS_PER_MINUTE_LIMIT,
): { maxBlocks: number; minGapMs: number } {
  const callsPerMinute = (limitPerMinute * RPC_BUDGET_UTILISATION) / laneCount;
  const blocksPerMinute = callsPerMinute / RPC_CALLS_PER_BLOCK;
  return {
    // Lanes run CONCURRENTLY, so each gets the whole spendable interval rather
    // than its share of it.
    maxBlocks: Math.max(
      1,
      Math.floor(blocksPerMinute * cronMinutes * TICK_SPEND_FRACTION),
    ),
    minGapMs: Math.ceil(60_000 / blocksPerMinute),
  };
}

/** The `*` `/N` minute step of a cron. An unreadable cron falls back to the
 * shipped cadence, narrowing the budget rather than widening it. */
export function cronStepMinutes(cron: string): number {
  const step = Number(cron.split(" ")[0]!.replace("*/", ""));
  return Number.isInteger(step) && step > 0 ? step : 5;
}

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
  /** Gap between two blocks' reads, so the tick's span is the budget rather
   * than one minute's allowance. */
  minGapMs: number;
  /** Blocks per durable write. */
  flushEvery: number;
}

/** Every lane draws on ONE client allowance, so they share one derived
 * budget. Declared before the table because the table needs it. */
const LANE_BUDGET = pacedLaneBudget(2, cronStepMinutes(RAW_CAPTURE_CRON));

export const RAW_CAPTURE_LANES: readonly RawCaptureLane[] = [
  {
    network: "mainnet",
    rpcUrlEnv: "CHAIN_HEAD_RPC_URL",
    defaultRpcUrl: DEFAULT_RPC_URL,
    genesisFloor: RAW_CAPTURE_GENESIS_FLOOR,
    maxPerTick: LANE_BUDGET.maxBlocks,
    minGapMs: LANE_BUDGET.minGapMs,
    flushEvery: FLUSH_EVERY_BLOCKS,
  },
  {
    network: "testnet",
    rpcUrlEnv: "TESTNET_CHAIN_HEAD_RPC_URL",
    // Verified 2026-08-04 to be a full archive: state readable at block 1,
    // unpruned, 186 RPC methods (#8700). Capture only needs recent blocks, but
    // an archive endpoint means a widened floor stays possible later.
    defaultRpcUrl: CHAIN_RPC_URLS.testnet,
    genesisFloor: TESTNET_RAW_CAPTURE_GENESIS_FLOOR,
    maxPerTick: LANE_BUDGET.maxBlocks,
    minGapMs: LANE_BUDGET.minGapMs,
    flushEvery: FLUSH_EVERY_BLOCKS,
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
    /** Injectable so a test asserts the PACING without waiting for it (#9430). */
    sleepFn?: (ms: number) => Promise<void>;
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
  // CONCURRENT, not sequential (#9430). Isolation is still the whole point:
  // testnet is a best-effort secondary lane, and a testnet RPC outage must not
  // stop mainnet capture. `runLane` already converts every failure into a
  // result rather than a throw, so `Promise.all` here cannot let one lane's
  // failure reject the other's -- isolation comes from that, not from ordering.
  //
  // Sequential was what made the budget unusable. Each lane is paced to its own
  // share of the per-minute allowance, so running them in parallel does not
  // raise the combined rate at all -- it just stops each lane idling through
  // the other's turn. Two lanes each getting the WHOLE interval instead of half
  // is the entire throughput gain here.
  const lanes: RawCaptureLaneResult[] = await Promise.all(
    RAW_CAPTURE_LANES.map((lane) =>
      runLane(lane, {
        env,
        store,
        now,
        capture,
        fetchImpl: deps.fetchImpl,
        sleepFn: deps.sleepFn,
      }),
    ),
  );

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
    sleepFn?: (ms: number) => Promise<void>;
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
      minGapMs: lane.minGapMs,
      flushEvery: lane.flushEvery,
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
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
