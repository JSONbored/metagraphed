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
 * Blocks per tick, per network. Each block costs three RPC calls.
 *
 * Two ceilings apply, and the tighter one wins per network.
 *
 * THE PLATFORM CEILING is 1000 subrequests per invocation, and both networks
 * run in ONE invocation, so the budgets are bounded together rather than
 * individually.
 *
 * THE ENDPOINT CEILING is ~100 requests per client per minute, measured against
 * the public testnet RPC by replaying this lane's exact call pattern (#9378):
 *
 *     FAILED after 33 blocks (100 calls) in 23.0s: HTTP 429
 *
 * It is per CLIENT, not per host — probing test.chain.opentensor.ai straight
 * afterwards stopped after 4 blocks, because the first probe had already spent
 * the budget. So there is no sibling endpoint to spread across, and a testnet
 * tick that asks for more than ~33 blocks does not go faster; it just gets the
 * surplus refused. The original 100 here made 300 calls to have 200 rejected
 * every five minutes, against an endpoint we do not own.
 *
 * 32, not 33: 32*3 + 1 head fetch = 97 calls, leaving headroom rather than
 * landing exactly on the limit, where a single retry tips the tick into a 429.
 *
 * Mainnet keeps its original 150. It sits at the tip in steady state (~25
 * blocks/tick, ~76 calls) so it does not approach the limit; the budget only
 * matters there for a backfill, and lowering it would slow a recovery this
 * measurement says nothing about.
 */
const MAX_BLOCKS_PER_TICK = 150;
const TESTNET_MAX_BLOCKS_PER_TICK = 32;

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
