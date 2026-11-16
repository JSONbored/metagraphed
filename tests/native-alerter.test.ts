import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  createNativeAlerter,
  type NativeAlerterOptions,
} from "../src/native-alerter.ts";
import { createPgAlerterOwner } from "../src/pg-alerter-owner.ts";
import { toPositionalPlaceholders } from "../src/pg-sql.ts";
import type { PgTransactionRunner } from "../src/pg-pool.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";

let db: PGlite;
const services: Awaited<ReturnType<typeof createNativeAlerter>>[] = [];
const trigger = {
  id: "1",
  tableFilter: null,
  netuid: 7,
  eventKind: null,
  account: null,
  minAmountTao: null,
  channel: "webhook",
  destination: "https://example.com/hook",
};
const payload = { table: "account_events", netuid: 7 };
const request = (value: unknown = payload) =>
  new Request("https://alerter.invalid/evaluate", {
    method: "POST",
    body: JSON.stringify(value),
  });
const transaction: PgTransactionRunner = (callback, options) =>
  db.transaction(async (tx) => {
    assert.deepEqual(options, { isolation: "read committed" });
    const query = async <Row>(text: string, values: unknown[] = []) =>
      (await tx.query<Row>(toPositionalPlaceholders(text), values)).rows;
    return callback({
      query,
      first: async <Row>(text: string, values?: unknown[]) =>
        (await query<Row>(text, values))[0] ?? null,
      run: async (text, values = []) => ({
        changes:
          (await tx.query(toPositionalPlaceholders(text), values))
            .affectedRows ?? 0,
      }),
    });
  });

function fixture(overrides: Partial<NativeAlerterOptions> = {}) {
  const calls: { path: string; body: unknown }[] = [],
    outbound: Request[] = [],
    errors: unknown[] = [];
  const options: NativeAlerterOptions = {
    dataApi: {
      async fetch(request) {
        calls.push({
          path: new URL(request.url).pathname,
          body: request.method === "GET" ? null : await request.json(),
        });
        return new Response(
          JSON.stringify(
            new URL(request.url).pathname.endsWith("alert-triggers-active")
              ? { triggers: [trigger] }
              : {},
          ),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
    outbound: {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async send(request, addresses, beforeSend) {
        beforeSend();
        assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
        outbound.push(request);
        return new Response("ok");
      },
    },
    secrets: { ALERT_TRIGGERS_INTERNAL_TOKEN: "fixture-internal" },
    maxConcurrentEvaluations: 2,
    maxConcurrentInternal: 4,
    maxConcurrentOutbound: 2,
    maxRequestBytes: 4096,
    maxInternalResponseBytes: 65536,
    maxOutboundRequestBytes: 8192,
    maxOutboundResponseBytes: 4096,
    leaseMilliseconds: 60000,
    renewIntervalMillis: 10000,
    executionTimeoutMillis: 1000,
    drainTimeoutMillis: 1000,
    onBackgroundError(error) {
      errors.push(error);
    },
    ...overrides,
  };
  return {
    calls,
    outbound,
    errors,
    options,
    async start(run: PgTransactionRunner = transaction) {
      const service = await createNativeAlerter({ transaction: run }, options);
      services.push(service);
      return service;
    },
  };
}
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  await db.exec("DROP SCHEMA IF EXISTS realtime CASCADE");
  await db.exec(
    readFileSync(
      new URL("../migrations/postgres/0037_alerter_owner.sql", import.meta.url),
      "utf8",
    ),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((service) => service.close()));
});
afterAll(async () => {
  await db.close();
});

test("exclusive owner evaluates and preserves source attempted/rate-limited counts", async () => {
  const f = fixture(),
    service = await f.start();
  assert.equal(service.state, "ready");
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 1,
    rate_limited: 0,
  });
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 0,
    rate_limited: 1,
  });
  assert.equal(f.outbound.length, 1);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("alert-triggers-active"))
      .length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/matched")).length,
    2,
  );
  await assert.rejects(
    createNativeAlerter({ transaction }, f.options),
    /owned by another/,
  );
  await service.close();
  assert.equal(service.state, "closed");
  const successor = await fixture().start();
  assert.equal((await successor.fetch(request())).status, 200);
});

