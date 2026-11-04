import {
  ChainFirehoseHub,
  CHAIN_FIREHOSE_MAX_WS_CONNECTIONS,
  CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP,
  chainFirehoseCapRefusal,
  chainFirehoseMatchesTopics,
  parseChainFirehoseTopics,
  type ChainFirehoseIngestPayload,
} from "../workers/chain-firehose-hub.ts";
import { GRAPHQL_TRANSPORT_WS_PROTOCOL } from "graphql-ws";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";
import type { McpSessionService } from "./mcp-session-service.ts";
import type { SubnetStatusService } from "./subnet-status-service.ts";
import { resolveClientIp } from "../workers/config.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { bufferNativeRequest } from "./native-request.ts";
import {
  createPgChainFirehoseStore,
  parseChainState,
  type ChainStateLimits,
} from "./pg-chain-firehose-store.ts";
import type { ChainHeadProvider } from "./native-chain-head.ts";
import { ChainFirehoseUnavailableError } from "./chain-firehose-service.ts";

export interface NativeChainSocket {
  readonly bufferedBytes: number;
  send(value: string): void;
  close(code: number, reason: string): void;
  onMessage(callback: (message: string | ArrayBuffer) => void): void;
  onClose(callback: (code: number, reason: string) => void): void;
}
export interface NativeChainOptions extends ChainStateLimits {
  maxConcurrentCalls: number;
  maxPendingCalls: number;
  maxRequestBytes: number;
  maxSocketMessageBytes: number;
  maxSocketBufferedBytes: number;
  maxPendingSocketMessages: number;
  renewIntervalMillis: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  headPollEnabled: boolean;
  headPollIntervalMillis: number;
  sessions: McpSessionService;
  alerter: SubnetStatusService;
  head: ChainHeadProvider;
  telemetry: TelemetryEnv;
  onBackgroundError(error: unknown): void;
}
interface SocketEntry {
  socket: NativeChainSocket;
  ip: string;
  topics: Set<string> | null;
  graphql: boolean;
  released: boolean;
  pending: number;
  message?: (message: string) => Promise<void>;
  closed?: (code?: number, reason?: string) => Promise<void>;
}

