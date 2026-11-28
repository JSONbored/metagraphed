import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  buildChainEmissionSplits,
  buildSubnetEmissionSplit,
  loadChainEmissionSplits,
  loadSubnetEmissionSplit,
} from "../src/subnet-emission-split.ts";
import { selectedSubnetEmissionStore } from "../src/subnet-emission-store.ts";
import {
  handleChainEmissionSplits,
  handleSubnetEmissionSplit,
} from "../workers/request-handlers/entities.ts";
import { handleRequest, runSubnetEmissionLane } from "../workers/api.ts";
import { SubnetEmissionSplitArtifactSchema } from "../schemas-src/routes/subnet-emission-split.ts";
import { ChainEmissionSplitsArtifactSchema } from "../schemas-src/routes/chain-emission-splits.ts";

type Row = Record<string, unknown>;

const DEFAULT_PARTS = {
  burn_parts: "0",
  recycle_parts: "0",
  owner_parts: "3320329489486196244",
  validator_parts: "7563207292111677685",
  miner_parts: "7563207292111677686",
};
const splitRow = (overrides: Row = {}) => ({
  netuid: 3,
  burn_parts: "0",
  recycle_parts: "0",
  owner_parts: "3320413933267719290",
  validator_parts: "6640827866535438581",
  miner_parts: "6640827866535438583",
  gamma_shares: [{ target: 51, parts: "1844674407370955161" }],
  valid_from: "200",
  valid_to: null,
  ...overrides,
});
const stateRow = (overrides: Row = {}) => ({
  netuid: 3,
  stage: "started",
  epoch_consensus: "yuma",
  created_via_lease: false,
  valid_from: "100",
  valid_to: null,
  ...overrides,
});
const observation = { block_number: "300", observed_at_ms: "1795900000000" };

describe("buildSubnetEmissionSplit", () => {
  test("no store is the decline: no observation, so no split and no history", () => {
    const data = buildSubnetEmissionSplit(null, 3);
    assert.deepEqual(data, {
      schema_version: 1,
      netuid: 3,
      observed_block: null,
      observed_at: null,
      exists: null,
      lifecycle: null,
      split: null,
      history: [],
      lifecycle_history: [],
    });
    SubnetEmissionSplitArtifactSchema.parse(data);
  });

  test("the current split, its exact parts and its history, newest first", () => {
    const data = buildSubnetEmissionSplit(
      {
        observation,
        splits: [
          splitRow(),
          splitRow({
            ...DEFAULT_PARTS,
            gamma_shares: [],
            valid_from: "100",
            valid_to: "200",
          }),
        ],
        lifecycle: [stateRow()],
      },
      3,
    );
    SubnetEmissionSplitArtifactSchema.parse(data);
    assert.equal(data.observed_block, 300);
    assert.equal(data.observed_at, "2026-11-28T21:06:40.000Z");
    assert.equal(data.exists, true);
    const split = data.split as Row;
    assert.equal(split.owner, 0.18);
    assert.equal(split.validator, 0.36);
    assert.equal(split.miner, 0.36);
    assert.equal(split.is_default, false);
    assert.deepEqual(split.gamma_shares, [
      { target_netuid: 51, share: 0.1, parts: "1844674407370955161" },
    ]);
    assert.equal((split.parts as Row).owner, "3320413933267719290");
    const history = data.history as Row[];
    assert.deepEqual(
      history.map((r) => [r.valid_from, r.valid_to, r.is_default]),
      [
        [200, null, false],
        [100, 200, true],
      ],
    );
    assert.deepEqual(data.lifecycle, {
      valid_from: 100,
      valid_to: null,
      stage: "started",
      epoch_consensus: "yuma",
      created_via_lease: false,
    });
  });

  test("a subnet with no current state does not exist at the observed block", () => {
    const data = buildSubnetEmissionSplit(
      {
        observation,
        splits: [splitRow({ valid_to: "250" })],
        lifecycle: [stateRow({ valid_to: "250" })],
      },
      3,
    );
    assert.equal(data.exists, false);
    assert.equal(data.lifecycle, null);
    assert.equal(data.split, null);
    assert.equal((data.history as Row[]).length, 1);
  });

  test("rows that do not read whole are dropped, never served as a split", () => {
    const data = buildSubnetEmissionSplit(
      {
        observation,
        splits: [
          splitRow({ owner_parts: "18446744073709551616" }),
          splitRow({ miner_parts: "-1" }),
          splitRow({ valid_from: "x" }),
          splitRow({ gamma_shares: "[]" }),
          splitRow({ gamma_shares: [{ target: 70000, parts: "1" }] }),
          splitRow({ gamma_shares: [{ target: 1, parts: 1 }] }),
          splitRow({ valid_to: "x" }),
        ],
        lifecycle: [
          stateRow({ stage: 1 }),
          stateRow({ valid_from: null }),
          stateRow({ created_via_lease: "no" }),
        ],
      },
      3,
    );
    // Only the row whose bad valid_to reads as null (current) survives.
    assert.deepEqual(
      (data.history as Row[]).map((r) => r.valid_to),
      [null],
    );
    assert.deepEqual(data.lifecycle_history, []);
    assert.equal(data.exists, false);
  });

  test("rows are not served without an observation to date them", () => {
    const data = buildSubnetEmissionSplit(
      { observation: null, splits: [splitRow()], lifecycle: [stateRow()] },
      3,
    );
    assert.equal(data.split, null);
    assert.deepEqual(data.history, []);
    assert.equal(
      buildSubnetEmissionSplit(
        {
          observation: { block_number: "5", observed_at_ms: null },
          splits: [],
          lifecycle: [],
        },
        3,
      ).observed_at,
      null,
    );
  });
});

