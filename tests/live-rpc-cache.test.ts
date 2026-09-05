import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  liveRpcFailureCacheKey,
  readLiveRpcCache,
  writeLiveRpcCache,
} from "../src/live-rpc-cache.ts";
import { loadAccountBalance } from "../src/account-balance.ts";
import { loadAccountRootClaim } from "../src/account-root-claim.ts";
import { loadAddressMapping } from "../src/address-mapping.ts";
import { loadChainBurn } from "../src/chain-burn.ts";
import {
  loadAccountChildren,
  loadAccountParents,
} from "../src/child-hotkey-delegation.ts";
import { loadCrowdloan } from "../src/crowdloans.ts";
import {
  loadNetworkParameters,
  readCachedNetworkParametersSnapshot,
} from "../src/network-parameters.ts";
import { loadRandomnessStatus } from "../src/randomness.ts";
import { loadSubnetBurn } from "../src/subnet-burn.ts";
import { loadSubnetLease } from "../src/subnet-lease.ts";
import { loadSubnetConvictionChainTier } from "../src/subnet-lock-state.ts";
import { loadSubnetRecycled } from "../src/subnet-recycled.ts";
import { loadSudoKey } from "../src/sudo-key.ts";
import { loadUpgradeRadar } from "../src/upgrade-radar.ts";
import { mergeFreshness } from "../src/health-serving.ts";
import { mockEnv } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const START = Date.parse("2026-09-05T10:00:00Z");

