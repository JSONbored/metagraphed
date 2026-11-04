import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import {
  AlerterHub,
  deliverAlertMatch,
  type AlerterHubEnv,
} from "../workers/alerter-hub.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { bufferNativeRequest } from "./native-request.ts";
import { bufferNativeResponse } from "./native-buffered-response.ts";
import {
  createPgAlerterOwner,
  type AlerterOwnerLease,
} from "./pg-alerter-owner.ts";
import { resolveUrlSafety, type ResolvedAddress } from "./native-url-safety.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetStatusService } from "./subnet-status-service.ts";

export interface NativeAlertOutbound {
  resolve(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>;
  /** Connect only to these vetted addresses, retaining the URL's TLS/Host
   * identity; never resolve again or follow a redirect. The process owns this
   * transport and its connection resources. */
  send(
    request: Request,
    addresses: readonly ResolvedAddress[],
    beforeSend: () => void,
  ): Promise<Response>;
}
export interface NativeAlerterOptions {
  dataApi: SubnetStatusService;
  outbound: NativeAlertOutbound;
  secrets: Pick<
    AlerterHubEnv,
    | "ALERT_TRIGGERS_INTERNAL_TOKEN"
    | "TELEGRAM_BOT_TOKEN"
    | "RESEND_API_KEY"
    | "RESEND_FROM_ADDRESS"
    | "VAPID_PUBLIC_KEY"
    | "VAPID_PRIVATE_KEY"
    | "VAPID_SUBJECT"
  >;
  maxConcurrentEvaluations: number;
  maxConcurrentInternal: number;
  maxConcurrentOutbound: number;
  maxRequestBytes: number;
  maxInternalResponseBytes: number;
  maxOutboundRequestBytes: number;
  maxOutboundResponseBytes: number;
  leaseMilliseconds: number;
  renewIntervalMillis: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  onBackgroundError(error: unknown): void;
}
interface EvaluationContext {
  signal: AbortSignal;
  addresses: Map<string, Promise<ResolvedAddress[]>>;
}

/** A single leased source evaluator with bounded explicit I/O. Its source
 * caches and optimistic rate reservations remain process-local, just as they
 * are after a Durable Object reconstruction. This opens no listener. */
export async function createNativeAlerter(
  runtime: Pick<PgStoreRuntime, "transaction">,
  requested: NativeAlerterOptions,
) {
  const options = {
    ...requested,
    secrets: {
      ALERT_TRIGGERS_INTERNAL_TOKEN:
        requested.secrets?.ALERT_TRIGGERS_INTERNAL_TOKEN,
      TELEGRAM_BOT_TOKEN: requested.secrets?.TELEGRAM_BOT_TOKEN,
      RESEND_API_KEY: requested.secrets?.RESEND_API_KEY,
      RESEND_FROM_ADDRESS: requested.secrets?.RESEND_FROM_ADDRESS,
      VAPID_PUBLIC_KEY: requested.secrets?.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: requested.secrets?.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: requested.secrets?.VAPID_SUBJECT,
    },
  };
  for (const [name, value, max] of [
    ["maxConcurrentEvaluations", options.maxConcurrentEvaluations, 100],
    ["maxConcurrentInternal", options.maxConcurrentInternal, 100],
    ["maxConcurrentOutbound", options.maxConcurrentOutbound, 100],
    ["maxRequestBytes", options.maxRequestBytes, 1048576],
    ["maxInternalResponseBytes", options.maxInternalResponseBytes, 8388608],
    ["maxOutboundRequestBytes", options.maxOutboundRequestBytes, 2097152],
    ["maxOutboundResponseBytes", options.maxOutboundResponseBytes, 1048576],
    ["renewIntervalMillis", options.renewIntervalMillis, 3600000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid native alerter ${name}`);
  // Budget both the source-facing and native transport buffers, including
  // collection/copy headroom, across every independently admitted work group.
  const aggregateBufferBytes =
    4 *
    (options.maxConcurrentEvaluations * options.maxRequestBytes +
      options.maxConcurrentInternal *
        (options.maxOutboundRequestBytes + options.maxInternalResponseBytes) +
      options.maxConcurrentOutbound *
        (options.maxOutboundRequestBytes + options.maxOutboundResponseBytes));
  if (aggregateBufferBytes > 64 * 1024 * 1024)
    throw new RangeError(
      "Native alerter aggregate buffering exceeds its budget",
    );
  if (
    options.renewIntervalMillis * 3 >= options.leaseMilliseconds ||
    options.executionTimeoutMillis >= options.leaseMilliseconds
  )
    throw new RangeError("Native alerter deadlines must leave lease headroom");
  if (
    typeof options.dataApi?.fetch !== "function" ||
    typeof options.outbound?.resolve !== "function" ||
    typeof options.outbound?.send !== "function" ||
    typeof options.onBackgroundError !== "function" ||
    typeof options.secrets.ALERT_TRIGGERS_INTERNAL_TOKEN !== "string" ||
    !options.secrets.ALERT_TRIGGERS_INTERNAL_TOKEN.trim() ||
    Object.values(options.secrets).some(
      (value) => value !== undefined && typeof value !== "string",
    )
  )
    throw new TypeError(
      "Native alerter data, delivery, token and reporting capabilities are required",
    );
  const work = createNativeWorkGroup({
    name: "Native alerter",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });
  const store = await createPgAlerterOwner(runtime, options.leaseMilliseconds);
  const started = performance.now(),
    lease = await store.acquire(),
    acquired = performance.now();
  if (!lease) throw new Error("Native alerter is owned by another process");
  const context = new AsyncLocalStorage<EvaluationContext>();
  const ownerAbort = new AbortController();
  let state: "ready" | "closing" | "closed" = "ready",
    deadline = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined,
    renewal: ReturnType<typeof setTimeout> | undefined;
  let leaseTail: Promise<unknown> = Promise.resolve(),
    closing: Promise<void> | undefined;
  const background = new Set<Promise<unknown>>();
  const report = (error: unknown) => {
    try {
      options.onBackgroundError(error);
    } catch {
      /* Reporting never owns delivery. */
    }
  };
  const retire = (reason: unknown) => {
    if (state !== "ready") return;
    state = "closing";
    clearTimeout(expiry);
    clearTimeout(renewal);
    ownerAbort.abort(reason);
  };
  const assertOwner = () => {
    if (state !== "ready" || performance.now() >= deadline) {
      const error = new Error("Native alerter ownership is unavailable");
      retire(error);
      throw error;
    }
  };
  const active = () => {
    assertOwner();
    const current = context.getStore();
    if (!current)
      throw new Error("Native alerter operation has no evaluation context");
    current.signal.throwIfAborted();
    return current;
  };
  const arm = (start: number, finish: number, clock: AlerterOwnerLease) => {
    const remaining =
      clock.expiresAtMs - clock.nowMs - Math.max(0, finish - start);
    if (remaining <= 0)
      throw new Error("Native alerter lease arrived after its safe deadline");
    deadline = finish + remaining;
    clearTimeout(expiry);
    expiry = setTimeout(
      () => retire(new Error("Native alerter lease expired")),
      remaining,
    );
  };
  const renew = () => {
    const result = leaseTail.then(async () => {
      assertOwner();
      const start = performance.now(),
        previous = deadline;
      const clock = await store.renew(lease),
        finish = performance.now();
      if (state !== "ready" || finish >= previous)
        throw new Error("Native alerter renewal arrived after expiry");
      arm(start, finish, clock);
    });
    leaseTail = result.catch((error) => {
      retire(error);
      report(error);
    });
    return result;
  };
  const scheduleRenew = () => {
    renewal = setTimeout(() => {
      if (state !== "ready") return;
      void renew()
        .then(scheduleRenew)
        .catch(() => {});
    }, options.renewIntervalMillis);
  };
  const beforeEffect = async () => {
    active();
    await renew();
    active();
  };
  const addresses = (hostname: string) => {
    const current = active(),
      key = hostname.toLowerCase();
    let pending = current.addresses.get(key);
    if (!pending) {
      pending = work.run(
        "dns",
        options.maxConcurrentOutbound,
        () => {
          throw new Error("Native alerter DNS capacity exceeded");
        },
        (scope) =>
          scope.invoke(async (signal) => {
            const combined = AbortSignal.any([
              signal,
              current.signal,
              ownerAbort.signal,
            ]);
            await beforeEffect();
            const records = await options.outbound.resolve(hostname, combined);
            active();
            if (
              !Array.isArray(records) ||
              records.length > 64 ||
              records.some(
                (row) =>
                  !row ||
                  ![4, 6].includes(row.family) ||
                  isIP(row.address) !== row.family,
              )
            )
              throw new Error("Invalid native alerter DNS result");
            return records.map((row) =>
              Object.freeze({ address: row.address, family: row.family }),
            );
          }),
      );
      current.addresses.set(key, pending);
    }
    return pending;
  };
  const internal = async (input: string | Request, init?: RequestInit) =>
    work.run(
      "internal",
      options.maxConcurrentInternal,
      () => {
        throw new Error("Native alerter data capacity exceeded");
      },
      (scope) =>
        scope.invoke(async (signal) => {
          const current = active(),
            request = new Request(input, init);
          const combined = AbortSignal.any([
            signal,
            current.signal,
            ownerAbort.signal,
            request.signal,
          ]);
          const bounded = await bufferNativeRequest(
            request,
            combined,
            options.maxOutboundRequestBytes,
          );
          await beforeEffect();
          const response = await options.dataApi.fetch(bounded);
          const result = await bufferNativeResponse(
            response,
            combined,
            options.maxInternalResponseBytes,
          );
          active();
          return result;
        }),
    );
  const outbound: typeof fetch = async (input, init) =>
    work.run(
      "outbound",
      options.maxConcurrentOutbound,
      () => {
        throw new Error("Native alerter delivery capacity exceeded");
      },
      (scope) =>
        scope.invoke(async (signal) => {
          const current = active(),
            request = new Request(input, init);
          const combined = AbortSignal.any([
            signal,
            current.signal,
            ownerAbort.signal,
            request.signal,
          ]);
          const bounded = await bufferNativeRequest(
            request,
            combined,
            options.maxOutboundRequestBytes,
          );
          const resolution = await resolveUrlSafety(bounded.url, (host) =>
            addresses(host),
          );
          active();
          if (resolution.failure !== null)
            throw new Error("Native alerter destination is unavailable");
          await beforeEffect();
          const response = await options.outbound.send(
            bounded,
            resolution.addresses,
            () => {
              active();
              combined.throwIfAborted();
            },
          );
          const result = await bufferNativeResponse(
            response,
            combined,
            options.maxOutboundResponseBytes,
          );
          active();
          return result;
        }),
    );
  const hub = new AlerterHub(
    {
      waitUntil(promise) {
        const pending = Promise.resolve(promise).catch(report);
        background.add(pending);
        void pending.finally(() => background.delete(pending));
      },
    },
    { ...options.secrets, DATA_API: { fetch: internal } },
    {
      deliver: (trigger, payload, env, _fetch, extra) =>
        deliverAlertMatch(trigger, payload, env, outbound, {
          ...extra,
          resolveHostnames: (host) =>
            addresses(host).then((rows) => rows.map((row) => row.address)),
        }),
    },
  );
  try {
    arm(started, acquired, lease);
    scheduleRenew();
  } catch (error) {
    retire(error);
    await store.release(lease);
    throw error;
  }
  const unavailable = () =>
    new Response(JSON.stringify({ error: "alerter unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  return {
    get state() {
      return state;
    },
    async fetch(request: Request): Promise<Response> {
      if (state !== "ready") return unavailable();
      try {
        return await work.run(
          "evaluate",
          options.maxConcurrentEvaluations,
          () => unavailable(),
          (scope) =>
            scope.invoke(async (signal) => {
              const combined = AbortSignal.any([
                signal,
                request.signal,
                ownerAbort.signal,
              ]);
              return context.run(
                { signal: combined, addresses: new Map() },
                async () => {
                  let bounded: Request;
                  try {
                    bounded = await bufferNativeRequest(
                      request,
                      combined,
                      options.maxRequestBytes,
                    );
                  } catch (error) {
                    if (error instanceof RangeError)
                      return new Response(
                        JSON.stringify({ error: "body too large" }),
                        {
                          status: 413,
                          headers: { "content-type": "application/json" },
                        },
                      );
                    throw error;
                  }
                  await beforeEffect();
                  const result = await hub.fetch(bounded);
                  active();
                  return result;
                },
              );
            }),
        );
      } catch (error) {
        report(error);
        return unavailable();
      }
    },
    close(): Promise<void> {
      closing ??= (async () => {
        retire(new Error("Native alerter is closing"));
        await work.close();
        await leaseTail;
        await Promise.allSettled([...background]);
        await store.release(lease);
        state = "closed";
        context.disable();
      })();
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
