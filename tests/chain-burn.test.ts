// The cross-subnet registration-cost ranking (src/chain-burn.ts, #9399).
//
// The decoding is the risky part, and it fails SILENTLY when it fails: a wrong storage
// key returns null for every netuid, which reads as "burn is unset chain-wide" rather
// than as a bug. So the key derivation is asserted against values verified against the
// live chain, not just against the code's own assumptions.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChainBurn,
  loadChainBurn,
  netuidFromBurnKey,
  CHAIN_BURN_KV_TTL,
  CHAIN_BURN_NEGATIVE_KV_TTL,
  CHAIN_BURN_MAX_NETUIDS,
} from "../src/chain-burn.ts";
import { ChainBurnArtifactSchema } from "../schemas-src/routes/subnet-registration-cost.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// twox128("SubtensorModule") ++ twox128("Burn"), verified against the live chain.
const PREFIX =
  "0x658faa385070e074c85bf6b568cf055501be1755d08418802946bca51b686325";

/** A netuid's Burn storage key, built the way the chain lays them out. */
function key(netuid: number): string {
  const lo = (netuid % 256).toString(16).padStart(2, "0");
  const hi = Math.floor(netuid / 256)
    .toString(16)
    .padStart(2, "0");
  return PREFIX + lo + hi;
}

/** A u64 rao value as the little-endian hex the RPC returns. */
function rao(value: bigint): string {
  const bytes: string[] = [];
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    bytes.push(
      Number(v & 0xffn)
        .toString(16)
        .padStart(2, "0"),
    );
    v >>= 8n;
  }
  return "0x" + bytes.join("");
}

const AT = "2026-08-04T13:00:00.000Z";

describe("netuidFromBurnKey", () => {
  test("round-trips the netuids the chain actually uses", () => {
    // Identity hasher: the key IS the netuid, little-endian u16. 76 and 92 are the
    // two cheapest real subnets; 128 crosses the byte boundary.
    for (const netuid of [0, 1, 64, 76, 92, 128, 129, 255, 256, 65535]) {
      assert.equal(netuidFromBurnKey(key(netuid)), netuid, `netuid ${netuid}`);
    }
  });

  test("refuses a key that is not ours rather than decoding noise", () => {
    for (const bad of [
      null,
      42,
      "0xdeadbeef",
      PREFIX, // no netuid suffix
      PREFIX + "0", // half a byte
      PREFIX + "0000ff", // too long
      PREFIX + "zzzz", // not hex
    ]) {
      assert.equal(netuidFromBurnKey(bad), null, String(bad).slice(0, 24));
    }
  });
});

describe("buildChainBurn", () => {
  // The real shape, from the live read on 2026-08-04.
  const CHANGES = [
    [key(0), rao(500_000n)],
    [key(76), rao(0n)],
    [key(92), rao(100_000n)],
    [key(122), rao(999_999_999n)],
  ];

  test("ranks cheapest-first and reports the spread", () => {
    const card = buildChainBurn(CHANGES, 129, { queriedAt: AT });
    assert.deepEqual(
      (card.subnets as Array<{ netuid: number }>).map((s) => s.netuid),
      [76, 92, 0, 122],
    );
    assert.equal(card.cheapest_burn_tao, 0);
    assert.equal(card.dearest_burn_tao, 0.999999999);
    assert.equal(card.read_count, 4);
  });

  test("a genuine zero burn is INCLUDED, not dropped", () => {
    // netuid 76 really is 0 on chain, and it is the cheapest registration on the
    // network -- exactly what someone sorting this list is looking for. Treating a
    // zero value as "absent" would hide the best answer.
    const card = buildChainBurn(CHANGES, 129, { queriedAt: AT });
    const zero = (card.subnets as Array<Record<string, unknown>>).find(
      (s) => s.netuid === 76,
    );
    assert.deepEqual(zero, { netuid: 76, burn_tao: 0 });
  });

  test("a netuid that does not exist is omitted, not published as free", () => {
    const card = buildChainBurn(
      [...CHANGES, [key(900), null], [key(901), undefined]],
      129,
      { queriedAt: AT },
    );
    assert.equal(card.read_count, 4);
    assert.ok(
      !(card.subnets as Array<{ netuid: number }>).some((s) => s.netuid > 500),
    );
  });

  test("subnet_count and read_count stay separate, so a partial read shows", () => {
    // The chain says 129 exist; we read 4. Collapsing these into one number would
    // present a truncated read as a complete answer.
    const card = buildChainBurn(CHANGES, 129, { queriedAt: AT });
    assert.equal(card.subnet_count, 129);
    assert.equal(card.read_count, 4);
    assert.notEqual(card.subnet_count, card.read_count);
  });

  test("the median is a real element, not an interpolation", () => {
    const card = buildChainBurn(CHANGES, 129, { queriedAt: AT });
    const values = (card.subnets as Array<{ burn_tao: number }>).map(
      (s) => s.burn_tao,
    );
    assert.ok(values.includes(card.median_burn_tao as number));
  });

  test("a failed read is an empty ranking with nulls, never zeroes", () => {
    // 0 is a legitimate burn, so a zeroed summary would be indistinguishable from a
    // network where everything is free.
    for (const empty of [null, undefined, [], "nonsense"]) {
      const card = buildChainBurn(empty, null, { queriedAt: AT });
      assert.deepEqual(card.subnets, []);
      assert.equal(card.read_count, 0);
      assert.equal(card.cheapest_burn_tao, null);
      assert.equal(card.dearest_burn_tao, null);
      assert.equal(card.median_burn_tao, null);
      assert.equal(card.subnet_count, null);
    }
  });

  test("malformed entries are skipped rather than decoded as garbage", () => {
    const card = buildChainBurn(
      [
        [key(1), rao(500_000n)],
        ["not-a-key", rao(1n)],
        [key(2), "0xshort"],
        [key(3)],
        "not-an-entry",
      ],
      129,
      { queriedAt: AT },
    );
    assert.deepEqual(card.subnets, [{ netuid: 1, burn_tao: 0.0005 }]);
  });

  test("rao converts without float drift at the top of the range", () => {
    const card = buildChainBurn([[key(1), rao(999_999_999n)]], 1, {
      queriedAt: AT,
    });
    assert.equal(
      (card.subnets as Array<{ burn_tao: number }>)[0].burn_tao,
      0.999999999,
    );
  });

  test("the card satisfies its published schema", () => {
    const card = {
      ...buildChainBurn(CHANGES, 129, { queriedAt: AT }),
      field_sources: {
        burn_tao: { kind: "measured", storage: "SubtensorModule.Burn" },
      },
    };
    const parsed = ChainBurnArtifactSchema.safeParse(card);
    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    );
  });
});

