import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  NETWORK_PARAMETERS_KV_TTL,
  NETWORK_PARAMETERS_NEGATIVE_KV_TTL,
  NETWORK_PARAMETERS_RPC_TIMEOUT_MS,
  NETWORK_PARAMETERS_FIELD_SOURCES,
  loadNetworkParameters,
  readCachedNetworkParametersSnapshot,
} from "../src/network-parameters.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import type { Row, AnyFn } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
// in tests/sudo-key.test.ts / tests/subnet-burn.test.ts.
function withFetchStub(stub: AnyFn, fn: AnyFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

// Live-confirmed 2026-07-17 against finney (bittensor 10.5.0,
// substrate.create_storage_key("SubtensorModule", <item>)) + raw
// state_getStorage RPC calls, cross-checked against the high-level
// substrate.query(...) values. TaoWeight's exact live value is governance-
// adjustable and will drift over time — the fixed-point DECODING these
// golden bytes exercise is what's pinned, not that TaoWeight will always be
// 0.18.
const GOLDEN_TAO_WEIGHT_RAW = "0x7a14ae47e17a142e";
const GOLDEN_TAO_WEIGHT = 0.18;
const GOLDEN_STAKE_THRESHOLD_RAW = "0x0010a5d4e8000000"; // 1e12 rao = 1000 TAO
const GOLDEN_STAKE_THRESHOLD_TAO = 1000;
const GOLDEN_COOLDOWN_RAW = "0x201c000000000000"; // 7200 blocks
const GOLDEN_COOLDOWN_BLOCKS = 7200;

// #8747: captured from finney via state_getStorage on 2026-07-30, not typed
// from the schema — 11,180,872,732,340,983 rao (11,180,872.73 TAO), which puts
// the network one halving in at 0.5 TAO/block.
const GOLDEN_TOTAL_ISSUANCE_RAW = "0xf7727dcbf1b82700";
// #8742: captured from finney the same way. Both are SIXTEEN bytes (U64F64
// u128), which decodeLeU64 rejects outright — the trap the issue named.
const GATE_BAR_KEY =
  "0x658faa385070e074c85bf6b568cf05557c9b0d2964cc73e7519676c3cc4d5df9";
const BAR_QUANTILE_KEY =
  "0x658faa385070e074c85bf6b568cf0555a772007dde2ed63e0f21b5f9d7f16650";
const GATE_EXPONENT_KEY =
  "0x658faa385070e074c85bf6b568cf055588c70e8dd0cf4af3aeb977ba2eee1df4";
const GOLDEN_GATE_BAR_RAW = "0xf552a5fa90c449020000000000000000";
const GOLDEN_GATE_BAR = 0.008938107867512188;
const GOLDEN_BAR_QUANTILE_RAW = "0x00000000000000c00000000000000000";
const GOLDEN_BAR_QUANTILE = 0.75;
const GOLDEN_TOTAL_ISSUANCE_TAO = 11180872.732340982;
const GOLDEN_BLOCK_EMISSION_TAO = 0.5;
const GOLDEN_BLOCK_EMISSION_HALVINGS = 1;

const TAO_WEIGHT_KEY =
  "0x658faa385070e074c85bf6b568cf05556b2684762c3b1e22ffb4a92939298741";
const STAKE_THRESHOLD_KEY =
  "0x658faa385070e074c85bf6b568cf0555782d99ebaa64a1ba18b3e8cda1047327";
// #8747: block emission is derived from this, not from the stale
// `BlockEmission` storage item.
const TOTAL_ISSUANCE_KEY =
  "0x658faa385070e074c85bf6b568cf055557c875e4cff74148e4628f264b974c80";
const COOLDOWN_KEY =
  "0x658faa385070e074c85bf6b568cf0555503e4fe5f139cae8b9d045e82e1c83a2";

// Routes each of the 3 parallel state_getStorage calls to its own golden
// raw value by storage key, mirroring a real finney response.
function goldenFetchStub() {
  return async (_url: unknown, init: Row) => {
    const body = JSON.parse(init.body);
    const key = body.params[0];
    const byKey: Record<string, string> = {
      [TAO_WEIGHT_KEY]: GOLDEN_TAO_WEIGHT_RAW,
      [STAKE_THRESHOLD_KEY]: GOLDEN_STAKE_THRESHOLD_RAW,
      [COOLDOWN_KEY]: GOLDEN_COOLDOWN_RAW,
      [TOTAL_ISSUANCE_KEY]: GOLDEN_TOTAL_ISSUANCE_RAW,
      [GATE_BAR_KEY]: GOLDEN_GATE_BAR_RAW,
      [BAR_QUANTILE_KEY]: GOLDEN_BAR_QUANTILE_RAW,
    };
    return {
      ok: true,
      // EmissionGateExponent is genuinely UNSET on chain, so the stub returns
      // a real null for it rather than omitting the key — that is the state
      // the effective-value logic has to handle.
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: key === GATE_EXPONENT_KEY ? null : byKey[key],
      }),
    };
  };
}