test("failed delivery rolls back the optimistic reservation and records source outcomes", async () => {
  let attempts = 0;
  const f = fixture({
    outbound: {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async send(_request, _addresses, beforeSend) {
        beforeSend();
        attempts++;
        return new Response("failure", { status: attempts === 1 ? 500 : 200 });
      },
    },
  });
  const service = await f.start();
  for (let i = 0; i < 2; i++)
    assert.equal((await service.fetch(request())).status, 200);
  assert.equal(attempts, 2);
  const deliveries = f.calls.filter((call) =>
    call.path.endsWith("/deliveries"),
  );
  assert.equal(deliveries.length, 2);
  assert.match(JSON.stringify(deliveries[0].body), /"success":false/);
  assert.match(JSON.stringify(deliveries[1].body), /"success":true/);
});

test("ownership loss stops internal and outbound effects and stale release cannot clear a successor", async () => {
  const f = fixture(),
    service = await f.start();
  await db.query(
    "UPDATE realtime.alerter_owner SET owner_token='00000000-0000-4000-8000-000000000002'::uuid,lease_until_ms=lease_until_ms+60000",
  );
  assert.equal((await service.fetch(request())).status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(f.outbound.length, 0);
  await service.close();
  assert.equal(
    (
      await db.query<{ token: string }>(
        "SELECT owner_token::text AS token FROM realtime.alerter_owner",
      )
    ).rows[0].token,
    "00000000-0000-4000-8000-000000000002",
  );
});

test("native admission bounds request bodies, concurrency and cancellation", async () => {
  const entered = queueDeferred(),
    release = queueDeferred();
  const f = fixture({
    maxConcurrentEvaluations: 1,
    dataApi: {
      async fetch(_request) {
        entered.resolve();
        await release.promise;
        return new Response(JSON.stringify({ triggers: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const service = await f.start();
  const pending = service.fetch(request());
  await entered.promise;
  assert.equal((await service.fetch(request())).status, 503);
  release.resolve();
  assert.equal((await pending).status, 200);
  assert.equal(
    (
      await service.fetch(
        new Request("https://alerter.invalid/evaluate", {
          method: "POST",
          body: "x".repeat(4097),
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await service.fetch(
        new Request("https://alerter.invalid/evaluate", {
          method: "POST",
          body: "{",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await service.fetch(new Request("https://alerter.invalid/other"))).status,
    404,
  );
  const controller = new AbortController();
  controller.abort(new Error("fixture aborted"));
  assert.equal(
    (
      await service.fetch(
        new Request("https://alerter.invalid/evaluate", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        }),
      )
    ).status,
    503,
  );
});

test("owner store refuses expired tokens and allows safe reconstruction", async () => {
  const store = await createPgAlerterOwner({ transaction }, 60000),
    first = await store.acquire();
  assert.ok(first);
  assert.equal(await store.acquire(), null);
  assert.equal((await store.renew(first)).token, first.token);
  await db.query("UPDATE realtime.alerter_owner SET lease_until_ms=0");
  await assert.rejects(store.renew(first), /ownership was lost/);
  const next = await store.acquire();
  assert.ok(next);
  assert.notEqual(next.token, first.token);
  await store.release(first);
  assert.equal(
    (
      await db.query<{ token: string }>(
        "SELECT owner_token::text AS token FROM realtime.alerter_owner",
      )
    ).rows[0].token,
    next.token,
  );
  await store.release(next);
});

test("configuration is explicit and bounded before acquiring an owner", async () => {
  for (const [name, value] of [
    ["maxRequestBytes", 0],
    ["maxRequestBytes", NaN],
    ["maxConcurrentEvaluations", 101],
    ["renewIntervalMillis", 30000],
    ["leaseMilliseconds", 0],
    ["executionTimeoutMillis", 60000],
  ] as const)
    await assert.rejects(
      createNativeAlerter(
        { transaction },
        { ...fixture().options, [name]: value },
      ),
      /Invalid|headroom/,
    );
  for (const overrides of [
    { dataApi: null },
    { outbound: null },
    { outbound: { resolve() {} } },
    { secrets: {} },
    { secrets: undefined },
    { secrets: { ALERT_TRIGGERS_INTERNAL_TOKEN: " " } },
    {
      secrets: {
        ALERT_TRIGGERS_INTERNAL_TOKEN: "fixture",
        TELEGRAM_BOT_TOKEN: 3,
      },
    },
    { onBackgroundError: null },
  ])
    await assert.rejects(
      createNativeAlerter({ transaction }, {
        ...fixture().options,
        ...overrides,
      } as unknown as NativeAlerterOptions),
      /capabilities are required/,
    );
});

test("owner storage rejects missing rows and unsafe stored clocks", async () => {
  const store = await createPgAlerterOwner({ transaction }, 60000);
  await db.query("DELETE FROM realtime.alerter_owner");
  await assert.rejects(store.acquire(), /ownership state/);
  await createPgAlerterOwner({ transaction }, 60000);
  await db.query(
    "UPDATE realtime.alerter_owner SET owner_token='00000000-0000-4000-8000-000000000001'::uuid,lease_until_ms=9223372036854775807",
  );
  await assert.rejects(store.acquire(), /ownership state/);
  for (const duration of [NaN, 0, 3600001])
    await assert.rejects(
      createPgAlerterOwner({ transaction }, duration),
      /Invalid alerter lease/,
    );
});

test("joint wire buffering stays within the process budget", async () => {
  const atLimit = {
    maxConcurrentEvaluations: 3,
    maxConcurrentInternal: 1,
    maxConcurrentOutbound: 1,
    maxRequestBytes: 1048576,
    maxInternalResponseBytes: 8388608,
    maxOutboundRequestBytes: 2097152,
    maxOutboundResponseBytes: 1048576,
  };
  await assert.rejects(
    createNativeAlerter(
      { transaction },
      fixture({ ...atLimit, maxConcurrentEvaluations: 4 }).options,
    ),
    /aggregate buffering/,
  );
  const service = await fixture(atLimit).start();
  assert.equal(service.state, "ready");
  await service.close();
});

test("periodic renewal retires an owner when its token is replaced", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture({
      leaseMilliseconds: 10000,
      renewIntervalMillis: 1000,
      executionTimeoutMillis: 100,
    }),
    service = await f.start();
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(service.state, "ready");
  await db.query(
    "UPDATE realtime.alerter_owner SET owner_token='00000000-0000-4000-8000-000000000002'::uuid",
  );
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(service.state, "closing");
  assert.equal(f.calls.length, 0);
  await service.close();
});

test("a queued renewal callback does nothing after shutdown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const f = fixture({
      leaseMilliseconds: 10000,
      renewIntervalMillis: 1000,
      executionTimeoutMillis: 100,
    }),
    service = await f.start();
  const callback = timers.mock.calls.find(([, delay]) => delay === 1000)?.[0];
  assert.equal(typeof callback, "function");
  await service.close();
  if (typeof callback !== "function")
    throw new Error("missing renewal callback");
  callback();
  await Promise.resolve();
  assert.equal(service.state, "closed");
  assert.equal(f.errors.length, 0);
});

test("a pending renewal cannot extend the local expiry deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const release = queueDeferred();
  let calls = 0;
  const run: PgTransactionRunner = async (callback, options) => {
    const result = await transaction(callback, options);
    if (++calls === 3) await release.promise;
    return result;
  };
  const f = fixture({
      leaseMilliseconds: 1000,
      renewIntervalMillis: 100,
      executionTimeoutMillis: 10,
    }),
    service = await f.start(run);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(service.state, "closing");
    assert.equal(f.calls.length, 0);
  } finally {
    release.resolve();
    await service.close();
  }
});

test("simultaneous evaluations reserve a trigger before sending", async () => {
  const entered = queueDeferred(),
    release = queueDeferred();
  let attempts = 0;
  const f = fixture({
    outbound: {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async send(_request, _addresses, beforeSend) {
        beforeSend();
        attempts++;
        entered.resolve();
        await release.promise;
        return new Response("ok");
      },
    },
  });
  const service = await f.start(),
    first = service.fetch(request());
  await entered.promise;
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 0,
    rate_limited: 1,
  });
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal(attempts, 1);
});

test("failed refresh retains the source stale trigger cache", async () => {
  let now = Date.now(),
    refreshes = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture({ leaseMilliseconds: 3600000, renewIntervalMillis: 60000 });
  f.options.dataApi = {
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("alert-triggers-active")) {
        refreshes++;
        return refreshes === 1
          ? Response.json({ triggers: [trigger] })
          : new Response("unavailable", { status: 503 });
      }
      return Response.json({});
    },
  };
  const service = await f.start();
  assert.equal((await service.fetch(request())).status, 200);
  now += 300001;
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 1,
    rate_limited: 0,
  });
  assert.equal(refreshes, 2);
  assert.equal(f.outbound.length, 2);
});

test("a renewal response after the safe deadline cannot authorize an effect", async () => {
  let now = 100,
    calls = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const run: PgTransactionRunner = async (callback, options) => {
    const result = await transaction(callback, options);
    if (++calls === 3) now = 60100;
    return result;
  };
  const f = fixture({
      onBackgroundError() {
        throw new Error("reporter failed");
      },
    }),
    service = await f.start(run);
  assert.equal((await service.fetch(request())).status, 503);
  assert.equal(service.state, "closing");
  assert.equal(f.calls.length, 0);
  assert.equal(f.outbound.length, 0);
});

test("a late initial claim is released and cannot create an evaluator", async () => {
  let now = 100,
    calls = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const run: PgTransactionRunner = async (callback, options) => {
    const result = await transaction(callback, options);
    if (++calls === 2) now = 60100;
    return result;
  };
  await assert.rejects(
    createNativeAlerter({ transaction: run }, fixture().options),
    /safe deadline/,
  );
  assert.equal(
    (
      await db.query<{ token: string | null }>(
        "SELECT owner_token::text AS token FROM realtime.alerter_owner",
      )
    ).rows[0].token,
    null,
  );
});

test("an outbound fence cannot be reused outside its evaluation", async () => {
  let fence: (() => void) | undefined;
  const f = fixture({
      outbound: {
        async resolve() {
          return [{ address: "93.184.216.34", family: 4 }];
        },
        async send(_request, _addresses, beforeSend) {
          beforeSend();
          fence = beforeSend;
          return new Response("ok");
        },
      },
    }),
    service = await f.start();
  assert.equal((await service.fetch(request())).status, 200);
  assert.ok(fence);
  assert.throws(fence, /no evaluation context/);
  vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60001);
  assert.throws(fence, /ownership is unavailable/);
  await service.close();
  assert.throws(fence, /ownership is unavailable/);
});

