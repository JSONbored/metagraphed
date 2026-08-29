import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_HOLDER_DIRECTORY_LIMIT,
  buildAccountHolderDirectory,
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
  test("aggregates once and derives distinct stake, emission, and reach rankings", () => {
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
    assert.equal(data.priced_registered_stake_tao, 180);
    assert.deepEqual(
      data.rankings.stake.map((account) => account.hotkey),
      ["hk-a", "hk-b", "hk-c"],
    );
    assert.deepEqual(
      data.rankings.emission.map((account) => account.hotkey),
      ["hk-b", "hk-c", "hk-a"],
    );
    assert.deepEqual(
      data.rankings.reach.map((account) => account.hotkey),
      ["hk-c", "hk-b", "hk-a"],
    );
    assert.equal(data.rankings.stake[0]?.stake_dominance, 0.555556);
    assert.deepEqual(Object.keys(data.rankings.stake[0]!).sort(), [
      "coldkey",
      "hotkey",
      "stake_dominance",
      "subnet_count",
      "total_emission_tao",
      "total_stake_tao",
      "uid_count",
    ]);
  });

  test("is cold-safe and keeps unknown dominance null", () => {
    const cold = buildAccountHolderDirectory(null, {
      priceByNetuid: new Map(),
    });
    assert.equal(cold.account_count, 0);
    assert.equal(cold.captured_at, null);
    assert.equal(cold.block_number, null);
    assert.equal(cold.priced_registered_stake_tao, 0);
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
    assert.equal(zero.rankings.stake[0]?.stake_dominance, null);
  });

  test("bounds every ranking and breaks equal values by hotkey", () => {
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

    for (const ranking of Object.values(data.rankings)) {
      assert.equal(ranking.length, ACCOUNT_HOLDER_DIRECTORY_LIMIT);
      assert.equal(ranking[0]?.hotkey, "hk-00");
      assert.equal(ranking.at(-1)?.hotkey, "hk-19");
    }
  });
});
