import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DEFAULT_ROOT_CLAIM_THRESHOLD,
  MAX_HOTKEYS,
  ROOT_CLAIM_KV_TTL,
  ROOT_CLAIM_NEGATIVE_KV_TTL,
  ROOT_CLAIM_RPC_TIMEOUT_MS,
  decodeI96F32,
  decodeOwnedHotkeys,
  decodeRootClaimType,
  decodeRootClaimable,
  decodeU128,
  loadRootClaim,
} from "../src/root-claim.mjs";
import { encodeAccountId32 } from "../src/ss58.mjs";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.mjs";
import { handleRequest } from "../workers/api.mjs";

// A real finney coldkey (base58, valid checksum) -- the same well-formed
// address the sibling child-hotkey-delegation test uses.
const COLDKEY_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

const TYPE_PREFIX = bytesToHex(
  storageMapPrefix("SubtensorModule", "RootClaimType"),
);
const OWNED_PREFIX = bytesToHex(
  storageMapPrefix("SubtensorModule", "OwnedHotkeys"),
);
const CLAIMABLE_PREFIX = bytesToHex(
  storageMapPrefix("SubtensorModule", "RootClaimable"),
);
const THRESHOLD_PREFIX = bytesToHex(
  storageMapPrefix("SubtensorModule", "RootClaimableThreshold"),
);
const CLAIMED_PREFIX = bytesToHex(
  storageMapPrefix("SubtensorModule", "RootClaimed"),
);

function hex(bytes) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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
function repeatByte(byte, n) {
  return new Uint8Array(n).fill(byte);
}
function u16le(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}
// SCALE Compact<u32> single-byte mode (values < 64): value << 2 | 0b00.
function compactU8(n) {
  return new Uint8Array([(n << 2) & 0xff]);
}
function u128le(value) {
  let v = BigInt(value);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
// I96F32 (32 fractional bits): raw = round(value * 2^32) as a two's-complement
// i128, little-endian 16 bytes.
function i96f32le(value) {
  let raw = BigInt(Math.round(value * 4294967296));
  if (raw < 0n) raw += 1n << 128n;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(raw & 0xffn);
    raw >>= 8n;
  }
  return out;
}

const HOTKEY_A_BYTES = repeatByte(0xa1, 32);
const HOTKEY_A_SS58 = encodeAccountId32(HOTKEY_A_BYTES);

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = orig;
  };
}

// A convenience stub that resolves each storage item by its prefix. `overrides`
// maps a role (type/owned/claimable/threshold/claimed) to a raw JSON-RPC result
// (a hex string, null, or the sentinel FAIL to force an ok:false RPC response).
const FAIL = Symbol("fail");
function prefixStub(overrides) {
  return stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const key = body.params[0];
    let role;
    if (key.startsWith(TYPE_PREFIX)) role = "type";
    else if (key.startsWith(OWNED_PREFIX)) role = "owned";
    else if (key.startsWith(CLAIMABLE_PREFIX)) role = "claimable";
    else if (key.startsWith(THRESHOLD_PREFIX)) role = "threshold";
    else if (key.startsWith(CLAIMED_PREFIX)) role = "claimed";
    else throw new Error(`unexpected storage key ${key}`);
    let value = overrides[role];
    if (typeof value === "function") value = value(key);
    if (value === FAIL) return { ok: false };
    return { ok: true, json: async () => ({ result: value ?? null }) };
  });
}