test("execution and drain deadlines retain unfinished work until it settles", async () => {
  const entered = queueDeferred(),
    release = queueDeferred();
  let internalCalls = 0;
  const f = fixture({
    executionTimeoutMillis: 20,
    drainTimeoutMillis: 20,
    dataApi: {
      async fetch() {
        internalCalls++;
        entered.resolve();
        await release.promise;
        return Response.json({ triggers: [trigger] });
      },
    },
  });
  const service = await f.start(),
    pending = service.fetch(request());
  await entered.promise;
  assert.equal((await pending).status, 503);
  await assert.rejects(service.close(), /drain deadline/);
  assert.equal((await service.fetch(request())).status, 503);
  release.resolve();
  await service.close();
  assert.equal(internalCalls, 1);
  assert.equal(f.outbound.length, 0);
  assert.equal(service.state, "closed");
});

test("internal and outbound bounds fail without bypassing the source delivery result", async () => {
  const malformed = fixture({
      dataApi: {
        async fetch() {
          return new Response("x".repeat(65537));
        },
      },
    }),
    cold = await malformed.start();
  assert.deepEqual(await (await cold.fetch(request())).json(), { matched: 0 });
  await cold.close();
  const oversized = fixture({
      outbound: {
        async resolve() {
          return [{ address: "93.184.216.34", family: 4 }];
        },
        async send(_request, _addresses, beforeSend) {
          beforeSend();
          return new Response("x".repeat(4097));
        },
      },
    }),
    service = await oversized.start();
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 1,
    trigger_ids: ["1"],
    delivered: 1,
    rate_limited: 0,
  });
  assert.match(JSON.stringify(oversized.calls), /"success":false/);
});

