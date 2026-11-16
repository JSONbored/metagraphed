import { McpSessionStateSchema } from "../schemas-src/internal-wire.ts";
import {
  McpSessionHub,
  type McpSessionHubEnv,
} from "../workers/mcp-session-hub.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import {
  createPgMcpSessionStore,
  parseMcpSessionState,
  type McpSessionLease,
  type McpStoreLimits,
} from "./pg-mcp-session-store.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { bufferNativeRequest } from "./native-request.ts";
import type { McpSessionService } from "./mcp-session-service.ts";
import type { SubnetStatusService } from "./subnet-status-service.ts";

export interface NativeMcpSessionOptions extends McpStoreLimits {
  maxResidentSessions: number;
  maxConcurrentCalls: number;
  maxPendingCallsPerSession: number;
  maxRequestBytes: number;
  maxQueuedFrames: number;
  renewIntervalMillis: number;
  residentIdleMillis: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  subnetStatus: SubnetStatusService;
  chainFirehose: SubnetStatusService;
  onBackgroundError(error: unknown): void;
}
interface Resident {
  id: string;
  lease: McpSessionLease;
  record: Record<string, unknown>;
  hub: McpSessionHub;
  valid: boolean;
  deadline: number;
  lastUsed: number;
  alarmVersion: number;
  queued: number;
  tail: Promise<void>;
  storageTail: Promise<void>;
  storageFailure?: { error: unknown };
  pending: Set<Promise<unknown>>;
  background: Set<Promise<unknown>>;
  signal?: AbortSignal;
  controller: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
  renewTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  streamCleanup?: () => void;
}

