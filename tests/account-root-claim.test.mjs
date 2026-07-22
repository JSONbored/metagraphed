import assert from "node:assert/strict";
import { describe, test, vi, afterEach } from "vitest";
import {
  decodeAccountIdVec,
  decodeClaimableMap,
  decodeI96F32,
  decodeRootClaimType,
  decodeU128,
  i96f32ToFloat,
  loadAccountRootClaim,
  ROOT_CLAIM_KV_TTL,
  ROOT_CLAIM_NEGATIVE_KV_TTL,
} from "../src/account-root-claim.ts";
import { encodeAccountId32 } from "../src/ss58.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function compactU32(n) {
  if (n < 64) return Uint8Array.of(n << 2);
  if (n < 1 << 14) {
    const v = (n << 2) | 0b01;
    return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff);
  }
  const v = (n << 2) | 0b10;
  return Uint8Array.of(
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff,
  );
}

function u16Le(n) {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff);
}

function i128LeFromFloat(n) {
  // Encode as I96F32: bits = round(n * 2^32)
  const bits = BigInt(Math.round(n * 2 ** 32));
  const out = new Uint8Array(16);
  let rest = bits < 0n ? bits + (1n << 128n) : bits;
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function u128Le(n) {
  const out = new Uint8Array(16);
  let rest = BigInt(n);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function toHex(bytes) {
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("i96f32ToFloat", () => {
  test("decodes whole and fractional parts", () => {
    assert.equal(i96f32ToFloat(0n), 0);
    assert.equal(i96f32ToFloat(1n << 32n), 1);
    assert.equal(i96f32ToFloat(1n << 31n), 0.5);
  });
});

describe("decodeRootClaimType", () => {
  test("defaults unset storage to Swap", () => {
    assert.deepEqual(decodeRootClaimType(null), { kind: "Swap" });
  });

  test("decodes Swap / Keep / KeepSubnets", () => {
    assert.deepEqual(decodeRootClaimType("0x00"), { kind: "Swap" });
    assert.deepEqual(decodeRootClaimType("0x01"), { kind: "Keep" });
    const keepSubnets = toHex(
      concatBytes(Uint8Array.of(2), compactU32(2), u16Le(1), u16Le(7)),
    );
    assert.deepEqual(decodeRootClaimType(keepSubnets), {
      kind: "KeepSubnets",
      subnets: [1, 7],
    });
  });

  test("rejects malformed tags and trailing bytes", () => {
    assert.equal(decodeRootClaimType("0x03"), null);
    assert.equal(decodeRootClaimType("0x0000"), null);
    assert.equal(decodeRootClaimType("0xzz"), null);
  });
});

describe("decodeClaimableMap", () => {
  test("decodes an empty map and unset storage", () => {
    assert.deepEqual(decodeClaimableMap(null), []);
    assert.deepEqual(decodeClaimableMap(toHex(compactU32(0))), []);
  });

  test("decodes netuid + I96F32 rate pairs", () => {
    const hex = toHex(concatBytes(compactU32(1), u16Le(3), i128LeFromFloat(2)));
    const entries = decodeClaimableMap(hex);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].netuid, 3);
    assert.equal(entries[0].claimable_rate, 2);
  });

  test("rejects truncated or trailing bytes", () => {
    assert.equal(decodeClaimableMap("0x04"), null); // compact 1, no payload
    assert.equal(
      decodeClaimableMap(toHex(concatBytes(compactU32(0), Uint8Array.of(1)))),
      null,
    );
  });
});

describe("decodeAccountIdVec / decodeU128 / decodeI96F32", () => {
  test("decodes an account vec", () => {
    const accountId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const hex = toHex(concatBytes(compactU32(1), accountId));
    const accounts = decodeAccountIdVec(hex);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0], encodeAccountId32(accountId));
  });

  test("decodes claimed u128 and threshold I96F32", () => {
    assert.equal(decodeU128(null), "0");
    assert.equal(decodeU128(toHex(u128Le(42))), "42");
    assert.equal(decodeI96F32(null), 0);
    assert.equal(decodeI96F32(toHex(i128LeFromFloat(1.5))), 1.5);
    assert.equal(decodeU128("0xdead"), null);
    assert.equal(decodeI96F32("0xdead"), null);
  });
});

