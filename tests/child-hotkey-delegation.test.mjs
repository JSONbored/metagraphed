import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHILD_HOTKEY_KV_TTL,
  CHILD_HOTKEY_NEGATIVE_KV_TTL,
  CHILD_HOTKEY_RPC_TIMEOUT_MS,
  decodeProportionAccountList,
  loadAccountChildren,
  loadAccountParents,
} from "../src/child-hotkey-delegation.mjs";
import { encodeAccountId32 } from "../src/ss58.ts";
import { handleRequest } from "../workers/api.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

const KNOWN_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
// twox128("SubtensorModule") ++ twox128("ChildKeys") ++
// blake2_128Concat(accountId for KNOWN_SS58) -- independently verified
// against Python's hashlib.blake2b(digest_size=16) + xxhash in the same
// session that wrote this module.
const KNOWN_CHILD_KEYS_PREFIX =
  "0x658faa385070e074c85bf6b568cf05554bf30057b0f64219556b6cc15bd2804a5410ca7d17d5c641ea125657e96aa6c9b4c087119097fbe3985298eef52f35ef6271c48322a8c2d430902a9cc38d9473";

function hex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function repeatByte(byte, n) {
  return new Uint8Array(n).fill(byte);
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
function u64le(n) {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
// SCALE Compact<u32> single-byte mode (values < 64): value << 2 | 0b00.
function compactU8(n) {
  return new Uint8Array([(n << 2) & 0xff]);
}

const CHILD_ACCOUNT_BYTES = repeatByte(0x44, 32);
const CHILD_ACCOUNT_SS58 = encodeAccountId32(CHILD_ACCOUNT_BYTES);

describe("decodeProportionAccountList", () => {
  test("decodes an empty list (Compact length 0)", () => {
    const encoded = hex(compactU8(0));
    assert.deepEqual(decodeProportionAccountList(encoded, "child"), []);
  });

  test("decodes a single (proportion, account) entry", () => {
    const encoded = hex(
      concatBytes(
        compactU8(1),
        u64le(9_223_372_036_854_775_808n),
        CHILD_ACCOUNT_BYTES,
      ),
    );
    const decoded = decodeProportionAccountList(encoded, "child");
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].child, CHILD_ACCOUNT_SS58);
    assert.equal(decoded[0].proportion, "9223372036854775808");
    assert.equal(decoded[0].proportion_fraction, 0.5);
  });

  test("decodes multiple entries in order", () => {
    const secondAccount = repeatByte(0x55, 32);
    const encoded = hex(
      concatBytes(
        compactU8(2),
        u64le(0n),
        CHILD_ACCOUNT_BYTES,
        u64le(18_446_744_073_709_551_615n), // u64::MAX -> fraction ~1
        secondAccount,
      ),
    );
    const decoded = decodeProportionAccountList(encoded, "parent");
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].parent, CHILD_ACCOUNT_SS58);
    assert.equal(decoded[0].proportion_fraction, 0);
    assert.equal(decoded[1].parent, encodeAccountId32(secondAccount));
    assert.ok(decoded[1].proportion_fraction > 0.999);
  });

  test("returns null for trailing bytes past a decoded entry", () => {
    const encoded = hex(
      concatBytes(
        compactU8(1),
        u64le(0n),
        CHILD_ACCOUNT_BYTES,
        new Uint8Array([1]),
      ),
    );
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });

  test("returns null for a truncated entry (declared count exceeds available bytes)", () => {
    const encoded = hex(concatBytes(compactU8(1), u64le(0n)));
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });

  test("returns null for non-hex input", () => {
    assert.equal(decodeProportionAccountList("not hex", "child"), null);
  });

  test("decodes the two-byte Compact length mode (values 64..16383)", () => {
    // 100 encoded as two-byte compact: (100 << 2 | 0b01) as a little-endian u16.
    const lengthValue = (100 << 2) | 0b01;
    const lengthBytes = new Uint8Array([
      lengthValue & 0xff,
      (lengthValue >> 8) & 0xff,
    ]);
    // Only assert the length decodes correctly; don't actually supply 100 entries.
    const encoded = hex(concatBytes(lengthBytes));
    // With no entry bytes following, decoding must fail (truncated), proving
    // the two-byte length itself was read as 100, not silently misread as a
    // single-byte value from the first byte alone.
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });

  test("returns null for a genuinely empty byte string (no length prefix at all)", () => {
    assert.equal(decodeProportionAccountList("0x", "child"), null);
  });

  test("returns null for a truncated two-byte Compact length (tag byte with no second byte)", () => {
    // Tag byte alone claims two-byte mode (0b01) but nothing follows.
    const encoded = hex(new Uint8Array([0b01]));
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });

  test("decodes the four-byte Compact length mode (values 16384..u32::MAX)", () => {
    // Length 1, deliberately encoded in the four-byte mode (tag 0b10) rather
    // than its natural single-byte form, to exercise that code path directly:
    // (1 << 2 | 0b10) as a little-endian u32.
    const lengthValue = (1 << 2) | 0b10;
    const lengthBytes = new Uint8Array([lengthValue, 0, 0, 0]);
    const encoded = hex(
      concatBytes(lengthBytes, u64le(0n), CHILD_ACCOUNT_BYTES),
    );
    const decoded = decodeProportionAccountList(encoded, "child");
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].child, CHILD_ACCOUNT_SS58);
  });

  test("returns null for a truncated four-byte Compact length (fewer than 4 bytes total)", () => {
    const encoded = hex(new Uint8Array([0b10, 0, 0])); // only 3 of 4 length bytes
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });

  test("returns null for the big-integer Compact mode (0b11), which is unsupported here", () => {
    const encoded = hex(new Uint8Array([0b11]));
    assert.equal(decodeProportionAccountList(encoded, "child"), null);
  });
});

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = orig;
  };
}