describe("decodeRootClaimType", () => {
  test("decodes Swap (discriminant 0)", () => {
    assert.deepEqual(decodeRootClaimType(hex(new Uint8Array([0]))), {
      type: "swap",
      subnets: null,
    });
  });
  test("decodes Keep (discriminant 1)", () => {
    assert.deepEqual(decodeRootClaimType(hex(new Uint8Array([1]))), {
      type: "keep",
      subnets: null,
    });
  });
  test("decodes KeepSubnets with a BTreeSet<NetUid> body", () => {
    const encoded = hex(
      concatBytes(new Uint8Array([2]), compactU8(2), u16le(7), u16le(19)),
    );
    assert.deepEqual(decodeRootClaimType(encoded), {
      type: "keep_subnets",
      subnets: [7, 19],
    });
  });
  test("decodes KeepSubnets with an empty set", () => {
    const encoded = hex(concatBytes(new Uint8Array([2]), compactU8(0)));
    assert.deepEqual(decodeRootClaimType(encoded), {
      type: "keep_subnets",
      subnets: [],
    });
  });
  test("returns null for a Swap value with trailing bytes", () => {
    assert.equal(decodeRootClaimType(hex(new Uint8Array([0, 0]))), null);
  });
  test("returns null for a Keep value with trailing bytes", () => {
    assert.equal(decodeRootClaimType(hex(new Uint8Array([1, 5]))), null);
  });
  test("returns null for an unknown discriminant", () => {
    assert.equal(decodeRootClaimType(hex(new Uint8Array([3]))), null);
  });
  test("returns null for a truncated KeepSubnets set (count exceeds bytes)", () => {
    const encoded = hex(
      concatBytes(new Uint8Array([2]), compactU8(1), u16le(7).slice(0, 1)),
    );
    assert.equal(decodeRootClaimType(encoded), null);
  });
  test("returns null for KeepSubnets with trailing bytes past the set", () => {
    const encoded = hex(
      concatBytes(
        new Uint8Array([2]),
        compactU8(1),
        u16le(7),
        new Uint8Array([9]),
      ),
    );
    assert.equal(decodeRootClaimType(encoded), null);
  });
  test("returns null for a KeepSubnets tag with no length prefix at all", () => {
    assert.equal(decodeRootClaimType(hex(new Uint8Array([2]))), null);
  });
  test("returns null for empty bytes", () => {
    assert.equal(decodeRootClaimType("0x"), null);
  });
  test("returns null for non-hex input", () => {
    assert.equal(decodeRootClaimType("not hex"), null);
  });
});

describe("decodeRootClaimable", () => {
  test("decodes an empty BTreeMap", () => {
    assert.deepEqual(decodeRootClaimable(hex(compactU8(0))), []);
  });
  test("decodes a single (netuid, I96F32) entry", () => {
    const encoded = hex(concatBytes(compactU8(1), u16le(5), i96f32le(2.5)));
    assert.deepEqual(decodeRootClaimable(encoded), [
      { netuid: 5, claimable: 2.5 },
    ]);
  });
  test("decodes multiple entries in order", () => {
    const encoded = hex(
      concatBytes(compactU8(2), u16le(1), i96f32le(1), u16le(9), i96f32le(3)),
    );
    assert.deepEqual(decodeRootClaimable(encoded), [
      { netuid: 1, claimable: 1 },
      { netuid: 9, claimable: 3 },
    ]);
  });
  test("returns null for trailing bytes past a decoded entry", () => {
    const encoded = hex(
      concatBytes(compactU8(1), u16le(5), i96f32le(2.5), new Uint8Array([1])),
    );
    assert.equal(decodeRootClaimable(encoded), null);
  });
  test("returns null for a truncated entry", () => {
    const encoded = hex(concatBytes(compactU8(1), u16le(5)));
    assert.equal(decodeRootClaimable(encoded), null);
  });
  test("returns null for a genuinely empty byte string (no length prefix)", () => {
    assert.equal(decodeRootClaimable("0x"), null);
  });
  test("returns null for non-hex input", () => {
    assert.equal(decodeRootClaimable("nope"), null);
  });
  test("decodes the two-byte Compact length mode", () => {
    // Length 1 forced into two-byte mode: (1 << 2 | 0b01) as a LE u16.
    const lenValue = (1 << 2) | 0b01;
    const encoded = hex(
      concatBytes(
        new Uint8Array([lenValue & 0xff, (lenValue >> 8) & 0xff]),
        u16le(5),
        i96f32le(2),
      ),
    );
    assert.deepEqual(decodeRootClaimable(encoded), [
      { netuid: 5, claimable: 2 },
    ]);
  });
  test("returns null for a truncated two-byte Compact length", () => {
    assert.equal(decodeRootClaimable(hex(new Uint8Array([0b01]))), null);
  });
  test("decodes the four-byte Compact length mode", () => {
    // Length 1 forced into four-byte mode (tag 0b10): (1 << 2 | 0b10) as LE u32.
    const lenValue = (1 << 2) | 0b10;
    const encoded = hex(
      concatBytes(new Uint8Array([lenValue, 0, 0, 0]), u16le(7), i96f32le(4)),
    );
    assert.deepEqual(decodeRootClaimable(encoded), [
      { netuid: 7, claimable: 4 },
    ]);
  });
  test("returns null for a truncated four-byte Compact length", () => {
    assert.equal(decodeRootClaimable(hex(new Uint8Array([0b10, 0, 0]))), null);
  });
  test("returns null for the big-integer Compact mode (0b11), unsupported here", () => {
    assert.equal(decodeRootClaimable(hex(new Uint8Array([0b11]))), null);
  });
});

