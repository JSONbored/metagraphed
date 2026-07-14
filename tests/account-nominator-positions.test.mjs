import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  NOMINATOR_POSITION_INSERT_COLUMNS,
  buildAccountPositions,
  distinctHotkeys,
  stakeByHotkeyNetuid,
} from "../src/account-nominator-positions.mjs";

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