describe("loadAccountRootClaim", () => {
  test("rejects a non-finney ss58", async () => {
    await assert.rejects(
      () => loadAccountRootClaim({}, "not-an-address"),
      /finney SS58/,
    );
  });

  test("returns schema-stable nulls when RPC fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const payload = await loadAccountRootClaim({}, SS58);
    assert.equal(payload.ss58, SS58);
    assert.equal(payload.claim_type, null);
    assert.equal(payload.hotkeys, null);
    assert.ok(payload.queried_at);
  });

  test("assembles claim_type + hotkey claimable entries from storage", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const hotSs58 = encodeAccountId32(hotAccountId);

    const claimTypeHex = "0x01"; // Keep
    const stakingHex = toHex(concatBytes(compactU32(1), hotAccountId));
    const ownedHex = toHex(compactU32(0));
    const claimableHex = toHex(
      concatBytes(compactU32(1), u16Le(5), i128LeFromFloat(0.25)),
    );
    const claimedHex = toHex(u128Le(1000));
    const thresholdHex = toHex(i128LeFromFloat(0.5));

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        let result;
        if (call === 1) result = claimTypeHex;
        else if (call === 2) result = stakingHex;
        else if (call === 3) result = ownedHex;
        else if (call === 4) result = claimableHex;
        else if (call === 5) result = claimedHex;
        else if (call === 6) result = thresholdHex;
        else result = null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );

    const payload = await loadAccountRootClaim({}, SS58);
    assert.deepEqual(payload.claim_type, { kind: "Keep" });
    assert.equal(payload.hotkeys.length, 1);
    assert.equal(payload.hotkeys[0].hotkey, hotSs58);
    assert.equal(payload.hotkeys[0].entries[0].netuid, 5);
    assert.equal(payload.hotkeys[0].entries[0].claimable_rate, 0.25);
    assert.equal(payload.hotkeys[0].entries[0].claimed, "1000");
    assert.equal(payload.hotkeys[0].entries[0].threshold, 0.5);
  });

  test("falls back to OwnedHotkeys when StakingHotkeys is empty", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => 40 + i);
    const hotSs58 = encodeAccountId32(hotAccountId);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        let result;
        if (call === 1)
          result = "0x00"; // Swap
        else if (call === 2)
          result = toHex(compactU32(0)); // no staking hotkeys
        else if (call === 3)
          result = toHex(concatBytes(compactU32(1), hotAccountId));
        else if (call === 4)
          result = toHex(compactU32(0)); // empty claimable
        else result = null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    const payload = await loadAccountRootClaim({}, SS58);
    assert.deepEqual(payload.claim_type, { kind: "Swap" });
    assert.equal(payload.hotkeys[0].hotkey, hotSs58);
    assert.deepEqual(payload.hotkeys[0].entries, []);
  });

  test("returns KV cache hit without RPC", async () => {
    const cached = {
      schema_version: 1,
      ss58: SS58,
      claim_type: { kind: "Swap" },
      hotkeys: [],
      queried_at: "2026-07-20T00:00:00.000Z",
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const payload = await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return cached;
          },
        },
      },
      SS58,
    );
    assert.equal(payload, cached);
    assert.equal(fetchSpy.mock.calls.length, 0);
  });

  test("positive-caches a successful payload", async () => {
    let stored = null;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        const result =
          call === 1
            ? "0x00"
            : call === 2 || call === 3
              ? toHex(compactU32(0))
              : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return null;
          },
          async put(_key, value, opts) {
            stored = { value: JSON.parse(value), opts };
          },
        },
      },
      SS58,
    );
    assert.equal(stored.opts.expirationTtl, ROOT_CLAIM_KV_TTL);
    assert.deepEqual(stored.value.claim_type, { kind: "Swap" });
    assert.deepEqual(stored.value.hotkeys, []);
  });

  test("negative-caches RPC failure", async () => {
    let stored = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return null;
          },
          async put(_key, value, opts) {
            stored = { value: JSON.parse(value), opts };
          },
        },
      },
      SS58,
    );
    assert.equal(stored.opts.expirationTtl, ROOT_CLAIM_NEGATIVE_KV_TTL);
    assert.equal(stored.value.hotkeys, null);
  });

  test("treats non-ok RPC and JSON-RPC errors as failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 502 })),
    );
    assert.equal((await loadAccountRootClaim({}, SS58)).hotkeys, null);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32601, message: "missing" },
            }),
            { status: 200 },
          ),
      ),
    );
    assert.equal((await loadAccountRootClaim({}, SS58)).claim_type, null);
  });

  test("nulls out when claim_type or hotkey vec decode fails", async () => {
    let call = 0;
    let stored = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        // Malformed KeepSubnets (truncated)
        const result =
          call === 1 ? "0x0204" : call <= 3 ? toHex(compactU32(0)) : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    // No KV → if (kv?.put) false arm
    assert.equal((await loadAccountRootClaim({}, SS58)).hotkeys, null);

    call = 0;
    const payload = await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return null;
          },
          async put(_k, value, opts) {
            stored = opts;
          },
        },
      },
      SS58,
    );
    assert.equal(payload.hotkeys, null);
    assert.equal(stored.expirationTtl, ROOT_CLAIM_NEGATIVE_KV_TTL);
  });

  test("nulls out when a per-hotkey claimable fetch fails", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call <= 3) {
          const result =
            call === 1
              ? "0x00"
              : call === 2
                ? toHex(concatBytes(compactU32(1), hotAccountId))
                : toHex(compactU32(0));
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
            { status: 200 },
          );
        }
        // RootClaimable fetch fails
        return new Response("err", { status: 500 });
      }),
    );
    assert.equal((await loadAccountRootClaim({}, SS58)).hotkeys, null);
  });

  test("nulls out when claimed/threshold decode fails mid-entry", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i + 2);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        let result;
        if (call === 1) result = "0x00";
        else if (call === 2)
          result = toHex(concatBytes(compactU32(1), hotAccountId));
        else if (call === 3) result = toHex(compactU32(0));
        else if (call === 4)
          result = toHex(
            concatBytes(compactU32(1), u16Le(9), i128LeFromFloat(1)),
          );
        else if (call === 5)
          result = "0xdead"; // bad claimed
        else result = toHex(i128LeFromFloat(1));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    assert.equal((await loadAccountRootClaim({}, SS58)).hotkeys, null);
  });

  test("tolerates KV get/put failures", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        const result =
          call === 1
            ? "0x00"
            : call === 2 || call === 3
              ? toHex(compactU32(0))
              : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    const payload = await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            throw new Error("kv get");
          },
          async put() {
            throw new Error("kv put");
          },
        },
      },
      SS58,
    );
    assert.deepEqual(payload.claim_type, { kind: "Swap" });
    assert.deepEqual(payload.hotkeys, []);
  });

  test("decodes compact mode-1 lengths and negative I96F32", () => {
    // count=100 uses 2-byte compact
    const accountId = Uint8Array.from({ length: 32 }, () => 7);
    // Just verify decodeAccountIdVec rejects truncated mode-1 payload
    assert.equal(decodeAccountIdVec(toHex(compactU32(100))), null);
    // Negative rate: -1.0 as I96F32
    const negBits = -(1n << 32n);
    assert.equal(i96f32ToFloat(negBits), -1);
    const hex = toHex(
      concatBytes(compactU32(1), u16Le(2), i128LeFromFloat(-0.5)),
    );
    assert.equal(decodeClaimableMap(hex)[0].claimable_rate, -0.5);
    void accountId;
  });

  test("KeepSubnets rejects trailing bytes; empty claimable hex is []", () => {
    assert.equal(
      decodeRootClaimType(
        toHex(
          concatBytes(
            Uint8Array.of(2),
            compactU32(1),
            u16Le(1),
            Uint8Array.of(0),
          ),
        ),
      ),
      null,
    );
    assert.deepEqual(decodeClaimableMap("0x"), []);
    assert.deepEqual(decodeAccountIdVec("0x"), []);
  });

  test("covers compact modes, Keep trailing bytes, and malformed claimable", () => {
    assert.equal(decodeRootClaimType("0x0100"), null); // Keep + trailing
    assert.equal(decodeRootClaimType("0x02"), null); // KeepSubnets, no compact
    assert.equal(decodeRootClaimType("0x0203"), null); // KeepSubnets + mode-3 compact
    // Truncated mode-1 compact (needs 2 bytes)
    assert.equal(decodeClaimableMap(toHex(Uint8Array.of(0x01))), null);
    // Truncated mode-2 compact (needs 4 bytes)
    assert.equal(decodeClaimableMap(toHex(Uint8Array.of(0x02, 0, 0))), null);
    // Successful mode-2 compact (4-byte length): count=0 encoded as 0b10
    assert.deepEqual(
      decodeClaimableMap(toHex(Uint8Array.of(0x02, 0, 0, 0))),
      [],
    );
    // Successful mode-2 compact with one claimable entry (count=1 → 0x06)
    const mode2One = toHex(
      concatBytes(Uint8Array.of(0x06, 0, 0, 0), u16Le(11), i128LeFromFloat(3)),
    );
    assert.equal(decodeClaimableMap(mode2One)[0].netuid, 11);
    assert.equal(decodeClaimableMap(mode2One)[0].claimable_rate, 3);
    assert.equal(decodeClaimableMap("0xzz"), null);
    assert.deepEqual(decodeAccountIdVec(null), []);
    assert.equal(decodeAccountIdVec("0xzz"), null);
    assert.equal(decodeAccountIdVec("0x03"), null); // mode-3 compact
    assert.equal(decodeClaimableMap("0x03"), null); // mode-3 via claimable map
    assert.equal(decodeRootClaimType("0x0203"), null); // KeepSubnets + mode-3
    // One full account + trailing byte
    const accountId = Uint8Array.from({ length: 32 }, () => 9);
    assert.equal(
      decodeAccountIdVec(
        toHex(concatBytes(compactU32(1), accountId, Uint8Array.of(0))),
      ),
      null,
    );
    // Successful mode-1 compact length
    const keepMany = toHex(
      concatBytes(
        Uint8Array.of(2),
        compactU32(64),
        ...Array.from({ length: 64 }, (_, i) => u16Le(i)),
      ),
    );
    assert.equal(decodeRootClaimType(keepMany).kind, "KeepSubnets");
    assert.equal(decodeRootClaimType(keepMany).subnets.length, 64);
  });

  test("nulls + negative-caches when claimable map is malformed", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
    let stored = null;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        let result;
        if (call === 1) result = "0x00";
        else if (call === 2)
          result = toHex(concatBytes(compactU32(1), hotAccountId));
        else if (call === 3) result = toHex(compactU32(0));
        else if (call === 4)
          result = "0xzz"; // malformed claimable
        else result = null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    const payload = await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return null;
          },
          async put(_k, value, opts) {
            stored = { opts, value: JSON.parse(value) };
          },
        },
      },
      SS58,
    );
    assert.equal(payload.hotkeys, null);
    assert.equal(stored.opts.expirationTtl, ROOT_CLAIM_NEGATIVE_KV_TTL);
  });

  test("nulls when claimed/threshold RPC is non-ok", async () => {
    const hotAccountId = Uint8Array.from({ length: 32 }, (_, i) => i + 6);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call <= 4) {
          let result;
          if (call === 1) result = "0x00";
          else if (call === 2)
            result = toHex(concatBytes(compactU32(1), hotAccountId));
          else if (call === 3) result = toHex(compactU32(0));
          else
            result = toHex(
              concatBytes(compactU32(1), u16Le(1), i128LeFromFloat(1)),
            );
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 503 });
      }),
    );
    assert.equal((await loadAccountRootClaim({}, SS58)).hotkeys, null);
  });

  test("works with a null env (no KV)", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        // Omit `result` entirely so fetchStorage takes the `?? null` arm.
        if (call === 1) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x00" }),
            { status: 200 },
          );
        }
        if (call === 2 || call === 3) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
          {
            status: 200,
          },
        );
      }),
    );
    // Missing result on StakingHotkeys/OwnedHotkeys → empty vecs → empty hotkeys
    const payload = await loadAccountRootClaim(null, SS58);
    assert.deepEqual(payload.claim_type, { kind: "Swap" });
    assert.deepEqual(payload.hotkeys, []);
  });

  test("skips KV when get/put bindings are missing", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        const result =
          call === 1
            ? "0x00"
            : call === 2 || call === 3
              ? toHex(compactU32(0))
              : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }),
    );
    const a = await loadAccountRootClaim(
      { METAGRAPH_CONTROL: { async put() {} } },
      SS58,
    );
    assert.deepEqual(a.hotkeys, []);
    call = 0;
    const b = await loadAccountRootClaim(
      {
        METAGRAPH_CONTROL: {
          async get() {
            return null;
          },
        },
      },
      SS58,
    );
    assert.deepEqual(b.hotkeys, []);
  });
});
