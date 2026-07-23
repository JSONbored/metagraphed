import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  NOMINATOR_POSITION_INSERT_COLUMNS,
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "../src/account-nominator-positions.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("GET /api/v1/accounts/{ss58}/positions (#5233)", () => {
  test("cold store (no METAGRAPH_NEURONS_SOURCE flag, D1 never touched) -> 200 with an empty card", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/positions`),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ss58, SS58);
    assert.equal(body.data.position_count, 0);
    assert.equal(body.data.total_stake_tao, 0);
    assert.deepEqual(body.data.positions, []);
  });

  test("flag=postgres proxies to DATA_API and returns its shape", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/positions`),
      {
        ...createLocalArtifactEnv(),
        METAGRAPH_NEURONS_SOURCE: "postgres",
        DATA_API: {
          fetch: async () =>
            Response.json({
              schema_version: 1,
              ss58: SS58,
              captured_at: null,
              position_count: 1,
              total_stake_tao: 250,
              positions: [
                {
                  hotkey: "5Hk1",
                  netuid: 3,
                  share_fraction: 0.25,
                  stake_tao: 250,
                },
              ],
            }),
        },
      },
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.position_count, 1);
    assert.equal(body.data.positions[0].stake_tao, 250);
  });

  test("testnet variant 404s instead of leaking a D1/R2 key (mainnet-only tier)", async () => {
    const res = await handleRequest(
      new Request(
        `https://api.metagraph.sh/api/v1/testnet/accounts/${SS58}/positions`,
      ),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 404);
  });
});

describe("stakeByHotkeyNetuid", () => {
  test("builds a hotkey|netuid -> stake_tao Map from neurons rows", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: 3, stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 8, stake_tao: 500 },
    ]);
    assert.equal(map.get("5Hk1|3"), 1000);
    assert.equal(map.get("5Hk1|8"), 500);
    assert.equal(map.size, 2);
  });

  test("is cold-safe for non-array/empty input", () => {
    assert.equal(stakeByHotkeyNetuid(null).size, 0);
    assert.equal(stakeByHotkeyNetuid(undefined).size, 0);
    assert.equal(stakeByHotkeyNetuid([]).size, 0);
  });

  test("skips a row missing hotkey/netuid/stake_tao", () => {
    const map = stakeByHotkeyNetuid([
      { netuid: 3, stake_tao: 1000 },
      { hotkey: "5Hk1", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 3 },
      { hotkey: "5Hk1", netuid: 3, stake_tao: -1 },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a row with a negative netuid or a blank/whitespace-only string netuid/stake_tao", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: -1, stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: "", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: "  ", stake_tao: 1000 },
      { hotkey: "5Hk1", netuid: 3, stake_tao: "" },
      { hotkey: "5Hk1", netuid: 3, stake_tao: "   " },
    ]);
    assert.equal(map.size, 0);
  });

  test("accepts a numeric-string netuid/stake_tao (D1/Postgres text cell coercion)", () => {
    const map = stakeByHotkeyNetuid([
      { hotkey: "5Hk1", netuid: "3", stake_tao: "1000" },
    ]);
    assert.equal(map.get("5Hk1|3"), 1000);
  });
});

describe("distinctHotkeys", () => {
  test("dedupes and preserves order", () => {
    const hotkeys = distinctHotkeys([
      { hotkey: "5Hk1" },
      { hotkey: "5Hk2" },
      { hotkey: "5Hk1" },
    ]);
    assert.deepEqual(hotkeys, ["5Hk1", "5Hk2"]);
  });

  test("is cold-safe and skips blank hotkeys", () => {
    assert.deepEqual(distinctHotkeys(null), []);
    assert.deepEqual(distinctHotkeys([{ hotkey: "" }, { hotkey: null }]), []);
  });
});