describe("decodeOwnedHotkeys", () => {
  test("decodes an empty Vec", () => {
    assert.deepEqual(decodeOwnedHotkeys(hex(compactU8(0))), []);
  });
  test("decodes a single hotkey", () => {
    const encoded = hex(concatBytes(compactU8(1), HOTKEY_A_BYTES));
    assert.deepEqual(decodeOwnedHotkeys(encoded), [HOTKEY_A_SS58]);
  });
  test("decodes multiple hotkeys", () => {
    const second = repeatByte(0xb2, 32);
    const encoded = hex(concatBytes(compactU8(2), HOTKEY_A_BYTES, second));
    assert.deepEqual(decodeOwnedHotkeys(encoded), [
      HOTKEY_A_SS58,
      encodeAccountId32(second),
    ]);
  });
  test("returns null for trailing bytes past the vec", () => {
    const encoded = hex(
      concatBytes(compactU8(1), HOTKEY_A_BYTES, new Uint8Array([1])),
    );
    assert.equal(decodeOwnedHotkeys(encoded), null);
  });
  test("returns null for a truncated account", () => {
    const encoded = hex(concatBytes(compactU8(1), HOTKEY_A_BYTES.slice(0, 20)));
    assert.equal(decodeOwnedHotkeys(encoded), null);
  });
  test("returns null for a genuinely empty byte string", () => {
    assert.equal(decodeOwnedHotkeys("0x"), null);
  });
  test("returns null for non-hex input", () => {
    assert.equal(decodeOwnedHotkeys("nope"), null);
  });
});

describe("decodeU128", () => {
  test("decodes a 16-byte u128", () => {
    assert.equal(decodeU128(hex(u128le(42))), 42n);
  });
  test("decodes u128::MAX", () => {
    const max = (1n << 128n) - 1n;
    assert.equal(decodeU128(hex(u128le(max))), max);
  });
  test("returns null for the wrong byte length", () => {
    assert.equal(decodeU128(hex(u128le(1).slice(0, 8))), null);
  });
  test("returns null for non-hex input", () => {
    assert.equal(decodeU128("nope"), null);
  });
});

describe("decodeI96F32", () => {
  test("decodes a whole number", () => {
    assert.equal(decodeI96F32(hex(i96f32le(3))), 3);
  });
  test("decodes a fractional value", () => {
    assert.equal(decodeI96F32(hex(i96f32le(0.5))), 0.5);
  });
  test("decodes a negative value", () => {
    assert.equal(decodeI96F32(hex(i96f32le(-2.25))), -2.25);
  });
  test("returns null for the wrong byte length", () => {
    assert.equal(decodeI96F32(hex(u128le(1).slice(0, 8))), null);
  });
  test("returns null for non-hex input", () => {
    assert.equal(decodeI96F32("nope"), null);
  });
});

