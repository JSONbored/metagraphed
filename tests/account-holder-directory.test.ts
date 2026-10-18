import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_HOLDER_DIRECTORY_LIMIT,
  buildAccountHolderDirectory,
  hasLegacyAccountHolderCapital,
} from "../src/account-holder-directory.ts";

const CAPTURED_AT = 1_750_000_000_000;
const PRICES = new Map<number, number | null>([
  [1, 1],
  [2, 1],
  [3, 1],
]);

function row({
  hotkey,
  coldkey,
  netuid,
  uid,
  stake,
  emission,
}: {
  hotkey: string;
  coldkey: string;
  netuid: number;
  uid: number;
  stake: number;
  emission: number;
}) {
  return {
    hotkey,
    coldkey,
    netuid,
    uid,
    stake_tao: stake,
    emission_tao: emission,
    validator_permit: 0,
    captured_at: CAPTURED_AT,
    block_number: 8_900_000,
  };
}

describe("buildAccountHolderDirectory", () => {
  test("retains independent emission and reach rankings while withholding the financial selection", () => {
    const data = buildAccountHolderDirectory(
      [
        row({
          hotkey: "hk-a",
          coldkey: "ck-a",
          netuid: 1,
          uid: 1,
          stake: 100,
          emission: 1,
        }),
        row({
          hotkey: "hk-b",
          coldkey: "ck-b",
          netuid: 1,
          uid: 2,
          stake: 25,
          emission: 50,
        }),
        row({
          hotkey: "hk-b",
          coldkey: "ck-b",
          netuid: 2,
          uid: 2,
          stake: 25,
          emission: 50,
        }),
        row({
          hotkey: "hk-c",
          coldkey: "ck-c",
          netuid: 1,
          uid: 3,
          stake: 10,
          emission: 20,
        }),
        row({
          hotkey: "hk-c",
          coldkey: "ck-c",
          netuid: 2,
          uid: 3,
          stake: 10,
          emission: 20,
        }),
        row({
          hotkey: "hk-c",
          coldkey: "ck-c",
          netuid: 3,
          uid: 3,
          stake: 10,
          emission: 20,
        }),
      ],
      { priceByNetuid: PRICES },
    );

    assert.equal(data.schema_version, 1);
    assert.equal(data.account_count, 3);
    assert.equal(data.limit, ACCOUNT_HOLDER_DIRECTORY_LIMIT);
    assert.equal(data.captured_at, new Date(CAPTURED_AT).toISOString());
    assert.equal(data.block_number, 8_900_000);
    assert.equal(data.priced_registered_stake_tao, null);
    assert.deepEqual(data.rankings.stake, []);
    assert.deepEqual(
      data.rankings.emission.map((account) => account.hotkey),
      ["hk-b", "hk-c", "hk-a"],
    );
    assert.deepEqual(
      data.rankings.reach.map((account) => account.hotkey),
      ["hk-c", "hk-b", "hk-a"],
    );
    assert.deepEqual(
      data.rankings.emission.map((account) => account.total_emission_tao),
      [100, 60, 1],
    );
    for (const ranking of [data.rankings.emission, data.rankings.reach]) {
      for (const account of ranking) {
        assert.equal(account.total_stake_tao, null);
        assert.equal(account.stake_dominance, null);
      }
    }
    assert.deepEqual(Object.keys(data.rankings.emission[0]!).sort(), [
      "coldkey",
      "hotkey",
      "stake_dominance",
      "subnet_count",
      "total_emission_tao",
      "total_stake_tao",
      "uid_count",
    ]);
  });

  test("cold and zero-weight snapshots do not establish zero holdings", () => {
    const cold = buildAccountHolderDirectory(null, {
      priceByNetuid: new Map(),
    });
    assert.equal(cold.account_count, 0);
    assert.equal(cold.captured_at, null);
    assert.equal(cold.block_number, null);
    assert.equal(cold.priced_registered_stake_tao, null);
    assert.deepEqual(cold.rankings, { stake: [], emission: [], reach: [] });

    const zero = buildAccountHolderDirectory(
      [
        row({
          hotkey: "hk-zero",
          coldkey: "ck-zero",
          netuid: 1,
          uid: 1,
          stake: 0,
          emission: 0,
        }),
      ],
      { priceByNetuid: PRICES },
    );
    assert.equal(zero.account_count, 1);
    assert.equal(zero.priced_registered_stake_tao, null);
    assert.deepEqual(zero.rankings.stake, []);
    assert.equal(zero.rankings.emission[0]?.total_stake_tao, null);
    assert.equal(zero.rankings.emission[0]?.stake_dominance, null);
    assert.equal(zero.rankings.emission[0]?.total_emission_tao, 0);
  });

  test("bounds independent rankings and breaks equal values by hotkey", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      row({
        hotkey: `hk-${String(24 - index).padStart(2, "0")}`,
        coldkey: `ck-${index}`,
        netuid: 1,
        uid: index,
        stake: 1,
        emission: 1,
      }),
    );
    const data = buildAccountHolderDirectory(rows, {
      priceByNetuid: PRICES,
    });

    assert.deepEqual(data.rankings.stake, []);
    for (const ranking of [data.rankings.emission, data.rankings.reach]) {
      assert.equal(ranking.length, ACCOUNT_HOLDER_DIRECTORY_LIMIT);
      assert.equal(ranking[0]?.hotkey, "hk-00");
      assert.equal(ranking.at(-1)?.hotkey, "hk-19");
    }
  });

  test("root and unknown-price memberships preserve counts and clocks without capital", () => {
    const data = buildAccountHolderDirectory(
      [
        row({
          hotkey: "hk-a",
          coldkey: "ck-a",
          netuid: 0,
          uid: 1,
          stake: 100,
          emission: 2,
        }),
        {
          ...row({
            hotkey: "hk-a",
            coldkey: "ck-a",
            netuid: 99,
            uid: 2,
            stake: 10_000,
            emission: 500,
          }),
          captured_at: CAPTURED_AT + 1000,
          block_number: 8_900_001,
        },
      ],
      { priceByNetuid: new Map() },
    );
    assert.equal(data.priced_registered_stake_tao, null);
    assert.equal(data.captured_at, new Date(CAPTURED_AT + 1000).toISOString());
    assert.equal(data.block_number, 8_900_001);
    assert.deepEqual(data.rankings.stake, []);
    assert.deepEqual(data.rankings.emission, data.rankings.reach);
    assert.deepEqual(data.rankings.reach[0], {
      hotkey: "hk-a",
      coldkey: "ck-a",
      subnet_count: 2,
      uid_count: 2,
      total_stake_tao: null,
      total_emission_tao: 2,
      stake_dominance: null,
    });
  });
});

