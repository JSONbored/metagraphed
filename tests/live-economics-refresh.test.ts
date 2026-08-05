// The live-economics refresh cron: the writer for KV `economics:current`.
//
// The gravity of this suite is the KV-shadows-R2 trap. resolveLiveEconomics
// prefers this blob over the published R2 artifact and never inspects a
// per-subnet field, so a dropped key does not fall back -- it deletes the
// field from the API. So the shape assertions here are held against two
// independent references, neither of them hand-written: the artifact builder
// the R2 tier is built with (scripts/lib/economics-artifacts.ts) and the
// published contract itself (schemas-src/shared.ts's `.strict()`
// SubnetEconomicsSchema / ChainStateSchema).
//
// The synthetic chain below carries real finney readings for netuid 64,
// captured 2026-08-03 -- which is why the decoded expectations are checkable
// against what /api/v1/economics served that day (owner_coldkey
// 5FRYKhbm..., owner_hotkey 5CS3g6nV..., registration_cost_tao 0.0005).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import emissionFixture from "./fixtures/emission-pipeline.json" with { type: "json" };
import {
  ECONOMICS_STORAGE_MAPS,
  ECONOMICS_STORAGE_VALUES,
  LIVE_ECONOMICS_DEFAULT_RPC_URL,
  LIVE_ECONOMICS_SUBNETS_ARTIFACT_PATH,
  NEURON_AGGREGATE_QUERY,
  buildSubnetEconomics,
  decodeAccountId,
  decodeLeUintNumber,
  decodeMovingPrice,
  decodeOptionalBool,
  decodeRaoTao,
  indexNeuronAggregates,
  raoToTao,
  refreshLiveEconomics,
  subnetHasChainData,
} from "../src/live-economics-refresh.ts";
import { buildEconomicsArtifact } from "../scripts/lib/economics-artifacts.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import {
  ChainStateSchema,
  SubnetEconomicsSchema,
} from "../schemas-src/shared.ts";

type Row = Record<string, unknown>;
type MapName = keyof typeof ECONOMICS_STORAGE_MAPS;

const PREFIX = "658faa385070e074c85bf6b568cf0555";
const BLOCK_NUMBER = 8_755_519;
const BLOCK_HASH =
  "0x8f20593270a781885ff658dcfd7de24eb0642363128b4d9204cba1bca02af3c7";

function leHex(value: bigint, byteLen: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < byteLen; i += 1) {
    out += Number(rest & 0xffn)
      .toString(16)
      .padStart(2, "0");
    rest >>= 8n;
  }
  return `0x${out}`;
}

const u16 = (n: number) => leHex(BigInt(n), 2);
const u64 = (n: bigint) => leHex(n, 8);
const u128 = (n: bigint) => leHex(n, 16);

/** Real finney readings for netuid 64 (2026-08-03). */
const NETUID_64: Partial<Record<MapName, string>> = {
  alpha_in_pool: u64(2_571_457_878_769_909n),
  alpha_out_pool: u64(3_256_908_869_542_092n),
  tao_in_pool: u64(217_944_967_412_489n),
  subnet_volume: u128(4_853_018_550_832_965n),
  max_uids: u16(256),
  max_validators: u16(64),
  owner_coldkey:
    "0x9498c2810274290765e5f04a1fbbae1fec9f152c5b1d5bf702606deddafa3626",
  owner_hotkey:
    "0x1046ddb9e982f422f9f020aa3f624ef74e9f5aa95b0ecbec5737640f36ee7c34",
  registration_cost: u64(500_000n),
  moving_price: u128(360_101_426n),
  registration_allowed: "0x01",
  miner_burned: u128(1n << 31n), // U96F32 -> exactly 0.5
  emission_enabled: "0x01",
  subtoken_enabled: "0x01",
  first_emission_block: u64(5_228_683n),
  tao_in_emission: u64(12_211_623n),
  excess_tao: u64(52_742_366n),
  alpha_in_emission: u64(144_080_821n),
  alpha_out_emission: u64(1_000_000_000n),
};

/**
 * A subnet the chain answers only ONE item for. Exercises every "absent"
 * default in one row: the true-by-default emission flag, the false-by-default
 * registration/subtoken flags, the null pools and owners, the zeroed emission
 * channels, and max_uids falling back to 0.
 */
