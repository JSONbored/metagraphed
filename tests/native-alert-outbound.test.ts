import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createNativeAlertOutbound,
  type NativeAlertOutboundOptions,
} from "../src/native-alert-outbound.ts";
import type { createPinnedAddressDispatcher } from "../src/native-url-safety.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";

function fixture(
  response = () => new Response("ok"),
  options: Partial<NativeAlertOutboundOptions> = {},
) {
  const calls: Request[] = [],
    pins: unknown[] = [];
  let closes = 0,
    destroys = 0;
  const outbound = createNativeAlertOutbound({
    timeoutMillis: 1000,
    maxRequestBytes: 4096,
    maxResponseBytes: 64,
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (input) => {
      calls.push(input as Request);
      return response();
    },
    dispatcher: (...values) => {
      pins.push(values);
      return {
        async close() {
          closes++;
        },
        async destroy() {
          destroys++;
        },
      } as unknown as ReturnType<typeof createPinnedAddressDispatcher>;
    },
    ...options,
  });
  return {
    outbound,
    calls,
    pins,
    closes: () => closes,
    destroys: () => destroys,
  };
}
const addresses = [{ address: "93.184.216.34", family: 4 }];
test("native alert POST preserves headers/body and pins one checked destination", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.outbound.resolve("example.com", new AbortController().signal),
    addresses,
  );
  const response = await f.outbound.send(
    new Request("https://example.com/hook", {
      method: "POST",
      headers: {
        authorization: "fixture-only",
        "content-type": "application/json",
      },
      body: '{"fixture":true}',
    }),
    addresses,
    () => {},
  );
  assert.equal(await response.text(), "ok");
  assert.equal(f.calls.length, 1);
  assert.equal(await f.calls[0].text(), '{"fixture":true}');
  assert.equal(f.calls[0].headers.get("authorization"), "fixture-only");
  assert.equal(f.calls[0].redirect, "manual");
  assert.deepEqual(f.pins, [["example.com", "93.184.216.34", 4]]);
  assert.equal(f.closes(), 1);
  assert.equal(f.destroys(), 0);
});

test("native alert transport checks the final fence before sending and destroys failures once", async () => {
  const fenced = fixture();
  await assert.rejects(
    fenced.outbound.send(
      new Request("https://example.com", { method: "POST" }),
      addresses,
      () => {
        throw new Error("lost owner");
      },
    ),
    /lost owner/,
  );
  assert.equal(fenced.calls.length, 0);
  assert.equal(fenced.destroys(), 1);
  const rejected = fixture(() => {
    throw new Error("transport failed");
  });
  await assert.rejects(
    rejected.outbound.send(
      new Request("https://example.com", { method: "POST" }),
      addresses,
      () => {},
    ),
    /transport failed/,
  );
  assert.equal(rejected.destroys(), 1);
});

test("native alert deadline and caller cancellation destroy pending transports", async () => {
  const pending: typeof fetch = async (input) =>
    new Promise((_resolve, reject) => {
      assert.ok(input instanceof Request);
      input.signal.throwIfAborted();
      input.signal.addEventListener(
        "abort",
        () => reject(input.signal.reason),
        { once: true },
      );
    });
  const timed = fixture(undefined, { timeoutMillis: 5, transport: pending });
  await assert.rejects(
    timed.outbound.send(
      new Request("https://example.com", { method: "POST" }),
      addresses,
      () => {},
    ),
    /deadline exceeded/,
  );
  assert.equal(timed.destroys(), 1);
  const controller = new AbortController();
  const cancelled = fixture(undefined, { transport: pending });
  await assert.rejects(
    cancelled.outbound.send(
      new Request("https://example.com", {
        method: "POST",
        signal: controller.signal,
      }),
      addresses,
      () => controller.abort(new Error("caller aborted")),
    ),
    /caller aborted/,
  );
  assert.equal(cancelled.destroys(), 1);
});