test("unprovisioned optional channels retain attempted counts without ambient telemetry", async () => {
  const ambient = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("ambient fetch forbidden"));
  const f = fixture({
    secrets: Object.assign(
      { ALERT_TRIGGERS_INTERNAL_TOKEN: "fixture-only" },
      {
        POSTHOG_API_KEY: "must-not-escape",
        POSTHOG_HOST: "https://telemetry.invalid",
      },
    ),
    dataApi: {
      async fetch(request) {
        return Response.json(
          new URL(request.url).pathname.endsWith("alert-triggers-active")
            ? {
                triggers: ["telegram", "email", "webpush"].map(
                  (channel, index) => ({
                    ...trigger,
                    id: String(index + 1),
                    channel,
                  }),
                ),
              }
            : {},
        );
      },
    },
  });
  const service = await f.start();
  assert.deepEqual(await (await service.fetch(request())).json(), {
    matched: 3,
    trigger_ids: ["1", "2", "3"],
    delivered: 3,
    rate_limited: 0,
  });
  assert.equal(f.outbound.length, 0);
  assert.equal(ambient.mock.calls.length, 0);
});

test("DNS and delivery admission limits retain attempted counts without extra effects", async () => {
  for (const distinctHosts of [true, false]) {
    const entered = queueDeferred(),
      release = queueDeferred();
    let lookups = 0,
      sends = 0;
    const f = fixture({
      maxConcurrentOutbound: 1,
      dataApi: {
        async fetch(request) {
          return Response.json(
            new URL(request.url).pathname.endsWith("alert-triggers-active")
              ? {
                  triggers: [
                    trigger,
                    {
                      ...trigger,
                      id: "2",
                      destination: distinctHosts
                        ? "https://other.example.com/hook"
                        : trigger.destination,
                    },
                  ],
                }
              : {},
          );
        },
      },
      outbound: {
        async resolve() {
          lookups++;
          if (distinctHosts) {
            entered.resolve();
            await release.promise;
          }
          return [{ address: "93.184.216.34", family: 4 }];
        },
        async send(_request, _addresses, beforeSend) {
          beforeSend();
          sends++;
          if (!distinctHosts) {
            entered.resolve();
            await release.promise;
          }
          return new Response("ok");
        },
      },
    });
    const service = await f.start(),
      pending = service.fetch(request());
    await entered.promise;
    release.resolve();
    assert.deepEqual(await (await pending).json(), {
      matched: 2,
      trigger_ids: ["1", "2"],
      delivered: 2,
      rate_limited: 0,
    });
    assert.equal(sends, 1);
    assert.equal(lookups, 1);
    await service.close();
  }
});

