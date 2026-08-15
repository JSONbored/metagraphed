// The sampler is the chain-I/O half of the emission-gate lane, now shared
// verbatim between the node script shell and the Worker cron. What these
// tests pin is FIDELITY of the assembly the differs receive -- plus the three
// chain quirks the original script learned the hard way (each carries its
// own comment at the assertion).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleScheduled } from "../workers/api.ts";
import {
  EMISSION_GATE_SAMPLE_CRON,
  EMISSION_GATE_SAMPLE_INTERVAL_MS,
} from "../workers/config.ts";
import {
  netuidFromKey,
  EMISSION_SAMPLER_ARCHIVE_URLS,
  sampleEmissionGate,
  sampleEmissionGateWithFailover,
  STORAGE_BATCH_SIZE,
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

/** The chain's storage, per key. The sampler reads these in BATCHES
 * (`state_queryStorageAt`), so the transport below turns this per-key view into
 * the batched response shape — keeping each test's intent expressed as "what
 * does this key hold" rather than as request plumbing. */
function healthyStorage(key: string): string | null {
  if (key === TOTAL_ISSUANCE_STORAGE_KEY) return "0x0000c16ff2862300"; // u64 LE
  if (key === ENABLED_KEY_7) return "0x00"; // disabled
  if (key === EMA_KEY_7) return null;
  return null;
}

/** `state_queryStorageAt`'s answer: one page whose `changes` pairs every
 * requested key with its value. */
function changesFor(
  keys: string[],
  value: (key: string) => string | null,
): unknown {
  return [{ changes: keys.map((key) => [key, value(key)]) }];
}

/** The finalized block every call in a sample must be pinned to. */
const FINALIZED_HASH =
  "0xe37c081adf43c0e284d4fb7ee3c21b58e057bf50548d8821d340f631f91ba244";

/** The minimal healthy chain: finalized head, header, null gate params, one
 * enabled subnet, flow params unset, one EMA entry. */
function healthyAnswer(method: string, params: unknown[]): unknown {
  if (method === "chain_getFinalizedHead") return FINALIZED_HASH;
  if (method === "chain_getHeader") return { number: "0x85a1c8" };
  if (method === "state_getKeysPaged") {
    const prefix = params[0];
    if (prefix === SUBNET_EMISSION_ENABLED_PREFIX) return [ENABLED_KEY_7];
    if (prefix === SUBNET_EMA_TAO_FLOW_PREFIX) return [EMA_KEY_7];
    return [];
  }
  if (method === "state_queryStorageAt") {
    return changesFor(params[0] as string[], healthyStorage);
  }
  throw new Error(`unexpected method ${method}`);
}

/** The healthy chain with specific storage keys overridden. */
function answerWith(
  overrides: Record<string, string | null>,
): (method: string, params: unknown[]) => unknown {
  return (method, params) =>
    method === "state_queryStorageAt"
      ? changesFor(params[0] as string[], (key) =>
          key in overrides ? overrides[key]! : healthyStorage(key),
        )
      : healthyAnswer(method, params);
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
    const { impl } = rpcFetch(answerWith({ [ENABLED_KEY_7]: "0x01" }));
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.deepEqual(sample.current_enabled, [[7, true]]);
  });

  test("state_getKeysPaged never passes null for params[2] — it 400s the proxy", async () => {
    // The block hash is params[3], so params[2] must be occupied to reach it,
    // and `null` is the one value the RPC proxy rejects. The PREFIX is used
    // instead: it sorts before every key under it, so it skips nothing.
    const { impl, calls } = rpcFetch(healthyAnswer);
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const firstPaged = calls.find((c) => c.method === "state_getKeysPaged")!;
    assert.notEqual(firstPaged.params[2], null, "null 400s the proxy");
    assert.equal(
      firstPaged.params[2],
      firstPaged.params[0],
      "the prefix is the first page's startKey",
    );
    assert.equal(firstPaged.params[3], FINALIZED_HASH);
  });

  test("EVERY read is pinned to the one finalized block", async () => {
    // A sample is a dozen calls. Unpinned, each resolves "best block" on
    // whichever archive node the rotation handed it, so block_number could come
    // from one block and the values from another -- and this lane's whole job is
    // to say WHEN a parameter changed. It is also what threw UnknownBlock in
    // production (#10742): a node that had not imported another node's head.
    const { impl, calls } = rpcFetch(healthyAnswer);
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });

    assert.equal(
      calls.filter((c) => c.method === "chain_getFinalizedHead").length,
      1,
      "the block is resolved ONCE, then reused",
    );
    assert.deepEqual(
      calls.find((c) => c.method === "chain_getHeader")!.params,
      [FINALIZED_HASH],
      "the header is read AT that block, not at the head",
    );
    for (const c of calls.filter((x) => x.method === "state_queryStorageAt")) {
      assert.equal(c.params[1], FINALIZED_HASH, "storage read off-block");
    }
    for (const c of calls.filter((x) => x.method === "state_getKeysPaged")) {
      assert.equal(c.params[3], FINALIZED_HASH, "keys read off-block");
    }
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

    // An error envelope with NO message still names the method and shows what
    // the node actually sent. This used to read `chain_getFinalizedHead: rpc
    // error` -- a hardcoded literal that says only "something went wrong". Now
    // it carries the serialized error (`{}` here), which is the shared client's
    // rule since #11194: the envelope IS the diagnosis, and a decline that does
    // not say why is the failure the method prefix exists to prevent.
    const bare = (async () =>
      ({
        ok: true,
        json: async () => ({ error: {} }),
      }) as unknown as Response) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: bare }),
      /^Error: chain_getFinalizedHead: \{\}$/,
    );
  });

  test("an unset TotalIssuance reads halvings as null, and the global fetch default engages", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = rpcFetch(
      answerWith({ [TOTAL_ISSUANCE_STORAGE_KEY]: null }),
    ).impl;
    try {
      const sample = await sampleEmissionGate({ rpcUrl: "https://rpc.test" });
      assert.equal(sample.current.block_emission_halvings, null);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an undecodable gate value and a malformed EMA key both degrade, never throw", async () => {
    // present but undecodable -> null param
    const undecodable = answerWith({
      [EMISSION_GATE_BAR_STORAGE_KEY]: "0xnothex",
    });
    const { impl } = rpcFetch((m, p) =>
      m === "state_getKeysPaged" && p[0] === SUBNET_EMA_TAO_FLOW_PREFIX
        ? [SUBNET_EMA_TAO_FLOW_PREFIX + "070000", EMA_KEY_7]
        : undecodable(m, p),
    );
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(sample.current.emission_gate_bar, null);
    assert.deepEqual(sample.current_ema, [[7, null]]);
  });

  // The batched read is what keeps this sampler inside the endpoint's 100
  // requests/minute/client budget (#9477). Before it, one state_getStorage per
  // subnet cost ~207 calls a tick, 429'd about six seconds in, and threw away
  // the whole sample every ten minutes.
  test("reads every subnet's storage in ONE call, not one call per subnet", async () => {
    const { impl, calls } = rpcFetch(healthyAnswer);
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    assert.equal(
      calls.filter((c) => c.method === "state_getStorage").length,
      0,
      "the per-key method is what blew the budget — nothing may still use it",
    );
    // header + params + 2 keysPaged + enabled + flow + ema.
    assert.ok(calls.length <= 8, `expected <=8 RPC calls, got ${calls.length}`);
  });

  test("chunks a key list longer than the batch size", async () => {
    // One key past the bound, so the loop must run twice rather than once.
    const many = Array.from(
      { length: STORAGE_BATCH_SIZE + 1 },
      (_, i) =>
        SUBNET_EMISSION_ENABLED_PREFIX + i.toString(16).padStart(4, "0"),
    );
    const { impl, calls } = rpcFetch((m, p) => {
      if (m === "state_getKeysPaged" && p[0] === SUBNET_EMISSION_ENABLED_PREFIX)
        return many;
      return healthyAnswer(m, p);
    });
    await sampleEmissionGate({ rpcUrl: "https://rpc.test", fetchImpl: impl });
    const batched = calls.filter((c) => c.method === "state_queryStorageAt");
    const enabledBatches = batched.filter((c) =>
      (c.params[0] as string[])[0]?.startsWith(SUBNET_EMISSION_ENABLED_PREFIX),
    );
    assert.equal(enabledBatches.length, 2);
    assert.equal((enabledBatches[0]!.params[0] as string[]).length, 200);
    assert.equal((enabledBatches[1]!.params[0] as string[]).length, 1);
  });

  test("a key the node omits from `changes` reads as unset, not as missing", async () => {
    // The node is entitled to answer with fewer pairs than were asked for.
    // Those keys are UNSET, which is a real reading — dropping them would let
    // an absent subnet look like one that was never queried.
    const { impl } = rpcFetch((m, p) =>
      m === "state_queryStorageAt" ? [{ changes: [] }] : healthyAnswer(m, p),
    );
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(sample.current.block_emission_halvings, null);
    // null !== "0x00", so an unset enablement still reads as enabled.
    assert.deepEqual(sample.current_enabled, [[7, true]]);
    assert.deepEqual(sample.current_ema, [[7, null]]);
  });

  test("a null or page-less batch result degrades rather than throwing", async () => {
    for (const result of [null, [], [{}]]) {
      const { impl } = rpcFetch((m, p) =>
        m === "state_queryStorageAt" ? result : healthyAnswer(m, p),
      );
      const sample = await sampleEmissionGate({
        rpcUrl: "https://rpc.test",
        fetchImpl: impl,
      });
      assert.equal(sample.current.emission_gate_bar, null);
    }
  });

  test("gate params decode through the u64f64 path when present", async () => {
    // 1.0 in U64F64: integer part 1 in the high 64 bits -> LE u128 hex.
    const oneU64F64 = "0x" + "00".repeat(8) + "01" + "00".repeat(7);
    const { impl } = rpcFetch(
      answerWith({ [EMISSION_GATE_BAR_STORAGE_KEY]: oneU64F64 }),
    );
    const sample = await sampleEmissionGate({
      rpcUrl: "https://rpc.test",
      fetchImpl: impl,
    });
    assert.equal(sample.current.emission_gate_bar, 1);
  });
});