describe("loadNetworkParameters", () => {
  test("decodes all three fields correctly (golden values)", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(mockEnv());
      assert.equal(data.schema_version, 1);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(data.stake_threshold_tao, GOLDEN_STAKE_THRESHOLD_TAO);
      // The whole point of #8747: 0.5, not the 1.0 the BlockEmission storage
      // item still reports.
      assert.equal(data.block_emission_tao, GOLDEN_BLOCK_EMISSION_TAO);
      assert.equal(
        data.block_emission_halvings,
        GOLDEN_BLOCK_EMISSION_HALVINGS,
      );
      assert.equal(data.total_issuance_tao, GOLDEN_TOTAL_ISSUANCE_TAO);
      assert.equal(
        data.pending_childkey_cooldown_blocks,
        GOLDEN_COOLDOWN_BLOCKS,
      );
      assert.ok(data.queried_at);
    });
  });

  test("queries all seven storage keys", async () => {
    const seenKeys = new Set();
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        seenKeys.add(JSON.parse(init.body).params[0]);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters(mockEnv());
        assert.ok(seenKeys.has(TAO_WEIGHT_KEY));
        assert.ok(seenKeys.has(STAKE_THRESHOLD_KEY));
        assert.ok(seenKeys.has(COOLDOWN_KEY));
        assert.ok(seenKeys.has(TOTAL_ISSUANCE_KEY));
        assert.ok(seenKeys.has(GATE_BAR_KEY));
        assert.ok(seenKeys.has(BAR_QUANTILE_KEY));
        assert.ok(seenKeys.has(GATE_EXPONENT_KEY));
        assert.equal(seenKeys.size, 7);
      },
    );
  });

  // #8742 trap 1: these three are 16-byte U64F64 values. decodeLeU64 rejects
  // anything but 16 HEX chars, so routing them through it would have returned
  // null for all three, forever, and looked like an RPC problem.
  test("decodes the 128-bit gate parameters", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(mockEnv());
      assert.equal(data.emission_gate_bar, GOLDEN_GATE_BAR);
      assert.equal(data.emission_bar_quantile, GOLDEN_BAR_QUANTILE);
    });
  });

  // #8742 trap 2: absent means "use the runtime default", NOT zero. h = 0
  // makes the Hill gate 1/(1+1) = 0.5 for every subnet — a plausible-looking
  // answer that would misreport all 128 at once.
  test("serves the unset exponent as null, with the runtime default beside it", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(mockEnv());
      assert.equal(data.emission_gate_exponent, null);
      assert.equal(data.emission_gate_exponent_effective, 3);
      // The two must not be collapsed: raw null and effective 0 are different
      // claims, and only one of them is true.
      assert.notEqual(data.emission_gate_exponent_effective, 0);
    });
  });

  // The day governance actually sets the exponent, raw and effective must both
  // report it — the unset case must not be the only one that works. h = 4 as
  // U64F64 is 4 << 64, encoded little-endian across sixteen bytes.
  test("reports a set exponent as both the raw and the effective value", async () => {
    const SET_EXPONENT_RAW = "0x00000000000000000400000000000000";
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        const key = JSON.parse(init.body).params[0];
        if (key === GATE_EXPONENT_KEY) {
          return {
            ok: true,
            json: async () => ({
              jsonrpc: "2.0",
              id: 1,
              result: SET_EXPONENT_RAW,
            }),
          };
        }
        return goldenFetchStub()(_url, init);
      },
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.emission_gate_exponent, 4);
        assert.equal(data.emission_gate_exponent_effective, 4);
      },
    );
  });

  // An unset item is a SUCCESSFUL read. Treating it as a partial failure would
  // pin this whole response to the 10s negative TTL for as long as the item
  // stays unset — which is indefinitely.
  test("an unset exponent still positive-caches with the full TTL", async () => {
    let putOptions: Row | undefined;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key: string, _value: string, options: Row) {
          putOptions = options;
        },
      },
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      await loadNetworkParameters(env);
      assert.equal(putOptions!.expirationTtl, NETWORK_PARAMETERS_KV_TTL);
    });
  });

  test("an unset storage result resolves to the item's RUNTIME DEFAULT, not to zero", async () => {
    // #8700. Every item read here is `modifier: Default` in the runtime
    // metadata, so an absent key means the chain is returning its declared
    // fallback -- not that the value is zero, and not that the read failed.
    //
    // This test previously asserted 0 for all three. That was right for two of
    // them by coincidence (TaoWeight and StakeThreshold both declare a 0
    // default) and WRONG for the cooldown, whose declared default is 7200
    // blocks. It went unnoticed because all three are set on finney; testnet
    // leaves the cooldown unset, where the old behaviour published "child-key
    // changes take effect immediately" for a chain with a one-day cooldown.
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      }),
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        // Declared default 0 — unchanged.
        assert.equal(data.tao_weight, 0);
        assert.equal(data.stake_threshold_tao, 0);
        // Declared default 0x201c000000000000 = 7200. The fix.
        assert.equal(
          data.pending_childkey_cooldown_blocks,
          GOLDEN_COOLDOWN_BLOCKS,
        );
        // Declared default 0x00285c8fc2f5289c… = 0.61 as U64F64. Serving null
        // here would also have poisoned rpcOk, pinning the whole response to
        // the 10s negative TTL on every single testnet request.
        assert.equal(data.emission_bar_quantile, 0.61);
      },
    );
  });

  test("an all-unset read still positive-caches, rather than hammering the RPC", async () => {
    // The operational half of the fix above. `rpcOk` requires every field to be
    // non-null; with the quantile resolving to null on an unset read, a chain
    // that leaves it unset would never positive-cache, so every request would
    // go to the RPC with a 10s negative entry behind it.
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: {
        get: async () => null,
        put: async (_key: string, _value: string, options: Row) => {
          puts.push(options);
        },
      },
    });
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      }),
      async () => {
        await loadNetworkParameters(env);
        assert.equal(puts.length, 1);
        assert.equal(puts[0].expirationTtl, NETWORK_PARAMETERS_KV_TTL);
      },
    );
  });

  test("all fields are null on a malformed (non-16-hex, non-null) storage result", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xnotvalid" }),
      }),
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
      },
    );
  });

  test("all fields are null when the RPC response is not ok", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
      },
    );
  });

  test("all fields are null when finney RPC times out", async () => {
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        assert.ok(init?.signal, "finney fetch must pass AbortSignal.timeout");
        const err = new Error("The operation timed out.");
        err.name = "TimeoutError";
        throw err;
      },
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.tao_weight, null);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(data.pending_childkey_cooldown_blocks, null);
        assert.ok(data.queried_at);
      },
    );
  });

  test("a single field's failure does not blank the other two", async () => {
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        const key = JSON.parse(init.body).params[0];
        if (key === STAKE_THRESHOLD_KEY) {
          return { ok: false };
        }
        const byKey: Record<string, string> = {
          [TAO_WEIGHT_KEY]: GOLDEN_TAO_WEIGHT_RAW,
          [COOLDOWN_KEY]: GOLDEN_COOLDOWN_RAW,
        };
        return { ok: true, json: async () => ({ result: byKey[key] }) };
      },
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
        assert.equal(data.stake_threshold_tao, null);
        assert.equal(
          data.pending_childkey_cooldown_blocks,
          GOLDEN_COOLDOWN_BLOCKS,
        );
      },
    );
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      tao_weight: GOLDEN_TAO_WEIGHT,
      stake_threshold_tao: GOLDEN_STAKE_THRESHOLD_TAO,
      pending_childkey_cooldown_blocks: GOLDEN_COOLDOWN_BLOCKS,
      queried_at: "2026-01-01T00:00:00.000Z",
    };
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    } as unknown as Env;
    let fetchCalled = false;
    await withFetchStub(
      async () => {
        fetchCalled = true;
        return { ok: false };
      },
      async () => {
        const data = await loadNetworkParameters(env);
        // The cached body verbatim, PLUS provenance (#9078). field_sources is
        // attached outside the cache, so an entry written before it existed
        // still comes back with one and a correction to the map takes effect
        // on the next read rather than after the 300s TTL.
        assert.deepEqual(data, {
          ...cached,
          field_sources: NETWORK_PARAMETERS_FIELD_SOURCES,
        });
        assert.equal(fetchCalled, false);
      },
    );
  });

  test("positive-caches a fully successful RPC result with the 300s TTL", async () => {
    let putKey: string | undefined;
    let putValue: Row | undefined;
    let putOptions: Row | undefined;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(key: string, value: string, options: Row) {
          putKey = key;
          putValue = JSON.parse(value);
          putOptions = options;
        },
      },
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      await loadNetworkParameters(env);
      assert.equal(putKey, "network:parameters");
      assert.equal(putValue!.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(putOptions!.expirationTtl, NETWORK_PARAMETERS_KV_TTL);
      assert.equal(NETWORK_PARAMETERS_KV_TTL, 300);
    });
  });

  test("negative-caches a partial RPC failure with the short TTL (does not cache stale-looking partial data)", async () => {
    let putOptions: Row | undefined;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key: string, _value: string, options: Row) {
          putOptions = options;
        },
      },
    } as unknown as Env;
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        const key = JSON.parse(init.body).params[0];
        if (key === STAKE_THRESHOLD_KEY) return { ok: false };
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters(env);
        assert.equal(
          putOptions!.expirationTtl,
          NETWORK_PARAMETERS_NEGATIVE_KV_TTL,
        );
      },
    );
  });

  test("passes AbortSignal.timeout to each finney fetch", async () => {
    const seenSignals: Row[] = [];
    await withFetchStub(
      async (_url: unknown, init: Row) => {
        seenSignals.push(init?.signal);
        return {
          ok: true,
          json: async () => ({ result: "0x0000000000000000" }),
        };
      },
      async () => {
        await loadNetworkParameters(mockEnv());
        assert.equal(seenSignals.length, 7);
        for (const signal of seenSignals) {
          assert.ok(signal);
          assert.equal(typeof signal.aborted, "boolean");
        }
        assert.equal(NETWORK_PARAMETERS_RPC_TIMEOUT_MS, 5000);
      },
    );
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network down");
      },
      async () => {
        const data = await loadNetworkParameters(mockEnv());
        assert.equal(data.tao_weight, null);
        assert.equal(data.schema_version, 1);
      },
    );
  });

  test("a KV write failure is non-fatal", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("KV down");
        },
      },
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(env);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
    });
  });

  test("a KV read failure falls through to the live RPC", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("KV down");
        },
        async put() {},
      },
    } as unknown as Env;
    await withFetchStub(goldenFetchStub(), async () => {
      const data = await loadNetworkParameters(env);
      assert.equal(data.tao_weight, GOLDEN_TAO_WEIGHT);
    });
  });
});

