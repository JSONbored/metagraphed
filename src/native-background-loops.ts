import {
  createPgCronDispatcher,
  type createPgCronScheduler,
} from "./pg-cron.ts";
import {
  createPgQueueDispatcher,
  PG_QUEUE_CONCURRENCY,
  PG_QUEUE_NAMES,
  type createPgQueueTransport,
} from "./pg-queue.ts";
import type { createNativeMcpSessions } from "./native-mcp-sessions.ts";
import type { createNativeChainFirehose } from "./native-chain-firehose.ts";
import type { createPgRpcUsageStore } from "./pg-rpc-usage.ts";
import type { createNativeAuthControls } from "./native-auth-controls.ts";

export interface NativeBackgroundCadence {
  cronPlan: number;
  cronRun: number;
  queues: number;
  mcpAlarms: number;
  chainAlarm: number;
  rpcFlush: number;
  rpcPrune: number;
  authPrune: number;
}
export interface NativeBackgroundOptions {
  cron: Pick<
    Awaited<ReturnType<typeof createPgCronScheduler>>,
    "register" | "plan" | "run"
  >;
  queues: Pick<Awaited<ReturnType<typeof createPgQueueTransport>>, "run">;
  owners: Parameters<typeof createPgCronDispatcher>[1] &
    Parameters<typeof createPgQueueDispatcher>[1];
  mcp: Pick<
    Awaited<ReturnType<typeof createNativeMcpSessions>>,
    "runDueAlarms"
  >;
  chain: Pick<
    Awaited<ReturnType<typeof createNativeChainFirehose>>,
    "runDueAlarm"
  >;
  rpc: Pick<ReturnType<typeof createPgRpcUsageStore>, "flush" | "prune">;
  auth: Pick<ReturnType<typeof createNativeAuthControls>, "pruneExpiredRates">;
  cadence: NativeBackgroundCadence;
  cronRunners: number;
  mcpAlarmBatch: number;
  authPruneBatch: number;
  stopTimeoutMillis: number;
  onError(error: unknown, loop: string): void;
}
interface Loop {
  name: string;
  interval: number;
  run(): Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
}

function bounded(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`Invalid native background ${name}`);
}
function method<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const value = object?.[key];
  if (typeof value !== "function")
    throw new TypeError(`Native background ${String(key)} is required`);
  return value.bind(object) as T[K];
}

/** Explicit loop owner. Construction performs no registration, work or timers.
 * Stop recurring admission before draining requests; close adapters afterward. */
