// src/market-cap-index.ts (#9526) — the chain-level alpha_market_cap_tao index
// that gives get_chain_alpha_volume's vol_mcap_ratio a denominator.
//
// The contract under test is deliberately forgiving in one direction and strict
// in the other: a tier that cannot answer costs a null ratio (an empty index),
// never a thrown read, because the leaderboard is useful without the ratio and
// useless if the request fails. But an unusable denominator is DROPPED rather
// than stored — a zero or negative market cap would otherwise be divided by.
import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { resolveMarketCapIndex } from "../src/market-cap-index.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";

type Row = Record<string, unknown>;

// resolveLiveEconomics accepts the blob only when it is on-contract, fresh, and
// internally consistent (row count matches the summary, emission_share sums to
// ~1). Build one that passes all three so the live tier is genuinely exercised
// rather than silently falling through to the artifact.
function liveBlob(subnets: Row[], contract: string) {
  return {
    contract_version: contract,
    captured_at: new Date().toISOString(),
    subnet_count: subnets.length,
    subnets,
  };
}

function subnet(netuid: number, marketCap: unknown, share: number): Row {
  return {
    netuid,
    alpha_market_cap_tao: marketCap,
    emission_share: share,
  };
}

let kvStore: Map<string, unknown>;
let artifactBody: Row | null;
let artifactOk: boolean;

function env() {
  return {
    METAGRAPH_CONTRACT_VERSION: "v1",
    // readHealthKv reads METAGRAPH_CONTROL with { type: "json" }, so the
    // binding hands back a parsed object, not text.
    METAGRAPH_CONTROL: {
      async get(key: string) {
        const value = kvStore.get(key);
        return value === undefined ? null : value;
      },
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        if (!artifactOk) return null;
        return { json: async () => artifactBody };
      },
    },
  } as unknown as Env;
}

beforeEach(() => {
  kvStore = new Map();
  artifactBody = null;
  artifactOk = false;
});

test("returns an empty index when there is no env at all", async () => {
  const index = await resolveMarketCapIndex(null);
  assert.equal(index.size, 0);
  assert.equal(index.get(1), undefined);
});

test("indexes every usable alpha_market_cap_tao from the live KV tier", async () => {
  kvStore.set(
    KV_ECONOMICS_CURRENT,
    liveBlob([subnet(1, 1000, 0.5), subnet(2, 250.5, 0.5)], "v1"),
  );
  const index = await resolveMarketCapIndex(env());
  assert.equal(index.get(1), 1000);
  assert.equal(index.get(2), 250.5);
  assert.equal(index.size, 2);
});

// Each of these would divide into a wrong or infinite ratio, so the key is left
// absent — vol_mcap_ratio's own guard then renders it null, which is the honest
// "no denominator" answer rather than a fabricated number.
test("drops rows whose market cap cannot be a denominator", async () => {
  kvStore.set(
    KV_ECONOMICS_CURRENT,
    liveBlob(
      [
        subnet(1, 0, 0.2), // zero
        subnet(2, -5, 0.2), // negative
        subnet(3, null, 0.2), // absent
        subnet(4, "1000", 0.2), // string, not a number
        subnet(5, Number.NaN, 0.1),
        subnet(6, 42, 0.1), // the only usable one
      ],
      "v1",
    ),
  );
  const index = await resolveMarketCapIndex(env());
  assert.deepEqual([...index.entries()], [[6, 42]]);
});

test("drops rows whose netuid is not a non-negative integer", async () => {
  kvStore.set(
    KV_ECONOMICS_CURRENT,
    liveBlob(
      [
        { netuid: -1, alpha_market_cap_tao: 10, emission_share: 0.25 },
        { netuid: 1.5, alpha_market_cap_tao: 10, emission_share: 0.25 },
        { netuid: "x", alpha_market_cap_tao: 10, emission_share: 0.25 },
        { netuid: 0, alpha_market_cap_tao: 10, emission_share: 0.25 },
      ],
      "v1",
    ),
  );
  const index = await resolveMarketCapIndex(env());
  // netuid 0 is root and a legitimate key — the guard is >= 0, not > 0.
  assert.deepEqual([...index.entries()], [[0, 10]]);
});

test("falls back to the R2 economics artifact when the live tier is off-contract", async () => {
  // A blob written under an older contract: resolveLiveEconomics declines it.
  kvStore.set(
    KV_ECONOMICS_CURRENT,
    liveBlob([subnet(1, 999, 1)], "v0-stale-contract"),
  );
  artifactOk = true;
  artifactBody = { subnets: [subnet(7, 777, 1)] };
  const index = await resolveMarketCapIndex(env());
  assert.equal(index.get(7), 777);
  assert.equal(
    index.get(1),
    undefined,
    "the off-contract KV blob must not win",
  );
});

test("falls back to the artifact when the live tier has no usable rows", async () => {
  kvStore.set(KV_ECONOMICS_CURRENT, liveBlob([subnet(1, 0, 1)], "v1"));
  artifactOk = true;
  artifactBody = { subnets: [subnet(3, 33, 1)] };
  const index = await resolveMarketCapIndex(env());
  assert.deepEqual([...index.entries()], [[3, 33]]);
});

test("returns an empty index when neither tier answers", async () => {
  artifactOk = false;
  const index = await resolveMarketCapIndex(env());
  assert.equal(index.size, 0);
});

test("returns an empty index when the artifact body has no subnets array", async () => {
  artifactOk = true;
  artifactBody = { subnets: "not-an-array" } as unknown as Row;
  const index = await resolveMarketCapIndex(env());
  assert.equal(index.size, 0);
});

// The leaderboard is worth serving without a ratio and worthless if the request
// throws, so a store that blows up degrades to "no denominator".
test("swallows a throwing store rather than failing the leaderboard", async () => {
  const throwing = {
    METAGRAPH_CONTRACT_VERSION: "v1",
    METAGRAPH_CONTROL: {
      async get() {
        throw new Error("kv exploded");
      },
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        throw new Error("r2 exploded");
      },
    },
  } as unknown as Env;
  const index = await resolveMarketCapIndex(throwing);
  assert.equal(index.size, 0);
});