describe("loadAccountChildren", () => {
  test("rejects an invalid ss58 address before any RPC work", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    });
    try {
      await assert.rejects(() => loadAccountChildren({}, "not-an-address"));
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("computes the correct Blake2_128Concat storage-key prefix for the account", async () => {
    let seenPrefix;
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        seenPrefix = body.params[0];
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(seenPrefix, KNOWN_CHILD_KEYS_PREFIX);
    } finally {
      restore();
    }
  });

  test("subnets:[] when the hotkey has no children anywhere", async () => {
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      throw new Error("should not reach state_getStorage");
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.schema_version, 1);
      assert.equal(data.account, KNOWN_SS58);
      assert.deepEqual(data.subnets, []);
      assert.ok(data.queried_at);
    } finally {
      restore();
    }
  });

  test("decodes children across multiple subnets, sorted by netuid", async () => {
    // Two returned keys: prefix + netuid=9 (Identity: 0900) and netuid=1 (0100).
    const keyNetuid9 = KNOWN_CHILD_KEYS_PREFIX + "0900";
    const keyNetuid1 = KNOWN_CHILD_KEYS_PREFIX + "0100";
    const valueForNetuid9 = hex(
      concatBytes(
        compactU8(1),
        u64le(9_223_372_036_854_775_808n),
        CHILD_ACCOUNT_BYTES,
      ),
    );
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return {
          ok: true,
          json: async () => ({ result: [keyNetuid9, keyNetuid1] }),
        };
      }
      const key = body.params[0];
      if (key === keyNetuid9) {
        return { ok: true, json: async () => ({ result: valueForNetuid9 }) };
      }
      if (key === keyNetuid1) {
        return { ok: true, json: async () => ({ result: null }) }; // ValueQuery default -> []
      }
      throw new Error(`unexpected key ${key}`);
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      // netuid=1 has an empty entries list, so it's filtered out of the
      // response entirely (only subnets with actual children are shown).
      assert.equal(data.subnets.length, 1);
      assert.equal(data.subnets[0].netuid, 9);
      assert.equal(data.subnets[0].entries[0].child, CHILD_ACCOUNT_SS58);
    } finally {
      restore();
    }
  });

  test("sorts multiple non-empty subnets ascending by netuid, not RPC return order", async () => {
    const keyNetuid9 = KNOWN_CHILD_KEYS_PREFIX + "0900";
    const keyNetuid3 = KNOWN_CHILD_KEYS_PREFIX + "0300";
    const entryValue = hex(
      concatBytes(compactU8(1), u64le(0n), CHILD_ACCOUNT_BYTES),
    );
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        // Returned in descending order to prove the response is actually
        // re-sorted, not just passed through.
        return {
          ok: true,
          json: async () => ({ result: [keyNetuid9, keyNetuid3] }),
        };
      }
      return { ok: true, json: async () => ({ result: entryValue }) };
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.deepEqual(
        data.subnets.map((s) => s.netuid),
        [3, 9],
      );
    } finally {
      restore();
    }
  });

  test("subnets:null on state_getKeysPaged RPC failure", async () => {
    const restore = stubFetch(async () => ({ ok: false }));
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.subnets, null);
    } finally {
      restore();
    }
  });

  test("subnets:null when a returned key's state_getStorage fetch fails", async () => {
    const key = KNOWN_CHILD_KEYS_PREFIX + "0900";
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [key] }) };
      }
      return { ok: false };
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.subnets, null);
    } finally {
      restore();
    }
  });

  test("subnets:null when a returned value fails to decode", async () => {
    const key = KNOWN_CHILD_KEYS_PREFIX + "0900";
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [key] }) };
      }
      return { ok: true, json: async () => ({ result: "0xnotvalid" }) };
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.subnets, null);
    } finally {
      restore();
    }
  });

  test("subnets:[] when state_getKeysPaged returns a non-array result", async () => {
    // A malformed/unexpected RPC result shape (e.g. null instead of []) is
    // treated the same as "no keys", not a decode failure -- state_getStorage
    // is never called since there's nothing to look up.
    let stateGetStorageCalled = false;
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: null }) };
      }
      stateGetStorageCalled = true;
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.deepEqual(data.subnets, []);
      assert.equal(stateGetStorageCalled, false);
    } finally {
      restore();
    }
  });

  test("subnets:null when a returned key is malformed (too short to carry a netuid suffix)", async () => {
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: ["0x00"] }) };
      }
      throw new Error("should not reach state_getStorage");
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.subnets, null);
    } finally {
      restore();
    }
  });

  test("serves from KV cache when present, without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      account: KNOWN_SS58,
      subnets: [],
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
    const restore = stubFetch(async () => {
      fetchCalled = true;
      return { ok: false };
    });
    try {
      const data = await loadAccountChildren(env, KNOWN_SS58);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("positive-caches a successful empty result with the full TTL", async () => {
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
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      await loadAccountChildren(env, KNOWN_SS58);
      assert.equal(putOptions.expirationTtl, CHILD_HOTKEY_KV_TTL);
      assert.equal(CHILD_HOTKEY_KV_TTL, 120);
    } finally {
      restore();
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
    const restore = stubFetch(async () => ({ ok: false }));
    try {
      await loadAccountChildren(env, KNOWN_SS58);
      assert.equal(putOptions.expirationTtl, CHILD_HOTKEY_NEGATIVE_KV_TTL);
      assert.equal(CHILD_HOTKEY_NEGATIVE_KV_TTL, 10);
    } finally {
      restore();
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal;
    const restore = stubFetch(async (_url, init) => {
      seenSignal = init?.signal;
      return { ok: true, json: async () => ({ result: [] }) };
    });
    try {
      await loadAccountChildren({}, KNOWN_SS58);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(CHILD_HOTKEY_RPC_TIMEOUT_MS, 5000);
    } finally {
      restore();
    }
  });

  test("is safe without KV or a working fetch binding (no throw)", async () => {
    const restore = stubFetch(async () => {
      throw new Error("network down");
    });
    try {
      const data = await loadAccountChildren({}, KNOWN_SS58);
      assert.equal(data.subnets, null);
      assert.equal(data.schema_version, 1);
    } finally {
      restore();
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
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const data = await loadAccountChildren(env, KNOWN_SS58);
      assert.deepEqual(data.subnets, []);
    } finally {
      restore();
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
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const data = await loadAccountChildren(env, KNOWN_SS58);
      assert.deepEqual(data.subnets, []);
    } finally {
      restore();
    }
  });
});

describe("loadAccountParents", () => {
  test("reads ParentKeys, not ChildKeys — a different pallet-item prefix", async () => {
    let seenPrefix;
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        seenPrefix = body.params[0];
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      await loadAccountParents({}, KNOWN_SS58);
      assert.notEqual(seenPrefix, KNOWN_CHILD_KEYS_PREFIX);
      // Same twox128("SubtensorModule") pallet prefix, different item hash.
      assert.ok(seenPrefix.startsWith("0x658faa385070e074c85bf6b568cf0555"));
    } finally {
      restore();
    }
  });

  test("decodes a parent entry using the 'parent' field name", async () => {
    // Discover the real ParentKeys prefix from a live call rather than
    // hardcoding a second golden value (storageMapPrefix is already
    // independently verified via twox-storage-key.test.mjs).
    let seenPrefix;
    const restore1 = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        seenPrefix = body.params[0];
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    await loadAccountParents({}, KNOWN_SS58);
    restore1();

    const key = seenPrefix + "0500";
    const value = hex(
      concatBytes(compactU8(1), u64le(0n), CHILD_ACCOUNT_BYTES),
    );
    const restore2 = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [key] }) };
      }
      return { ok: true, json: async () => ({ result: value }) };
    });
    try {
      const data = await loadAccountParents({}, KNOWN_SS58);
      assert.equal(data.subnets[0].netuid, 5);
      assert.equal(data.subnets[0].entries[0].parent, CHILD_ACCOUNT_SS58);
    } finally {
      restore2();
    }
  });
});

