import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildDeregRiskSnapshot,
  neuronImmunityCountdownBlocks,
  subnetAlphaPriceRank,
} from "../src/dereg-risk.ts";

describe("subnetAlphaPriceRank", () => {
  test("ranks subnets by alpha_price_tao descending, 1 = highest price", () => {
    const rank = subnetAlphaPriceRank([
      { netuid: 1, alpha_price_tao: 0.5 },
      { netuid: 2, alpha_price_tao: 2.0 },
      { netuid: 3, alpha_price_tao: 1.0 },
    ]);
    assert.equal(rank.get(2), 1);
    assert.equal(rank.get(3), 2);
    assert.equal(rank.get(1), 3);
  });

  test("excludes a row with a missing or non-finite alpha_price_tao entirely", () => {
    const rank = subnetAlphaPriceRank([
      { netuid: 1, alpha_price_tao: 1 },
      { netuid: 2, alpha_price_tao: null },
      { netuid: 3, alpha_price_tao: "not-a-number" },
      { netuid: 4 },
    ]);
    assert.equal(rank.size, 1);
    assert.equal(rank.get(1), 1);
    assert.equal(rank.has(2), false);
    assert.equal(rank.has(3), false);
    assert.equal(rank.has(4), false);
  });

  test("excludes a row with a non-integer netuid", () => {
    const rank = subnetAlphaPriceRank([
      { netuid: "not-a-number", alpha_price_tao: 1 },
    ]);
    assert.equal(rank.size, 0);
  });

  test("non-array / empty input never throws", () => {
    assert.equal(subnetAlphaPriceRank([]).size, 0);
    assert.equal(subnetAlphaPriceRank(null).size, 0);
    assert.equal(subnetAlphaPriceRank(undefined).size, 0);
  });

  test("a tie keeps a stable order (Array#sort is spec-stable)", () => {
    const rank = subnetAlphaPriceRank([
      { netuid: 1, alpha_price_tao: 1 },
      { netuid: 2, alpha_price_tao: 1 },
    ]);
    assert.equal(rank.get(1), 1);
    assert.equal(rank.get(2), 2);
  });
});

describe("neuronImmunityCountdownBlocks", () => {
  test("computes the countdown for a neuron still within its immunity window", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [{ netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 1500 }],
      1000,
    );
    assert.equal(countdown.get("7:5Fhot"), 500);
  });

  test("keys by netuid:hotkey, distinguishing the same hotkey across subnets", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [
        { netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 1500 },
        { netuid: 8, hotkey: "5Fhot", immunity_expires_at_block: 2000 },
      ],
      1000,
    );
    assert.equal(countdown.get("7:5Fhot"), 500);
    assert.equal(countdown.get("8:5Fhot"), 1000);
  });

  test("excludes a neuron with no immunity_expires_at_block (not currently in immunity)", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [{ netuid: 7, hotkey: "5Fhot" }],
      1000,
    );
    assert.equal(countdown.size, 0);
  });

  test("excludes a neuron whose countdown has already reached zero or gone negative", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [
        { netuid: 7, hotkey: "5Fexpired", immunity_expires_at_block: 1000 },
        { netuid: 7, hotkey: "5Fpast", immunity_expires_at_block: 900 },
      ],
      1000,
    );
    assert.equal(countdown.size, 0);
  });

  test("excludes a row missing netuid or hotkey", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [
        { hotkey: "5Fhot", immunity_expires_at_block: 1500 },
        { netuid: 7, immunity_expires_at_block: 1500 },
      ],
      1000,
    );
    assert.equal(countdown.size, 0);
  });

  test("returns an empty map for a non-finite currentBlock", () => {
    const countdown = neuronImmunityCountdownBlocks(
      [{ netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 1500 }],
      NaN,
    );
    assert.equal(countdown.size, 0);
  });

  test("non-array / empty rows never throws", () => {
    assert.equal(neuronImmunityCountdownBlocks([], 1000).size, 0);
    assert.equal(neuronImmunityCountdownBlocks(null, 1000).size, 0);
    assert.equal(neuronImmunityCountdownBlocks(undefined, 1000).size, 0);
  });
});

describe("buildDeregRiskSnapshot", () => {
  test("composes both metrics into the shape triggerMatchesEvent's metricSnapshot expects", () => {
    const snapshot = buildDeregRiskSnapshot({
      economicsRows: [{ netuid: 7, alpha_price_tao: 1 }],
      neuronRows: [
        { netuid: 7, hotkey: "5Fhot", immunity_expires_at_block: 1500 },
      ],
      currentBlock: 1000,
    });
    assert.equal(snapshot.subnetAlphaPriceRank.get(7), 1);
    assert.equal(snapshot.neuronImmunityCountdownBlocks.get("7:5Fhot"), 500);
  });

  test("no args produces two empty maps, never throws", () => {
    const snapshot = buildDeregRiskSnapshot();
    assert.equal(snapshot.subnetAlphaPriceRank.size, 0);
    assert.equal(snapshot.neuronImmunityCountdownBlocks.size, 0);
  });
});