// Faithful to KV's expiry floor and physical deletion, without pretending to
// model worldwide propagation. Rejected writes do not enter the store.
function providerKv() {
  const records = new Map<string, { value: string; expiresAt: number }>();
  const writes: { key: string; ttl: number; value: unknown }[] = [];
  return {
    records,
    writes,
    async get(key: string) {
      const record = records.get(key);
      if (!record || record.expiresAt <= Date.now()) return null;
      return JSON.parse(record.value);
    },
    async put(key: string, value: string, options: { expirationTtl: number }) {
      assert.ok(options.expirationTtl >= 60, "KV requires at least 60 seconds");
      writes.push({
        key,
        ttl: options.expirationTtl,
        value: JSON.parse(value),
      });
      records.set(key, {
        value,
        expiresAt: Date.now() + options.expirationTtl * 1000,
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("provider stub rejects the inherited invalid persistence options", async () => {
  const kv = providerKv();
  for (const expirationTtl of [10, 30]) {
    await assert.rejects(kv.put("key", "{}", { expirationTtl }));
  }
  assert.equal(kv.records.size, 0);
});

test.each([10, 30])(
  "%is failures persist for 60s but stop suppressing retries at the logical boundary",
  async (ttlSeconds) => {
    const kv = providerKv();
    const payload = {
      queried_at: new Date().toISOString(),
      count: null,
      reason: "unavailable",
    };
    await writeLiveRpcCache(kv, "finney:item", payload, {
      ttlSeconds,
      negative: true,
    });
    assert.equal(kv.writes[0].ttl, 60);
    assert.equal(kv.records.has("finney:item"), false);
    vi.setSystemTime(START + ttlSeconds * 1000 - 1);
    assert.deepEqual(await readLiveRpcCache(kv, "finney:item"), payload);
    vi.setSystemTime(START + ttlSeconds * 1000);
    assert.equal(await readLiveRpcCache(kv, "finney:item"), null);
    assert.ok(
      await kv.get(liveRpcFailureCacheKey("finney:item")),
      "physical record still exists",
    );
    vi.setSystemTime(START + 60_000);
    assert.equal(await kv.get(liveRpcFailureCacheKey("finney:item")), null);
  },
);

test("a delayed failure cannot overwrite a recovered success, including a measured zero", async () => {
  const kv = providerKv();
  const failure = { value: null, queried_at: new Date().toISOString() };
  await writeLiveRpcCache(kv, "item", failure, {
    ttlSeconds: 10,
    negative: true,
  });
  vi.setSystemTime(START + 10_000);
  const recovered = { value: 0, queried_at: new Date().toISOString() };
  await writeLiveRpcCache(kv, "item", recovered, {
    ttlSeconds: 120,
    negative: false,
  });
  vi.setSystemTime(START + 11_000);
  await writeLiveRpcCache(kv, "item", failure, {
    ttlSeconds: 10,
    negative: true,
  });
  assert.deepEqual(await readLiveRpcCache(kv, "item"), recovered);
  assert.deepEqual(
    await kv.get("item"),
    recovered,
    "success retains the legacy storage shape",
  );
  assert.equal(kv.writes[1].ttl, 120);
});

test("short positive observations expire logically without becoming a failure", async () => {
  const kv = providerKv();
  await writeLiveRpcCache(
    kv,
    "randomness:v2",
    { round: 42 },
    { ttlSeconds: 30, negative: false },
  );
  assert.equal(kv.writes[0].key, "randomness:v2");
  assert.equal(kv.writes[0].ttl, 60);
  vi.setSystemTime(START + 29_999);
  assert.deepEqual(await readLiveRpcCache(kv, "randomness:v2"), { round: 42 });
  vi.setSystemTime(START + 30_000);
  assert.equal(await readLiveRpcCache(kv, "randomness:v2"), null);
});

test.each([
  null,
  "invalid",
  42,
  {},
  { live_rpc_cache_version: 2, expires_at_ms: START + 10_000, value: {} },
  { live_rpc_cache_version: 1, expires_at_ms: "later", value: {} },
  { live_rpc_cache_version: 1, expires_at_ms: START, value: {} },
  { live_rpc_cache_version: 1, expires_at_ms: START + 10_000 },
  { live_rpc_cache_version: 1, expires_at_ms: START + 10_000, value: null },
  {
    live_rpc_cache_version: 1,
    expires_at_ms: START + 10_000,
    value: "invalid",
  },
  { live_rpc_cache_version: 1, expires_at_ms: START + 10_000, value: [] },
])("an unreadable or expired failure %j is a cache miss", async (value) => {
  const kv = providerKv();
  await kv.put(liveRpcFailureCacheKey("item"), JSON.stringify(value), {
    expirationTtl: 60,
  });
  assert.equal(await readLiveRpcCache(kv, "item"), null);
});

test("runtime predicates reject old positive observations and incompatible failures", async () => {
  const kv = providerKv();
  await writeLiveRpcCache(
    kv,
    "root",
    { runtime: 440 },
    { ttlSeconds: 120, negative: false },
  );
  await writeLiveRpcCache(
    kv,
    "root",
    { runtime: 454 },
    { ttlSeconds: 10, negative: true },
  );
  assert.deepEqual(
    await readLiveRpcCache(
      kv,
      "root",
      (value: { runtime: number }) => value.runtime === 454,
    ),
    { runtime: 454 },
  );
  assert.equal(
    await readLiveRpcCache(
      kv,
      "root",
      (value: { runtime: number }) => value.runtime === 455,
    ),
    null,
  );
});

test("unreadable storage still reaches the reader's existing non-fatal fallback", async () => {
  const kv = providerKv();
  const fetchSpy = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
  kv.records.set(`balance:${SS58}`, {
    value: "not json",
    expiresAt: START + 60_000,
  });
  const env = mockEnv({
    METAGRAPH_CONTROL: {
      ...kv,
      put: async () => {
        throw new Error("write unavailable");
      },
    },
  });
  assert.equal((await loadAccountBalance(env, SS58)).balance_tao, null);
  assert.equal(fetchSpy.mock.calls.length, 1);
});

const readers: {
  name: string;
  load: (env: Env) => Promise<unknown>;
  ttl: number;
  requiredRpc?: number;
}[] = [
  { name: "balance", load: (env) => loadAccountBalance(env, SS58), ttl: 10 },
  {
    name: "root claim",
    load: (env) => loadAccountRootClaim(env, SS58),
    ttl: 10,
    requiredRpc: 1,
  },
  {
    name: "mapping",
    load: (env) => loadAddressMapping(env, `0x${"12".repeat(20)}`),
    ttl: 10,
  },
  { name: "chain burn", load: (env) => loadChainBurn(env), ttl: 10 },
  { name: "children", load: (env) => loadAccountChildren(env, SS58), ttl: 10 },
  { name: "parents", load: (env) => loadAccountParents(env, SS58), ttl: 10 },
  { name: "crowdloan detail", load: (env) => loadCrowdloan(env, 1), ttl: 10 },
  {
    name: "network parameters",
    load: (env) => loadNetworkParameters(env),
    ttl: 10,
  },
  { name: "randomness", load: (env) => loadRandomnessStatus(env), ttl: 10 },
  { name: "subnet burn", load: (env) => loadSubnetBurn(env, 1), ttl: 10 },
  { name: "lease", load: (env) => loadSubnetLease(env, 1), ttl: 10 },
  {
    name: "conviction",
    load: (env) =>
      loadSubnetConvictionChainTier(1, { kv: env.METAGRAPH_CONTROL }),
    ttl: 10,
  },
  { name: "recycled", load: (env) => loadSubnetRecycled(env, 1), ttl: 10 },
  { name: "sudo", load: (env) => loadSudoKey(env), ttl: 10 },
  { name: "upgrade radar", load: (env) => loadUpgradeRadar(env), ttl: 30 },
];

test.each(readers)(
  "$name preserves the failure payload and retries after $ttl seconds",
  async ({ load, ttl, requiredRpc = 0 }) => {
    const kv = providerKv();
    const env = mockEnv({ METAGRAPH_CONTROL: kv });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);
    const original = await load(env);
    assert.equal(kv.writes.length, 1);
    assert.equal(kv.writes[0].ttl, 60);
    assert.ok(kv.writes[0].key.endsWith(":failure:v1"));
    const firstRpcCount = fetchSpy.mock.calls.length;
    vi.setSystemTime(START + ttl * 1000 - 1);
    assert.deepEqual(
      await load(env),
      original,
      "cached failure retains timestamps, nulls, and reasons",
    );
    assert.equal(
      kv.writes.length,
      1,
      "reading never renews the logical expiry",
    );
    assert.equal(fetchSpy.mock.calls.length, firstRpcCount + requiredRpc);
    vi.setSystemTime(START + ttl * 1000);
    await load(env);
    assert.equal(
      kv.writes.length,
      2,
      "logical expiry permits another observation before KV deletion",
    );
    assert.ok(fetchSpy.mock.calls.length > firstRpcCount + requiredRpc);
  },
);

test("network isolation and passive freshness cannot turn failed reads into current observations", async () => {
  const kv = providerKv();
  const env = mockEnv({ METAGRAPH_CONTROL: kv });
  const fetchSpy = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
  const finney = await loadNetworkParameters(env);
  const calls = fetchSpy.mock.calls.length;
  const cached = await readCachedNetworkParametersSnapshot(env);
  const cachedQueriedAt = cached?.queried_at;
  assert.equal(cached, null);
  assert.equal(finney.queried_at, new Date().toISOString());
  const freshness = mergeFreshness(
    { sources: [] },
    { last_run_at: new Date().toISOString() },
    { parametersQueriedAt: cachedQueriedAt, now: Date.now() },
  );
  const sources = freshness?.sources;
  assert.ok(Array.isArray(sources));
  assert.equal(
    sources.find((source: { id: string }) => source.id === "chain-parameters")
      .status,
    "missing",
  );
  assert.equal(await readCachedNetworkParametersSnapshot(env, "testnet"), null);
  vi.setSystemTime(START + 10_000);
  assert.equal(await readCachedNetworkParametersSnapshot(env), null);
  assert.equal(
    fetchSpy.mock.calls.length,
    calls,
    "freshness inspection cannot refresh its own source",
  );
});

test("the balance reader recovers to a real zero immediately after its failure expires", async () => {
  const kv = providerKv();
  const env = mockEnv({ METAGRAPH_CONTROL: kv });
  const fetchSpy = vi.fn(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
  const failure = await loadAccountBalance(env, SS58);
  assert.equal(failure.balance_tao, null);
  vi.setSystemTime(START + 10_000);
  fetchSpy.mockImplementation(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: null }),
  );
  const success = await loadAccountBalance(env, SS58);
  assert.equal(success.balance_tao, 0);
  assert.notEqual(success.queried_at, failure.queried_at);
  assert.deepEqual(await loadAccountBalance(env, SS58), success);
  assert.equal(fetchSpy.mock.calls.length, 2);
});