describe("hasLegacyAccountHolderCapital", () => {
  const account = { total_stake_tao: null, stake_dominance: null };
  const directory = {
    priced_registered_stake_tao: null,
    rankings: { stake: [], emission: [account], reach: [account] },
  };

  test("accepts fresh unavailable-capital and empty directories", () => {
    assert.equal(hasLegacyAccountHolderCapital(directory), false);
    assert.equal(
      hasLegacyAccountHolderCapital(
        buildAccountHolderDirectory(null, { priceByNetuid: new Map() }),
      ),
      false,
    );
  });

  test("rejects zero, positive, or missing aggregate and per-row capital", () => {
    for (const value of [10, 0, undefined]) {
      assert.equal(
        hasLegacyAccountHolderCapital({
          ...directory,
          priced_registered_stake_tao: value,
        }),
        true,
      );
      for (const metric of ["emission", "reach"]) {
        for (const field of ["total_stake_tao", "stake_dominance"]) {
          assert.equal(
            hasLegacyAccountHolderCapital({
              ...directory,
              rankings: {
                ...directory.rankings,
                [metric]: [{ ...account, [field]: value }],
              },
            }),
            true,
          );
        }
      }
    }
  });

  test("rejects nonempty stake selections even when their row values are null", () => {
    assert.equal(
      hasLegacyAccountHolderCapital({
        ...directory,
        rankings: { ...directory.rankings, stake: [account] },
      }),
      true,
    );
  });

  test("fails closed for malformed directory, ranking, or row shapes", () => {
    for (const value of [
      null,
      [],
      {},
      { priced_registered_stake_tao: null },
      { ...directory, rankings: null },
      { ...directory, rankings: { ...directory.rankings, stake: null } },
      { ...directory, rankings: { ...directory.rankings, emission: null } },
      { ...directory, rankings: { ...directory.rankings, reach: null } },
      { ...directory, rankings: { ...directory.rankings, emission: [null] } },
    ]) {
      assert.equal(hasLegacyAccountHolderCapital(value), true);
    }
  });
});
