import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { createChainRpcAdmission } from "../src/chain-rpc-admission.ts";
import { chainRpc, chainRpcBatch } from "../src/chain-rpc.ts";

const URL = "https://bittensor-finney.api.onfinality.io/public";
function clock() {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    advance: (ms: number) => void (at += ms),
    waits,
    sleep: async (ms: number) => {
      assert.ok(ms > 0);
      waits.push(ms);
      at += ms;
    },
  };
}

describe("public Finney response-unit admission", () => {
  test("separates a lookup and a full batch without changing either", async () => {
    const time = clock();
    const admit = createChainRpcAdmission(time.now, time.sleep);
    await admit(URL, 1);
    await admit(URL, 50);
    assert.equal(time.now(), 1_000);
    assert.deepEqual(time.waits, [1_000]);
    await admit(URL, 1);
    assert.equal(time.now(), 2_000);
  });

  test("concurrent lanes share capacity, including canonical URL aliases", async () => {
    const time = clock();
    let release: (() => void) | undefined;
    const admit = createChainRpcAdmission(
      time.now,
      (ms) =>
        new Promise<void>((resolve) => {
          release = () => {
            time.advance(ms);
            resolve();
          };
        }),
    );
    const sent: number[] = [];
    const pending = Promise.all(
      [URL, "https://BITTENSOR-FINNEY.api.onfinality.io:443/public/", URL].map(
        async (url) => {
          await admit(url, 25);
          sent.push(time.now());
        },
      ),
    );
    await vi.waitFor(() => assert.equal(sent.length, 2));
    assert.deepEqual(sent, [0, 0]);
    assert.ok(release);
    release();
    await pending;
    assert.deepEqual(sent, [0, 0, 1_000]);
  });

  test("only expires operations outside the rolling window", async () => {
    const time = clock();
    const admit = createChainRpcAdmission(time.now, time.sleep);
    await admit(URL, 1);
    time.advance(100);
    await admit(URL, 48);
    time.advance(100);
    await admit(URL, 2);
    assert.equal(time.now(), 1_000);
    assert.deepEqual(time.waits, [800]);
    await admit(URL, 48);
    assert.equal(time.now(), 1_100);
    assert.deepEqual(time.waits, [800, 100]);
  });

  test("leaves other providers, private paths, protocols and invalid URLs to transport", async () => {
    const time = clock();
    const admit = createChainRpcAdmission(time.now, time.sleep);
    await admit(URL, 50);
    for (const url of [
      "https://archive.chain.opentensor.ai",
      "https://test.finney.opentensor.ai",
      "https://bittensor-finney.api.onfinality.io/private",
      "http://bittensor-finney.api.onfinality.io/public",
      "not a URL",
    ])
      await admit(url, 50);
    assert.deepEqual(time.waits, []);
  });

  test("rejects impossible reservations without consuming capacity", async () => {
    const time = clock();
    const admit = createChainRpcAdmission(time.now, time.sleep);
    for (const units of [0, -1, 51, 1.5, NaN, Infinity])
      await assert.rejects(admit(URL, units), RangeError);
    await admit(URL, 50);
    assert.deepEqual(time.waits, []);
  });

  test("a failed wait does not poison subsequent requests", async () => {
    const time = clock();
    let failed = false;
    const admit = createChainRpcAdmission(time.now, async (ms) => {
      if (!failed) {
        failed = true;
        throw new Error("timer failed");
      }
      await time.sleep(ms);
    });
    await admit(URL, 50);
    await assert.rejects(admit(URL, 1), /timer failed/);
    await admit(URL, 1);
    assert.equal(time.now(), 1_000);
  });

  test("production defaults use the monotonic clock and timer", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout"] });
    try {
      const admit = createChainRpcAdmission();
      await admit(URL, 50);
      const next = admit(URL, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await next;
      assert.equal(performance.now(), 1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("both transports admit their exact operation count before fetching", async () => {
    const time = clock();
    const admit = createChainRpcAdmission(time.now, time.sleep);
    const sent: { at: number; units: number; body: unknown }[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const calls = Array.isArray(body) ? body : [body];
      sent.push({ at: time.now(), units: calls.length, body });
      assert.equal(init?.signal?.aborted, false);
      const answers = calls.map((call: { id: number }) => ({
        jsonrpc: "2.0",
        id: call.id,
        result: null,
      }));
      return new Response(
        JSON.stringify(Array.isArray(body) ? answers : answers[0]),
      );
    }) as typeof fetch;
    await chainRpc(URL, "chain_getHeader", [], {
      fetchImpl,
      admission: admit,
      timeoutMs: 10_000,
    });
    const calls = Array.from({ length: 50 }, (_, index) => ({
      method: "state_getStorage",
      params: ["0xkey", `0x${index}`],
    }));
    const result = await chainRpcBatch(URL, calls, {
      fetchImpl,
      admission: admit,
      timeoutMs: 10_000,
    });
    assert.deepEqual(
      sent.map(({ at, units }) => [at, units]),
      [
        [0, 1],
        [1_000, 50],
      ],
    );
    assert.deepEqual(
      sent[1]!.body,
      calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call })),
    );
    assert.deepEqual(
      result,
      calls.map(() => ({ ok: true, result: null })),
    );
  });

  test("empty batches neither reserve capacity nor fetch", async () => {
    const admission = vi.fn();
    const fetchImpl = vi.fn();
    assert.deepEqual(
      await chainRpcBatch(URL, [], { admission, fetchImpl }),
      [],
    );
    assert.equal(admission.mock.calls.length, 0);
    assert.equal(fetchImpl.mock.calls.length, 0);
  });
});