/** Prepares one owned chain core; no HTTP listener or automatic alarm loop. */
export async function createNativeChainFirehose(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: NativeChainOptions,
) {
  const options = { ...requested };
  for (const [key, value, max] of [
    ["maxConcurrentCalls", options.maxConcurrentCalls, 100],
    ["maxPendingCalls", options.maxPendingCalls, 100],
    ["maxRequestBytes", options.maxRequestBytes, 1048576],
    ["maxSocketMessageBytes", options.maxSocketMessageBytes, 1048576],
    ["maxSocketBufferedBytes", options.maxSocketBufferedBytes, 4194304],
    ["maxPendingSocketMessages", options.maxPendingSocketMessages, 100],
    ["renewIntervalMillis", options.renewIntervalMillis, 3600000],
    ["headPollIntervalMillis", options.headPollIntervalMillis, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid native chain ${key}`);
  if (
    options.renewIntervalMillis * 3 >= options.leaseMilliseconds ||
    options.executionTimeoutMillis >= options.leaseMilliseconds
  )
    throw new RangeError(
      "Native chain deadlines must leave lease renewal headroom",
    );
  if (
    typeof options.headPollEnabled !== "boolean" ||
    typeof options.sessions?.fetch !== "function" ||
    typeof options.alerter?.fetch !== "function" ||
    typeof options.head?.head !== "function" ||
    typeof options.head?.block !== "function" ||
    typeof options.head?.write !== "function" ||
    typeof options.onBackgroundError !== "function"
  )
    throw new TypeError(
      "Native chain session, alerter, head and reporting capabilities are required",
    );
  // Native readiness includes the real subscription schema before accepting a
  // socket. The Worker retains its lazy schema path and startup budget.
  const { schema } = await import("./graphql.ts");
  const work = createNativeWorkGroup({
    name: "Native chain",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });
  const store = await createPgChainFirehoseStore(runtime, options);
  const started = performance.now();
  const lease = await store.acquire();
  const acquired = performance.now();
  if (!lease) throw new Error("Native chain is owned by another process");
  let record = parseChainState(lease.state),
    deadline = 0;
  let status: "ready" | "closing" | "closed" = "ready";
  let tail: Promise<void> = Promise.resolve(),
    storageTail: Promise<void> = Promise.resolve();
  let queued = 0,
    currentSignal: AbortSignal | undefined;
  let storageFailure: { error: unknown } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined,
    renewal: ReturnType<typeof setTimeout> | undefined;
  let alarmVersion = lease.alarmVersion;
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  const ownedAbort = new AbortController();
  const pending = new Set<Promise<unknown>>(),
    background = new Set<Promise<unknown>>(),
    socketWork = new Set<Promise<unknown>>();
  const sockets = new Set<SocketEntry>(),
    streams = new Set<() => void>();
  const report = (error: unknown) => {
    try {
      options.onBackgroundError(error);
    } catch {
      /* Reporters do not own custody. */
    }
  };
  const retire = (reason: unknown) => {
    if (status !== "ready") return;
    status = "closing";
    ownedAbort.abort(reason);
    clearTimeout(expiry);
    clearTimeout(renewal);
    hub?.disposeNativeConnections();
    for (const close of [...streams]) close();
    for (const entry of [...sockets])
      closeSocket(entry, 1012, "chain owner unavailable; reconnect");
  };
  const assertOwner = () => {
    if (status !== "ready" || performance.now() >= deadline) {
      const error = new ChainFirehoseUnavailableError(
        "Native chain ownership is unavailable",
      );
      retire(error);
      throw error;
    }
    currentSignal?.throwIfAborted();
  };
  const signal = () => currentSignal ?? ownedAbort.signal;
  const issue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = storageTail.then(async () => {
      assertOwner();
      const value = await operation();
      assertOwner();
      return value;
    });
    pending.add(result);
    storageTail = result.then(
      () => {},
      (error) => {
        storageFailure ??= { error };
        retire(error);
      },
    );
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  };
  const drain = async () => {
    while (pending.size || background.size)
      await Promise.allSettled([...pending, ...background]);
    if (storageFailure) throw storageFailure.error;
  };
  const track = (promise: Promise<unknown>) => {
    const observed = promise.catch(report);
    background.add(observed);
    void observed.finally(() => background.delete(observed)).catch(() => {});
  };
  const trackSocket = (promise: Promise<unknown>) => {
    const observed = promise.catch(report);
    socketWork.add(observed);
    void observed.finally(() => socketWork.delete(observed)).catch(() => {});
  };
  const arm = (
    start: number,
    finish: number,
    clock: { nowMs: number; expiresAtMs: number },
  ) => {
    const remaining =
      clock.expiresAtMs - clock.nowMs - Math.max(0, finish - start);
    if (remaining <= 0)
      throw new Error("Native chain lease arrived after its safe deadline");
    deadline = finish + remaining;
    clearTimeout(expiry);
    expiry = setTimeout(
      () => retire(new Error("Native chain lease expired")),
      remaining,
    );
  };
  const renew = () => {
    renewal = setTimeout(() => {
      if (status !== "ready") return;
      const start = performance.now(),
        previous = deadline;
      void issue(() => store.renew(lease))
        .then((clock) => {
          const finish = performance.now();
          if (status !== "ready" || finish >= previous)
            throw new Error("Native chain renewal arrived after expiry");
          arm(start, finish, clock);
          renew();
        })
        .catch((error) => retire(error));
    }, options.renewIntervalMillis);
  };
  const serial = <T>(
    operation: () => Promise<T>,
    callerSignal: AbortSignal,
  ): Promise<T> => {
    assertOwner();
    if (queued >= options.maxPendingCalls)
      return Promise.reject(new Error("Native chain call capacity exceeded"));
    queued++;
    const result = tail
      .then(async () => {
        currentSignal = AbortSignal.any([callerSignal, ownedAbort.signal]);
        let value!: T, failure: { error: unknown } | undefined;
        try {
          assertOwner();
          value = await operation();
        } catch (error) {
          failure = { error };
        }
        try {
          await drain();
          assertOwner();
        } catch (error) {
          failure ??= { error };
        }
        if (failure) {
          retire(failure.error);
          throw failure.error;
        }
        return value;
      })
      .finally(() => {
        currentSignal = undefined;
        queued--;
      });
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const invoke = <T>(operation: () => Promise<T>) =>
    work.run<T>(
      "calls",
      options.maxConcurrentCalls,
      () => {
        throw new Error("Native chain call capacity exceeded");
      },
      (scope) =>
        scope.invoke(async (workSignal) => {
          const combined = AbortSignal.any([workSignal, ownedAbort.signal]);
          const abort = () => retire(combined.reason);
          combined.addEventListener("abort", abort, { once: true });
          try {
            return await serial(operation, combined);
          } finally {
            combined.removeEventListener("abort", abort);
          }
        }),
    );
  const closeSocket = (entry: SocketEntry, code: number, reason: string) => {
    if (entry.released) return;
    entry.released = true;
    sockets.delete(entry);
    hub.recordNativeSocketClose();
    try {
      entry.socket.close(code, reason);
    } catch {
      /* A peer that already closed cannot complete another close handshake. */
    }
    if (entry.closed)
      trackSocket(Promise.resolve().then(() => entry.closed?.(code, reason)));
  };
  const send = (entry: SocketEntry, value: string) => {
    if (entry.released) return;
    assertOwner();
    if (
      entry.socket.bufferedBytes + new TextEncoder().encode(value).byteLength >
      options.maxSocketBufferedBytes
    ) {
      closeSocket(entry, 1013, "slow consumer; reconnect");
      return;
    }
    try {
      entry.socket.send(value);
    } catch (error) {
      report(error);
      closeSocket(entry, 1011, "send failed");
    }
  };
  const broadcast = async (payload: ChainFirehoseIngestPayload) => {
    for (const entry of [...sockets])
      if (!entry.graphql && chainFirehoseMatchesTopics(payload, entry.topics))
        send(entry, JSON.stringify(payload));
  };
  const hub = new ChainFirehoseHub(
    {
      storage: {
        async get(key) {
          assertOwner();
          await storageTail;
          assertOwner();
          return structuredClone(record[key]);
        },
        put(key, value) {
          return issue(async () => {
            const next = { ...record, [key]: structuredClone(value) };
            const text = JSON.stringify(next);
            await store.save(lease, text);
            record = next;
          });
        },
        getAlarm: () => issue(() => store.alarmTime(lease)),
        setAlarm: (when) =>
          issue(async () => {
            alarmVersion = await store.setAlarm(
              lease,
              when instanceof Date ? when.getTime() : when,
            );
          }),
      },
      getWebSockets: () => [],
      acceptWebSocket: () => {
        throw new Error("Native sockets require explicit admission");
      },
      waitUntil: track,
    },
    {
      ...options.telemetry,
      MCP_SESSION_SERVICE: options.sessions,
      ALERTER_SERVICE: options.alerter,
      CHAIN_HEAD_POLL_ENABLED: String(options.headPollEnabled),
      CHAIN_HEAD_POLL_INTERVAL_MS: String(options.headPollIntervalMillis),
    },
    {
      schema,
      assertActive: assertOwner,
      broadcast,
      head: {
        head: () => options.head.head(signal()),
        block: (height) => options.head.block(height, signal()),
        write: (block) => options.head.write(block, signal()),
      },
    },
  );
  try {
    arm(started, acquired, lease);
    renew();
  } catch (error) {
    await store.release(lease);
    throw error;
  }

  const bridge = (response: Response, callerSignal: AbortSignal) => {
    if (
      !response.body ||
      response.headers.get("content-type")?.split(";")[0] !==
        "text/event-stream"
    )
      return response;
    const reader = response.body.getReader();
    let done = false,
      output!: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = () => {
      streams.delete(end);
      callerSignal.removeEventListener("abort", end);
    };
    const end = () => {
      if (done) return;
      done = true;
      cleanup();
      void reader.cancel().catch(report);
      try {
        output.close();
      } catch {
        /* Consumer already closed. */
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (done) return;
          assertOwner();
          if (next.done) {
            done = true;
            cleanup();
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (done) return;
          done = true;
          cleanup();
          reader.releaseLock();
          controller.error(error);
        }
      },
      cancel() {
        end();
      },
    });
    streams.add(end);
    if (callerSignal.aborted) end();
    else callerSignal.addEventListener("abort", end, { once: true });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    get state() {
      return status;
    },
    get activeGraphqlSubscriptions() {
      return hub.chainEventSubscribers.size;
    },
    get maxMessageBytes() {
      return options.maxSocketMessageBytes;
    },
    async fetch(request: Request) {
      if (status !== "ready")
        throw new ChainFirehoseUnavailableError("Native chain is closing");
      return work.run<Response>(
        "calls",
        options.maxConcurrentCalls,
        () => {
          throw new Error("Native chain call capacity exceeded");
        },
        (scope) =>
          scope.invoke(async (workSignal) => {
            // A rejected or disconnected upload never reaches the shared owner. Once
            // admitted, a mutation drains independently of that caller's connection.
            const buffered = await bufferNativeRequest(
              request,
              AbortSignal.any([request.signal, workSignal, ownedAbort.signal]),
              options.maxRequestBytes,
            );
            if (buffered.headers.get("upgrade")?.toLowerCase() === "websocket")
              return new Response("WebSocket upgrade transport required", {
                status: 426,
              });
            return serial(
              async () => bridge(await hub.fetch(buffered), request.signal),
              AbortSignal.any([workSignal, ownedAbort.signal]),
            );
          }),
      );
    },
    async runDueAlarm() {
      return invoke(async () => {
        const claim = await issue(() => store.claimAlarm(lease));
        if (!claim) return "skipped" as const;
        let failure: { error: unknown } | undefined;
        try {
          await hub.alarm();
        } catch (error) {
          failure = { error };
        }
        await drain();
        if (
          !(await issue(() =>
            store.settleAlarm(lease, claim, Boolean(failure)),
          ))
        )
          throw new Error("Native chain alarm claim was superseded");
        if (failure) throw failure.error;
        return alarmVersion === claim.version
          ? ("completed" as const)
          : ("rearmed" as const);
      });
    },
    async openSocket(
      request: Request,
      connect: (protocol: string | null) => Promise<NativeChainSocket>,
    ): Promise<Response | null> {
      return invoke(async () => {
        if (request.method !== "GET")
          return new Response("Method not allowed", { status: 405 });
        if (sockets.size >= CHAIN_FIREHOSE_MAX_WS_CONNECTIONS)
          return chainFirehoseCapRefusal(
            "ws-global",
            sockets.size,
            CHAIN_FIREHOSE_MAX_WS_CONNECTIONS,
          );
        const ip = resolveClientIp(request),
          sameIp = [...sockets].filter((entry) => entry.ip === ip).length;
        if (sameIp >= CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP)
          return chainFirehoseCapRefusal(
            "ws-per-ip",
            sameIp,
            CHAIN_FIREHOSE_MAX_CONNECTIONS_PER_IP,
            ip,
          );
        const graphql = (request.headers.get("sec-websocket-protocol") ?? "")
          .split(",")
          .some((part) => part.trim() === GRAPHQL_TRANSPORT_WS_PROTOCOL);
        let socket: NativeChainSocket;
        try {
          socket = await connect(
            graphql ? GRAPHQL_TRANSPORT_WS_PROTOCOL : null,
          );
        } catch (error) {
          report(error);
          return new Response("WebSocket handshake failed", { status: 400 });
        }
        try {
          assertOwner();
        } catch (error) {
          socket.close(1012, "chain owner unavailable; reconnect");
          throw error;
        }
        const entry: SocketEntry = {
          socket,
          ip,
          graphql,
          topics: parseChainFirehoseTopics(new URL(request.url).searchParams),
          released: false,
          pending: 0,
        };
        sockets.add(entry);
        socket.onClose((code, reason) => closeSocket(entry, code, reason));
        if (graphql)
          entry.closed = hub.graphqlWsServer.opened(
            {
              protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
              send: (value) => send(entry, value),
              close: (code, reason) =>
                closeSocket(entry, code ?? 1000, reason ?? ""),
              onMessage: (callback) => {
                entry.message = callback;
              },
            },
            { ip, graphqlWsConnection: { activeSubscriptions: 0 } },
          );
        socket.onMessage((message) => {
          if (entry.released || !entry.graphql) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if (
            new TextEncoder().encode(text).byteLength >
              options.maxSocketMessageBytes ||
            entry.pending >= options.maxPendingSocketMessages
          ) {
            closeSocket(entry, 1009, "message limit exceeded");
            return;
          }
          entry.pending++;
          // graphql-ws keeps subscribe's promise alive until that subscription
          // ends. Its own protocol state owns ordering; serializing these
          // promises would prevent ping/complete from ever reaching it.
          const call = Promise.resolve()
            .then(async () => {
              assertOwner();
              if (!entry.released) await entry.message?.(text);
            })
            .catch((error) => {
              report(error);
              closeSocket(entry, 1011, "protocol failure");
            })
            .finally(() => {
              entry.pending--;
            });
          trackSocket(call);
        });
        return null;
      });
    },
    close() {
      if (closing) return closing;
      retire(new Error("Native chain is closing"));
      draining ??= work.track(async () => {
        await tail;
        await drain().catch(report);
        while (socketWork.size) await Promise.allSettled([...socketWork]);
      });
      closing = work.close().then(async () => {
        await draining;
        await store.release(lease);
        status = "closed";
      });
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
