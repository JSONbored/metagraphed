import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUBNET_LEASE_KV_TTL,
  SUBNET_LEASE_NEGATIVE_KV_TTL,
  SUBNET_LEASE_RPC_TIMEOUT_MS,
  decodeSubnetLease,
  loadSubnetLease,
} from "../src/subnet-lease.mjs";
import { encodeAccountId32 } from "../src/ss58.ts";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Mirrors withFetchStub in tests/subnet-burn.test.mjs.
function withFetchStub(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

function hex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function repeatByte(byte, n) {
  return new Uint8Array(n).fill(byte);
}
function u32le(n) {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}
function u16le(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
function u64le(n) {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function concatBytes(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Synthetic but SCALE-correct SubnetLease<AccountId, u32, TaoBalance>
// encodings, built field-by-field per this module's own header (field order
// verified against pallets/subtensor/src/subnets/leasing.rs). Not a
// live-chain golden value (no lease has ever been created on-chain as of
// 2026-07-18 -- confirmed via a direct state_getKeysPaged probe against
// archive.chain.opentensor.ai), so this exercises the decoder's correctness
// against a hand-built, independently-reasoned-about encoding instead.
const BENEFICIARY_BYTES = repeatByte(0x11, 32);
const COLDKEY_BYTES = repeatByte(0x22, 32);
const HOTKEY_BYTES = repeatByte(0x33, 32);
const BENEFICIARY_SS58 = encodeAccountId32(BENEFICIARY_BYTES);
const COLDKEY_SS58 = encodeAccountId32(COLDKEY_BYTES);
const HOTKEY_SS58 = encodeAccountId32(HOTKEY_BYTES);

function encodeLease({ emissionsShare, endBlock, netuid, costRao }) {
  const endBlockField =
    endBlock == null
      ? new Uint8Array([0])
      : concatBytes(new Uint8Array([1]), u32le(endBlock));
  return hex(
    concatBytes(
      BENEFICIARY_BYTES,
      COLDKEY_BYTES,
      HOTKEY_BYTES,
      new Uint8Array([emissionsShare]),
      endBlockField,
      u16le(netuid),
      u64le(costRao),
    ),
  );
}

describe("decodeSubnetLease", () => {
  test("decodes a lease with a defined end_block (Some(u32))", () => {
    const encoded = encodeLease({
      emissionsShare: 42,
      endBlock: 1_000_000,
      netuid: 5,
      costRao: 123_456_789_000,
    });
    const decoded = decodeSubnetLease(encoded);
    assert.deepEqual(decoded, {
      beneficiary: BENEFICIARY_SS58,
      coldkey: COLDKEY_SS58,
      hotkey: HOTKEY_SS58,
      emissions_share_percent: 42,
      end_block: 1_000_000,
      netuid: 5,
      cost_tao: 123.456789,
    });
  });

  test("decodes a perpetual lease (end_block: None)", () => {
    const encoded = encodeLease({
      emissionsShare: 100,
      endBlock: null,
      netuid: 65535,
      costRao: 0,
    });
    const decoded = decodeSubnetLease(encoded);
    assert.equal(decoded.end_block, null);
    assert.equal(decoded.emissions_share_percent, 100);
    assert.equal(decoded.netuid, 65535);
    assert.equal(decoded.cost_tao, 0);
  });

  test("emissions_share_percent is the raw byte (Percent's ACCURACY==100, no rescale)", () => {
    const encoded = encodeLease({
      emissionsShare: 0,
      endBlock: null,
      netuid: 1,
      costRao: 1_000_000_000, // exactly 1 TAO
    });
    const decoded = decodeSubnetLease(encoded);
    assert.equal(decoded.emissions_share_percent, 0);
    assert.equal(decoded.cost_tao, 1);
  });

  test("returns null for a wrong-length payload (neither 108 nor 112 bytes)", () => {
    assert.equal(decodeSubnetLease(hex(repeatByte(0, 100))), null);
    assert.equal(decodeSubnetLease(hex(repeatByte(0, 113))), null);
  });

  test("returns null for a malformed Option<u32> tag byte", () => {
    const bad = concatBytes(
      BENEFICIARY_BYTES,
      COLDKEY_BYTES,
      HOTKEY_BYTES,
      new Uint8Array([50]),
      new Uint8Array([2]), // invalid Option tag (must be 0 or 1)
      u16le(1),
      u64le(0),
    );
    assert.equal(decodeSubnetLease(hex(bad)), null);
  });

  test("returns null when the total length is 108 bytes but the tag byte claims Some(u32)", () => {
    // A 108-byte (no-end-block-length) payload whose tag byte is 1 (Some) is
    // internally inconsistent -- there's no room for the trailing netuid/cost
    // fields to follow a 4-byte end_block within only 108 bytes.
    const bad = concatBytes(
      BENEFICIARY_BYTES,
      COLDKEY_BYTES,
      HOTKEY_BYTES,
      new Uint8Array([50]),
      new Uint8Array([1]), // tag says Some, but payload is the 108-byte (None) length
      u16le(1),
      u64le(0),
    );
    assert.equal(bad.length, 108);
    assert.equal(decodeSubnetLease(hex(bad)), null);
  });

  test("returns null when the total length is 112 bytes but the tag byte claims None", () => {
    // The mirror case: a 112-byte (with-end-block-length) payload whose tag
    // byte is 0 (None) leaves 4 unaccounted trailing bytes.
    const bad = concatBytes(
      BENEFICIARY_BYTES,
      COLDKEY_BYTES,
      HOTKEY_BYTES,
      new Uint8Array([50]),
      new Uint8Array([0]), // tag says None, but payload is the 112-byte (Some) length
      u32le(999), // the 4 bytes a real Some(end_block) would occupy
      u16le(1),
      u64le(0),
    );
    assert.equal(bad.length, 112);
    assert.equal(decodeSubnetLease(hex(bad)), null);
  });

  test("returns null for non-hex / odd-length input", () => {
    assert.equal(decodeSubnetLease("0x1234f"), null);
    assert.equal(decodeSubnetLease("not hex"), null);
    assert.equal(decodeSubnetLease(null), null);
  });
});

describe("loadSubnetLease", () => {
  const NO_LEASE_RESULT = { jsonrpc: "2.0", id: 1, result: null };

  test("leased:false when SubnetUidToLeaseId reads back genuinely absent", async () => {
    const orig = globalThis.fetch;
    let seenKey;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      seenKey = body.params[0];
      return { ok: true, json: async () => NO_LEASE_RESULT };
    };
    try {
      const data = await loadSubnetLease({}, 7);
      assert.equal(data.schema_version, 1);
      assert.equal(data.netuid, 7);
      assert.equal(data.leased, false);
      assert.equal(data.lease, null);
      assert.ok(data.queried_at);
      // twox64ConcatU16StorageKey("SubtensorModule", "SubnetUidToLeaseId", 7)
      assert.ok(seenKey.startsWith("0x658faa385070e074c85bf6b568cf0555"));
      assert.ok(seenKey.endsWith("0700"));
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("leased:true with full decoded lease + accumulated dividends on a full success chain", async () => {
    const encodedLease = encodeLease({
      emissionsShare: 25,
      endBlock: null,
      netuid: 9,
      costRao: 500_000_000_000, // 500 TAO
    });
    const orig = globalThis.fetch;
    // SubnetLeases(3)/AccumulatedLeaseDividends(3) fire in parallel under
    // Promise.all, so route the stub by key rather than call order.
    const { twox64ConcatU32StorageKey } =
      await import("../src/twox-storage-key.ts");
    const leaseKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "SubnetLeases",
      3,
    );
    const dividendsKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "AccumulatedLeaseDividends",
      3,
    );
    globalThis.fetch = async (_url, init) => {
      const key = JSON.parse(init.body).params[0];
      if (key.endsWith("0900")) {
        return { ok: true, json: async () => ({ result: "0x03000000" }) };
      }
      if (key === leaseKey) {
        return { ok: true, json: async () => ({ result: encodedLease }) };
      }
      if (key === dividendsKey) {
        return {
          ok: true,
          json: async () => ({ result: "0x0065cd1d00000000" }), // 500000000 = 0.5 alpha
        };
      }
      throw new Error(`unexpected storage key ${key}`);
    };
    try {
      const data = await loadSubnetLease({}, 9);
      assert.equal(data.leased, true);
      assert.ok(data.lease);
      assert.equal(data.lease.lease_id, 3);
      assert.equal(data.lease.netuid, 9);
      assert.equal(data.lease.emissions_share_percent, 25);
      assert.equal(data.lease.end_block, null);
      assert.equal(data.lease.cost_tao, 500);
      assert.equal(data.lease.accumulated_dividends_alpha, 0.5);
      assert.equal(data.lease.beneficiary, BENEFICIARY_SS58);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("accumulated_dividends_alpha:0 when AccumulatedLeaseDividends reads back genuinely absent (ValueQuery default)", async () => {
    const encodedLease = encodeLease({
      emissionsShare: 25,
      endBlock: null,
      netuid: 9,
      costRao: 500_000_000_000,
    });
    const { twox64ConcatU32StorageKey } =
      await import("../src/twox-storage-key.ts");
    const leaseKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "SubnetLeases",
      3,
    );
    const dividendsKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "AccumulatedLeaseDividends",
      3,
    );
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const key = JSON.parse(init.body).params[0];
      if (key.endsWith("0900")) {
        return { ok: true, json: async () => ({ result: "0x03000000" }) };
      }
      if (key === leaseKey) {
        return { ok: true, json: async () => ({ result: encodedLease }) };
      }
      if (key === dividendsKey) {
        // A brand-new lease with no distribution interval elapsed yet.
        return { ok: true, json: async () => ({ result: null }) };
      }
      throw new Error(`unexpected storage key ${key}`);
    };
    try {
      const data = await loadSubnetLease({}, 9);
      assert.equal(data.leased, true);
      assert.equal(data.lease.accumulated_dividends_alpha, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("leased:true but lease:null when the details fetch fails (transient RPC failure)", async () => {
    const orig = globalThis.fetch;
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ result: "0x01000000" }) };
      }
      return { ok: false };
    };
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, true);
      assert.equal(data.lease, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("leased stays null when SubnetUidToLeaseId reads back a malformed (non-4-byte) raw value", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: "0xabcd" }), // present but only 2 bytes, not a valid u32 LeaseId
    });
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, null);
      assert.equal(data.lease, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("decoded lease with accumulated_dividends_alpha:null when the dividends RPC fails (not just returns null)", async () => {
    const encodedLease = encodeLease({
      emissionsShare: 10,
      endBlock: null,
      netuid: 3,
      costRao: 0,
    });
    const { twox64ConcatU32StorageKey } =
      await import("../src/twox-storage-key.ts");
    const leaseKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "SubnetLeases",
      1,
    );
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const key = JSON.parse(init.body).params[0];
      if (key.endsWith("0300")) {
        return { ok: true, json: async () => ({ result: "0x01000000" }) };
      }
      if (key === leaseKey) {
        return { ok: true, json: async () => ({ result: encodedLease }) };
      }
      // AccumulatedLeaseDividends RPC itself fails (non-ok response).
      return { ok: false };
    };
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, true);
      assert.ok(data.lease);
      assert.equal(data.lease.accumulated_dividends_alpha, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("decoded lease with accumulated_dividends_alpha:null when the dividends result is present but malformed", async () => {
    const encodedLease = encodeLease({
      emissionsShare: 10,
      endBlock: null,
      netuid: 3,
      costRao: 0,
    });
    const { twox64ConcatU32StorageKey } =
      await import("../src/twox-storage-key.ts");
    const leaseKey = twox64ConcatU32StorageKey(
      "SubtensorModule",
      "SubnetLeases",
      1,
    );
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const key = JSON.parse(init.body).params[0];
      if (key.endsWith("0300")) {
        return { ok: true, json: async () => ({ result: "0x01000000" }) };
      }
      if (key === leaseKey) {
        return { ok: true, json: async () => ({ result: encodedLease }) };
      }
      // AccumulatedLeaseDividends RPC succeeds but returns a non-16-hex-char result.
      return { ok: true, json: async () => ({ result: "0xnotvalid" }) };
    };
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, true);
      assert.ok(data.lease);
      assert.equal(data.lease.accumulated_dividends_alpha, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("leased:null on RPC failure for the initial SubnetUidToLeaseId read", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, null);
      assert.equal(data.lease, null);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("rejects out-of-range netuids before KV or RPC work", async () => {
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    };
    try {
      await assert.rejects(() => loadSubnetLease({}, 65536), /0\.\.65535/);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      netuid: 3,
      leased: false,
      lease: null,
      queried_at: "2026-01-01T00:00:00.000Z",
    };
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return cached;
        },
      },
    };
    let fetchCalled = false;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: false };
    };
    try {
      const data = await loadSubnetLease(env, 3);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("positive-caches a confirmed no-lease result with the full TTL", async () => {
    let putOptions;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key, _value, options) {
          putOptions = options;
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    try {
      await loadSubnetLease(env, 3);
      assert.equal(putOptions.expirationTtl, SUBNET_LEASE_KV_TTL);
      assert.equal(SUBNET_LEASE_KV_TTL, 120);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("negative-caches an RPC failure with the short TTL", async () => {
    let putOptions;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_key, _value, options) {
          putOptions = options;
        },
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false });
    try {
      await loadSubnetLease(env, 3);
      assert.equal(putOptions.expirationTtl, SUBNET_LEASE_NEGATIVE_KV_TTL);
      assert.equal(SUBNET_LEASE_NEGATIVE_KV_TTL, 10);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal;
    const orig = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      seenSignal = init?.signal;
      return { ok: true, json: async () => ({ result: null }) };
    };
    try {
      await loadSubnetLease({}, 3);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(SUBNET_LEASE_RPC_TIMEOUT_MS, 5000);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const data = await loadSubnetLease({}, 3);
      assert.equal(data.leased, null);
      assert.equal(data.schema_version, 1);
    } finally {
      globalThis.fetch = orig;
    }
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
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    try {
      const data = await loadSubnetLease(env, 3);
      assert.equal(data.leased, false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("a KV read failure falls through to the live RPC", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("KV down");
        },
        async put() {},
      },
    };
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: null }),
    });
    try {
      const data = await loadSubnetLease(env, 3);
      assert.equal(data.leased, false);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("GET /api/v1/subnets/{netuid}/lease via the Worker", () => {
  test("returns the confirmed no-lease state for a successful RPC read", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      }),
      async () => {
        const res = await handleRequest(req("/api/v1/subnets/7/lease"), {}, {});
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.schema_version, 1);
        assert.equal(body.data.netuid, 7);
        assert.equal(body.data.leased, false);
        assert.ok(res.headers.get("etag"));
        assert.ok(res.headers.get("x-metagraph-contract-version"));
      },
    );
  });

  test("returns 200 with leased:null on RPC failure (never 404/500)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(req("/api/v1/subnets/7/lease"), {}, {});
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.leased, null);
      },
    );
  });

  test("rejects out-of-range u16 netuids before rate limiting or RPC fetch", async () => {
    let limiterCalls = 0;
    let fetchCalls = 0;
    const env = {
      RPC_RATE_LIMITER: {
        limit: async () => {
          limiterCalls += 1;
          return { success: true };
        },
      },
    };
    await withFetchStub(
      async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      async () => {
        const res = await handleRequest(
          req("/api/v1/subnets/65536/lease"),
          env,
          {},
        );
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, "invalid_netuid");
        assert.equal(limiterCalls, 0);
        assert.equal(fetchCalls, 0);
      },
    );
  });

  test("accepts the maximum u16 netuid", async () => {
    let rpcStorageKey;
    await withFetchStub(
      async (_url, init) => {
        rpcStorageKey = JSON.parse(init.body).params[0];
        return { ok: true, json: async () => ({ result: null }) };
      },
      async () => {
        const res = await handleRequest(
          req("/api/v1/subnets/65535/lease"),
          {},
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.netuid, 65535);
        assert.ok(rpcStorageKey.endsWith("ffff"));
      },
    );
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    await withFetchStub(
      async () => ({ ok: false }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/testnet/subnets/7/lease"),
          {},
          {},
        );
        assert.equal(res.status, 404);
      },
    );
  });

  test("applies per-client RPC rate limiting", async () => {
    let limiterKey;
    let fetchCalls = 0;
    const env = {
      RPC_RATE_LIMITER: {
        limit: async ({ key }) => {
          limiterKey = key;
          return { success: false };
        },
      },
    };
    await withFetchStub(
      async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      },
      async () => {
        const res = await handleRequest(
          new Request("https://api.metagraph.sh/api/v1/subnets/7/lease", {
            headers: { "cf-connecting-ip": "203.0.113.9" },
          }),
          env,
          {},
        );
        assert.equal(res.status, 429);
        assert.equal(limiterKey, "lease:203.0.113.9");
        assert.equal(fetchCalls, 0);
        assert.equal(res.headers.get("x-ratelimit-limit"), "100");
        assert.equal(res.headers.get("retry-after"), "60");
      },
    );
  });

  test("proceeds to the live RPC when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: {
        limit: async () => ({ success: true }),
      },
    };
    await withFetchStub(
      async () => ({ ok: true, json: async () => ({ result: null }) }),
      async () => {
        const res = await handleRequest(
          req("/api/v1/subnets/7/lease"),
          env,
          {},
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.data.leased, false);
      },
    );
  });
});
