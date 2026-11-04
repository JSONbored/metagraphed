import {
  SubnetStatusHub,
  hydrateSubscriptionIndex,
  type SubnetStatusHubEnv,
} from "../workers/subnet-status-hub.ts";
import type { KeyedDoStorage } from "../workers/do-state.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { bufferNativeRequest } from "./native-request.ts";
import { asJsonObject } from "../schemas-src/json-request.ts";
import type {
  SubnetStatusNotifier,
  SubnetStatusService,
} from "./subnet-status-service.ts";

export interface NativeSubnetStatusOptions {
  maxConcurrentRequests: number;
  maxRequestBytes: number;
  maxStateBytes: number;
  maxMemberships: number;
  notificationConcurrency: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  notify: SubnetStatusNotifier["notify"];
  onBackgroundError(error: unknown): void;
}
interface StoredState {
  state: string;
  max_state_bytes: number;
  max_memberships: number;
}

/** Explicit stateful service preparation; no listener, singleton process or alarm loop. */
export async function createPgSubnetStatusHub(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: NativeSubnetStatusOptions,
): Promise<
  SubnetStatusService & {
    readonly state: "ready" | "closing" | "closed";
    close(): Promise<void>;
  }
> {
  const options = { ...requested };
  for (const [name, value, max] of [
    ["maxConcurrentRequests", options.maxConcurrentRequests, 64],
    ["maxRequestBytes", options.maxRequestBytes, 131072],
    ["maxStateBytes", options.maxStateBytes, 131072],
    ["maxMemberships", options.maxMemberships, 10000],
    ["notificationConcurrency", options.notificationConcurrency, 100],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid subnet status ${name}`);
  if (
    typeof options.notify !== "function" ||
    typeof options.onBackgroundError !== "function"
  )
    throw new TypeError(
      "Native subnet status notifier and error reporter are required",
    );
  const work = createNativeWorkGroup({
    name: "Native subnet status",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });
  const validate = (row: StoredState | null) => {
    if (
      !row ||
      row.max_state_bytes !== options.maxStateBytes ||
      row.max_memberships !== options.maxMemberships
    )
      throw new Error("Native subnet status policy differs");
    let state: Record<string, unknown> | null = null;
    if (typeof row.state === "string") {
      try {
        state = asJsonObject(JSON.parse(row.state));
      } catch {
        /* Invalid persisted JSON is unavailable. */
      }
    }
    if (!state) throw new Error("Invalid subnet status state");
    if (new TextEncoder().encode(row.state).byteLength > options.maxStateBytes)
      throw new RangeError("Subnet status state exceeds byte limit");
    const index = hydrateSubscriptionIndex(state.byNetuid);
    if (
      [...index.byNetuid.values()].reduce(
        (count, sessions) => count + sessions.size,
        0,
      ) > options.maxMemberships
    )
      throw new RangeError("Subnet status membership capacity exceeded");
    return state;
  };
  const load = async (tx: PgTransaction, lock: boolean) =>
    validate(
      await tx.first<StoredState>(
        `SELECT * FROM realtime.subnet_status_actor WHERE singleton${lock ? " FOR UPDATE" : ""}`,
      ),
    );
  await runtime.transaction(
    async (tx) => {
      await tx.run(
        "INSERT INTO realtime.subnet_status_actor(singleton,max_state_bytes,max_memberships) VALUES(true,?,?) ON CONFLICT(singleton) DO NOTHING",
        [options.maxStateBytes, options.maxMemberships],
      );
      await load(tx, true);
    },
    { isolation: "read committed" },
  );
  const report = (error: unknown) => {
    try {
      options.onBackgroundError(error);
    } catch {
      /* The reporter does not own completion. */
    }
  };
  return {
    get state() {
      return work.state;
    },
    async fetch(request) {
      return work.run(
        "requests",
        options.maxConcurrentRequests,
        () => {
          throw new Error("Native subnet status request capacity exceeded");
        },
        (scope) =>
          scope.invoke(async (workSignal) => {
            const signal = AbortSignal.any([request.signal, workSignal]);
            const buffered = await bufferNativeRequest(
              request,
              signal,
              options.maxRequestBytes,
            );
            const background: Promise<unknown>[] = [];
            const env: SubnetStatusHubEnv = {
              SUBNET_STATUS_NOTIFIER: {
                maxConcurrent: options.notificationConcurrency,
                notify: (
                  sessionId: string,
                  uri: string,
                  current: AbortSignal,
                ) => {
                  signal.throwIfAborted();
                  return options.notify(
                    sessionId,
                    uri,
                    AbortSignal.any([signal, current]),
                  );
                },
              } satisfies SubnetStatusNotifier,
            };
            const invoke = async (
              initial: Record<string, unknown>,
              tx?: PgTransaction,
            ) => {
              let state = initial;
              const storage: KeyedDoStorage = {
                async get(keys) {
                  signal.throwIfAborted();
                  return new Map(
                    keys
                      .filter((key) => Object.hasOwn(state, key))
                      .map((key) => [key, structuredClone(state[key])]),
                  );
                },
                async put(entries) {
                  signal.throwIfAborted();
                  if (!tx)
                    throw new Error(
                      "Notification snapshot cannot mutate membership",
                    );
                  const next = { ...state, ...structuredClone(entries) };
                  const serialized = JSON.stringify(next);
                  validate({
                    state: serialized,
                    max_state_bytes: options.maxStateBytes,
                    max_memberships: options.maxMemberships,
                  });
                  await tx.run(
                    "UPDATE realtime.subnet_status_actor SET state=? WHERE singleton",
                    [serialized],
                  );
                  signal.throwIfAborted();
                  state = next;
                },
              };
              const hub = new SubnetStatusHub(
                {
                  storage,
                  waitUntil(pending) {
                    background.push(Promise.resolve(pending).catch(report));
                  },
                },
                env,
              );
              const response = await hub.fetch(buffered);
              signal.throwIfAborted();
              return response;
            };
            const notify =
              request.method === "POST" &&
              new URL(request.url).pathname === "/notify-changed";
            let response: Response;
            try {
              if (notify) {
                // Finish the database snapshot before any outbound session call.
                const snapshot = await runtime.transaction(
                  (tx) => load(tx, false),
                  { isolation: "read committed" },
                );
                signal.throwIfAborted();
                response = await invoke(snapshot);
              } else
                response = await runtime.transaction(
                  async (tx) => {
                    const result = await invoke(await load(tx, true), tx);
                    signal.throwIfAborted();
                    return result;
                  },
                  { isolation: "read committed" },
                );
            } finally {
              await Promise.all(background);
            }
            signal.throwIfAborted();
            return response;
          }),
      );
    },
    close: work.close,
  };
}