describe("GET /api/v1/network/parameters via the Worker", () => {
  test("returns all three decoded fields for a successful RPC read", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const res = await handleRequest(
        req("/api/v1/network/parameters"),
        {} as unknown as Env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.schema_version, 1);
      assert.equal(body.data.tao_weight, GOLDEN_TAO_WEIGHT);
      assert.equal(body.data.stake_threshold_tao, GOLDEN_STAKE_THRESHOLD_TAO);
      assert.equal(
        body.data.pending_childkey_cooldown_blocks,
        GOLDEN_COOLDOWN_BLOCKS,
      );
      assert.ok(body.data.queried_at);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("x-metagraph-contract-version"));
    });
  });

  test("returns 200 with null fields on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/network/parameters"),
          {} as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.tao_weight, null);
      },
    );
  });

  test("testnet serves its own parameters from its own RPC", async () => {
    // This used to assert a 404, on the grounds that the route was a
    // "mainnet-only live RPC route". That was a property of our code (a
    // hardcoded finney URL), not of the chain: testnet exposes the same
    // storage items at the same twox128 addresses under the same runtime.
    // #8700 pointed the read at the requested network, so it answers -- and
    // the endpoint it answers from is the assertion that matters.
    const seen: string[] = [];
    await withFetchStub(
      async (url: unknown) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
        };
      },
      async () => {
        const res = await handleRequest(
          req("/api/v1/testnet/network/parameters"),
          mockEnv() as unknown as Env,
          {},
        );
        assert.equal(res.status, 200);
        assert.ok(seen.length > 0, "no RPC call was made");
        for (const url of seen) {
          assert.ok(
            url.startsWith("https://test.finney.opentensor.ai"),
            `testnet request read from ${url}`,
          );
        }
      },
    );
  });
});