/** Resident session preparation only; explicit fetch/alarm entrypoints, no listener or poller. */
export async function createNativeMcpSessions(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: NativeMcpSessionOptions,
) {
  const options = { ...requested };
  for (const [name, value, max] of [
    ["maxResidentSessions", options.maxResidentSessions, 10000],
    ["maxConcurrentCalls", options.maxConcurrentCalls, 100],
    ["maxPendingCallsPerSession", options.maxPendingCallsPerSession, 100],
    ["maxRequestBytes", options.maxRequestBytes, 131072],
    ["maxQueuedFrames", options.maxQueuedFrames, 1024],
    ["renewIntervalMillis", options.renewIntervalMillis, 3600000],
    ["residentIdleMillis", options.residentIdleMillis, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid MCP ${name}`);
  if (
    options.renewIntervalMillis * 3 >= options.leaseMilliseconds ||
    options.executionTimeoutMillis >= options.leaseMilliseconds
  )
    throw new RangeError("MCP deadlines must leave lease renewal headroom");
  if (
    typeof options.subnetStatus?.fetch !== "function" ||
    typeof options.chainFirehose?.fetch !== "function" ||
    typeof options.onBackgroundError !== "function"
  )
    throw new TypeError(
      "Native MCP reverse services and error reporter are required",
    );
  const work = createNativeWorkGroup({
    name: "Native MCP",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });
  const store = await createPgMcpSessionStore(runtime, options);
  const residents = new Map<string, Resident>();
  const acquiring = new Map<string, Promise<Resident>>();
  const retiring = new Set<Resident>();
  let open = true,
    closed = false;
  let closing: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onBackgroundError(error);
    } catch {
      /* Reporting does not own custody. */
    }
  };
  const clearTimers = (entry: Resident) => {
    clearTimeout(entry.expiryTimer);
    clearTimeout(entry.renewTimer);
    clearTimeout(entry.idleTimer);
  };
  const retire = (
    entry: Resident,
    reason: unknown,
    release = false,
    empty = false,
  ) => {
    if (retiring.has(entry)) return;
    entry.valid = false;
    entry.controller.abort(reason);
    clearTimers(entry);
    entry.hub.dispose();
    entry.streamCleanup?.();
    if (residents.get(entry.id) === entry) residents.delete(entry.id);
    retiring.add(entry);
    void work
      .track(async () => {
        await entry.tail;
        while (entry.pending.size || entry.background.size)
          await Promise.allSettled([...entry.pending, ...entry.background]);
        if (release && (!empty || !(await store.dropEmpty(entry.lease))))
          await store.release(entry.lease);
      })
      .catch(report)
      .finally(() => retiring.delete(entry));
  };
  const assertOwner = (entry: Resident) => {
    if (!entry.valid || !open || performance.now() >= entry.deadline) {
      const error = new Error("Native MCP session ownership is unavailable");
      if (entry.valid) retire(entry, error);
      throw error;
    }
    entry.signal?.throwIfAborted();
  };
  const canSend = (entry: Resident) => {
    try {
      assertOwner(entry);
      return true;
    } catch {
      return false;
    }
  };
  const issue = <T>(
    entry: Resident,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const pending = entry.storageTail.then(async () => {
      assertOwner(entry);
      const value = await operation();
      assertOwner(entry);
      return value;
    });
    entry.pending.add(pending);
    entry.storageTail = pending.then(
      () => {},
      (error) => {
        entry.storageFailure ??= { error };
        retire(entry, error);
      },
    );
    void pending.finally(() => entry.pending.delete(pending)).catch(() => {});
    return pending;
  };
  const persist = (entry: Resident, entries: Record<string, unknown>) =>
    issue(entry, async () => {
      const next = { ...entry.record, ...structuredClone(entries) };
      const text = JSON.stringify(next);
      if (text !== JSON.stringify(entry.record))
        await store.save(entry.lease, text);
      entry.record = next;
    });
  const drain = async (entry: Resident) => {
    while (entry.pending.size || entry.background.size)
      await Promise.allSettled([...entry.pending, ...entry.background]);
    if (entry.storageFailure) throw entry.storageFailure.error;
  };
  const armExpiry = (
    entry: Resident,
    started: number,
    finished: number,
    clock: { nowMs: number; expiresAtMs: number },
  ) => {
    // Subtract the entire local roundtrip: neither NTP nor a late timer can extend custody.
    const remaining =
      clock.expiresAtMs - clock.nowMs - Math.max(0, finished - started);
    if (remaining <= 0)
      throw new Error("Native MCP lease arrived after its safe deadline");
    entry.deadline = finished + remaining;
    clearTimeout(entry.expiryTimer);
    entry.expiryTimer = setTimeout(
      () => retire(entry, new Error("Native MCP lease expired")),
      remaining,
    );
  };
  const scheduleRenew = (entry: Resident) => {
    clearTimeout(entry.renewTimer);
    entry.renewTimer = setTimeout(() => {
      if (!entry.valid || !open) return;
      const started = performance.now(),
        previous = entry.deadline;
      void issue(entry, () => store.renew(entry.lease))
        .then((clock) => {
          const finished = performance.now();
          if (!entry.valid || finished >= previous)
            throw new Error(
              "Native MCP renewal arrived after ownership expired",
            );
          armExpiry(entry, started, finished, clock);
          scheduleRenew(entry);
        })
        .catch((error) => {
          if (entry.valid) retire(entry, error);
        });
    }, options.renewIntervalMillis);
  };
  const scheduleIdle = (entry: Resident) => {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (!entry.valid || !open) return;
      if (
        entry.queued ||
        entry.hub.streamController ||
        performance.now() - entry.lastUsed < options.residentIdleMillis
      ) {
        scheduleIdle(entry);
        return;
      }
      retire(entry, new Error("Native MCP resident became idle"), true);
    }, options.residentIdleMillis);
  };
  const resident = (id: string): Promise<Resident> => {
    if (!open) return Promise.reject(new Error("Native MCP service is closed"));
    const existing = residents.get(id);
    if (existing) {
      assertOwner(existing);
      return Promise.resolve(existing);
    }
    const creating = acquiring.get(id);
    if (creating) return creating;
    if (
      residents.size + acquiring.size + retiring.size >=
      options.maxResidentSessions
    )
      return Promise.reject(new Error("Native MCP resident capacity exceeded"));
    const pending = (async () => {
      const started = performance.now(),
        lease = await store.acquire(id),
        finished = performance.now();
      if (!lease)
        throw new Error("Native MCP session is owned by another process");
      if (!open) {
        await store.release(lease);
        throw new Error("Native MCP service is closed");
      }
      const entry: Resident = {
        id,
        lease,
        record: parseMcpSessionState(lease.state),
        hub: undefined!,
        valid: true,
        deadline: 0,
        lastUsed: finished,
        alarmVersion: lease.alarmVersion,
        queued: 0,
        tail: Promise.resolve(),
        storageTail: Promise.resolve(),
        pending: new Set(),
        background: new Set(),
        controller: new AbortController(),
      };
      const environment: McpSessionHubEnv = {
        SUBNET_STATUS_SERVICE: options.subnetStatus,
        CHAIN_FIREHOSE_SERVICE: options.chainFirehose,
      };
      entry.hub = new McpSessionHub(
        {
          blockConcurrencyWhile: async (callback) => callback(),
          storage: {
            async get(keys) {
              assertOwner(entry);
              await entry.storageTail;
              assertOwner(entry);
              return new Map(
                keys
                  .filter((key) => Object.hasOwn(entry.record, key))
                  .map((key) => [key, structuredClone(entry.record[key])]),
              );
            },
            put: (entries) => persist(entry, entries),
            setAlarm(when) {
              return issue(entry, async () => {
                entry.alarmVersion = await store.setAlarm(
                  entry.lease,
                  when instanceof Date ? when.getTime() : when,
                );
              });
            },
          },
          waitUntil(value) {
            const pending = Promise.resolve(value).catch(report);
            entry.background.add(pending);
            void pending
              .finally(() => entry.background.delete(pending))
              .catch(() => {});
          },
        },
        environment,
        {
          canSend: () => canSend(entry),
          maxQueuedFrames: options.maxQueuedFrames,
        },
      );
      try {
        armExpiry(entry, started, finished, lease);
      } catch (error) {
        await store.release(lease);
        entry.valid = false;
        throw error;
      }
      residents.set(id, entry);
      scheduleRenew(entry);
      scheduleIdle(entry);
      return entry;
    })();
    acquiring.set(id, pending);
    void pending.finally(() => acquiring.delete(id)).catch(() => {});
    return pending;
  };
  const serial = <T>(
    entry: Resident,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    assertOwner(entry);
    if (entry.queued >= options.maxPendingCallsPerSession)
      return Promise.reject(
        new Error("Native MCP session call capacity exceeded"),
      );
    entry.queued++;
    entry.lastUsed = performance.now();
    const pending = entry.tail
      .then(async () => {
        entry.signal = AbortSignal.any([signal, entry.controller.signal]);
        let result!: T;
        let failure: { error: unknown } | undefined;
        try {
          assertOwner(entry);
          result = await operation();
        } catch (error) {
          failure = { error };
        }
        try {
          await drain(entry);
          assertOwner(entry);
          if (!failure && typeof entry.record.sessionId === "string") {
            // Explicit puts have drained: union only against their latest snapshot,
            // so an unsubscribe or termination cannot resurrect an old marker.
            const saved = McpSessionStateSchema.parse(entry.record);
            await persist(entry, {
              sequence: entry.hub.sequence,
              pendingUris: [
                ...new Set([
                  ...(saved.pendingUris ?? []),
                  ...entry.hub.pendingUris,
                ]),
              ],
            });
            await drain(entry);
          }
          assertOwner(entry);
        } catch (error) {
          failure ??= { error };
        }
        if (failure) {
          retire(entry, failure.error, !entry.storageFailure);
          throw failure.error;
        }
        return result;
      })
      .finally(() => {
        entry.signal = undefined;
        entry.queued--;
        entry.lastUsed = performance.now();
        if (entry.valid) scheduleIdle(entry);
      });
    entry.tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const streamResponse = (
    entry: Resident,
    response: Response,
    signal: AbortSignal,
  ) => {
    if (
      response.headers.get("content-type") !== "text/event-stream" ||
      !response.body
    )
      return response;
    entry.streamCleanup?.();
    const selected = entry.hub.streamController;
    const reader = response.body.getReader();
    let done = false;
    const releaseReader = () => {
      reader.releaseLock();
    };
    const cancelReader = () => {
      void reader
        .cancel()
        .then(releaseReader, releaseReader)
        .catch(() => {});
    };
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      // Every completion marks this bridge done before a replacement is installed.
      entry.streamCleanup = undefined;
    };
    const end = () => {
      if (done) return;
      done = true;
      cleanup();
      cancelReader();
      try {
        output.close();
      } catch {
        /* Already canceled. */
      }
    };
    const onAbort = () => {
      if (entry.hub.streamController === selected) entry.hub.dispose();
      end();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          // A notification is first queued by the shared hub, then its serial
          // call durably commits sequence/pending state. Expose bytes only after
          // that call drains; an uncommitted frame must not escape on failure.
          await entry.tail;
          if (done) return;
          if (!canSend(entry)) {
            end();
            return;
          }
          if (next.done) {
            done = true;
            cleanup();
            releaseReader();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (done) return;
          done = true;
          cleanup();
          releaseReader();
          controller.error(error);
        }
      },
      cancel() {
        if (!done) {
          done = true;
          cleanup();
          cancelReader();
        }
      },
    });
    entry.streamCleanup = end;
    signal.addEventListener("abort", onAbort, { once: true });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const service: McpSessionService & {
    readonly state: "ready" | "closing" | "closed";
    readonly residentCount: number;
    runDueAlarms(limit: number): Promise<{
      completed: number;
      rearmed: number;
      skipped: number;
      failed: number;
    }>;
    close(): Promise<void>;
  } = {
    get state() {
      return open ? "ready" : closed ? "closed" : "closing";
    },
    get residentCount() {
      return residents.size;
    },
    async fetch(id, request) {
      return work.run(
        "calls",
        options.maxConcurrentCalls,
        () => {
          throw new Error("Native MCP call capacity exceeded");
        },
        (scope) =>
          scope.invoke(async (signal) => {
            const combined = AbortSignal.any([signal, request.signal]);
            const buffered = await bufferNativeRequest(
              request,
              combined,
              options.maxRequestBytes,
            );
            const entry = await resident(id);
            const onAbort = () => retire(entry, combined.reason);
            combined.addEventListener("abort", onAbort, { once: true });
            try {
              const response = await serial(entry, combined, () =>
                entry.hub.fetch(buffered),
              );
              assertOwner(entry);
              const streamed = streamResponse(entry, response, request.signal);
              if (entry.hub.terminated || JSON.stringify(entry.record) === "{}")
                retire(
                  entry,
                  new Error("Native MCP session became inactive"),
                  true,
                  true,
                );
              return streamed;
            } finally {
              combined.removeEventListener("abort", onAbort);
            }
          }),
      );
    },
    runDueAlarms(limit) {
      return work.track(async () => {
        const result = { completed: 0, rearmed: 0, skipped: 0, failed: 0 };
        for (const id of await store.due(limit)) {
          try {
            const outcome = await work.run<
              "completed" | "rearmed" | "failed" | "skipped"
            >(
              "calls",
              options.maxConcurrentCalls,
              () => {
                throw new Error("Native MCP call capacity exceeded");
              },
              (scope) =>
                scope.invoke(async (signal) => {
                  const entry = await resident(id);
                  const onAbort = () => retire(entry, signal.reason);
                  signal.addEventListener("abort", onAbort, { once: true });
                  try {
                    const attempted = await serial(entry, signal, async () => {
                      const claim = await issue(entry, () =>
                        store.claimAlarm(entry.lease),
                      );
                      if (!claim) return null;
                      let failure: { error: unknown } | undefined;
                      try {
                        await entry.hub.alarm();
                      } catch (error) {
                        failure = { error };
                      }
                      return { claim, failure };
                    });
                    if (!attempted) return "skipped";
                    const { claim, failure } = attempted;
                    if (
                      !(await issue(entry, () =>
                        store.settleAlarm(entry.lease, claim, Boolean(failure)),
                      ))
                    )
                      throw new Error("Native MCP alarm claim was superseded");
                    if (entry.hub.terminated)
                      retire(
                        entry,
                        new Error("Native MCP session terminated"),
                        true,
                      );
                    if (failure) {
                      report(failure.error);
                      return "failed";
                    }
                    return entry.alarmVersion !== claim.version
                      ? "rearmed"
                      : "completed";
                  } finally {
                    signal.removeEventListener("abort", onAbort);
                  }
                }),
            );
            result[outcome]++;
          } catch (error) {
            report(error);
            result.failed++;
          }
        }
        return result;
      });
    },
    close() {
      if (closing) return closing;
      open = false;
      for (const entry of [...residents.values()])
        retire(entry, new Error("Native MCP service is closing"), true);
      closing = work.close().then(() => {
        closed = true;
      });
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
  return service;
}