describe("GET /api/v1/accounts/{ss58}/children and /parents via the Worker", () => {
  test("children route returns 200 with an empty subnets list for a hotkey with none", async () => {
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${KNOWN_SS58}/children`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.account, KNOWN_SS58);
      assert.deepEqual(body.data.subnets, []);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("x-metagraph-contract-version"));
    } finally {
      restore();
    }
  });

  test("parents route returns 200 with an empty subnets list", async () => {
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${KNOWN_SS58}/parents`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.subnets, []);
    } finally {
      restore();
    }
  });

  test("rejects a bad-checksum ss58 (right shape, wrong address) before rate limiting or RPC fetch", async () => {
    // ACCOUNT_CHILDREN_PATH_PATTERN's base58-charset/length regex alone can't
    // catch a bad checksum -- something clearly non-SS58 like "not-an-address"
    // never reaches the router pattern at all (404, tested separately), but a
    // same-length/charset string with one flipped trailing character reaches
    // the handler and must fail its own isFinneySs58Address check.
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
    const restore = stubFetch(async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    });
    const badChecksumSs58 =
      KNOWN_SS58.slice(0, -1) + (KNOWN_SS58.at(-1) === "5" ? "6" : "5");
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${badChecksumSs58}/children`),
        env,
        {},
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "invalid_ss58");
      assert.equal(limiterCalls, 0);
      assert.equal(fetchCalls, 0);
    } finally {
      restore();
    }
  });

  test("a non-SS58-shaped path segment 404s at the router (never reaches the handler)", async () => {
    const res = await handleRequest(
      req("/api/v1/accounts/not-an-address/children"),
      {},
      {},
    );
    assert.equal(res.status, 404);
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    const restore = stubFetch(async () => ({ ok: false }));
    try {
      const res = await handleRequest(
        req(`/api/v1/testnet/accounts/${KNOWN_SS58}/children`),
        {},
        {},
      );
      assert.equal(res.status, 404);
    } finally {
      restore();
    }
  });

  test("applies per-client RPC rate limiting on the children route", async () => {
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
    const restore = stubFetch(async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    });
    try {
      const res = await handleRequest(
        new Request(
          `https://api.metagraph.sh/api/v1/accounts/${KNOWN_SS58}/children`,
          { headers: { "cf-connecting-ip": "203.0.113.9" } },
        ),
        env,
        {},
      );
      assert.equal(res.status, 429);
      assert.equal(limiterKey, "children:203.0.113.9");
      assert.equal(fetchCalls, 0);
      assert.equal(res.headers.get("x-ratelimit-limit"), "100");
      assert.equal(res.headers.get("retry-after"), "60");
    } finally {
      restore();
    }
  });

  test("applies per-client RPC rate limiting on the parents route", async () => {
    let limiterKey;
    const env = {
      RPC_RATE_LIMITER: {
        limit: async ({ key }) => {
          limiterKey = key;
          return { success: false };
        },
      },
    };
    const restore = stubFetch(async () => {
      throw new Error("should not fetch");
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${KNOWN_SS58}/parents`),
        env,
        {},
      );
      assert.equal(res.status, 429);
      assert.equal(limiterKey, "parents:anonymous");
    } finally {
      restore();
    }
  });

  test("parents route rejects a bad-checksum ss58 before rate limiting or RPC fetch", async () => {
    let fetchCalls = 0;
    const restore = stubFetch(async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    });
    const badChecksumSs58 =
      KNOWN_SS58.slice(0, -1) + (KNOWN_SS58.at(-1) === "5" ? "6" : "5");
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${badChecksumSs58}/parents`),
        {},
        {},
      );
      assert.equal(res.status, 400);
      assert.equal(fetchCalls, 0);
    } finally {
      restore();
    }
  });

  test("children route proceeds to the live RPC when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${KNOWN_SS58}/children`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.subnets, []);
    } finally {
      restore();
    }
  });

  test("parents route proceeds to the live RPC when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const restore = stubFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === "state_getKeysPaged") {
        return { ok: true, json: async () => ({ result: [] }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${KNOWN_SS58}/parents`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.subnets, []);
    } finally {
      restore();
    }
  });
});
