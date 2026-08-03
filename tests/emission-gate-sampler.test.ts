// The sampler is the chain-I/O half of the emission-gate lane, now shared
// verbatim between the node script shell and the Worker cron. What these
// tests pin is FIDELITY of the assembly the differs receive -- plus the three
// chain quirks the original script learned the hard way (each carries its
// own comment at the assertion).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  netuidFromKey,
  sampleEmissionGate,
  SUBNET_EMA_TAO_FLOW_PREFIX,
  SUBNET_EMISSION_ENABLED_PREFIX,
} from "../src/emission-gate-sampler.ts";
import {
  EMISSION_GATE_BAR_STORAGE_KEY,
  TOTAL_ISSUANCE_STORAGE_KEY,
} from "../src/network-parameters.ts";
import { FLOW_PARAM_ITEMS } from "../src/emission-flow-monitor.ts";

/** netuid 7 as u16 LE hex. */
const LE7 = "0700";
const ENABLED_KEY_7 = SUBNET_EMISSION_ENABLED_PREFIX + LE7;
const EMA_KEY_7 = SUBNET_EMA_TAO_FLOW_PREFIX + LE7;

interface RpcCall {
  method: string;
  params: unknown[];
}

/** An RPC transport stub: `answer(method, params)` decides each response. */
function rpcFetch(answer: (method: string, params: unknown[]) => unknown): {
  impl: typeof fetch;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push({ method: body.method, params: body.params });
    return {
      ok: true,
      json: async () => ({ result: answer(body.method, body.params) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** The minimal healthy chain: header, null gate params, one enabled subnet,
 * flow params unset, one EMA entry. */
function healthyAnswer(method: string, params: unknown[]): unknown {
  if (method === "chain_getHeader") return { number: "0x85a1c8" };
  if (method === "state_getKeysPaged") {
    const prefix = params[0];
    if (prefix === SUBNET_EMISSION_ENABLED_PREFIX) return [ENABLED_KEY_7];
    if (prefix === SUBNET_EMA_TAO_FLOW_PREFIX) return [EMA_KEY_7];
    return [];
  }
  if (method === "state_getStorage") {
    const key = params[0];
    if (key === TOTAL_ISSUANCE_STORAGE_KEY) return "0x0000c16ff2862300"; // u64 LE
    if (key === ENABLED_KEY_7) return "0x00"; // disabled
    if (key === EMA_KEY_7) return null;
    return null;
  }
  throw new Error(`unexpected method ${method}`);
}

describe("netuidFromKey", () => {
  test("decodes the little-endian u16 suffix", () => {
    assert.equal(
      netuidFromKey(ENABLED_KEY_7, SUBNET_EMISSION_ENABLED_PREFIX),
      7,
    );
    // 0x0102 LE = "0201" suffix -> 258
    assert.equal(
      netuidFromKey(
        SUBNET_EMISSION_ENABLED_PREFIX + "0201",
        SUBNET_EMISSION_ENABLED_PREFIX,
      ),
      258,
    );
  });

  test("rejects the wrong prefix and the wrong length", () => {
    assert.equal(
      netuidFromKey(EMA_KEY_7, SUBNET_EMISSION_ENABLED_PREFIX),
      null,
    );
    assert.equal(
      netuidFromKey(
        SUBNET_EMISSION_ENABLED_PREFIX + "070000",
        SUBNET_EMISSION_ENABLED_PREFIX,
      ),
      null,
    );
  });
});

describe("sampleEmissionGate", () => {
  test("assembles the exact sync-route payload", async () => {
    const { impl } = rpcFetch(healthyAnswer);
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
      now: () => 1_785_720_000_000,
    });
    assert.equal(sample.block_number, 0x85a1c8);
    assert.equal(sample.observed_at, 1_785_720_000_000);
    // Null gate storage reads null params, never zero -- zero would be a
    // recorded governance value.
    assert.equal(sample.current.emission_gate_bar, null);
    // TotalIssuance is a u64, NOT a u128: the u128 decoder rejects its
    // 16-hex value, which once silently recorded halvings as "unknown".
    assert.notEqual(sample.current.block_emission_halvings, null);
    // 0x00 means DISABLED; the pair array carries the claim explicitly.
    assert.deepEqual(sample.current_enabled, [[7, false]]);
    assert.equal(
      sample.flow_observations.length,
      Object.keys(FLOW_PARAM_ITEMS).length,
    );
    assert.deepEqual(sample.current_ema, [[7, null]]);
  });

  test("a non-0x00 enablement value reads as enabled", async () => {
    const { impl } = rpcFetch((m, p) =>
      m === "state_getStorage" && p[0] === ENABLED_KEY_7
        ? "0x01"
        : healthyAnswer(m, p),
    );
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.deepEqual(sample.current_enabled, [[7, true]]);
  });

  test("state_getKeysPaged omits params[2] on the first page — null 400s the proxy", async () => {
    const { impl, calls } = rpcFetch(healthyAnswer);
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const firstPaged = calls.find((c) => c.method === "state_getKeysPaged")!;
    assert.equal(
      firstPaged.params.length,
      2,
      "third param must be ABSENT, not null",
    );
  });

  test("paginates keysPaged past a full page, passing the last key", async () => {
    const fullPage = Array.from(
      { length: 500 },
      (_, i) =>
        SUBNET_EMISSION_ENABLED_PREFIX +
        (i & 0xff).toString(16).padStart(2, "0") +
        ((i >> 8) & 0xff).toString(16).padStart(2, "0"),
    );
    let enabledCalls = 0;
    const { impl, calls } = rpcFetch((m, p) => {
      if (
        m === "state_getKeysPaged" &&
        p[0] === SUBNET_EMISSION_ENABLED_PREFIX
      ) {
        enabledCalls += 1;
        return enabledCalls === 1 ? fullPage : [ENABLED_KEY_7];
      }
      return healthyAnswer(m, p);
    });
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const paged = calls.filter(
      (c) =>
        c.method === "state_getKeysPaged" &&
        c.params[0] === SUBNET_EMISSION_ENABLED_PREFIX,
    );
    assert.equal(paged.length, 2, "a full page demands a second request");
    assert.equal(
      paged[1]!.params[2],
      fullPage[499],
      "resumes from the last key of the previous page",
    );
  });

  test("an HTTP failure throws — a partial sample must never reach the differs", async () => {
    const impl = (async () =>
      ({
        ok: false,
        status: 502,
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl }),
      /HTTP 502/,
    );
  });

  test("an rpc error body throws with the engine's message", async () => {
    const impl = (async () =>
      ({
        ok: true,
        json: async () => ({ error: { message: "state discarded" } }),
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl }),
      /state discarded/,
    );
  });

  test("an empty keys page, a malformed key, and a message-less rpc error", async () => {
    // Empty first page breaks pagination immediately; a key with a foreign
    // suffix length is skipped rather than misdecoded; an rpc error object
    // with no message still throws usefully.
    const { impl } = rpcFetch((m, p) => {
      if (m === "state_getKeysPaged") {
        return p[0] === SUBNET_EMISSION_ENABLED_PREFIX
          ? [SUBNET_EMISSION_ENABLED_PREFIX + "070000", ENABLED_KEY_7]
          : [];
      }
      return healthyAnswer(m, p);
    });
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.deepEqual(
      sample.current_enabled,
      [[7, false]],
      "the malformed key is skipped, not misread",
    );
    assert.deepEqual(sample.current_ema, [], "empty page yields no entries");

    const bare = (async () =>
      ({
        ok: true,
        json: async () => ({ error: {} }),
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: bare }),
      /rpc error/,
    );
  });

  test("an unset TotalIssuance reads halvings as null, and the global fetch default engages", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch((m, p) =>
      m === "state_getStorage" && p[0] === TOTAL_ISSUANCE_STORAGE_KEY
        ? null
        : healthyAnswer(m, p),
    ).impl;
    try {
      const sample = await sampleEmissionGate({ rpcUrl: "https://rpc.test" });
      assert.equal(sample.current.block_emission_halvings, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an undecodable gate value and a malformed EMA key both degrade, never throw", async () => {
    const { impl } = rpcFetch((m, p) => {
      if (m === "state_getStorage" && p[0] === EMISSION_GATE_BAR_STORAGE_KEY)
        return "0xnothex"; // present but undecodable -> null param
      if (m === "state_getKeysPaged" && p[0] === SUBNET_EMA_TAO_FLOW_PREFIX)
        return [SUBNET_EMA_TAO_FLOW_PREFIX + "070000", EMA_KEY_7];
      return healthyAnswer(m, p);
    });
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(sample.current.emission_gate_bar, null);
    assert.deepEqual(sample.current_ema, [[7, null]]);
  });

  test("gate params decode through the u64f64 path when present", async () => {
    // 1.0 in U64F64: integer part 1 in the high 64 bits -> LE u128 hex.
    const oneU64F64 = "0x" + "00".repeat(8) + "01" + "00".repeat(7);
    const { impl } = rpcFetch((m, p) =>
      m === "state_getStorage" && p[0] === EMISSION_GATE_BAR_STORAGE_KEY
        ? oneU64F64
        : healthyAnswer(m, p),
    );
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(sample.current.emission_gate_bar, 1);
  });
});