describe("loadChainBurn", () => {
  function rpcStub(
    { total, changes }: { total?: string | null; changes?: unknown },
    calls: Array<{ method: string; params: unknown }> = [],
  ) {
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: body.method, params: body.params });
      const result =
        body.method === "state_getStorage"
          ? (total ?? null)
          : [{ changes: changes ?? [] }];
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  test("reads every subnet in ONE storage call, keys derived from TotalNetworks", async () => {
    // The whole point: 129 subnets must not be 129 round trips. state_getKeys is
    // refused by the public endpoint as unsafe, so the keys are derived instead.
    const calls = rpcStub({
      total: "0x8100", // 129, little-endian u16
      changes: [[key(5), rao(500_000n)]],
    });
    const card = await loadChainBurn({} as never);
    const batched = calls.filter((c) => c.method === "state_queryStorageAt");
    assert.equal(batched.length, 1, "exactly one batched read");
    const keys = (batched[0].params as string[][])[0];
    assert.equal(keys.length, 130, "0..TotalNetworks inclusive");
    assert.equal(keys[0], key(0));
    assert.equal(card.subnet_count, 129);
  });

  test("probes one PAST the reported count, so the newest subnet is not dropped", async () => {
    // TotalNetworks is a count and netuids are 0-indexed with root included, so
    // stopping at the count would silently omit the highest netuid -- the newest
    // subnet, which is the one most likely to be cheap and therefore looked for.
    const calls = rpcStub({ total: "0x0300", changes: [] }); // 3
    await loadChainBurn({} as never);
    const keys = (
      calls.find((c) => c.method === "state_queryStorageAt")!
        .params as string[][]
    )[0];
    assert.deepEqual(keys, [key(0), key(1), key(2), key(3)]);
  });

  test("an RPC failure yields the empty card rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("upstream down");
    }) as unknown as typeof fetch;
    const card = await loadChainBurn({} as never);
    assert.equal(card.read_count, 0);
    assert.equal(card.cheapest_burn_tao, null);
    assert.ok(card.field_sources, "provenance is still attached");
  });

  test("a served card is cached, and an empty one only briefly", async () => {
    // An empty read is indistinguishable from a broken upstream, so it must not
    // occupy the cache for the full TTL and mask a recovery.
    for (const [changes, expected] of [
      [[[key(1), rao(1n)]], CHAIN_BURN_KV_TTL],
      [[], CHAIN_BURN_NEGATIVE_KV_TTL],
    ] as const) {
      const puts: Array<{ ttl?: number }> = [];
      rpcStub({ total: "0x0200", changes });
      const env = {
        METAGRAPH_CONTROL: {
          get: async () => null,
          put: async (
            _k: string,
            _v: string,
            opts: { expirationTtl?: number },
          ) => {
            puts.push({ ttl: opts?.expirationTtl });
          },
        },
      };
      await loadChainBurn(env as never);
      assert.equal(puts[0]?.ttl, expected);
    }
  });

  test("a cached card is served without touching the chain", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    rpcStub({ total: "0x0200", changes: [] }, calls);
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => ({ schema_version: 1, read_count: 7, subnets: [] }),
        put: async () => {},
      },
    };
    const card = await loadChainBurn(env as never);
    assert.equal(card.read_count, 7);
    assert.equal(calls.length, 0, "no RPC when the cache answers");
    assert.ok(
      card.field_sources,
      "provenance is attached outside the cache blob",
    );
  });

  test("a throwing KV read falls through to the chain rather than failing", async () => {
    rpcStub({ total: "0x0200", changes: [[key(1), rao(500_000n)]] });
    const env = {
      METAGRAPH_CONTROL: {
        get: async () => {
          throw new Error("kv down");
        },
        put: async () => {},
      },
    };
    const card = await loadChainBurn(env as never);
    assert.equal(card.read_count, 1);
  });
});