// /freshness reports how current the live-RPC lane is, and reads the cached
// snapshot ONLY — never falling through to chain RPC. A freshness probe that triggered
// the work it measures would refresh `queried_at` on every call and always report
// "current": a lane that cannot go stale, and therefore cannot be gated on.
describe("readCachedNetworkParametersSnapshot", () => {
  test("returns the cached snapshot without touching RPC", async () => {
    const snapshot = {
      queried_at: "2026-08-05T03:59:00.000Z",
      tao_weight: 0.18,
    };
    let fetched = false;
    await withFetchStub(
      () => {
        fetched = true;
        throw new Error("the freshness probe must not query the chain");
      },
      async () => {
        const out = await readCachedNetworkParametersSnapshot({
          METAGRAPH_CONTROL: { get: async () => snapshot },
        } as unknown as Env);
        assert.equal(out?.queried_at, snapshot.queried_at);
        assert.equal(fetched, false);
      },
    );
  });

  test("a cold or unbound KV is null, not an RPC read", async () => {
    assert.equal(
      await readCachedNetworkParametersSnapshot({} as unknown as Env),
      null,
      "unbound",
    );
    assert.equal(
      await readCachedNetworkParametersSnapshot({
        METAGRAPH_CONTROL: { get: async () => null },
      } as unknown as Env),
      null,
      "cold",
    );
  });

  test("a KV failure is null rather than a thrown freshness route", async () => {
    // The caller reports `missing`; a throw here would take out the whole route over
    // one lane's store being unreachable.
    assert.equal(
      await readCachedNetworkParametersSnapshot({
        METAGRAPH_CONTROL: {
          get: async () => {
            throw new Error("KV down");
          },
        },
      } as unknown as Env),
      null,
    );
  });
});