export function createNativeBackgroundLoops(options: NativeBackgroundOptions) {
  const cadence = { ...options.cadence };
  for (const name of [
    "cronPlan",
    "cronRun",
    "queues",
    "mcpAlarms",
    "chainAlarm",
    "rpcFlush",
    "rpcPrune",
    "authPrune",
  ] as const)
    bounded(cadence[name], 10, 3600000, name);
  bounded(options.cronRunners, 1, 100, "cron runners");
  bounded(options.mcpAlarmBatch, 1, 100, "MCP alarm batch");
  bounded(options.authPruneBatch, 1, 10000, "auth prune batch");
  bounded(options.stopTimeoutMillis, 1, 3600000, "stop timeout");
  if (typeof options.onError !== "function")
    throw new TypeError("Native background error reporter is required");
  const report = options.onError;
  const stopTimeout = options.stopTimeoutMillis;
  const register = method(options.cron, "register");
  const plan = method(options.cron, "plan");
  const cron = createPgCronDispatcher(
    { run: method(options.cron, "run") },
    {
      api: { scheduled: method(options.owners?.api, "scheduled") },
      data: { scheduled: method(options.owners?.data, "scheduled") },
      registry: { scheduled: method(options.owners?.registry, "scheduled") },
    },
  );
  const queue = createPgQueueDispatcher(
    { run: method(options.queues, "run") },
    {
      api: { queue: method(options.owners?.api, "queue") },
      data: { queue: method(options.owners?.data, "queue") },
    },
  );
  const alarms = method(options.mcp, "runDueAlarms");
  const mcpBatch = options.mcpAlarmBatch;
  const pruneRates = method(options.auth, "pruneExpiredRates");
  const authBatch = options.authPruneBatch;
  const loops: Loop[] = [
    { name: "cron-plan", interval: cadence.cronPlan, run: plan },
    ...Array.from({ length: options.cronRunners }, (_, index) => ({
      name: `cron-run:${index}`,
      interval: cadence.cronRun,
      run: cron,
    })),
    ...PG_QUEUE_NAMES.flatMap((name) =>
      Array.from({ length: PG_QUEUE_CONCURRENCY[name] }, (_, index) => ({
        name: `queue:${name}:${index}`,
        interval: cadence.queues,
        run: () => queue.run(name),
      })),
    ),
    {
      name: "mcp-alarms",
      interval: cadence.mcpAlarms,
      run: () => alarms(mcpBatch),
    },
    {
      name: "chain-alarm",
      interval: cadence.chainAlarm,
      run: method(options.chain, "runDueAlarm"),
    },
    {
      name: "rpc-flush",
      interval: cadence.rpcFlush,
      run: method(options.rpc, "flush"),
    },
    {
      name: "rpc-prune",
      interval: cadence.rpcPrune,
      run: method(options.rpc, "prune"),
    },
    {
      name: "auth-prune",
      interval: cadence.authPrune,
      run: () => pruneRates(authBatch),
    },
  ];
  let state: "ready" | "starting" | "running" | "stopping" | "stopped" =
    "ready";
  let startBoundary: number | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let completed = 0,
    failed = 0;
  const active = new Set<Promise<unknown>>();
  const track = (name: string, run: () => Promise<unknown>) => {
    const task = Promise.resolve().then(run);
    active.add(task);
    void task
      .then(
        () => {
          completed++;
        },
        (error) => {
          failed++;
          try {
            report(error, name);
          } catch {
            /* Reporting cannot discard work. */
          }
        },
      )
      .finally(() => active.delete(task));
    return task;
  };
  const turn = (loop: Loop) => {
    if (state !== "running") return;
    loop.timer = undefined;
    const finished = () => {
      if (state === "running") {
        loop.timer = setTimeout(() => turn(loop), loop.interval);
        loop.timer.unref();
      }
    };
    void track(loop.name, loop.run).then(finished, finished);
  };
  return Object.freeze({
    get state() {
      return state;
    },
    stats() {
      return { active: active.size, completed, failed, loops: loops.length };
    },
    start(boundary: number): Promise<void> {
      bounded(boundary, 0, Number.MAX_SAFE_INTEGER, "start boundary");
      if (
        (state === "starting" || state === "running") &&
        boundary === startBoundary
      )
        return starting!;
      if (state !== "ready")
        return Promise.reject(
          new Error("Native background loops cannot start"),
        );
      state = "starting";
      startBoundary = boundary;
      starting = track("cron-register", () => register(boundary)).then(
        () => {
          if (state !== "starting") return;
          state = "running";
          for (const loop of loops) turn(loop);
        },
        (error) => {
          if (state === "starting") state = "stopped";
          throw error;
        },
      );
      return starting;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      if (state === "stopped") return Promise.resolve();
      state = "stopping";
      for (const loop of loops) {
        clearTimeout(loop.timer);
        loop.timer = undefined;
      }
      draining ??= (async () => {
        while (active.size) await Promise.allSettled([...active]);
        state = "stopped";
      })();
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Native background stop deadline exceeded; unfinished work remains",
              ),
            ),
          stopTimeout,
        );
      });
      stopping = Promise.race([draining, deadline]).finally(() =>
        clearTimeout(timer),
      );
      void stopping.catch(() => {
        stopping = undefined;
      });
      return stopping;
    },
  });
}