describe("loadChainBurn — the edges of the chain read", () => {
  function stub(handler: (method: string, params: unknown) => unknown) {
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const out = handler(body.method, body.params);
      if (out === "NOT_OK") {
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: out }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("an unreadable TotalNetworks still probes root, rather than nothing", async () => {
    // A malformed or absent count must not silently produce a zero-key request that
    // reads as "no subnets exist". Root is always there.
    for (const total of [null, "0x", "0xzz", "0xdeadbeef00"]) {
      stub((m) => (m === "state_getStorage" ? total : [{ changes: [] }]));
      const card = await loadChainBurn({} as never);
      assert.equal(card.subnet_count, null, `total ${String(total)}`);
      assert.equal(card.read_count, 0);
    }
  });

  test("a non-2xx RPC response is a failed read, not an empty network", async () => {
    stub(() => "NOT_OK");
    const card = await loadChainBurn({} as never);
    assert.equal(card.read_count, 0);
    assert.equal(card.cheapest_burn_tao, null);
  });

  test("a response that is not the expected envelope degrades cleanly", async () => {
    for (const shape of [null, "nonsense", [], [{}], [{ changes: "nope" }]]) {
      stub((m) => (m === "state_getStorage" ? "0x0200" : shape));
      const card = await loadChainBurn({} as never);
      assert.equal(card.read_count, 0, JSON.stringify(shape));
    }
  });

  test("an absurd TotalNetworks is capped, not obeyed", async () => {
    // A chain reporting a nonsense count must not make us build 65,536 keys and send
    // them in one request. CHAIN_BURN_MAX_NETUIDS is the bound.
    let sent: string[] = [];
    stub((m, params) => {
      if (m === "state_getStorage") return "0xffff"; // 65535
      sent = (params as string[][])[0];
      return [{ changes: [] }];
    });
    await loadChainBurn({} as never);
    assert.equal(sent.length, CHAIN_BURN_MAX_NETUIDS);
    // Still comfortably above SubnetLimit (128), so a real network is never truncated.
    assert.ok(CHAIN_BURN_MAX_NETUIDS > 128 * 4);
  });

  test("equal burns tie-break on netuid, so the order is stable", () => {
    // Most subnets sit at the same floor price, so without a deterministic tiebreak
    // the ranking would reshuffle between reads for no reason.
    const card = buildChainBurn(
      [
        [key(9), rao(500_000n)],
        [key(2), rao(500_000n)],
        [key(5), rao(500_000n)],
      ],
      3,
      { queriedAt: AT },
    );
    assert.deepEqual(
      (card.subnets as Array<{ netuid: number }>).map((s) => s.netuid),
      [2, 5, 9],
    );
  });
});

describe("GET /api/v1/chain/burn — through the Worker router", () => {
  function chainStub(seen: string[] = []) {
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      seen.push(String(u));
      const body = JSON.parse(String(init.body));
      const result =
        body.method === "state_getStorage"
          ? "0x0200" // TotalNetworks = 2
          : [
              {
                changes: [
                  [key(1), rao(500_000n)],
                  [key(0), rao(0n)],
                ],
              },
            ];
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return seen;
  }

  async function get(path: string) {
    chainStub();
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      createLocalArtifactEnv() as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return { res, body: (await res.json()) as Record<string, never> };
  }

  test("serves the ranked card", async () => {
    const { res, body } = await get("/api/v1/chain/burn");
    assert.equal(res.status, 200);
    const data = body.data as unknown as Record<string, unknown>;
    assert.equal(data.subnet_count, 2);
    assert.deepEqual(data.subnets, [
      { netuid: 0, burn_tao: 0 },
      { netuid: 1, burn_tao: 0.0005 },
    ]);
    assert.ok(data.field_sources);
  });

  test("the /{network}/ prefixed form reaches the same route", async () => {
    // The contract auto-publishes /api/v1/{network}/chain/burn alongside the bare
    // path, and resolveNetworkPrefix strips the segment before dispatch -- so an
    // exact-path match serves both. Asserted rather than assumed, because the
    // alternative is a documented route that 404s.
    const { res, body } = await get("/api/v1/testnet/chain/burn");
    assert.equal(res.status, 200);
    assert.equal(
      (body.data as unknown as Record<string, unknown>).subnet_count,
      2,
    );
  });

  test("the prefixed form reads the network's OWN chain, not mainnet's", async () => {
    // Testnet runs its own registration auction; serving finney's prices under a
    // testnet path would be a confident wrong answer about what registration costs.
    const seen: string[] = [];
    chainStub(seen);
    await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/testnet/chain/burn"),
      createLocalArtifactEnv() as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    assert.ok(seen.length > 0, "the chain was read");
    assert.ok(
      seen.every((u) => u.includes("test")),
      `testnet path read ${seen[0]}`,
    );
  });
});
