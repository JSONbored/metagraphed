// Worker-side wiring for the raw chain capture lane (src/raw-chain-capture.ts).
//
// The pure capture logic and its no-gap guarantee live in that module; this
// one binds it to the runtime: the R2 bucket the bytes land in, the store row the
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
import { recordExceptionEvent, type TelemetryEnv } from "./usage-telemetry.ts";
import { mirrorRawCaptureStateToNeon } from "./capture-state-neon-write.ts";
import { createPgSql, type HyperdriveLike } from "./pg-sql.ts";
import type { WaitUntilLike } from "./pg-sql.ts";
import {
  CHAIN_RPC_URLS,
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "./chain-network.ts";
import type { StoreEnv } from "./read-store.ts";
import {
  captureEndpointList,
  resolveCaptureEndpoints,
  type CaptureEndpointDeps,
} from "./raw-capture-endpoints.ts";
import { readArtifact, readHealthKv } from "../workers/storage.ts";
import { recordLaneVerdict } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";

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
 * The real constraint WAS throughput, and that constraint has largely lifted.
 * The endpoint serves ~100 requests per minute, and this lane used to spend
 * three of them per block -- capping it near 33 blocks/minute, which put
 * genesis..7,700,000 at roughly 162 DAYS of continuous capture. Batching made
 * a chunk cost two requests for 25 blocks, so the same allowance now funds
 * hundreds of blocks/minute and that figure falls by more than an order of
 * magnitude. The floor is left where it is regardless: the watermark is long
 * past it, and lowering it is a separate decision about how much history to
 * buy, not a throughput problem any more.
 *
 * DRAIN TIME. The old numbers here (32 blocks/tick against ~25 produced, ~four
 * days to converge) described the three-requests-per-block lane and no longer
 * hold; the budget now outpaces both chains by roughly two orders of magnitude,
 * so a backlog closes at whatever rate the pacing allows rather than at the
 * margin between capture and production. The floor is deliberately NOT raised
 * to shorten a drain: the watermark is already past it, so moving it up would
 * leave the blocks in between permanently uncaptured, which is the one outcome
 * this lane exists to prevent.
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
 * individually. Chunking put two orders of magnitude between the lane and this
 * ceiling: a full mainnet tick now issues 33 subrequests, not 1,201.
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
 * bounded by its own span. Both numbers below fall out of the same measured
 * inputs -- the ceiling, the requests a chunk costs, the blocks a chunk carries,
 * and the cron interval -- so a cadence change or a third network moves them
 * together instead of leaving one behind.
 */
/**
 * HTTP REQUESTS the public RPC serves one client per minute, per backend node.
 *
 * REQUESTS, NOT CALLS, and the distinction is the whole shape of the budget
 * below. Re-measured 2026-08-16 against archive.chain.opentensor.ai by
 * replaying this lane's own pattern:
 *
 *     one call per request:      429 after 103 requests (103 calls)
 *     fifty calls per request:   no limit in 140 requests (1,400 calls, 103.7s)
 *
 * The same allowance carried 13.6x the data purely by batching, so what this
 * number bounds is round trips. A per-BLOCK call cost is therefore no longer a
 * multiplier on it -- see `REQUESTS_PER_CHUNK`.
 *
 * PER BACKEND NODE, not per client as #9378 concluded: exhausting archive and
 * then immediately draining lite.chain.opentensor.ai got a full fresh 100.
 * captureTick's `chunkGapMs` carries that measurement and why the lane still
 * does not try to spend more than one node's worth.
 *
 * Exported so the budget above is checked against it by a test rather than by a
 * comment — a raised `maxPerTick` that silently re-crosses this limit is the
 * exact regression #9378 was.
 */
export const RPC_REQUESTS_PER_MINUTE_LIMIT = 100;

// The wire costs belong to the module that makes the calls; re-exported here
// because the budget and its tests have always addressed them through this one.
// IMPORTED THEN RE-EXPORTED, not `export ... from`: a bare re-export does not
// bind the name locally, and the budget below reads both.
import {
  MAX_CAPTURE_CHUNK_BLOCKS,
  REQUESTS_PER_CHUNK,
} from "./raw-chain-capture.ts";
export { MAX_CAPTURE_CHUNK_BLOCKS, REQUESTS_PER_CHUNK };

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

/**
 * Blocks per chunk: ONE batched read and ONE durable write.
 *
 * THIS WAS A DEADLINE AND IS NOW A BATCH SIZE, which is the whole point of the
 * change that set it here. It was 5 because a chunk only becomes durable once
 * it is FULL, and reading a block cost three sequential round trips: the time
 * to the first durable write was `flushEvery * minGapMs`, which at 25 blocks
 * and a paced 4,500 ms was 112 s -- longer than the invocation lived, so a tick
 * wrote NOTHING. Measured against production 2026-08-16, mainnet: the watermark
 * advanced 25 blocks in 21 minutes while the chain advanced ~105, losing ~3.8
 * blocks/min and 8,409 blocks (~28 h) behind, throwing nothing the whole time.
 *
 * Batching removes the deadline instead of tuning it. A chunk is now TWO
 * requests regardless of size (~1.7 s measured for 25 blocks, 0.81 MB), so the
 * first durable write lands in seconds and the number is free to be what the
 * wire wants: the largest chunk the node will answer. Sizing it below the cap
 * would spend the same two requests on fewer blocks.
 *
 * DERIVED from the node's stated batch limit rather than chosen, so it cannot
 * drift past what the endpoint will serve -- an over-large chunk is refused
 * whole, which would stall the lane rather than slow it.
 */
const FLUSH_EVERY_BLOCKS = MAX_CAPTURE_CHUNK_BLOCKS;

/**
 * The paced budget for ONE lane, in the unit the endpoint actually meters.
 *
 * COUNTED IN REQUESTS, NOT BLOCKS, and that is the correction this function
 * needed. The old form divided a per-minute allowance by three CALLS per block
 * and got ~33 blocks/minute as a hard ceiling -- a ceiling that was never real,
 * because the limit counts round trips (see RPC_REQUESTS_PER_MINUTE_LIMIT for
 * the measurement). A chunk costs `REQUESTS_PER_CHUNK` whatever its size, so
 * the same allowance now funds `MAX_CAPTURE_CHUNK_BLOCKS` times more blocks and
 * the lane's problem stops being rate at all.
 *
 * `laneCount` DIVIDES. Mainnet and testnet run concurrently, and while they
 * read DIFFERENT backend nodes -- so they do not in fact share one bucket --
 * the division is kept deliberately. This lane is a guest on free public
 * infrastructure that the same community also uses, and the resulting spend
 * (~32 requests/minute per lane against a measured ~100) is already two orders
 * of magnitude more headroom than a chain producing five blocks/minute needs.
 * Buying the last factor of two would cost politeness for throughput nobody
 * can use.
 *
 * There is deliberately NO host parameter, and a test pins the budget against
 * the endpoint count so one cannot be reintroduced silently. Rotation is
 * FAILOVER and archive-depth coverage, not rate; captureTick's `chunkGapMs`
 * carries the DNS measurement showing why a host multiplier would be wrong
 * even where it looks free.
 */
export function pacedLaneBudget(
  laneCount: number,
  cronMinutes: number,
  limitPerMinute: number = RPC_REQUESTS_PER_MINUTE_LIMIT,
): { maxBlocks: number; minGapMs: number } {
  const requestsPerMinute =
    (limitPerMinute * RPC_BUDGET_UTILISATION) / laneCount;
  const chunksPerMinute = requestsPerMinute / REQUESTS_PER_CHUNK;
  const blocksPerMinute = chunksPerMinute * MAX_CAPTURE_CHUNK_BLOCKS;
  return {
    // Lanes run CONCURRENTLY, so each gets the whole spendable interval rather
    // than its share of it.
    //
    // The floor is a whole CHUNK, not one block: a chunk is indivisible on the
    // wire, so a budget below one would pace a tick to read nothing.
    maxBlocks: Math.max(
      MAX_CAPTURE_CHUNK_BLOCKS,
      Math.floor(blocksPerMinute * cronMinutes * TICK_SPEND_FRACTION),
    ),
    // Between CHUNK STARTS. captureTick subtracts the read's own duration from
    // this, so the figure is a true cycle time and the request rate lands on
    // the budget instead of on `budget + latency`.
    minGapMs: Math.ceil(60_000 / chunksPerMinute),
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

interface RawCaptureEnv extends TelemetryEnv, StoreEnv {
  METAGRAPH_ARCHIVE?: { put(key: string, value: string): Promise<unknown> };
  RAW_CAPTURE_ENABLED?: string;
  CHAIN_HEAD_RPC_URL?: string;
  TESTNET_CHAIN_HEAD_RPC_URL?: string;
}

export interface WatermarkReadDb {
  first?(
    text: string,
    values?: unknown[],
  ): Promise<Record<string, unknown> | null>;
}

/**
 * The same store, plus a Neon mirror on every write.
 *
 * Wrapping rather than duplicating: `raw_capture_state` has exactly one writer
 * and it is this store's `write`, so there is no second path to keep in step.
 * The mirror runs AFTER the store returns and its failure is a lane verdict only --
 * the capture must not lose a tick because the copy is unreachable.
 */
/**
 * The watermark as Neon holds it, or null when Neon cannot be reached.
 *
 * Returns a reader rather than a value so the connection is opened only on the
 * tick that actually reads. Null (rather than 0) on any failure: the capture
 * treats null as "start at the floor" and 0 as a real watermark, so a failed
 * read must never be mistaken for a genesis restart.
 */
function neonWatermarkRead(
  env: StoreEnv | null | undefined,
  waitUntil: WaitUntilLike | undefined,
  network: string,
): (() => Promise<number | null>) | null {
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  if (!hyperdrive?.connectionString || !waitUntil) return null;
  return async () => {
    try {
      const sql = createPgSql(hyperdrive, waitUntil);
      const rows = (await sql.unsafe(
        "SELECT last_contiguous_block FROM raw_capture_state WHERE network = $1",
        [network],
      )) as { last_contiguous_block?: unknown }[];
      const value = rows?.[0]?.last_contiguous_block;
      return typeof value === "number" ? value : null;
    } catch (error) {
      console.error("[raw-capture-watermark-neon]", String(error));
      return null;
    }
  };
}

/**
 * The watermark store, on Neon.
 *
 * THE READ AND THE WRITE MOVE TOGETHER, always. An earlier version of this
 * nearly shipped writing Neon while still reading a store-backed store, so the
 * watermark would have been read from a row nothing updated again. The capture
 * resumes FROM that value, so it would have re-captured the same blocks every
 * tick, forever, while both stores looked healthy.
 *
 * Reads return null (rather than 0) on any failure: the capture treats null as
 * "start at the floor" and 0 as a real watermark, so a failed read must never
 * be mistaken for a genesis restart.
 */
export function neonWatermark(
  env: StoreEnv | null | undefined,
  waitUntil: WaitUntilLike | undefined,
  network: string,
  now: () => number,
): WatermarkStore {
  const read = neonWatermarkRead(env, waitUntil, network);
  return {
    read: () => (read ? read() : Promise.resolve(null)),
    async write(value: number) {
      await mirrorRawCaptureStateToNeon(env, waitUntil, network, value, now());
      return undefined;
    },
  };
}

/**
 * The watermark row, read through any `prepare().bind().first()` handle.
 *
 * Read-only on purpose: its one caller is the lakehouse-seam watchdog, which
 * reuses the capture lane's own column names so the two can never disagree
 * about where the watermark lives. Absent row => null, which the capture
 * treats as "start at the floor".
 */
export function watermarkRead(
  db: WatermarkReadDb,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): () => Promise<number | null> {
  return async () => {
    const row = await db.first?.(
      `SELECT last_contiguous_block FROM raw_capture_state WHERE network = ?`,
      [network],
    );
    const value = row?.last_contiguous_block;
    return typeof value === "number" ? value : null;
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
    /** Needed to reach Neon: createPgSql returns the pooled connection through
     * waitUntil, so without one the mirror is skipped rather than leaking. */
    ctx?: WaitUntilLike;
    /**
     * How the lane discovers the archive endpoints it may read from.
     *
     * DEFAULTED, NOT OPTIONAL-AND-UNSET. An injectable that nothing injects in
     * production is a feature that never runs, so the real readers are the
     * default and a test overrides them. `resolveCaptureEndpoints` already
     * treats every unreadable shape as "no pool", so wiring the live readers
     * here cannot make a tick fail -- it can only widen the rotation.
     */
    endpointDeps?: CaptureEndpointDeps;
  } = {},
): Promise<RawCaptureSyncResult> {
  const now = deps.now ?? Date.now;
  const capture = deps.recordException ?? recordExceptionEvent;
  const loud = async (reason: string, message: string) => {
    console.error(`[raw-capture-sync] ${message}`);
    await capture(env, {
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
  // A watermark this tick can READ AND WRITE (#10158). The refusal stays even
  // though there is only one store left: without a durable watermark the next
  // tick cannot know where to resume, which is exactly how a gap forms.
  // the ownership check collapsed with the flag (#10051): Neon is the only
  // store, so durability is the BINDING question alone
  const captureStateOnNeon = Boolean(env?.HYPERDRIVE?.connectionString);
  if (!captureStateOnNeon) {
    return loud(
      "watermark_unavailable",
      "no store holds raw_capture_state; refusing to run. Without a durable watermark the next tick cannot know where to resume, which is exactly how a gap forms.",
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
        waitUntil: deps.ctx,
        fetchImpl: deps.fetchImpl,
        sleepFn: deps.sleepFn,
        endpointDeps: deps.endpointDeps ?? {
          readArtifact: (e, path) =>
            readArtifact(e as Parameters<typeof readArtifact>[0], path),
          readHealthKv: (e, key) =>
            readHealthKv(e as Parameters<typeof readHealthKv>[0], key),
        },
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
    waitUntil?: WaitUntilLike;
    endpointDeps?: CaptureEndpointDeps;
  },
): Promise<RawCaptureLaneResult> {
  const { env, store, now, capture } = ctx;
  try {
    const configured =
      (env[lane.rpcUrlEnv] as string | undefined) || lane.defaultRpcUrl;
    // The registry's archive-capable members for this network, behind the
    // configured host. Empty when the pool cannot answer, which degrades to
    // exactly the single-endpoint lane this was before.
    const fromPool = ctx.endpointDeps
      ? await resolveCaptureEndpoints(env, lane.network, ctx.endpointDeps)
      : [];
    const rpcUrls = captureEndpointList(configured, fromPool);
    // The per-host limit is what was measured, so the budget scales with the
    // hosts this tick actually has -- derived here rather than compiled in,
    // because the pool's membership changes without a deploy.
    // NOT widened by `rpcUrls.length`. See pacedLaneBudget: the allowance is
    // per backend node, but two of the three mainnet names resolve to one
    // machine and batching already leaves the lane two orders of magnitude of
    // headroom, so there is nothing a host multiplier could buy. The rotation
    // is failover and archive coverage.
    const budget = pacedLaneBudget(
      RAW_CAPTURE_LANES.length,
      cronStepMinutes(RAW_CAPTURE_CRON),
      RPC_REQUESTS_PER_MINUTE_LIMIT,
    );
    const result = await captureTick({
      rpcUrls,
      store,
      // THE TABLE IS THE WATERMARK, so this store is the whole write path.
      watermark: neonWatermark(ctx.env, ctx.waitUntil, lane.network, now),
      genesisFloor: lane.genesisFloor,
      // The lane's table values are the ONE-HOST budget, kept as the floor this
      // can never fall below; `budget` widens them when the pool offers more.
      maxPerTick: Math.max(lane.maxPerTick, budget.maxBlocks),
      network: lane.network,
      minGapMs: Math.min(lane.minGapMs, budget.minGapMs),
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
    // THE TICK'S OWN THROUGHPUT, DURABLY.
    //
    // Everything above was a `console.warn`, which is why "is this lane gaining
    // or losing?" could only be answered by polling `raw_capture_state` by hand
    // across an hour and differencing it. The lane already KNOWS: `captured` is
    // what this tick landed and `behind` is what remains. Throwing both away
    // each tick is what let it lose ~3.8 blocks/min for 28 hours while every
    // watchdog read a watermark that was, technically, advancing.
    //
    // `age_ms` is deliberately null: this is not a staleness verdict (the seam
    // watchdog's rule 6 owns that question against the chain head). This is the
    // RATE, so a reader can tell a lane that is behind-and-closing from one
    // that is behind-and-widening -- two states an absolute lag cannot separate,
    // and the difference between "wait" and "page someone".
    //
    // Never throws; recordLaneVerdict swallows its own failures.
    await recordLaneVerdict(laneHealthStore(env), {
      lane: `raw-capture:${lane.network}`,
      // `ok` means the tick RAN and landed what it could. A short tick is not a
      // fault -- the next one resumes at the same height -- so the verdict
      // tracks whether the lane is keeping pace, not whether it stopped early.
      // A watermark already at the measured head needs no new writes. Only
      // zero progress with a remaining backlog is a stalled capture tick.
      verdict: result.captured > 0 || result.behind === 0 ? "ok" : "stale",
      age_ms: null,
      detail:
        `${result.captured} captured, ${result.behind} behind, ` +
        `${rpcUrls.length} endpoint(s)` +
        (result.stoppedAt === undefined
          ? ""
          : `, stopped at ${result.stoppedAt}: ${result.reason}`),
      checked_at: now(),
    });
    return { network: lane.network, ok: true, ...result, result };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error(`[raw-capture-sync] ${lane.network}`, message);
    await capture(env, {
      error,
      route: `raw-capture-sync:${lane.network}`,
    });
    return { network: lane.network, ok: false, reason: message };
  }
}