test("internal admission bounds concurrent best-effort writebacks", async () => {
  const entered = queueDeferred(),
    release = queueDeferred(),
    delivered = queueDeferred();
  let deliveryLogs = 0;
  const f = fixture({
      maxConcurrentInternal: 1,
      outbound: {
        async resolve() {
          return [{ address: "93.184.216.34", family: 4 }];
        },
        async send(_request, _addresses, beforeSend) {
          beforeSend();
          delivered.resolve();
          return new Response("ok");
        },
      },
      dataApi: {
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("alert-triggers-active"))
            return Response.json({ triggers: [trigger] });
          if (path.endsWith("/matched")) {
            entered.resolve();
            await release.promise;
          }
          if (path.endsWith("/deliveries")) deliveryLogs++;
          return Response.json({});
        },
      },
    }),
    service = await f.start(),
    pending = service.fetch(request());
  await entered.promise;
  await delivered.promise;
  // Delivery completion schedules its log while the match writeback holds
  // the only internal permit. Let that scheduled work attempt admission.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release.resolve();
  assert.equal((await pending).status, 200);
  assert.equal(deliveryLogs, 0);
});

test("malformed DNS and unsafe channel resolutions never reach delivery", async () => {
  for (const unsafe of [false, true]) {
    let sends = 0;
    const f = fixture({
        secrets: {
          ALERT_TRIGGERS_INTERNAL_TOKEN: "fixture",
          TELEGRAM_BOT_TOKEN: "fixture",
        },
        dataApi: {
          async fetch(request) {
            return Response.json(
              new URL(request.url).pathname.endsWith("alert-triggers-active")
                ? {
                    triggers: [
                      unsafe
                        ? {
                            ...trigger,
                            channel: "telegram",
                            destination: "123",
                          }
                        : trigger,
                    ],
                  }
                : {},
            );
          },
        },
        outbound: {
          async resolve() {
            return [{ address: "127.0.0.1", family: unsafe ? 4 : 6 }];
          },
          async send() {
            sends++;
            return new Response("ok");
          },
        },
      }),
      service = await f.start();
    assert.deepEqual(await (await service.fetch(request())).json(), {
      matched: 1,
      trigger_ids: ["1"],
      delivered: 1,
      rate_limited: 0,
    });
    assert.equal(sends, 0);
    await service.close();
  }
});