describe("rotating the archive pool", () => {
  test("both declared endpoints serve ARCHIVE state", () => {
    // The lite and entrypoint endpoints prune, and a pruned node cannot answer
    // a finalized-block read that is more than a few blocks old.
    assert.deepEqual(EMISSION_SAMPLER_ARCHIVE_URLS, [
      "https://archive.chain.opentensor.ai",
      "https://bittensor-finney.api.onfinality.io/public",
    ]);
  });

  test("the offset picks the endpoint, so consecutive ticks alternate", async () => {
    // One sample is a dozen fetches to the SAME endpoint, so what is asserted
    // is the endpoint each sample ran on -- not the call count.
    const perSample: string[] = [];
    async function runAt(offset: number) {
      const seen = new Set<string>();
      const impl = (async (url: string, init?: RequestInit) => {
        seen.add(String(url));
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method: string;
          params: unknown[];
        };
        return {
          ok: true,
          json: async () => ({
            result: healthyAnswer(body.method, body.params),
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      await sampleEmissionGateWithFailover({ offset, fetchImpl: impl });
      assert.equal(seen.size, 1, "a sample must not split across endpoints");
      perSample.push([...seen][0]!);
    }
    for (const offset of [0, 1, 2, 3]) await runAt(offset);
    assert.deepEqual(perSample, [
      EMISSION_SAMPLER_ARCHIVE_URLS[0],
      EMISSION_SAMPLER_ARCHIVE_URLS[1],
      EMISSION_SAMPLER_ARCHIVE_URLS[0],
      EMISSION_SAMPLER_ARCHIVE_URLS[1],
    ]);
  });

  test("a failing endpoint fails the WHOLE sample over, not one call", async () => {
    // Completing a half-sample from one node against another is the split this
    // lane exists to stop making.
    const seen: string[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const host = String(url);
      seen.push(host);
      if (host === EMISSION_SAMPLER_ARCHIVE_URLS[0]) {
        throw new Error("archive unreachable");
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params: unknown[];
      };
      return {
        ok: true,
        json: async () => ({
          result: healthyAnswer(body.method, body.params),
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sample = await sampleEmissionGateWithFailover({
      offset: 0,
      fetchImpl: impl,
    });
    assert.equal(sample.block_number, 0x85a1c8);
    assert.equal(seen[0], EMISSION_SAMPLER_ARCHIVE_URLS[0], "tried first");
    assert.ok(
      seen.slice(1).every((u) => u === EMISSION_SAMPLER_ARCHIVE_URLS[1]),
      "every call after the failover ran on the SECOND endpoint",
    );
  });

  test("all endpoints failing throws the LAST reason, not a generic one", async () => {
    // A lane reporting a generic failure over a specific one is how #10742 hid
    // behind a stale issue title for a week.
    const impl = (async (url: string) => {
      throw new Error(
        `down: ${String(url).includes("onfinality") ? "b" : "a"}`,
      );
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGateWithFailover({ offset: 0, fetchImpl: impl }),
      /down: b/,
    );
  });

  test("an explicit override runs alone, with no failover", async () => {
    const used: string[] = [];
    const impl = (async (url: string) => {
      used.push(String(url));
      throw new Error("nope");
    }) as unknown as typeof fetch;
    await assert.rejects(() =>
      sampleEmissionGateWithFailover({
        urls: ["https://operator.example"],
        fetchImpl: impl,
      }),
    );
    assert.deepEqual(used, ["https://operator.example"]);
  });
});

describe("the cron branch", () => {
  test("no sync secret declines before any chain read", async () => {
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const out = (await handleScheduled(
        { cron: EMISSION_GATE_SAMPLE_CRON } as unknown as ScheduledController,
        {} as unknown as Parameters<typeof handleScheduled>[1],
        { waitUntil: () => {} } as unknown as ExecutionContext,
      )) as { ok: boolean; skipped?: boolean; reason?: string };
      assert.equal(out.ok, false);
      assert.equal(out.skipped, true);
      assert.equal(fetched, 0, "a lane that cannot persist must not read");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an operator's override runs alone; otherwise the pool rotates", async () => {
    // The branch's own decision, asserted through the URLs the sample reaches.
    const original = globalThis.fetch;
    async function hostsFor(env: Record<string, unknown>) {
      const seen = new Set<string>();
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("internal.metagraph.sh")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        seen.add(new URL(href).origin);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          method: string;
          params: unknown[];
        };
        return new Response(
          JSON.stringify({ result: healthyAnswer(body.method, body.params) }),
        );
      }) as typeof fetch;
      await handleScheduled(
        { cron: EMISSION_GATE_SAMPLE_CRON } as unknown as ScheduledController,
        { EMISSION_GATE_SYNC_SECRET: "s", ...env } as never,
        { waitUntil: () => {} } as unknown as ExecutionContext,
      ).catch(() => {});
      return [...seen];
    }
    try {
      assert.deepEqual(
        await hostsFor({
          EMISSION_SAMPLER_RPC_URL: "https://operator.example",
        }),
        ["https://operator.example"],
        "an explicit endpoint means THAT endpoint",
      );
      const rotated = await hostsFor({});
      assert.equal(rotated.length, 1, "one sample, one endpoint");
      assert.ok(
        (EMISSION_SAMPLER_ARCHIVE_URLS as readonly string[]).some((u) =>
          u.startsWith(rotated[0]!),
        ),
        "absent an override it comes from the archive pool",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the interval is the cron's cadence, which is what rotates the pool", () => {
    // A wrong constant here would not fail anything loudly -- it would just
    // stop alternating, and quietly pin every sample to one endpoint.
    assert.equal(EMISSION_GATE_SAMPLE_INTERVAL_MS, 10 * 60 * 1000);
    assert.equal(EMISSION_GATE_SAMPLE_CRON, "3,13,23,33,43,53 * * * *");
  });

  test("a non-Error thrown by every endpoint still yields an Error", async () => {
    const impl = (async () => {
      throw "a bare string";
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => sampleEmissionGateWithFailover({ offset: 0, fetchImpl: impl }),
      /failed on all 2 endpoint\(s\)/,
    );
  });
});