test("native alert validates bounded options and pre-aborted default capabilities", async () => {
  for (const [name, value] of [
    ["timeoutMillis", 0],
    ["timeoutMillis", 8001],
    ["maxRequestBytes", 2097153],
    ["maxResponseBytes", 1048577],
  ] as const)
    assert.throws(
      () =>
        createNativeAlertOutbound({
          timeoutMillis: 1,
          maxRequestBytes: 1,
          maxResponseBytes: 1,
          [name]: value,
        }),
      /Invalid alert outbound/,
    );
  const native = createNativeAlertOutbound({
    timeoutMillis: 100,
    maxRequestBytes: 100,
    maxResponseBytes: 100,
  });
  const controller = new AbortController();
  controller.abort(new Error("already aborted"));
  await assert.rejects(
    native.resolve("example.com", controller.signal),
    /already aborted/,
  );
  await assert.rejects(
    native.send(
      new Request("https://example.com", {
        method: "POST",
        signal: controller.signal,
      }),
      addresses,
      () => {},
    ),
    /already aborted/,
  );
  const late = new AbortController();
  const aborted = fixture(undefined, {
    resolver: async () => {
      late.abort(new Error("DNS aborted"));
      return addresses;
    },
  });
  await assert.rejects(
    aborted.outbound.resolve("example.com", late.signal),
    /DNS aborted/,
  );
});

test("literal IP destinations must match their vetted pin", async () => {
  const f = fixture();
  await assert.rejects(
    f.outbound.send(
      new Request("https://1.1.1.1/hook", { method: "POST" }),
      addresses,
      () => {},
    ),
    /does not match/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await f.outbound.send(
        new Request("https://1.1.1.1/hook", { method: "POST" }),
        [{ address: "1.1.1.1", family: 4 }],
        () => {},
      )
    ).status,
    200,
  );
  assert.deepEqual(f.pins, [["1.1.1.1", "1.1.1.1", 4]]);
});

test("failed dispatcher cleanup preserves the original transport failure", async () => {
  const f = fixture(
    () => {
      throw new Error("delivery failed");
    },
    {
      dispatcher: () =>
        ({
          async close() {},
          async destroy() {
            throw new Error("cleanup failed");
          },
        }) as unknown as ReturnType<typeof createPinnedAddressDispatcher>,
    },
  );
  await assert.rejects(
    f.outbound.send(
      new Request("https://example.com", { method: "POST" }),
      addresses,
      () => {},
    ),
    /delivery failed/,
  );
});

test("deadline expiry during graceful connection close cannot return success", async () => {
  const entered = queueDeferred(),
    release = queueDeferred();
  let destroyed = 0;
  const f = fixture(undefined, {
    timeoutMillis: 5,
    dispatcher: () =>
      ({
        async close() {
          entered.resolve();
          await release.promise;
        },
        async destroy() {
          destroyed++;
          release.resolve();
        },
      }) as unknown as ReturnType<typeof createPinnedAddressDispatcher>,
  });
  const pending = f.outbound.send(
    new Request("https://example.com/hook", { method: "POST" }),
    addresses,
    () => {},
  );
  await entered.promise;
  await assert.rejects(pending, /deadline exceeded/);
  assert.equal(destroyed, 1);
});
test("redirects remain responses and oversized bodies destroy the private connection", async () => {
  const redirect = fixture(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example" },
      }),
  );
  assert.equal(
    (
      await redirect.outbound.send(
        new Request("https://example.com", { method: "POST" }),
        addresses,
        () => {},
      )
    ).status,
    302,
  );
  assert.equal(redirect.calls.length, 1);
  const large = fixture(() => new Response("x".repeat(65)));
  await assert.rejects(
    large.outbound.send(
      new Request("https://example.com", { method: "POST" }),
      addresses,
      () => {},
    ),
    /byte budget/,
  );
  assert.equal(large.destroys(), 1);
  assert.equal(large.closes(), 0);
  const body = fixture();
  await assert.rejects(
    body.outbound.send(
      new Request("https://example.com", {
        method: "POST",
        body: "x".repeat(4097),
      }),
      addresses,
      () => {},
    ),
    /byte limit/,
  );
  assert.equal(body.calls.length, 0);
  assert.equal(body.pins.length, 0);
});
test("unsafe or mismatched addresses and unsupported methods never leave the process", async () => {
  const f = fixture();
  for (const rows of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "192.0.2.1", family: 4 }],
    [{ address: "93.184.216.34", family: 6 }],
  ])
    await assert.rejects(
      f.outbound.send(
        new Request("https://example.com", { method: "POST" }),
        rows,
        () => {},
      ),
      /publicly routable/,
    );
  for (const request of [
    new Request("https://example.com"),
    new Request("http://127.0.0.1", { method: "POST" }),
  ])
    await assert.rejects(
      f.outbound.send(request, addresses, () => {}),
      /Invalid native alert/,
    );
  assert.equal(f.calls.length, 0);
});