describe("buildAccountPositions", () => {
  test("joins share_fraction against live neurons stake_tao to produce stake_tao", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.25,
          captured_at: 1_780_000_000_000,
        },
      ],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    assert.equal(data.ss58, "5Cold");
    assert.equal(data.position_count, 1);
    assert.equal(data.positions[0].hotkey, "5Hk1");
    assert.equal(data.positions[0].netuid, 3);
    assert.equal(data.positions[0].share_fraction, 0.25);
    assert.equal(data.positions[0].stake_tao, 250);
    assert.equal(data.total_stake_tao, 250);
    assert.equal(data.captured_at, new Date(1_780_000_000_000).toISOString());
  });

  test("sums multiple positions and sorts biggest stake first", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.1,
          captured_at: 1,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk2",
          netuid: 8,
          share_fraction: 0.5,
          captured_at: 1,
        },
      ],
      new Map([
        ["5Hk1|3", 1000], // 100 stake_tao
        ["5Hk2|8", 500], // 250 stake_tao
      ]),
      "5Cold",
    );
    assert.equal(data.position_count, 2);
    assert.equal(data.positions[0].hotkey, "5Hk2"); // 250 > 100
    assert.equal(data.positions[1].hotkey, "5Hk1");
    assert.equal(data.total_stake_tao, 350);
  });

  test("excludes a position whose hotkey|netuid has no entry in the stake map (deregistered or not yet in the daily snapshot)", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.25,
          captured_at: 1,
        },
      ],
      new Map(), // cold/empty stake map
      "5Cold",
    );
    assert.equal(data.position_count, 0);
    assert.equal(data.total_stake_tao, 0);
    assert.deepEqual(data.positions, []);
  });

  test("is cold-safe for a coldkey with no positions at all", () => {
    const data = buildAccountPositions([], new Map(), "5Cold");
    assert.equal(data.ss58, "5Cold");
    assert.equal(data.position_count, 0);
    assert.equal(data.total_stake_tao, 0);
    assert.equal(data.captured_at, null);
    assert.deepEqual(data.positions, []);
  });

  test("skips a malformed row (missing hotkey/netuid/share_fraction)", () => {
    const data = buildAccountPositions(
      [
        { coldkey: "5Cold", netuid: 3, share_fraction: 0.5 },
        { coldkey: "5Cold", hotkey: "5Hk1", share_fraction: 0.5 },
        { coldkey: "5Cold", hotkey: "5Hk1", netuid: 3 },
      ],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    assert.equal(data.position_count, 0);
  });

  test("skips a row with a negative or blank/whitespace-only string share_fraction", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: -0.1,
          captured_at: 1,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: "",
          captured_at: 1,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: "  ",
          captured_at: 1,
        },
      ],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    assert.equal(data.position_count, 0);
  });

  test("accepts a numeric-string netuid/share_fraction (D1/Postgres text cell coercion)", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: "3",
          share_fraction: "0.25",
          captured_at: 1,
        },
      ],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    assert.equal(data.position_count, 1);
    assert.equal(data.positions[0].stake_tao, 250);
  });

  test("is cold-safe for a non-array positionRows or a non-Map hotkeyNetuidStake", () => {
    const dataNonArray = buildAccountPositions(
      "not-an-array" as unknown as Record<string, unknown>[],
      new Map(),
      "5Cold",
    );
    assert.deepEqual(dataNonArray.positions, []);
    const dataNonMap = buildAccountPositions(
      [{ coldkey: "5Cold", hotkey: "5Hk1", netuid: 3, share_fraction: 0.5 }],
      { not: "a map" } as unknown as Map<string, number>,
      "5Cold",
    );
    assert.deepEqual(dataNonMap.positions, []);
  });

  test("skips a position whose share_fraction * stake_tao is non-finite (a crafted/corrupt stake map entry)", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.5,
          captured_at: 1,
        },
      ],
      new Map([["5Hk1|3", Infinity]]),
      "5Cold",
    );
    assert.equal(data.position_count, 0);
    assert.equal(data.total_stake_tao, 0);
  });

  test("tie-breaks by netuid when stake AND hotkey are both equal (two subnets of the same validator)", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 8,
          share_fraction: 0.1,
          captured_at: 1,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.1,
          captured_at: 1,
        },
      ],
      new Map([
        ["5Hk1|8", 1000],
        ["5Hk1|3", 1000],
      ]),
      "5Cold",
    );
    assert.equal(data.positions[0].netuid, 3);
    assert.equal(data.positions[1].netuid, 8);
  });

  test("nulls captured_at when the only captured_at is beyond Date's valid range (a corrupt/out-of-range epoch)", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.5,
          // Number.isSafeInteger-valid but exceeds Date's own ~8.64e15 max,
          // producing an Invalid Date -- nonNegativeInt's safe-integer check
          // alone doesn't guarantee a constructible Date.
          captured_at: Number.MAX_SAFE_INTEGER,
        },
      ],
      new Map([["5Hk1|3", 1000]]),
      "5Cold",
    );
    assert.equal(data.captured_at, null);
  });

  test("falls back total_stake_tao to 0 when per-position stake_tao sums overflow to Infinity", () => {
    // Each individual stakeTao is itself finite, but summing two
    // near-MAX_VALUE positions overflows the accumulator to Infinity --
    // roundTao(Infinity) is null, and the ?? 0 fallback catches it.
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 1,
          captured_at: 1,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk2",
          netuid: 8,
          share_fraction: 1,
          captured_at: 1,
        },
      ],
      new Map([
        ["5Hk1|3", Number.MAX_VALUE],
        ["5Hk2|8", Number.MAX_VALUE],
      ]),
      "5Cold",
    );
    assert.equal(data.total_stake_tao, 0);
  });

  test("does not advance captured_at when a later row's captured_at is not newer", () => {
    const data = buildAccountPositions(
      [
        {
          coldkey: "5Cold",
          hotkey: "5Hk1",
          netuid: 3,
          share_fraction: 0.1,
          captured_at: 2000,
        },
        {
          coldkey: "5Cold",
          hotkey: "5Hk2",
          netuid: 8,
          share_fraction: 0.1,
          captured_at: 1000,
        },
      ],
      new Map([
        ["5Hk1|3", 1000],
        ["5Hk2|8", 1000],
      ]),
      "5Cold",
    );
    assert.equal(data.captured_at, new Date(2000).toISOString());
  });
});

describe("NOMINATOR_POSITION_INSERT_COLUMNS", () => {
  test("is the exact five-column shape the migration/sync endpoint expect", () => {
    assert.deepEqual(NOMINATOR_POSITION_INSERT_COLUMNS, [
      "coldkey",
      "hotkey",
      "netuid",
      "share_fraction",
      "captured_at",
    ]);
  });
});