describe("buildChainEmissionSplits", () => {
  test("no store is the decline: an empty set and every count null", () => {
    const data = buildChainEmissionSplits(null);
    ChainEmissionSplitsArtifactSchema.parse(data);
    assert.deepEqual(data.subnets, []);
    assert.equal(data.subnet_count, null);
    assert.equal(data.custom_count, null);
    assert.equal(data.gamma_share_count, null);
    assert.equal(
      ((data.default_split as Row).parts as Row).owner,
      "3320329489486196244",
    );
    // 11796/65535, the runtime's InitialSubnetOwnerCut: not quite 18%.
    assert.equal((data.default_split as Row).owner, 0.179995422);
  });

  test("the subnets the chain holds, with how many left the default", () => {
    const data = buildChainEmissionSplits({
      observation,
      splits: [
        splitRow(),
        splitRow({ netuid: 1, ...DEFAULT_PARTS, gamma_shares: [] }),
        // A split row for a subnet with no current state is history, not a member.
        splitRow({ netuid: 9 }),
        splitRow({ netuid: 10, owner_parts: "bad" }),
      ],
      lifecycle: [
        stateRow(),
        stateRow({ netuid: 1, epoch_consensus: "null" }),
        stateRow({ netuid: 10 }),
        stateRow({ netuid: 11, stage: 7 }),
      ],
    });
    ChainEmissionSplitsArtifactSchema.parse(data);
    assert.equal(data.subnet_count, 2);
    assert.equal(data.custom_count, 1);
    assert.equal(data.gamma_share_count, 1);
    assert.deepEqual(
      (data.subnets as Row[]).map((r) => [
        r.netuid,
        r.stage,
        r.epoch_consensus,
        r.is_default,
      ]),
      [
        [3, "started", "yuma", false],
        [1, "started", "null", true],
      ],
    );
  });

  test("rows are not served without an observation", () => {
    const data = buildChainEmissionSplits({
      observation: null,
      splits: [splitRow()],
      lifecycle: [stateRow()],
    });
    assert.deepEqual(data.subnets, []);
    assert.equal(data.subnet_count, null);
  });
});

const fakeStore = (overrides: Row = {}) => ({
  write: async () => ({ written: true, opened: 0, closed: 0 }),
  current: async () => ({
    observation,
    splits: [splitRow()],
    lifecycle: [stateRow()],
  }),
  subnet: async () => ({
    observation,
    splits: [splitRow()],
    lifecycle: [stateRow()],
  }),
  ...overrides,
});

describe("the store seam and its loaders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedSubnetEmissionStore({}), null);
    assert.equal(selectedSubnetEmissionStore(null), null);
    assert.equal(await loadSubnetEmissionSplit({}, 3), null);
    assert.equal(await loadChainEmissionSplits({}), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}, { ...fakeStore(), current: 1 }])
      assert.throws(
        () => selectedSubnetEmissionStore({ SUBNET_EMISSION_STORE: store }),
        /Invalid native subnet emission store/,
      );
  });

  test("a bound store serves, and a failing read declines rather than erroring the route", async () => {
    const env = { SUBNET_EMISSION_STORE: fakeStore() };
    assert.equal(
      (await loadSubnetEmissionSplit(env, 3))?.observation,
      observation,
    );
    assert.equal((await loadChainEmissionSplits(env))?.splits.length, 1);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      SUBNET_EMISSION_STORE: fakeStore({
        current: async () => Promise.reject(new Error("pool")),
        subnet: async () => Promise.reject(new Error("pool")),
      }),
    };
    assert.equal(await loadSubnetEmissionSplit(failing, 3), null);
    assert.equal(await loadChainEmissionSplits(failing), null);
    assert.equal(error.mock.calls.length, 2);
  });
});