describe("loadRootClaim", () => {
  test("rejects an invalid ss58 before any RPC work", async () => {
    let fetchCalled = false;
    const restore = stubFetch(async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    });
    try {
      await assert.rejects(() => loadRootClaim({}, "not-an-address"));
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  test("default swap + no owned hotkeys -> empty, fully-resolved result", async () => {
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
    const restore = prefixStub({ type: null, owned: null });
    try {
      const data = await loadRootClaim(env, COLDKEY_SS58);
      assert.equal(data.schema_version, 1);
      assert.equal(data.account, COLDKEY_SS58);
      assert.deepEqual(data.claim_type, { type: "swap", subnets: null });
      assert.deepEqual(data.hotkeys, []);
      assert.equal(data.hotkeys_truncated, false);
      assert.deepEqual(data.entries, []);
      assert.equal(data.total_claimable, 0);
      assert.equal(data.total_claimed, "0");
      assert.ok(data.queried_at);
      assert.equal(putOptions.expirationTtl, ROOT_CLAIM_KV_TTL);
    } finally {
      restore();
    }
  });

  test("decodes a keep_subnets claim type", async () => {
    const restore = prefixStub({
      type: hex(concatBytes(new Uint8Array([2]), compactU8(1), u16le(4))),
      owned: null,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.deepEqual(data.claim_type, { type: "keep_subnets", subnets: [4] });
    } finally {
      restore();
    }
  });

  test("resolves per-entry claimable/claimed/threshold and aggregates for one hotkey", async () => {
    // One owned hotkey with a two-subnet claimable map; per-netuid claimed and
    // threshold looked up individually.
    const claimableValue = hex(
      concatBytes(
        compactU8(2),
        u16le(5),
        i96f32le(3),
        u16le(8),
        i96f32le(0.25),
      ),
    );
    const restore = prefixStub({
      type: null, // default swap
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: claimableValue,
      // threshold of 1.0 for every netuid (single value keyed by hashed netuid,
      // which we can't cheaply distinguish -- fine, both entries share it).
      threshold: hex(i96f32le(1)),
      // claimed distinguished by the raw netuid in the NMap key (Identity hasher
      // leaves it unhashed right after the 32-byte prefix).
      claimed: (key) => {
        const netuid =
          parseInt(key.slice(66, 68), 16) |
          (parseInt(key.slice(68, 70), 16) << 8);
        return netuid === 5 ? hex(u128le(100)) : hex(u128le(7));
      },
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.deepEqual(data.hotkeys, [HOTKEY_A_SS58]);
      assert.equal(data.entries.length, 2);
      const byNetuid = Object.fromEntries(
        data.entries.map((e) => [e.netuid, e]),
      );
      assert.deepEqual(byNetuid[5], {
        hotkey: HOTKEY_A_SS58,
        netuid: 5,
        claimable: 3,
        claimed: "100",
        threshold: 1,
        actionable: true, // 3 >= 1
      });
      assert.deepEqual(byNetuid[8], {
        hotkey: HOTKEY_A_SS58,
        netuid: 8,
        claimable: 0.25,
        claimed: "7",
        threshold: 1,
        actionable: false, // 0.25 < 1
      });
      assert.equal(data.total_claimable, 3.25);
      assert.equal(data.total_claimed, "107");
    } finally {
      restore();
    }
  });

  test("a hotkey with no RootClaimable set contributes no entries", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: null, // ValueQuery default empty map
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.deepEqual(data.hotkeys, [HOTKEY_A_SS58]);
      assert.deepEqual(data.entries, []);
      assert.equal(data.total_claimable, 0);
      assert.equal(data.total_claimed, "0");
    } finally {
      restore();
    }
  });

  test("sorts entries when a later hotkey outranks an earlier one (>0 branch)", async () => {
    // Owned in ascending ss58 order (0x01.. < 0xff..) so the sort's a>b path is
    // exercised when the second hotkey's entry is compared against the first.
    const owned = hex(
      concatBytes(compactU8(2), repeatByte(0x01, 32), repeatByte(0xff, 32)),
    );
    const restore = prefixStub({
      type: null,
      owned,
      claimable: hex(concatBytes(compactU8(1), u16le(2), i96f32le(1))),
      threshold: hex(i96f32le(1)),
      claimed: null,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      const hotkeys = data.entries.map((e) => e.hotkey);
      assert.deepEqual(hotkeys, [...hotkeys].sort());
    } finally {
      restore();
    }
  });

  test("threshold defaults to DefaultMinRootClaimAmount when unset", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: hex(concatBytes(compactU8(1), u16le(5), i96f32le(3))),
      threshold: null, // ValueQuery default
      claimed: null, // ValueQuery default 0
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries[0].threshold, DEFAULT_ROOT_CLAIM_THRESHOLD);
      assert.equal(data.entries[0].claimed, "0");
      assert.equal(data.entries[0].actionable, false); // 3 < 500000
    } finally {
      restore();
    }
  });

  test("entries are sorted by hotkey then netuid, independent of RPC order", async () => {
    // Two hotkeys, each claimable on netuid 2; the entries must be ordered by
    // the (stringified) hotkey to be deterministic.
    const owned = hex(
      concatBytes(compactU8(2), repeatByte(0xff, 32), repeatByte(0x01, 32)),
    );
    const restore = prefixStub({
      type: null,
      owned,
      claimable: hex(concatBytes(compactU8(1), u16le(2), i96f32le(1))),
      threshold: hex(i96f32le(1)),
      claimed: null,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      const hotkeys = data.entries.map((e) => e.hotkey);
      const sorted = [...hotkeys].sort();
      assert.deepEqual(hotkeys, sorted);
    } finally {
      restore();
    }
  });

  test("claim_type null (and negative TTL) on a RootClaimType RPC failure", async () => {
    let putOptions;
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put(_k, _v, o) {
          putOptions = o;
        },
      },
    };
    const restore = prefixStub({ type: FAIL, owned: null });
    try {
      const data = await loadRootClaim(env, COLDKEY_SS58);
      assert.equal(data.claim_type, null);
      assert.deepEqual(data.entries, []); // hotkeys resolved fine
      assert.equal(putOptions.expirationTtl, ROOT_CLAIM_NEGATIVE_KV_TTL);
    } finally {
      restore();
    }
  });

  test("claim_type null on a malformed RootClaimType value", async () => {
    const restore = prefixStub({ type: hex(new Uint8Array([9])), owned: null });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.claim_type, null);
    } finally {
      restore();
    }
  });

  test("hotkeys null and entries null on an OwnedHotkeys RPC failure", async () => {
    const restore = prefixStub({ type: null, owned: FAIL });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.hotkeys, null);
      assert.equal(data.entries, null);
      assert.equal(data.total_claimable, null);
      assert.equal(data.total_claimed, null);
    } finally {
      restore();
    }
  });

  test("hotkeys null on a malformed OwnedHotkeys value", async () => {
    const restore = prefixStub({ type: null, owned: "0xff" });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.hotkeys, null);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a RootClaimable RPC failure", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: FAIL,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.deepEqual(data.hotkeys, [HOTKEY_A_SS58]);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a malformed RootClaimable value", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: "0xzz",
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a RootClaimableThreshold RPC failure", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: hex(concatBytes(compactU8(1), u16le(5), i96f32le(3))),
      threshold: FAIL,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a malformed RootClaimableThreshold value", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: hex(concatBytes(compactU8(1), u16le(5), i96f32le(3))),
      threshold: "0xabcd", // not 16 bytes
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a RootClaimed RPC failure", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: hex(concatBytes(compactU8(1), u16le(5), i96f32le(3))),
      threshold: hex(i96f32le(1)),
      claimed: FAIL,
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("entries null on a malformed RootClaimed value", async () => {
    const restore = prefixStub({
      type: null,
      owned: hex(concatBytes(compactU8(1), HOTKEY_A_BYTES)),
      claimable: hex(concatBytes(compactU8(1), u16le(5), i96f32le(3))),
      threshold: hex(i96f32le(1)),
      claimed: "0xabcd", // not 16 bytes
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.entries, null);
    } finally {
      restore();
    }
  });

  test("bounds the owned-hotkey fan-out and flags hotkeys_truncated", async () => {
    const count = MAX_HOTKEYS + 1;
    const hotkeyBytes = [];
    for (let i = 0; i < count; i += 1) {
      // Distinct 32-byte accounts (vary the first two bytes).
      const b = repeatByte(0x10, 32);
      b[0] = i & 0xff;
      b[1] = (i >> 8) & 0xff;
      hotkeyBytes.push(b);
    }
    // count (129) needs the two-byte compact form.
    const lenValue = (count << 2) | 0b01;
    const owned = hex(
      concatBytes(
        new Uint8Array([lenValue & 0xff, (lenValue >> 8) & 0xff]),
        ...hotkeyBytes,
      ),
    );
    let claimableReads = 0;
    const restore = prefixStub({
      type: null,
      owned,
      claimable: () => {
        claimableReads += 1;
        return hex(compactU8(0)); // each hotkey has an empty claimable map
      },
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.hotkeys.length, count); // full list reported
      assert.equal(data.hotkeys_truncated, true);
      assert.equal(claimableReads, MAX_HOTKEYS); // only the bounded subset read
      assert.deepEqual(data.entries, []);
    } finally {
      restore();
    }
  });

  test("serves from KV cache without hitting RPC", async () => {
    const cached = {
      schema_version: 1,
      account: COLDKEY_SS58,
      claim_type: { type: "swap", subnets: null },
      hotkeys: [],
      hotkeys_truncated: false,
      entries: [],
      total_claimable: 0,
      total_claimed: "0",
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
      const data = await loadRootClaim(env, COLDKEY_SS58);
      assert.deepEqual(data, cached);
      assert.equal(fetchCalled, false);
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
    const restore = prefixStub({ type: null, owned: null });
    try {
      const data = await loadRootClaim(env, COLDKEY_SS58);
      assert.deepEqual(data.entries, []);
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
    const restore = prefixStub({ type: null, owned: null });
    try {
      const data = await loadRootClaim(env, COLDKEY_SS58);
      assert.deepEqual(data.entries, []);
    } finally {
      restore();
    }
  });

  test("is safe without KV and with a dead fetch binding (no throw)", async () => {
    const restore = stubFetch(async () => {
      throw new Error("network down");
    });
    try {
      const data = await loadRootClaim({}, COLDKEY_SS58);
      assert.equal(data.claim_type, null);
      assert.equal(data.hotkeys, null);
      assert.equal(data.entries, null);
      assert.equal(data.schema_version, 1);
    } finally {
      restore();
    }
  });

  test("passes AbortSignal.timeout to the finney fetch", async () => {
    let seenSignal;
    const restore = stubFetch(async (_url, init) => {
      seenSignal = init?.signal;
      return { ok: true, json: async () => ({ result: null }) };
    });
    try {
      await loadRootClaim({}, COLDKEY_SS58);
      assert.ok(seenSignal);
      assert.equal(typeof seenSignal.aborted, "boolean");
      assert.equal(ROOT_CLAIM_RPC_TIMEOUT_MS, 5000);
    } finally {
      restore();
    }
  });
});

function req(path, headers) {
  return new Request(
    `https://api.metagraph.sh${path}`,
    headers ? { headers } : undefined,
  );
}

describe("GET /api/v1/accounts/{ss58}/root-claim via the Worker", () => {
  test("returns 200 with a fully-resolved empty result", async () => {
    const restore = prefixStub({ type: null, owned: null });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${COLDKEY_SS58}/root-claim`),
        {},
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.account, COLDKEY_SS58);
      assert.deepEqual(body.data.entries, []);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("x-metagraph-contract-version"));
    } finally {
      restore();
    }
  });

  test("rejects a bad-checksum ss58 before rate limiting or RPC", async () => {
    let fetchCalls = 0;
    const restore = stubFetch(async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    });
    const badChecksum =
      COLDKEY_SS58.slice(0, -1) + (COLDKEY_SS58.at(-1) === "5" ? "6" : "5");
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${badChecksum}/root-claim`),
        {},
        {},
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, "invalid_ss58");
      assert.equal(fetchCalls, 0);
    } finally {
      restore();
    }
  });

  test("a non-SS58-shaped path segment 404s at the router", async () => {
    const res = await handleRequest(
      req("/api/v1/accounts/not-an-address/root-claim"),
      {},
      {},
    );
    assert.equal(res.status, 404);
  });

  test("testnet has no variant (mainnet-only live RPC route)", async () => {
    const restore = stubFetch(async () => ({ ok: false }));
    try {
      const res = await handleRequest(
        req(`/api/v1/testnet/accounts/${COLDKEY_SS58}/root-claim`),
        {},
        {},
      );
      assert.equal(res.status, 404);
    } finally {
      restore();
    }
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
    const restore = stubFetch(async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${COLDKEY_SS58}/root-claim`, {
          "cf-connecting-ip": "203.0.113.7",
        }),
        env,
        {},
      );
      assert.equal(res.status, 429);
      assert.equal(limiterKey, "root-claim:203.0.113.7");
      assert.equal(fetchCalls, 0);
      assert.equal(res.headers.get("x-ratelimit-limit"), "100");
      assert.equal(res.headers.get("retry-after"), "60");
    } finally {
      restore();
    }
  });

  test("proceeds to the live RPC when the rate limiter allows the request", async () => {
    const env = {
      RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const restore = prefixStub({ type: null, owned: null });
    try {
      const res = await handleRequest(
        req(`/api/v1/accounts/${COLDKEY_SS58}/root-claim`),
        env,
        {},
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data.entries, []);
    } finally {
      restore();
    }
  });
});