const NETUID_9: Partial<Record<MapName, string>> = { tao_in_pool: u64(7n) };

interface ChainState {
  maps: Partial<Record<MapName, Record<number, string>>>;
  values: Partial<Record<keyof typeof ECONOMICS_STORAGE_VALUES, string | null>>;
  header?: unknown;
}

function defaultChain(): ChainState {
  const maps: ChainState["maps"] = {};
  for (const name of Object.keys(ECONOMICS_STORAGE_MAPS) as MapName[]) {
    const entries: Record<number, string> = {};
    if (NETUID_64[name] !== undefined) entries[64] = NETUID_64[name]!;
    if (NETUID_9[name] !== undefined) entries[9] = NETUID_9[name]!;
    maps[name] = entries;
  }
  return {
    maps,
    values: {
      total_issuance: u64(11_189_382_031_409_947n),
      // theta and q as U64F64 words: 0.75 is exactly representable.
      emission_gate_bar: u128((1n << 64n) / 100n),
      emission_bar_quantile: u128((3n * (1n << 64n)) / 4n),
      emission_gate_exponent: null,
    },
  };
}

interface RpcCall {
  method: string;
  params: unknown[];
}

/** A fake chain RPC over a ChainState, recording every call. */
function chainFetch(chain: ChainState): {
  impl: typeof fetch;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const mapByHash = new Map<string, Record<number, string>>(
    (Object.keys(ECONOMICS_STORAGE_MAPS) as MapName[]).map((name) => [
      ECONOMICS_STORAGE_MAPS[name],
      chain.maps[name] ?? {},
    ]),
  );
  const valueByHash = new Map<string, string | null>(
    Object.entries(ECONOMICS_STORAGE_VALUES).map(([name, hash]) => [
      hash,
      chain.values[name as keyof typeof ECONOMICS_STORAGE_VALUES] ?? null,
    ]),
  );
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as RpcCall;
    calls.push({ method: body.method, params: body.params });
    let result: unknown;
    if (body.method === "chain_getHeader") {
      result = chain.header ?? { number: `0x${BLOCK_NUMBER.toString(16)}` };
    } else if (body.method === "chain_getBlockHash") {
      result = BLOCK_HASH;
    } else if (body.method === "state_queryStorageAt") {
      const keys = body.params[0] as string[];
      result = [
        {
          changes: keys.map((key) => {
            const itemHash = key.slice(2 + PREFIX.length, -4);
            const suffix = key.slice(-4);
            const netuid =
              Number.parseInt(suffix.slice(0, 2), 16) +
              Number.parseInt(suffix.slice(2, 4), 16) * 256;
            return [key, mapByHash.get(itemHash)?.[netuid] ?? null];
          }),
        },
      ];
    } else if (body.method === "state_getStorage") {
      result =
        valueByHash.get((body.params[0] as string).slice(2 + PREFIX.length)) ??
        null;
    } else {
      throw new Error(`unexpected method ${body.method}`);
    }
    return {
      ok: true,
      json: async () => ({ result }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// The published index's `block` is the last registry publish's bulk-call
// height, which is a DIFFERENT and older instant than the block this sweep pins
// -- on the live tier the two were 7206 blocks apart. It is deliberately not
// BLOCK_NUMBER here: setting them equal is what let the row inherit the index's
// stale height without any test noticing.
const INDEX_STALE_BLOCK = BLOCK_NUMBER - 7_206;

const SUBNETS_INDEX = {
  network: "finney",
  subnets: [
    { netuid: 64, slug: "sn-64", name: "Chutes", block: INDEX_STALE_BLOCK },
    {
      netuid: 9,
      slug: "sn-9",
      name: "Pretraining",
      block: INDEX_STALE_BLOCK,
    },
  ],
};

const NEURON_ROWS = [
  {
    netuid: 64,
    uid_count: 256,
    validator_count: 21,
    total_stake_alpha: 3_895_629.026,
    max_stake_alpha: 2_114_915.958,
  },
];

const HISTORY_ROWS = [
  { netuid: 64, snapshot_date: "2026-08-01", alpha_price_tao: 0.08 },
  { netuid: 64, snapshot_date: "2026-08-03", alpha_price_tao: 0.09 },
];

interface HarnessOptions {
  index?: unknown;
  indexOk?: boolean;
  neuronRows?: Row[] | null;
  historyRows?: Row[] | null;
  d1Result?: null;
  kv?: boolean;
  db?: boolean;
  env?: Row;
}

function harness(options: HarnessOptions = {}) {
  const puts: { key: string; value: string }[] = [];
  const queries: string[] = [];
  const env: Row = {
    ...(options.kv === false
      ? {}
      : {
          METAGRAPH_CONTROL: {
            put: async (key: string, value: string) => {
              puts.push({ key, value });
            },
          },
        }),
    ...(options.db === false
      ? {}
      : {
          METAGRAPH_HEALTH_DB: {
            prepare(sql: string) {
              queries.push(sql);
              return {
                all: async () => {
                  if (options.d1Result === null) return null;
                  if (sql === NEURON_AGGREGATE_QUERY) {
                    return {
                      results:
                        "neuronRows" in options
                          ? options.neuronRows
                          : NEURON_ROWS,
                    };
                  }
                  return {
                    results:
                      "historyRows" in options
                        ? options.historyRows
                        : HISTORY_ROWS,
                  };
                },
              };
            },
          },
        }),
    ...(options.env ?? {}),
  };
  const readArtifact = async (_env: Env, path: string) => {
    assert.equal(path, LIVE_ECONOMICS_SUBNETS_ARTIFACT_PATH);
    return {
      ok: options.indexOk !== false,
      data: "index" in options ? options.index : SUBNETS_INDEX,
    } as never;
  };
  return { env: env as unknown as Env, readArtifact, puts, queries };
}

const NOW = () => Date.parse("2026-08-03T07:35:48.000Z");

describe("live-economics storage item digests", () => {
  test("every item the emission harness also reads uses the SAME digest", () => {
    // The two lanes read the same pallet items at the same pinned block. A
    // digest that drifted here would silently read a different storage item
    // and publish it under the same field name.
    const shared = emissionFixture.item_hashes as Record<string, string>;
    for (const [name, hash] of Object.entries({
      ...ECONOMICS_STORAGE_MAPS,
      ...ECONOMICS_STORAGE_VALUES,
    })) {
      if (shared[name] === undefined) continue;
      assert.equal(hash, shared[name], `digest drift for ${name}`);
    }
    // Guard against the check passing vacuously if the fixture is renamed.
    const overlap = Object.keys({
      ...ECONOMICS_STORAGE_MAPS,
      ...ECONOMICS_STORAGE_VALUES,
    }).filter((name) => shared[name] !== undefined);
    assert.equal(overlap.length, 12);
  });

  test("every digest is a distinct 32-hex item hash", () => {
    const all = Object.values({
      ...ECONOMICS_STORAGE_MAPS,
      ...ECONOMICS_STORAGE_VALUES,
    });
    for (const hash of all) assert.match(hash, /^[0-9a-f]{32}$/);
    assert.equal(new Set(all).size, all.length);
  });
});

describe("live-economics cron wiring", () => {
  test("the cron constant matches a wrangler schedule", async () => {
    // A constant with no matching wrangler entry never fires at all, and a
    // wrangler entry with no matching constant falls through to the health
    // prober. Both are silent.
    const { readFileSync } = await import("node:fs");
    const { LIVE_ECONOMICS_REFRESH_CRON } =
      await import("../workers/config.ts");
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    assert.ok(
      wrangler.includes(`"${LIVE_ECONOMICS_REFRESH_CRON}"`),
      `wrangler.jsonc declares no "${LIVE_ECONOMICS_REFRESH_CRON}" cron, so the live economics tier never refreshes`,
    );
  });

  test("refresh-economics.yml keeps workflow_dispatch and drops its schedule", async () => {
    // The manual fallback has to survive the move: it is the path to reach for
    // when the cron itself is what is under suspicion.
    const { readFileSync } = await import("node:fs");
    const workflow = readFileSync(
      ".github/workflows/refresh-economics.yml",
      "utf8",
    );
    assert.match(workflow, /workflow_dispatch: \{\}/);
    assert.doesNotMatch(workflow, /^\s+schedule:/m);
    assert.match(workflow, /LIVE_ECONOMICS_REFRESH_CRON/);
  });
});

describe("live-economics decoders", () => {
  test("raoToTao stays exact past the double ceiling", () => {
    assert.equal(raoToTao(1_500_000_000n), 1.5);
    assert.equal(raoToTao(0n), 0);
    // 341,897,675 TAO -- 38x over the 2^53-1 rao ceiling a naive divide loses.
    assert.equal(raoToTao(341_897_675_806_350_302n), 341897675.8063503);
  });

  test("decodeRaoTao distinguishes an unknown pool from a measured zero", () => {
    assert.equal(decodeRaoTao(u64(500_000n)), 0.0005);
    assert.equal(decodeRaoTao(undefined), null);
    assert.equal(decodeRaoTao(undefined, true), 0);
    assert.equal(decodeRaoTao("0x00", true), 0);
  });

  test("decodeLeUintNumber rejects short, unprefixed and non-hex words", () => {
    assert.equal(decodeLeUintNumber(u16(256), 2), 256);
    assert.equal(decodeLeUintNumber("0x00", 2), null);
    assert.equal(decodeLeUintNumber("0001", 2), null);
    assert.equal(decodeLeUintNumber(undefined, 2), null);
    assert.equal(decodeLeUintNumber("0xzzzz", 2), null);
  });

  test("decodeOptionalBool treats ABSENCE as the item's own default", () => {
    // SubnetEmissionEnabled defaults TRUE: ~57 subnets carry no entry at all
    // and reading absence as false would mislabel every one of them.
    assert.equal(decodeOptionalBool(undefined, true), true);
    assert.equal(decodeOptionalBool(undefined, false), false);
    assert.equal(decodeOptionalBool("0x00", true), false);
    assert.equal(decodeOptionalBool("0x01", false), true);
    // An unparseable word is not a claim either way.
    assert.equal(decodeOptionalBool("0x0203", true), true);
  });

  test("decodeAccountId encodes AccountId32 to the served SS58", () => {
    assert.equal(
      decodeAccountId(NETUID_64.owner_coldkey),
      "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9",
    );
    assert.equal(decodeAccountId("0xdeadbeef"), null);
    assert.equal(decodeAccountId(undefined), null);
  });

  test("decodeMovingPrice reads one I96F32 word at ONE scale", () => {
    // A real finney word for netuid 64. Both published fields are bits / 2^32:
    // SubnetMovingPrice is I96F32, so there is no second scale to publish.
    const decoded = decodeMovingPrice(u128(360_101_426n));
    // The published price, at rao precision, as the SDK path produced it.
    assert.equal(decoded.alpha_price_tao, 0.083842646);
    assert.equal(decoded.moving_price_pinned, 360_101_426 / 2 ** 32);
    // #9224: this was u64f64 and therefore 2^32 too small. The two fields
    // agreeing to rao precision is the regression check -- the old decode put
    // them a flat 4.29e9 apart, which no consumer could reconcile with the
    // AMM pool spot the price tracks.
    assert.ok(
      Math.abs(decoded.moving_price_pinned! - decoded.alpha_price_tao!) < 1e-9,
      "the pinned reading must be the same magnitude as the published price",
    );
    assert.deepEqual(decodeMovingPrice(undefined), {
      alpha_price_tao: null,
      moving_price_pinned: null,
    });
  });

  test("indexNeuronAggregates skips unusable netuids and non-finite sums", () => {
    const indexed = indexNeuronAggregates([
      ...NEURON_ROWS,
      null as unknown as Row,
      { netuid: "nope", uid_count: 1 },
      { netuid: -1, uid_count: 1 },
      {
        netuid: 3,
        uid_count: 4,
        total_stake_alpha: null,
        max_stake_alpha: "x",
      },
      // A netuid with no aggregate columns at all -- SQLite's own answer for
      // a group that matched nothing.
      { netuid: 5 },
    ]);
    assert.equal(indexed.size, 3);
    assert.equal(indexed.get(64)!.validator_count, 21);
    assert.deepEqual(indexed.get(3), {
      uid_count: 4,
      validator_count: 0,
      total_stake_alpha: null,
      max_stake_alpha: null,
    });
    assert.deepEqual(indexed.get(5), {
      uid_count: 0,
      validator_count: 0,
      total_stake_alpha: null,
      max_stake_alpha: null,
    });
    assert.equal(indexNeuronAggregates(null).size, 0);
  });

  test("subnetHasChainData is true on a single answered item", () => {
    const maps = Object.fromEntries(
      (Object.keys(ECONOMICS_STORAGE_MAPS) as MapName[]).map((name) => [
        name,
        new Map<number, string>(),
      ]),
    ) as Record<MapName, Map<number, string>>;
    assert.equal(subnetHasChainData(9, maps), false);
    maps.tao_in_pool.set(9, u64(7n));
    assert.equal(subnetHasChainData(9, maps), true);
  });

  test("buildSubnetEconomics falls back for a subnet with no neurons row", () => {
    const maps = Object.fromEntries(
      (Object.keys(ECONOMICS_STORAGE_MAPS) as MapName[]).map((name) => [
        name,
        new Map<number, string>(
          NETUID_64[name] === undefined ? [] : [[64, NETUID_64[name]!]],
        ),
      ]),
    ) as Record<MapName, Map<number, string>>;
    const row = buildSubnetEconomics(64, maps, undefined);
    assert.equal(row.validator_count, 0);
    assert.equal(row.miner_count, 0);
    assert.equal(row.total_stake_alpha, null);
    assert.equal(row.max_stake_alpha, null);
    // A neurons row present but carrying null stakes is a different case.
    const withNulls = buildSubnetEconomics(64, maps, {
      uid_count: 5,
      validator_count: 2,
      total_stake_alpha: null,
      max_stake_alpha: null,
    });
    assert.equal(withNulls.miner_count, 3);
    assert.equal(withNulls.total_stake_alpha, null);
  });
});

describe("refreshLiveEconomics", () => {
  test("publishes a blob whose shape matches the R2 builder and the contract", async () => {
    const { env, readArtifact, puts, queries } = harness();
    const { impl, calls } = chainFetch(defaultChain());
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
      timeoutMs: 5_000,
    });

    assert.deepEqual(result, {
      ok: true,
      written: true,
      block: BLOCK_NUMBER,
      subnet_count: 2,
      with_economics_count: 2,
      captured_at: "2026-08-03T07:35:48.000Z",
    });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].key, KV_ECONOMICS_CURRENT);
    const blob = JSON.parse(puts[0].value) as Row;

    // --- byte-shape parity, against the builder's OWN output ---------------
    // The KV tier shadows the R2 artifact, so the two must agree on the key
    // set or a field disappears from the API rather than falling back. The
    // reference is the builder itself, fed the same inputs -- never a
    // hand-written fixture, which would only ever re-assert this file.
    const reference = buildEconomicsArtifact({
      subnets: SUBNETS_INDEX.subnets,
      economicsByNetuid: new Map(
        (blob.subnets as Row[]).map((row) => [row.netuid as number, row]),
      ),
      generatedAt: "2026-08-03T07:35:48.000Z",
      network: "finney",
      capturedAt: "2026-08-03T07:35:48.000Z",
      chainState: blob.chain_state as Row,
    });
    reference.contract_version = CONTRACT_VERSION;
    assert.deepEqual(
      Object.keys(blob).sort(),
      Object.keys(reference).sort(),
      "top-level key set drifted from the R2 builder",
    );
    for (const row of blob.subnets as Row[]) {
      const referenceRow = (reference.subnets as Row[]).find(
        (candidate) => candidate.netuid === row.netuid,
      )!;
      assert.deepEqual(
        Object.keys(row).sort(),
        Object.keys(referenceRow).sort(),
        `row key set drifted for netuid ${row.netuid}`,
      );
      // ...and against the published contract, which is `.strict()`: an EXTRA
      // key fails here even though it would pass the comparison above.
      SubnetEconomicsSchema.parse(row);
    }
    ChainStateSchema.parse(blob.chain_state);

    // --- the values themselves --------------------------------------------
    assert.equal(blob.contract_version, CONTRACT_VERSION);
    assert.equal(blob.network, "finney");
    assert.equal(blob.captured_at, "2026-08-03T07:35:48.000Z");
    const chutes = (blob.subnets as Row[]).find((row) => row.netuid === 64)!;
    assert.equal(chutes.slug, "sn-64");
    // The PINNED height, not the index's older one: every value on this row was
    // read at blockHash, so stamping the index's publish-time height would
    // claim an instant none of them came from.
    assert.equal(chutes.block, BLOCK_NUMBER);
    assert.notEqual(chutes.block, INDEX_STALE_BLOCK);
    assert.equal(chutes.alpha_in_pool, 2571457.878769909);
    assert.equal(chutes.tao_in_pool_tao, 217944.967412489);
    assert.equal(chutes.subnet_volume_tao, 4853018.550832965);
    assert.equal(chutes.max_uids, 256);
    assert.equal(chutes.max_validators, 64);
    assert.equal(chutes.registration_cost_tao, 0.0005);
    assert.equal(chutes.alpha_price_tao, 0.083842646);
    assert.equal(chutes.miner_burned_fraction, 0.5);
    assert.equal(chutes.first_emission_block, 5228683);
    assert.equal(chutes.alpha_out_emission, 1);
    assert.equal(chutes.registration_allowed, true);
    assert.equal(chutes.registration_allowed_pinned, true);
    assert.equal(
      chutes.owner_coldkey,
      "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9",
    );
    assert.equal(
      chutes.owner_hotkey,
      "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV",
    );
    // Per-UID aggregates come from D1, not from a second chain walk.
    assert.equal(chutes.validator_count, 21);
    assert.equal(chutes.miner_count, 235);
    assert.equal(chutes.total_stake_alpha, 3895629.026);
    assert.equal(chutes.max_stake_alpha, 2114915.958);
    // #7227 change fields come from subnet_snapshots over the D1 BINDING --
    // the read the Actions path 403'd on, which nulled all four (#9189).
    assert.equal(chutes.alpha_price_change_1d, 12.5);

    // The sparse subnet takes every absent-value default.
    const sparse = (blob.subnets as Row[]).find((row) => row.netuid === 9)!;
    assert.equal(sparse.tao_in_pool_tao, 7e-9);
    assert.equal(sparse.alpha_in_pool, null);
    assert.equal(sparse.owner_coldkey, null);
    assert.equal(sparse.max_uids, 0);
    assert.equal(sparse.alpha_price_tao, null);
    assert.equal(sparse.emission_enabled, true); // absent means ENABLED
    assert.equal(sparse.registration_allowed, false); // absent means NOT allowed
    assert.equal(sparse.subtoken_enabled, false);
    assert.equal(sparse.excess_tao, 0); // a measured zero, never null
    assert.equal(sparse.first_emission_block, null);
    assert.equal(sparse.miner_burned_fraction, null);
    assert.equal(sparse.alpha_price_change_1d, null);

    assert.deepEqual(blob.chain_state, {
      block: BLOCK_NUMBER,
      block_hash: BLOCK_HASH,
      total_issuance_tao: 11189382.031409947,
      emission_gate_bar: 0.01,
      emission_bar_quantile: 0.75,
      emission_gate_exponent: null,
    });

    // EVERY state read is pinned to the one block hash: the values move every
    // block and theta recomputes on a 360-block boundary, so an unpinned sweep
    // would publish a mix of states that never coexisted.
    const reads = calls.filter((call) => call.method.startsWith("state_"));
    assert.equal(reads.length, 23);
    for (const call of reads) assert.equal(call.params[1], BLOCK_HASH);
    assert.deepEqual(queries, [
      NEURON_AGGREGATE_QUERY,
      // #9449: captured_at is selected because the %-change windows are
      // measured in elapsed time, not by subtracting snapshot dates.
      "SELECT netuid, snapshot_date, alpha_price_tao, captured_at " +
        "FROM subnet_snapshots " +
        "WHERE snapshot_date >= date('now','-40 days') " +
        "ORDER BY netuid ASC, snapshot_date ASC",
    ]);
  });

  test("a set emission-gate exponent decodes to the small integer h", async () => {
    // UNSET means the runtime default h = 3, which is why it stays null; a SET
    // value must arrive as 3, not as its raw 128-bit word.
    const chain = defaultChain();
    chain.values.emission_gate_exponent = u128(3n * (1n << 64n));
    const { env, readArtifact, puts } = harness();
    const { impl } = chainFetch(chain);
    await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    const blob = JSON.parse(puts[0].value) as Row;
    assert.equal((blob.chain_state as Row).emission_gate_exponent, 3);
    ChainStateSchema.parse(blob.chain_state);
  });

  test("unwritten gate parameters read as null, never as invented zeroes", async () => {
    // A chain where governance never wrote the bar or the quantile: theta null
    // disables the gate outright, which is a real state -- not a zero.
    const chain = defaultChain();
    chain.values.emission_gate_bar = null;
    chain.values.emission_bar_quantile = null;
    const { env, readArtifact, puts } = harness();
    const { impl } = chainFetch(chain);
    await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    const chainState = (JSON.parse(puts[0].value) as Row).chain_state as Row;
    assert.equal(chainState.emission_gate_bar, null);
    assert.equal(chainState.emission_bar_quantile, null);
    assert.equal(chainState.total_issuance_tao, 11189382.031409947);
    ChainStateSchema.parse(chainState);
  });

  test("an unreadable TotalIssuance drops chain_state rather than faking it", async () => {
    // A block number with no issuance is provenance that proves nothing: every
    // share is checked against the issuance-derived block emission. The key is
    // ABSENT, not null, which is the degraded shape the schema documents.
    const chain = defaultChain();
    chain.values.total_issuance = null;
    const { env, readArtifact, puts } = harness();
    const { impl } = chainFetch(chain);
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.equal(result.ok, true);
    const blob = JSON.parse(puts[0].value) as Row;
    assert.equal("chain_state" in blob, false);
  });

  test("a node answering nothing SKIPS the write -- the content floor", async () => {
    // Zero rows must never overwrite a good live value: the serve path keeps
    // the last KV blob (or falls back to R2) instead.
    const chain = defaultChain();
    for (const name of Object.keys(chain.maps) as MapName[]) {
      chain.maps[name] = {};
    }
    const { env, readArtifact, puts } = harness();
    const { impl } = chainFetch(chain);
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.deepEqual(result, {
      ok: false,
      written: false,
      reason: "content_floor:no-economics-rows",
      block: BLOCK_NUMBER,
      subnet_count: 2,
      with_economics_count: 0,
    });
    assert.equal(puts.length, 0);
  });

  test("a half-answered sweep SKIPS the write -- below the floor ratio", async () => {
    const chain = defaultChain();
    for (const name of Object.keys(chain.maps) as MapName[]) {
      delete chain.maps[name]![64];
      delete chain.maps[name]![9];
    }
    chain.maps.tao_in_pool![64] = u64(1n);
    const index = {
      network: "finney",
      subnets: [
        ...SUBNETS_INDEX.subnets,
        { netuid: 1, slug: "sn-1", name: "Apex", block: BLOCK_NUMBER },
      ],
    };
    const { env, readArtifact, puts } = harness({ index });
    const { impl } = chainFetch(chain);
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.equal(result.reason, "content_floor:below-floor (1 of ~3)");
    assert.equal(puts.length, 0);
  });

  test("a chain failure leaves the last good KV value untouched", async () => {
    const { env, readArtifact, puts } = harness();
    const impl = (async () =>
      ({
        ok: false,
        status: 503,
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.deepEqual(result, {
      ok: false,
      written: false,
      reason: "unreachable",
    });
    assert.equal(puts.length, 0);
  });

  test("a non-Error rejection is contained too", async () => {
    const { env, puts } = harness();
    const result = await refreshLiveEconomics(env, {
      readArtifact: () => Promise.reject("artifact store exploded"),
      now: NOW,
    });
    assert.deepEqual(result, {
      ok: false,
      written: false,
      reason: "unreachable",
    });
    assert.equal(puts.length, 0);
  });

  test("an empty D1 answer degrades to zeroed aggregates, never a throw", async () => {
    const { env, readArtifact, puts } = harness({ d1Result: null });
    const { impl } = chainFetch(defaultChain());
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.equal(result.ok, true);
    const blob = JSON.parse(puts[0].value) as Row;
    const chutes = (blob.subnets as Row[]).find((row) => row.netuid === 64)!;
    assert.equal(chutes.validator_count, 0);
    assert.equal(chutes.total_stake_alpha, null);
    assert.equal(chutes.alpha_price_change_1d, null);
  });

  test("a null-results D1 answer is handled the same way", async () => {
    const { env, readArtifact, puts } = harness({
      neuronRows: null,
      historyRows: null,
    });
    const { impl } = chainFetch(defaultChain());
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.equal(result.ok, true);
    const blob = JSON.parse(puts[0].value) as Row;
    assert.equal((blob.subnets as Row[])[0].validator_count, 0);
  });

  test("a non-string network and non-integer netuids are dropped, not published", async () => {
    const { env, readArtifact, puts } = harness({
      index: {
        network: 42,
        subnets: [
          ...SUBNETS_INDEX.subnets,
          null,
          { netuid: "sixty-four", slug: "bogus", name: "Bogus" },
        ],
      },
    });
    const { impl } = chainFetch(defaultChain());
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
      now: NOW,
    });
    assert.equal(result.subnet_count, 2);
    const blob = JSON.parse(puts[0].value) as Row;
    assert.equal(blob.network, null);
  });

  test("declines without a reader, a KV binding or a D1 binding", async () => {
    const { env } = harness();
    assert.deepEqual(await refreshLiveEconomics(env), {
      ok: false,
      reason: "reader_unavailable",
    });
    const noKv = harness({ kv: false });
    assert.deepEqual(
      await refreshLiveEconomics(noKv.env, { readArtifact: noKv.readArtifact }),
      { ok: false, reason: "kv_binding_missing" },
    );
    const noDb = harness({ db: false });
    assert.deepEqual(
      await refreshLiveEconomics(noDb.env, { readArtifact: noDb.readArtifact }),
      { ok: false, reason: "d1_binding_missing" },
    );
  });

  test("declines on an unavailable or empty registry index", async () => {
    const unavailable = harness({ indexOk: false });
    assert.deepEqual(
      await refreshLiveEconomics(unavailable.env, {
        readArtifact: unavailable.readArtifact,
      }),
      { ok: false, reason: "subnets_artifact_unavailable" },
    );
    // A read that succeeded but carries no rows is a BROKEN input, not an
    // empty network -- publishing from it would wipe the live tier.
    const empty = harness({ index: null });
    assert.deepEqual(
      await refreshLiveEconomics(empty.env, {
        readArtifact: empty.readArtifact,
      }),
      { ok: false, reason: "no_subnets_in_index" },
    );
  });

  test("the RPC endpoint falls back var -> head-poller var -> public archive", async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(String(url));
      throw new Error("stop");
    }) as unknown as typeof fetch;
    for (const [env, expected] of [
      [{ LIVE_ECONOMICS_RPC_URL: "https://own.test" }, "https://own.test"],
      [{ CHAIN_HEAD_RPC_URL: "https://head.test" }, "https://head.test"],
      [{}, LIVE_ECONOMICS_DEFAULT_RPC_URL],
    ] as [Row, string][]) {
      const { readArtifact, env: harnessEnv } = harness({ env });
      await refreshLiveEconomics(harnessEnv, {
        readArtifact,
        fetchImpl: spy,
        now: NOW,
      });
      assert.equal(seen.at(-1), expected);
    }
  });

  test("defaults its clock to the real one when no seam is injected", async () => {
    const before = Date.now();
    const { env, readArtifact, puts } = harness();
    const { impl } = chainFetch(defaultChain());
    const result = await refreshLiveEconomics(env, {
      readArtifact,
      fetchImpl: impl,
    });
    assert.equal(result.ok, true);
    const stamped = Date.parse(
      (JSON.parse(puts[0].value) as Row).captured_at as string,
    );
    assert.ok(stamped >= before && stamped <= Date.now());
  });
});