describe("the handlers and the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const get = (path: string, env: unknown = {}) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env as Env,
      ctx,
    );

  test("no bound store is the schema-stable decline, marked degraded", async () => {
    const res = await handleSubnetEmissionSplit(
      new Request("https://api.metagraph.sh/api/v1/subnets/3/emission-split"),
      {} as unknown as Env,
      3,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).observed_block, null);
    assert.equal(
      (body.meta as Row).artifact_path,
      "/metagraph/subnets/3/emission-split.json",
    );
    const chain = await handleChainEmissionSplits(
      new Request("https://api.metagraph.sh/api/v1/chain/emission-splits"),
      {} as unknown as Env,
    );
    assert.equal(
      ((await chain.json()) as { data: Row }).data.subnet_count,
      null,
    );
  });

  test("a bound store serves both routes through the router", async () => {
    const env = { SUBNET_EMISSION_STORE: fakeStore() };
    const one = (await (
      await get("/api/v1/subnets/3/emission-split", env)
    ).json()) as { data: Row };
    assert.equal((one.data.split as Row).owner, 0.18);
    const all = (await (
      await get("/api/v1/chain/emission-splits", env)
    ).json()) as { data: Row };
    assert.equal(all.data.subnet_count, 1);
    const direct = await handleChainEmissionSplits(
      new Request("https://api.metagraph.sh/api/v1/chain/emission-splits"),
      env as unknown as Env,
    );
    assert.equal(((await direct.json()) as { data: Row }).data.custom_count, 1);
  });

  test("testnet has no variant, and the routes take no query parameter", async () => {
    assert.equal(
      (await get("/api/v1/testnet/subnets/3/emission-split")).status,
      404,
    );
    assert.equal(
      (await get("/api/v1/testnet/chain/emission-splits")).status,
      404,
    );
    assert.equal(
      (await get("/api/v1/subnets/3/emission-split?window=7d")).status,
      400,
    );
    assert.equal(
      (await get("/api/v1/chain/emission-splits?limit=5")).status,
      400,
    );
  });
});

describe("the capture lane on the burn tick", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const verdicts = () => {
    const rows: unknown[][] = [];
    return {
      rows,
      LANE_HEALTH_STORE: {
        run: async (_text: string, values: unknown[]) => {
          rows.push(values);
          return { changes: 1 };
        },
        retentionReady: async () => false,
      },
    };
  };

  test("a written capture is the lane's ok verdict", async () => {
    // An empty chain: a finalized head, and no subnet in SubnetState.
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { id, method } = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
      };
      const result =
        method === "chain_getFinalizedHead"
          ? "0xf1"
          : method === "chain_getHeader"
            ? { number: "0x928461" }
            : method === "state_queryStorageAt"
              ? [{ changes: [] }]
              : [];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const lane = verdicts();
    await runSubnetEmissionLane({
      SUBNET_EMISSION_STORE: fakeStore(),
      LANE_HEALTH_STORE: lane.LANE_HEALTH_STORE,
    } as unknown as Env);
    const [name, verdict, , detail] = lane.rows[0];
    assert.equal(name, "subnet-emission");
    assert.equal(verdict, "ok");
    assert.equal(detail, "0 subnets, 0 ranges changed");
  });

  test("no store, and a malformed one, are stale verdicts, never a throw", async () => {
    const unbound = verdicts();
    await runSubnetEmissionLane({
      LANE_HEALTH_STORE: unbound.LANE_HEALTH_STORE,
    } as unknown as Env);
    assert.deepEqual(
      [unbound.rows[0][1], unbound.rows[0][3]],
      ["stale", "no_store_binding"],
    );
    const malformed = verdicts();
    await runSubnetEmissionLane({
      SUBNET_EMISSION_STORE: {},
      LANE_HEALTH_STORE: malformed.LANE_HEALTH_STORE,
    } as unknown as Env);
    assert.equal(malformed.rows[0][1], "stale");
    assert.match(
      String(malformed.rows[0][3]),
      /^store_unavailable: TypeError: Invalid native subnet emission store/,
    );
  });
});
